'use strict';
// Utilidades puras de URL, srcset y CSS. Sin DOM ni APIs de extensión.
// Se carga como script clásico (content, SW, offscreen) y vía require (Node).
(function (root) {
  const WS = /[\t\n\f\r ]/;

  // Regex url() consciente de escapes: comillas dobles, simples o sin comillas.
  const URL_FN_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|((?:[^)\s\\]|\\.)*))\s*\)/i;
  const STRING_RE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/;
  const IMAGE_SET_RE = /(?:-webkit-)?image-set\(/i;
  const RESOLUTION_RE = /(?:^|\s)(\d*\.?\d+(?:e[-+]?\d+)?)(x|dppx|dpi|dpcm)(?=\s|$)/i;
  const IMAGE_EXT_RE = /\.(avif|bmp|gif|ico|jfif|jpe?g|png|svg|tiff?|webp|heic|jxl)$/i;
  const PROXY_PARAMS = ['url', 'u', 'src', 'img', 'image', 'i', 'file'];

  // --- srcset ---------------------------------------------------------------

  const isNonNegInt = (s) => /^[0-9]+$/.test(s);
  const isFloat = (s) => /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(s);

  // Tokenizador según el algoritmo "parse a srcset attribute" de la spec HTML.
  // Nunca divide por ',' a ciegas: las comas dentro de URLs (Cloudinary, data:) sobreviven.
  // Devuelve [{url, w, x}] con w = 0 si no hay descriptor w y x = 1 si no hay densidad.
  function parseSrcset(input) {
    const out = [];
    if (typeof input !== 'string') return out;
    const s = input;
    const len = s.length;
    let pos = 0;
    for (;;) {
      // Saltar espacios y comas
      while (pos < len && (WS.test(s[pos]) || s[pos] === ',')) pos++;
      if (pos >= len) return out;
      // URL: hasta el siguiente espacio
      const start = pos;
      while (pos < len && !WS.test(s[pos])) pos++;
      let url = s.slice(start, pos);
      const descriptors = [];
      if (url.endsWith(',')) {
        // Sin descriptores: quitar comas finales
        url = url.replace(/,+$/, '');
      } else {
        while (pos < len && WS.test(s[pos])) pos++;
        let current = '';
        let state = 'in';
        for (;;) {
          const c = pos < len ? s[pos] : null;
          if (state === 'in') {
            if (c === null) { if (current) descriptors.push(current); break; }
            if (WS.test(c)) {
              if (current) { descriptors.push(current); current = ''; }
              state = 'after';
            } else if (c === ',') {
              pos++;
              if (current) descriptors.push(current);
              break;
            } else if (c === '(') {
              current += c;
              state = 'parens';
            } else {
              current += c;
            }
          } else if (state === 'parens') {
            if (c === null) { if (current) descriptors.push(current); break; }
            current += c;
            if (c === ')') state = 'in';
          } else { // after
            if (c === null) break;
            if (!WS.test(c)) { state = 'in'; continue; } // reprocesar el carácter
          }
          pos++;
        }
      }
      // Parser de descriptores
      let w = null;
      let d = null;
      let h = null;
      let error = false;
      for (const desc of descriptors) {
        const unit = desc[desc.length - 1];
        const num = desc.slice(0, -1);
        if (unit === 'w' && isNonNegInt(num) && w === null && d === null) {
          w = parseInt(num, 10);
          if (w === 0) error = true;
        } else if (unit === 'x' && isFloat(num) && w === null && d === null && h === null) {
          d = parseFloat(num);
          if (d < 0) error = true;
        } else if (unit === 'h' && isNonNegInt(num) && h === null && d === null) {
          h = parseInt(num, 10);
          if (h === 0) error = true;
        } else {
          error = true;
        }
      }
      if (h !== null && w === null) error = true;
      if (!error && url) out.push({ url, w: w === null ? 0 : w, x: d === null ? 1 : d });
    }
  }

  // Mayor w; si ninguno tiene w, mayor x (sin descriptor = 1x). En empate gana el primero.
  function pickLargest(cands) {
    if (!Array.isArray(cands) || cands.length === 0) return null;
    let best = null;
    for (const c of cands) {
      if (!c || !c.url) continue;
      const w = Number(c.w) || 0;
      if (w > 0 && (!best || w > (Number(best.w) || 0))) best = c;
    }
    if (best) return best;
    let bestX = -Infinity;
    for (const c of cands) {
      if (!c || !c.url) continue;
      const x = (typeof c.x === 'number' && c.x >= 0) ? c.x : 1;
      if (x > bestX) { bestX = x; best = c; }
    }
    return best;
  }

  // --- CSS ------------------------------------------------------------------

  // Deshace escapes CSS: \XX hex (+ espacio opcional), \<salto> y \c.
  function cssUnescape(s) {
    return s.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\f\r]?|(\r\n|[\n\f\r])|(.))/g, (m, hex, nl, ch) => {
      if (hex) {
        const cp = parseInt(hex, 16);
        if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '�';
        return String.fromCodePoint(cp);
      }
      if (nl) return '';
      return ch;
    });
  }

  function urlFromMatch(m) {
    const raw = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
    return cssUnescape(raw || '').trim();
  }

  // Divide por comas de nivel superior respetando paréntesis y comillas.
  function splitTopLevel(s) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === '\'') quote = c;
      else if (c === '(') depth++;
      else if (c === ')') { if (depth > 0) depth--; }
      else if (c === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
    }
    parts.push(s.slice(start));
    return parts;
  }

  // Contenido entre el '(' en openIdx y su ')' pareja.
  function balancedInner(s, openIdx) {
    let depth = 0;
    let quote = null;
    for (let i = openIdx; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === '\'') quote = c;
      else if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return s.slice(openIdx + 1, i); }
    }
    return s.slice(openIdx + 1);
  }

  // Resolución de un candidato de image-set(): x/dppx directo, dpi/96, dpcm*2.54/96.
  function candidateResolution(rest) {
    const r = RESOLUTION_RE.exec(rest);
    if (!r) return 1;
    const v = parseFloat(r[1]);
    const unit = r[2].toLowerCase();
    if (unit === 'dpi') return v / 96;
    if (unit === 'dpcm') return (v * 2.54) / 96;
    return v;
  }

  // Mejor candidato (mayor resolución, primero en empate) del interior de image-set().
  function parseImageSet(inner) {
    let best = null;
    for (const raw of splitTopLevel(inner)) {
      const cand = raw.trim();
      if (!cand) continue;
      let url = null;
      let rest = '';
      const m = URL_FN_RE.exec(cand);
      if (m) {
        url = urlFromMatch(m);
        rest = cand.slice(0, m.index) + ' ' + cand.slice(m.index + m[0].length);
      } else {
        const q = STRING_RE.exec(cand);
        if (q) {
          url = cssUnescape(q[1] !== undefined ? q[1] : q[2]).trim();
          rest = ' ' + cand.slice(q[0].length);
        }
      }
      if (!url) continue;
      const resolution = candidateResolution(rest);
      if (!best || resolution > best.resolution) best = { url, resolution };
    }
    return best;
  }

  // Capas de background-image en orden de pintado (índice 0 = la de arriba).
  // Omite none, gradientes y cross-fade; en image-set() elige la mayor resolución.
  function parseImageLayers(cssValue) {
    const layers = [];
    if (typeof cssValue !== 'string') return layers;
    for (const raw of splitTopLevel(cssValue)) {
      const layer = raw.trim();
      if (!layer || /^none$/i.test(layer)) continue;
      if (/^url\(/i.test(layer)) {
        const m = URL_FN_RE.exec(layer);
        if (!m) continue;
        const url = urlFromMatch(m);
        if (url) layers.push({ url, resolution: 1 });
      } else if (IMAGE_SET_RE.test(layer) && /^(?:-webkit-)?image-set\(/i.test(layer)) {
        const best = parseImageSet(balancedInner(layer, layer.indexOf('(')));
        if (best) layers.push(best);
      }
      // gradientes, cross-fade, element(), paint()…: se omiten
    }
    return layers;
  }

  // Índice de la comilla que cierra la cadena abierta en s[openIdx] (o el final).
  function skipString(s, openIdx) {
    const quote = s[openIdx];
    for (let i = openIdx + 1; i < s.length; i++) {
      if (s[i] === '\\') i++;
      else if (s[i] === quote) return i;
    }
    return s.length;
  }

  // URL de imagen de la propiedad content (::before/::after); null si no hay.
  // Recorre el valor por tokens: una cadena ("url(x)") es texto, no una imagen.
  function extractContentUrl(content) {
    if (typeof content !== 'string') return null;
    const s = content.trim();
    if (!s || /^(?:none|normal)$/i.test(s)) return null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"' || c === '\'') { i = skipString(s, i); continue; }
      if (i > 0 && /[\w-]/.test(s[i - 1])) continue; // dentro de un identificador
      const rest = s.slice(i);
      const set = /^(?:-webkit-)?image-set\(/i.exec(rest);
      if (set) {
        const inner = balancedInner(s, i + set[0].length - 1);
        const best = parseImageSet(inner);
        if (best) return best.url;
        i += set[0].length + inner.length; // salta el grupo entero
        continue;
      }
      if (/^url\(/i.test(rest)) {
        const m = URL_FN_RE.exec(rest);
        if (m && m.index === 0) {
          const url = urlFromMatch(m);
          if (url) return url;
        }
      }
    }
    return null;
  }

  // --- URLs -----------------------------------------------------------------

  // 'http' | 'data' | 'blob' | null. Todo lo demás (javascript:, about:, file:…) → null.
  function schemeKind(url) {
    if (typeof url !== 'string') return null;
    const m = /^[\t\n\r ]*([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https') return 'http';
    if (scheme === 'data') return 'data';
    if (scheme === 'blob') return 'blob';
    return null;
  }

  // Absoluta (string) o null si no parsea o el esquema no es http(s)/data/blob.
  function resolveUrl(v, base) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s) return null;
    let u;
    try {
      u = base ? new URL(s, base) : new URL(s);
    } catch (e) {
      return null;
    }
    return schemeKind(u.href) ? u.href : null;
  }

  function stripHash(url) {
    if (typeof url !== 'string') return url;
    const i = url.indexOf('#');
    return i < 0 ? url : url.slice(0, i);
  }

  // Solo pathname (sin query ni hash); anclado al final.
  function isImageExtPath(pathname) {
    return typeof pathname === 'string' && IMAGE_EXT_RE.test(pathname);
  }

  // Si la URL es un proxy (/_next/image?url=…, ?src=…) devuelve la URL http(s)
  // absoluta interna; si no, la entrada tal cual. Desenvuelve hasta 3 niveles.
  function unwrapProxyUrl(url) {
    let current = url;
    for (let depth = 0; depth < 3; depth++) {
      if (schemeKind(current) !== 'http') return current;
      let u;
      try { u = new URL(current); } catch (e) { return current; }
      let inner = null;
      for (const key of PROXY_PARAMS) {
        const v = u.searchParams.get(key);
        if (!v) continue;
        const abs = resolveUrl(v);
        if (abs && schemeKind(abs) === 'http') { inner = abs; break; }
      }
      if (!inner || inner === current) return current;
      current = inner;
    }
    return current;
  }

  // data: URI corta (p. ej. GIF 1×1 de lazysizes): no es la imagen real.
  function isTinyDataPlaceholder(src, max) {
    const limit = typeof max === 'number' ? max : 1024;
    return typeof src === 'string' && /^[\t\n\r ]*data:/i.test(src) && src.length <= limit;
  }

  // LQIP: imagen cargada con atributo lazy cuyo ancho natural es mucho menor
  // que el ancho pintado × DPR.
  function isLqip(f, ratio) {
    const r = typeof ratio === 'number' ? ratio : 0.25;
    if (!f || !f.complete || !f.hasLazyAttr) return false;
    const rectWidth = Number(f.rectWidth) || 0;
    if (!(rectWidth > 0)) return false;
    const dpr = Number(f.dpr) > 0 ? Number(f.dpr) : 1;
    const naturalWidth = Number(f.naturalWidth) || 0;
    return naturalWidth < r * rectWidth * dpr;
  }

  // host (con puerto, como new URL(x).host) sin 'www.' inicial; '' si no parsea.
  // Para blob: usa el origen interno. names.sanitizeHost convierte ':' en '_'.
  function hostOf(url) {
    if (typeof url !== 'string') return '';
    const s = url.trim();
    if (/^blob:/i.test(s)) return hostOf(s.slice(5));
    let u;
    try { u = new URL(s); } catch (e) { return ''; }
    return u.host.replace(/^www\./i, '');
  }

  const api = {
    parseSrcset,
    pickLargest,
    parseImageLayers,
    extractContentUrl,
    resolveUrl,
    stripHash,
    schemeKind,
    isImageExtPath,
    unwrapProxyUrl,
    isTinyDataPlaceholder,
    isLqip,
    hostOf
  };

  root.ImgDL = root.ImgDL || {};
  root.ImgDL.urls = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
