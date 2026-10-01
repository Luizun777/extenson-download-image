'use strict';
// Esquema de nombres de archivo. Implementa, componente a componente, las reglas
// de Chromium para rutas de descarga (net::IsSafePortableRelativePath) para que
// el nombre planificado coincida con el que acaba en disco o dentro del ZIP.
(function (root) {
  // dependencias entre libs: primero el global, si no, require (Node)
  const urls = (root.ImgDL && root.ImgDL.urls) || (typeof require === 'function' ? require('./urls.js') : null);

  const DEFAULT_MAX = 120;
  const BYTE_MAX = 200; // margen bajo los 255 bytes de NAME_MAX en macOS/Linux
  const FALLBACK = 'imagen';
  const FALLBACK_HOST = 'pagina';
  const DEFAULT_FOLDER = 'Imagenes';

  // Ilegales en cualquier posición: " * / : < > ? \ | (Chromium) y % (downloads_api lo cambia por '_').
  const ILLEGAL_ANYWHERE = /[\\/:*?"<>|%]|\p{Cc}/gu;
  // Caracteres de formato (Cf: ancho cero, BOM, soft hyphen...) y no-caracteres U+FDD0-FDEF, U+xFFFE/xFFFF.
  const INVISIBLE = (() => {
    let cls = '\\p{Cf}\\uFDD0-\\uFDEF';
    for (let p = 0; p <= 0x10; p++) {
      cls += '\\u{' + (p * 0x10000 + 0xFFFE).toString(16) + '}\\u{' + (p * 0x10000 + 0xFFFF).toString(16) + '}';
    }
    return new RegExp('[' + cls + ']', 'gu');
  })();
  const TRIM_ENDS = /^[\s.~]+|[\s.~]+$/g;
  // Dispositivos: exactos o con extensión (NUL.txt). Nombres mágicos: exactos.
  const RESERVED = /^(?:(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)(?:\..*)?|desktop\.ini|thumbs\.db|conin\$|conout\$)$/i;
  // Extensiones integradas con el shell de Windows y extensiones con forma de CLSID {…}.
  const SHELL_EXT = /\.(?:lnk|local|scf|url)$|\.\{[^.]*\}$/i;
  // Extensión "visual" de un componente: sufijo tras el último punto, corto y sin espacios.
  const EXT_RE = /\.([^.\s]{1,10})$/;
  // Etiquetas iniciales que el sniffer de Chromium toma por HTML (seguidas de espacio, '>' o '/').
  const HTML_TAG_RE = /^<(?:!--|html|head|body|title|script|div|p|br|font|table|a|style|b|h1|iframe)(?:[\s>\/]|$)/i;

  const IMAGE_EXT_RE = /\.(avif|bmp|gif|ico|jfif|jpe?g|png|svg|tiff?|webp|heic|jxl)$/i;
  const EXT_ALIAS = { jpeg: 'jpg', jpe: 'jpg', jfif: 'jpg', tiff: 'tif', heif: 'heic' };
  const KNOWN_EXT = new Set(['jpg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'heic', 'jxl']);
  const MIME_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg',
    'image/png': 'png', 'image/apng': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp', 'image/x-ms-bmp': 'bmp',
    'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
    'image/tiff': 'tif',
    'image/heic': 'heic', 'image/heif': 'heic',
    'image/jxl': 'jxl'
  };
  const GENERIC_BASES = new Set(['index', 'image', 'default', 'thumb']);

  function utf8Length(s) {
    let n = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    }
    return n;
  }

  function splitExt(name) {
    const m = EXT_RE.exec(name);
    if (!m) return { stem: name, ext: '' };
    return { stem: name.slice(0, name.length - m[0].length), ext: m[0] };
  }

  // Recorta a `max` puntos de código (y BYTE_MAX bytes UTF-8) conservando la extensión.
  function capComponent(s, max) {
    const { stem, ext } = splitExt(s);
    const extLen = Array.from(ext).length;
    const room = Math.max(1, max - extLen);
    const all = Array.from(stem);
    let cps = all.length > room ? all.slice(0, room) : all;
    while (cps.length > 1 && utf8Length(cps.join('')) + utf8Length(ext) > BYTE_MAX) cps.pop();
    let head = cps.join('');
    // Solo tras recortar: un tallo que acaba en punto/espacio daría 'abc..png'. Sin recorte,
    // los puntos interiores ya eran legales y tocarlos rompería la idempotencia.
    if (cps.length < all.length) head = head.replace(/[\s.]+$/, '');
    return head + ext;
  }

  // Igual que sanitizeComponent pero devuelve '' si no queda nada.
  // Desviaciones deliberadas respecto a la especificación: los caracteres de formato
  // (Cf) y los no-caracteres se eliminan en vez de pasar a '_', y la '~' interior
  // pasa a '_' (Windows rechaza nombres con forma 8.3). Ambas salidas son legales.
  function sanitizeRaw(s, max) {
    const limit = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX;
    let out = String(s == null ? '' : s).normalize('NFC');
    out = out.replace(INVISIBLE, '');
    out = out.replace(/\s+/g, ' ');
    out = out.replace(ILLEGAL_ANYWHERE, '_');
    out = out.replace(TRIM_ENDS, '');
    out = out.replace(/~/g, '_'); // '~' interior: evita nombres cortos 8.3 en Windows
    if (!out) return '';
    // Primero el tope: el recorte puede dejar al descubierto un nombre reservado o una
    // extensión del shell ('x…x.lnkyyy' -> 'x…x.lnk'), así que las reglas de prefijo y
    // sufijo van después y reservan sitio para su carácter extra.
    out = capComponent(out, limit);
    if (RESERVED.test(out)) out = capComponent('_' + out, limit);
    if (SHELL_EXT.test(out)) out = capComponent(out, limit - 1) + '_';
    return out;
  }

  function sanitizeComponent(s, max) {
    return sanitizeRaw(s, max) || FALLBACK;
  }

  function unwrap(url) {
    if (!urls || typeof urls.unwrapProxyUrl !== 'function') return url;
    try {
      const inner = urls.unwrapProxyUrl(url);
      return typeof inner === 'string' && inner ? inner : url;
    } catch (e) {
      return url;
    }
  }

  function isImageExt(path) {
    if (urls && typeof urls.isImageExtPath === 'function') return !!urls.isImageExtPath(path);
    return IMAGE_EXT_RE.test(path);
  }

  // Ruta (sin query ni hash) de una URL absoluta o relativa; '' para data:/blob:.
  function pathnameOf(url) {
    const s = String(url == null ? '' : url).trim();
    if (!s || /^(?:data|blob|javascript|about):/i.test(s)) return '';
    const stripped = s.replace(/[?#][\s\S]*$/, '');
    try {
      return new URL(stripped).pathname;
    } catch (e) {
      return stripped;
    }
  }

  function lastSegment(pathname) {
    const seg = pathname.replace(/\/+$/, '').split('/').pop() || '';
    try {
      return decodeURIComponent(seg);
    } catch (e) {
      return seg;
    }
  }

  function normalizeExt(ext) {
    const e = String(ext || '').toLowerCase();
    const mapped = EXT_ALIAS[e] || e;
    return KNOWN_EXT.has(mapped) ? mapped : null;
  }

  function buildBaseName(opts) {
    const { url, alt, index } = opts || {};
    const seg = lastSegment(pathnameOf(unwrap(url)));
    let raw = isImageExt(seg) ? seg.replace(/\.[^.]*$/, '') : seg;
    raw = raw.trim();
    const generic = !raw || raw.length < 2 || GENERIC_BASES.has(raw.toLowerCase());
    if (!generic) {
      const base = sanitizeRaw(raw, 100);
      if (base && base.length >= 2) return base;
    }
    const altText = String(alt == null ? '' : alt).replace(/\s+/g, ' ').trim();
    if (altText) {
      const base = sanitizeRaw(Array.from(altText).slice(0, 60).join(''), 100);
      if (base) return base;
    }
    return Number.isInteger(index) && index >= 0 ? FALLBACK + '-' + String(index).padStart(3, '0') : FALLBACK;
  }

  // Extensión de la ruta (sin query ni hash). Una ruta que termina en '/' no tiene
  // extensión, igual que urls.isImageExtPath('/a.png/') es false.
  function extFromUrl(url) {
    const pathname = pathnameOf(unwrap(url));
    if (/\/$/.test(pathname)) return null;
    const m = /\.([a-z0-9]{2,5})$/i.exec(lastSegment(pathname));
    return m ? normalizeExt(m[1]) : null;
  }

  function normalizeMime(mime) {
    return String(mime == null ? '' : mime).split(';')[0].trim().toLowerCase();
  }

  function extFromMime(mime) {
    return MIME_EXT[normalizeMime(mime)] || null;
  }

  function extFromDataUrl(url) {
    const m = /^data:([^;,]+)/i.exec(String(url == null ? '' : url).trim());
    return m ? extFromMime(m[1]) : null;
  }

  function isImageMime(mime) {
    return /^image\//.test(normalizeMime(mime));
  }

  // Chrome corrige una extensión equivocada según el MIME, pero nunca añade una que falta: siempre devolvemos una.
  function extForRef(ref) {
    const r = ref || {};
    const own = normalizeExt(r.ext);
    if (own) return own;
    if (r.mime) {
      const fromMime = extFromMime(r.mime);
      if (fromMime) return fromMime;
    }
    if (r.kind === 'canvas') return 'png';
    if (r.kind === 'svg') return 'svg';
    return extFromUrl(r.url) || extFromDataUrl(r.url) || 'jpg';
  }

  function asciiHead(bytes, n) {
    let s = '';
    const end = Math.min(n, bytes.length);
    for (let i = 0; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function startsWithBytes(bytes, sig, offset) {
    const off = offset || 0;
    if (bytes.length < off + sig.length) return false;
    for (let i = 0; i < sig.length; i++) if (bytes[off + i] !== sig[i]) return false;
    return true;
  }

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input && input.buffer instanceof ArrayBuffer) return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (Array.isArray(input)) return Uint8Array.from(input);
    return new Uint8Array(0);
  }

  function sniffFtyp(bytes) {
    if (!startsWithBytes(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return null; // 'ftyp'
    const brand = asciiHead(bytes.subarray(8, 12), 4).toLowerCase();
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', ext: 'avif' };
    const heicBrands = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];
    if (!heicBrands.includes(brand)) return null;
    // Marca mayor genérica (mif1): mira las marcas compatibles por si es AVIF.
    const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    const end = Math.min(bytes.length, boxSize || bytes.length);
    for (let i = 16; i + 4 <= end; i += 4) {
      const b = asciiHead(bytes.subarray(i, i + 4), 4).toLowerCase();
      if (b === 'avif' || b === 'avis') return { mime: 'image/avif', ext: 'avif' };
    }
    return { mime: 'image/heic', ext: 'heic' };
  }

  // Detecta el formato por los primeros bytes. Devuelve {mime, ext}, {mime:'text/html'} o null.
  function sniffExt(input) {
    const bytes = toBytes(input);
    if (bytes.length < 2) return null;
    if (startsWithBytes(bytes, [0xFF, 0xD8, 0xFF])) return { mime: 'image/jpeg', ext: 'jpg' };
    if (startsWithBytes(bytes, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return { mime: 'image/png', ext: 'png' };
    if (startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return { mime: 'image/gif', ext: 'gif' };
    if (startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWithBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return { mime: 'image/webp', ext: 'webp' };
    const ftyp = sniffFtyp(bytes);
    if (ftyp) return ftyp;
    if (startsWithBytes(bytes, [0x42, 0x4D])) return { mime: 'image/bmp', ext: 'bmp' };
    if (startsWithBytes(bytes, [0x00, 0x00, 0x01, 0x00])) return { mime: 'image/x-icon', ext: 'ico' };
    if (startsWithBytes(bytes, [0x49, 0x49, 0x2A, 0x00]) ||
        startsWithBytes(bytes, [0x4D, 0x4D, 0x00, 0x2A])) return { mime: 'image/tiff', ext: 'tif' };
    if (startsWithBytes(bytes, [0xFF, 0x0A]) ||
        startsWithBytes(bytes, [0x00, 0x00, 0x00, 0x0C, 0x4A, 0x58, 0x4C, 0x20])) return { mime: 'image/jxl', ext: 'jxl' };

    // Texto: BOM UTF-8 y espacios opcionales, luego la etiqueta inicial. 16 bytes bastan
    // para las firmas binarias; para HTML con espacios o comentarios iniciales y para
    // AVIF con marca mayor mif1 los llamadores deben pasar 64 bytes.
    let head = asciiHead(bytes, 64);
    if (head.charCodeAt(0) === 0xEF && head.charCodeAt(1) === 0xBB && head.charCodeAt(2) === 0xBF) head = head.slice(3);
    head = head.replace(/^[\s\u0000]+/, '');
    if (/^<!doctype\s+(?!svg)/i.test(head) || HTML_TAG_RE.test(head)) return { mime: 'text/html' };
    if (/^<svg\b/i.test(head) || /^<\?xml/i.test(head) || /^<!doctype\s+svg/i.test(head)) return { mime: 'image/svg+xml', ext: 'svg' };
    return null;
  }

  // Deduplica sin distinguir mayúsculas: 'a.jpg', 'a (2).jpg', 'a (3).jpg'.
  function dedupeNames(names) {
    const seen = new Set();
    const out = [];
    for (const original of names || []) {
      const name = String(original == null ? '' : original);
      const keyOf = (n) => n.normalize('NFC').toLowerCase();
      let candidate = name;
      if (seen.has(keyOf(candidate))) {
        const parts = splitExt(name);
        const ext = parts.ext;
        const stem = parts.stem.replace(/ \(\d+\)$/, ''); // 'a (2)' repetido -> 'a (3)', no 'a (2) (2)'
        let n = 2;
        do {
          candidate = stem + ' (' + n + ')' + ext;
          n++;
        } while (seen.has(keyOf(candidate)));
      }
      seen.add(keyOf(candidate));
      out.push(candidate);
    }
    return out;
  }

  // Sello local 'YYYYMMDD-HHmm'.
  function stamp(date) {
    let d = date instanceof Date ? date : (typeof date === 'number' ? new Date(date) : new Date());
    if (Number.isNaN(d.getTime())) d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return String(d.getFullYear()).padStart(4, '0') + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function sanitizeFolder(folder) {
    const parts = String(folder == null ? '' : folder).split('/').map((c) => sanitizeRaw(c)).filter(Boolean);
    return parts.length ? parts.join('/') : DEFAULT_FOLDER;
  }

  function sanitizeHost(host) {
    let h = String(host == null ? '' : host).trim();
    // Si llega una URL completa, quedarse con host:puerto (misma convención que urls.hostOf).
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) {
      try { h = new URL(h).host; } catch (e) { h = ''; }
    }
    h = h.replace(/^www\./i, '');
    return sanitizeRaw(h) || FALLBACK_HOST;
  }

  // {single:'Imagenes/host', batch:'Imagenes/host_sello', zip:'Imagenes/host_sello.zip'}
  function buildPaths(opts) {
    const o = opts || {};
    const folder = sanitizeFolder(o.folder == null ? DEFAULT_FOLDER : o.folder);
    const host = sanitizeHost(o.host);
    const st = typeof o.stamp === 'string' && o.stamp ? o.stamp : stamp(o.stamp);
    const single = folder + '/' + host;
    const batch = single + '_' + st;
    return { single, batch, zip: batch + '.zip' };
  }

  // Copia cada ítem con un 'fileName' final único (base + ext, saneado y deduplicado).
  function planNames(items) {
    const list = Array.isArray(items) ? items : [];
    const names = list.map((item, i) => {
      const it = item || {};
      const ext = extForRef(it);
      let base = typeof it.name === 'string' && it.name.trim()
        ? it.name
        : buildBaseName({ url: it.url, alt: it.alt, index: Number.isInteger(it.index) ? it.index : i });
      // Quita la extensión propia del nombre aunque sea un alias (photo.jpeg + jpg -> photo).
      const own = splitExt(base);
      if (own.ext && normalizeExt(own.ext.slice(1)) === ext) base = own.stem;
      return sanitizeComponent(base + '.' + ext, 110);
    });
    const unique = dedupeNames(names);
    return list.map((item, i) => Object.assign({}, item, { fileName: unique[i] }));
  }

  // Une componentes con '/' (nunca '\': es ilegal en macOS/Linux).
  function joinPath() {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) {
      const p = arguments[i];
      if (p == null) continue;
      const s = String(p).replace(/^\/+|\/+$/g, '');
      if (s) parts.push(s);
    }
    return parts.join('/').replace(/\/{2,}/g, '/');
  }

  const api = {
    sanitizeComponent,
    buildBaseName,
    extFromUrl,
    extFromMime,
    extFromDataUrl,
    extForRef,
    sniffExt,
    isImageMime,
    dedupeNames,
    stamp,
    buildPaths,
    planNames,
    joinPath
  };

  root.ImgDL = root.ImgDL || {};
  root.ImgDL.names = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
