'use strict';
// Selección por frame: Map clave → {ref, el (WeakRef), blob, mime, ext, visible, ready}.
// Los tipos byte (blob/canvas/svg) se materializan al seleccionar (las blob: se
// revocan pronto) y el Blob se guarda aquí; el SW pide los bytes uno a uno con
// imgdl:materialize {id} → data URL. Las claves http/data no guardan nada.
// Mientras un tipo byte se materializa (pending) la entrada existe para has()
// (el checkbox del chip sigue marcado) pero NO cuenta: count(), visibleEntries()
// y collectSelection() la omiten hasta que haya bytes; si falla, se retira con
// onError. Así la barra nunca ofrece descargar algo que aún puede fallar.
// Visibilidad por IntersectionObserver({threshold:0}) → visibleEntries() para los
// badges. rebind(key, el) cuando una lista virtualizada recrea el nodo.
// Sin acceso a chrome.* ni a la UI: avisa por onChange(count, reason) y
// onError(code, text, ref); el controlador envía mensajes y muestra toasts.
(function (root) {
  const ImgDL = root.ImgDL || (root.ImgDL = {});
  const thresholds = ImgDL.thresholds || (typeof require === 'function' ? require('../lib/thresholds.js') : null);
  const names = ImgDL.names || (typeof require === 'function' ? require('../lib/names.js') : null);
  const DEFAULTS = (thresholds && thresholds.DEFAULTS) || {};
  const MAX_ITEM_BYTES = DEFAULTS.maxItemBytes || 32 * 1024 * 1024;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
  const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>\n';
  const USE_CAP = 200;        // <use href="#id"> inlinados como máximo
  const SNIFF_BYTES = 64;     // bytes para names.sniffExt
  const BYTE_KINDS = new Set(['blob', 'canvas', 'svg']);
  const FIXED_TYPES = { canvas: { mime: 'image/png', ext: 'png' }, svg: { mime: 'image/svg+xml', ext: 'svg' } };

  function S() {
    return ImgDL.strings || {};
  }

  function textFor(code) {
    const s = S();
    if (typeof s.format === 'function') return s.format(code);
    return s[code] || s.ERR_GENERIC || String(code || '');
  }

  function fail(code, cause) {
    const e = new Error(code);
    e.code = code;
    if (cause !== undefined) e.cause = cause;
    return e;
  }

  function codeOf(e) {
    return e && typeof e.code === 'string' && e.code ? e.code : 'ERR_GENERIC';
  }

  function isSecurityError(e) {
    return !!e && (e.name === 'SecurityError' || e.code === 18);
  }

  function tagOf(el) {
    return el && typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  }

  // Elemento real desde una WeakRef o un elemento; null si se recogió o no vale.
  function derefEl(el) {
    if (!el) return null;
    if (typeof WeakRef === 'function' && el instanceof WeakRef) {
      const v = el.deref();
      return v && v.nodeType === 1 ? v : null;
    }
    return el.nodeType === 1 ? el : null;
  }

  function holdEl(el) {
    if (!el || el.nodeType !== 1) return null;
    try { return typeof WeakRef === 'function' ? new WeakRef(el) : el; } catch (_) { return el; }
  }

  function rectOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    } catch (_) {
      return { x: 0, y: 0, w: 0, h: 0 };
    }
  }

  // Visibilidad inicial (síncrona) hasta que el IntersectionObserver informe.
  function inViewport(el) {
    if (!el || !el.isConnected) return false;
    const r = rectOf(el);
    const vw = root.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
    const vh = root.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
    return r.w > 0 && r.h > 0 && r.x < vw && r.y < vh && r.x + r.w > 0 && r.y + r.h > 0;
  }

  function outermostSvg(el) {
    const res = ImgDL.resolve;
    if (res && typeof res.outermostSvg === 'function') return res.outermostSvg(el);
    let node = el && el.namespaceURI === SVG_NS ? el : null;
    while (node && node.ownerSVGElement) node = node.ownerSVGElement;
    return node && tagOf(node) === 'SVG' ? node : null;
  }

  // Copia JSON-safe del ImageRef (sin Blobs ni elementos).
  function cloneRef(ref) {
    const out = {};
    for (const k of Object.keys(ref)) {
      const v = ref[k];
      if (v === undefined || v === null || typeof v === 'function' || typeof v === 'object') continue;
      out[k] = v;
    }
    return out;
  }

  // ---- Materialización ---------------------------------------------------------

  function canvasToBlob(canvas, type) {
    return new Promise((resolve, reject) => {
      try { canvas.toBlob((b) => resolve(b || null), type || 'image/png'); } catch (e) { reject(e); }
    });
  }

  // <img> ya decodificada → PNG por canvas (se pierden bytes y formato originales).
  async function reencodeImage(img) {
    const el = derefEl(img);
    if (!el || tagOf(el) !== 'IMG') throw fail('ERR_BLOB_GONE');
    const w = Number(el.naturalWidth) || 0;
    const h = Number(el.naturalHeight) || 0;
    if (el.complete === false || !(w > 0 && h > 0)) throw fail('ERR_BLOB_GONE');
    let blob = null;
    try {
      const c = document.createElement('canvas'); // nunca se inserta
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) throw fail('ERR_BLOB_GONE');
      ctx.drawImage(el, 0, 0);
      blob = await canvasToBlob(c, 'image/png');
    } catch (e) {
      throw fail('ERR_BLOB_GONE', e);
    }
    if (!blob || !blob.size) throw fail('ERR_BLOB_GONE');
    return blob;
  }

  // blob: fetch en ESTE marco (misma clave de almacenamiento); si falla (revocada),
  // recodificar desde el <img> ya decodificado.
  async function blobFromUrl(ref, el) {
    let blob = null;
    try {
      const res = await fetch(ref.url);
      if (res && res.ok) blob = await res.blob();
    } catch (_) {
      blob = null;
    }
    if (blob && blob.size > 0) return blob;
    return reencodeImage(el);
  }

  // Nunca getContext sobre el canvas de la página: solo toBlob.
  async function canvasBlob(el) {
    const c = derefEl(el);
    if (!c || tagOf(c) !== 'CANVAS') throw fail('ERR_CANVAS_EMPTY');
    let blob = null;
    try {
      blob = await canvasToBlob(c, 'image/png');
    } catch (e) {
      throw fail(isSecurityError(e) ? 'ERR_TAINTED_CANVAS' : 'ERR_CANVAS_EMPTY', e);
    }
    if (!blob || !blob.size) throw fail('ERR_CANVAS_EMPTY');
    return blob;
  }

  function useHref(use) {
    let v = '';
    try { v = use.getAttribute('href') || use.getAttributeNS(XLINK_NS, 'href') || use.getAttribute('xlink:href') || ''; } catch (_) { v = ''; }
    return String(v).trim();
  }

  function byId(scope, id) {
    try {
      if (scope && typeof scope.getElementById === 'function') return scope.getElementById(id);
    } catch (_) { /* nada */ }
    return null;
  }

  function escapeId(id) {
    try { return root.CSS && typeof root.CSS.escape === 'function' ? root.CSS.escape(id) : id.replace(/[^\w-]/g, '\\$&'); } catch (_) { return id; }
  }

  // Exportación básica del <svg> raíz: clon + xmlns + tamaño + <use> externos inlinados.
  // (Los estilos de clase de la página no se inlinan: exportación de mejor esfuerzo.)
  function exportSvg(svgEl) {
    try {
      const el = derefEl(svgEl);
      const svgRoot = outermostSvg(el) || (tagOf(el) === 'SVG' ? el : null);
      if (!svgRoot) throw fail('ERR_SVG');
      const clone = svgRoot.cloneNode(true);
      if (!clone.getAttribute('xmlns')) clone.setAttributeNS(XMLNS_NS, 'xmlns', SVG_NS);
      if (!clone.getAttribute('xmlns:xlink')) clone.setAttributeNS(XMLNS_NS, 'xmlns:xlink', XLINK_NS);
      const r = rectOf(svgRoot);
      const w = Math.max(0, Math.round(r.w));
      const h = Math.max(0, Math.round(r.h));
      if (!clone.getAttribute('width') && w > 0) clone.setAttribute('width', String(w));
      if (!clone.getAttribute('height') && h > 0) clone.setAttribute('height', String(h));
      if (!clone.getAttribute('viewBox') && w > 0 && h > 0) clone.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      // <use href="#id"> cuyo destino vive fuera del svg (sprites): copiarlo a <defs>.
      let uses = [];
      try { uses = Array.from(clone.querySelectorAll('use')).slice(0, USE_CAP); } catch (_) { uses = []; }
      const seen = new Set();
      let defs = null;
      const docOf = svgRoot.ownerDocument || document;
      const scope = typeof svgRoot.getRootNode === 'function' ? svgRoot.getRootNode() : docOf;
      for (const use of uses) {
        const href = useHref(use);
        if (!href || href[0] !== '#') continue;
        let id = href.slice(1);
        try { id = decodeURIComponent(id); } catch (_) { /* id tal cual */ }
        if (!id || seen.has(id)) continue;
        let inside = null;
        try { inside = svgRoot.querySelector('#' + escapeId(id)); } catch (_) { inside = null; }
        if (inside) continue;
        const target = byId(scope, id) || byId(docOf, id);
        if (!target) continue;
        seen.add(id);
        if (!defs) {
          defs = docOf.createElementNS(SVG_NS, 'defs');
          clone.insertBefore(defs, clone.firstChild);
        }
        defs.append(target.cloneNode(true));
      }
      const xml = XML_PROLOG + new XMLSerializer().serializeToString(clone);
      return new Blob([xml], { type: 'image/svg+xml' });
    } catch (e) {
      throw fail('ERR_SVG', e);
    }
  }

  // entry = {ref, el (WeakRef|Element)} → Blob; lanza Error con .code.
  async function toBlobFor(entry) {
    const ref = entry && entry.ref;
    const el = derefEl(entry && entry.el);
    if (!ref) throw fail('ERR_GENERIC');
    switch (ref.kind) {
      case 'blob':
        return blobFromUrl(ref, el);
      case 'canvas':
        return canvasBlob(el);
      case 'svg':
        if (!el) throw fail('ERR_SVG');
        return exportSvg(el);
      default:
        throw fail('ERR_GENERIC');
    }
  }

  // {mime, ext} del Blob: fijos para canvas/svg; para blob: el tipo del Blob o la
  // firma de los primeros bytes.
  async function describeBlob(blob, kind) {
    if (FIXED_TYPES[kind]) return FIXED_TYPES[kind];
    const mime = typeof blob.type === 'string' ? blob.type.split(';')[0].trim().toLowerCase() : '';
    const ext = names && typeof names.extFromMime === 'function' ? names.extFromMime(mime) : null;
    if (mime && ext) return { mime, ext };
    try {
      const head = new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer());
      const sniff = names && typeof names.sniffExt === 'function' ? names.sniffExt(head) : null;
      if (sniff && sniff.ext) return { mime: sniff.mime, ext: sniff.ext };
    } catch (_) { /* sin firma */ }
    return { mime: mime || 'application/octet-stream', ext: ext || 'bin' };
  }

  function readAsDataUrl(blob, mime) {
    return new Promise((resolve, reject) => {
      try {
        const b = mime && blob.type !== mime ? new Blob([blob], { type: mime }) : blob;
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(fail('ERR_GENERIC', fr.error));
        fr.readAsDataURL(b);
      } catch (e) {
        reject(fail('ERR_GENERIC', e));
      }
    });
  }

  // ---- Almacén de selección ----------------------------------------------------

  // opts = {signal, onChange(count, reason), onError(code, text, ref), maxItemBytes?}
  function createSelection(opts) {
    const o = opts || {};
    const maxItemBytes = typeof o.maxItemBytes === 'number' && o.maxItemBytes > 0 ? o.maxItemBytes : MAX_ITEM_BYTES;
    const map = new Map();          // key -> entry
    const elKeys = new WeakMap();   // elemento observado -> key
    let io = null;
    let disposed = false;

    function notify(reason) {
      if (typeof o.onChange !== 'function') return;
      try { o.onChange(count(), reason); } catch (_) { /* nada */ }
    }

    function notifyError(code, ref) {
      if (typeof o.onError !== 'function') return;
      try { o.onError(code, textFor(code), ref); } catch (_) { /* nada */ }
    }

    function onIntersect(records) {
      let changed = false;
      for (const rec of records) {
        const key = elKeys.get(rec.target);
        const entry = key !== undefined ? map.get(key) : null;
        if (!entry || derefEl(entry.el) !== rec.target) continue;
        const v = !!rec.isIntersecting && rec.target.isConnected;
        if (entry.visible !== v) { entry.visible = v; changed = true; }
      }
      if (changed) notify('visibility');
    }

    function observer() {
      if (io || disposed || typeof IntersectionObserver !== 'function') return io;
      try { io = new IntersectionObserver(onIntersect, { threshold: 0 }); } catch (_) { io = null; }
      return io;
    }

    function observe(entry, el) {
      if (!el) return;
      elKeys.set(el, entry.key);
      const obs = observer();
      if (obs) { try { obs.observe(el); } catch (_) { /* nada */ } }
    }

    function unobserve(entry) {
      const el = derefEl(entry.el);
      if (!el || !io) return;
      try { io.unobserve(el); } catch (_) { /* nada */ }
    }

    function has(key) {
      return typeof key === 'string' && map.has(key);
    }

    // Seleccionadas con bytes asegurados: las pendientes de materializar no cuentan.
    function count() {
      let n = 0;
      for (const entry of map.values()) if (!entry.pending) n++;
      return n;
    }

    // Tipos byte: materializar ya; si falla, la entrada se retira y se avisa.
    // Mientras tanto la entrada está pending (no cuenta); al terminar, 'ready'.
    function materializeEntry(entry) {
      entry.pending = true;
      entry.ready = toBlobFor(entry)
        .then(async (blob) => {
          if (!blob || !blob.size) throw fail('ERR_GENERIC');
          if (blob.size > maxItemBytes) throw fail('ERR_TOO_BIG_ITEM');
          const d = await describeBlob(blob, entry.ref.kind);
          entry.blob = blob;
          entry.mime = d.mime;
          entry.ext = d.ext;
          entry.pending = false;
          if (map.get(entry.key) === entry) notify('ready');
          return blob;
        })
        .catch((e) => {
          entry.pending = false;
          if (map.get(entry.key) === entry) {
            map.delete(entry.key);
            unobserve(entry);
            notifyError(codeOf(e), entry.ref);
            notify('error');
          }
          throw e;
        });
      entry.ready.catch(() => {}); // solo materialize() la espera
    }

    function add(ref, el) {
      if (disposed || !ref || typeof ref.key !== 'string' || !ref.key) return false;
      if (map.has(ref.key)) {
        rebind(ref.key, el);
        return true;
      }
      const node = el && el.nodeType === 1 ? el : null;
      const entry = {
        key: ref.key,
        ref: cloneRef(ref),
        el: holdEl(node),
        blob: null,
        mime: null,
        ext: null,
        visible: inViewport(node),
        pending: false,
        ready: null
      };
      map.set(ref.key, entry);
      observe(entry, node);
      if (BYTE_KINDS.has(ref.kind)) materializeEntry(entry);
      notify('add');
      return true;
    }

    function remove(key) {
      const entry = has(key) ? map.get(key) : null;
      if (!entry) return false;
      map.delete(key);
      unobserve(entry);
      entry.blob = null;
      notify('remove');
      return true;
    }

    function toggle(ref, el) {
      if (!ref || typeof ref.key !== 'string') return false;
      if (map.has(ref.key)) {
        remove(ref.key);
        return false;
      }
      return add(ref, el);
    }

    function clear() {
      for (const entry of map.values()) entry.blob = null;
      map.clear();
      if (io) { try { io.disconnect(); } catch (_) { /* nada */ } io = null; }
      notify('clear');
    }

    // Nodo recreado (lista virtualizada) con una clave ya seleccionada.
    function rebind(key, el) {
      const entry = has(key) ? map.get(key) : null;
      const node = el && el.nodeType === 1 ? el : null;
      if (!entry || !node) return false;
      const cur = derefEl(entry.el);
      if (cur === node) return true;
      unobserve(entry);
      entry.el = holdEl(node);
      entry.visible = inViewport(node);
      observe(entry, node);
      notify('rebind');
      return true;
    }

    function entries() {
      const out = [];
      for (const entry of map.values()) {
        out.push({ key: entry.key, ref: entry.ref, el: derefEl(entry.el), hasBlob: !!entry.blob, pending: entry.pending, mime: entry.mime, ext: entry.ext });
      }
      return out;
    }

    // Seleccionadas visibles y conectadas: [{key, rect, name, el}] para overlay.setBadges.
    function visibleEntries() {
      const out = [];
      for (const entry of map.values()) {
        if (entry.pending) continue;
        const el = derefEl(entry.el);
        if (!el || !el.isConnected || !entry.visible) continue;
        out.push({ key: entry.key, rect: rectOf(el), name: entry.ref.name, el });
      }
      return out;
    }

    // Solo refs JSON-safe (nunca Blobs ni data URLs) y solo entradas con bytes
    // asegurados: lo que ve el SW coincide con el recuento de la barra.
    function collectSelection() {
      const items = [];
      for (const entry of map.values()) if (!entry.pending) items.push(cloneRef(entry.ref));
      let frameUrl = '';
      try { frameUrl = root.location ? root.location.href : ''; } catch (_) { frameUrl = ''; }
      return { frameUrl, items };
    }

    function entryById(id) {
      const n = typeof id === 'number' ? id : Number(id);
      for (const entry of map.values()) {
        if (entry.ref.id === n || entry.ref.id === id) return entry;
      }
      return null;
    }

    // Bytes de un tipo byte seleccionado como data URL (uno por mensaje).
    async function materialize(id) {
      const entry = entryById(id);
      const bad = (code) => ({ id, code, text: textFor(code) });
      if (!entry || !BYTE_KINDS.has(entry.ref.kind)) return bad('ERR_GENERIC');
      try {
        if (entry.ready) await entry.ready;
      } catch (e) {
        return bad(codeOf(e));
      }
      if (!entry.blob) return bad('ERR_GENERIC');
      try {
        const dataUrl = await readAsDataUrl(entry.blob, entry.mime);
        if (!dataUrl) return bad('ERR_GENERIC');
        return { id, dataUrl, mime: entry.mime, ext: entry.ext };
      } catch (e) {
        return bad(codeOf(e));
      }
    }

    if (o.signal) {
      if (o.signal.aborted) { disposed = true; }
      else o.signal.addEventListener('abort', () => { disposed = true; clear(); }, { once: true });
    }

    return { add, remove, toggle, clear, count, entries, has, rebind, collectSelection, materialize, visibleEntries };
  }

  const materializeApi = { toBlobFor, exportSvg, reencodeImage, describeBlob, readAsDataUrl, BYTE_KINDS };
  const api = { createSelection, materialize: materializeApi };

  root.ImgDL = root.ImgDL || {};
  root.ImgDL.selection = api;
  root.ImgDL.createSelection = createSelection;
  root.ImgDL.materialize = materializeApi;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
