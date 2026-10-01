'use strict';
// Elemento → ImageRef. Resuelve la "mejor" URL de <img>/<picture> (srcset, lazy,
// placeholders), fondos CSS (capas y ::before/::after), <video poster>, <svg> inline,
// <canvas> y blob:. Sin estado salvo el id por elemento (WeakMap) y el id de instancia
// del marco, que hace únicas las claves blob/canvas/svg entre frames.
(function (root) {
  const ImgDL = root.ImgDL || (root.ImgDL = {});
  const urls = ImgDL.urls || (typeof require === 'function' ? require('../lib/urls.js') : null);
  const thresholds = ImgDL.thresholds || (typeof require === 'function' ? require('../lib/thresholds.js') : null);
  const names = ImgDL.names || (typeof require === 'function' ? require('../lib/names.js') : null);
  const DEFAULTS = (thresholds && thresholds.DEFAULTS) || {};

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  // Atributos de carga perezosa verificados (lazysizes, vanilla-lazyload, WP Rocket, jQuery lazyload).
  const LAZY_ATTRS = ['data-src', 'data-srcset', 'data-lazy-src', 'data-lazy-srcset', 'data-original', 'data-bg', 'data-bg-hidpi'];
  const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];
  const LAZY_SINGLE_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-bg-hidpi', 'data-bg'];
  // Atributos "débiles": galerías y widgets AJAX los usan para fichas HTML
  // (data-url=/producto/123); solo cuentan si el valor parece imagen o src es placeholder.
  const LAZY_WEAK_ATTRS = ['data-url'];
  const ANCHOR_DEPTH = 6;
  const PSEUDOS = ['::before', '::after'];

  // --- identidad ------------------------------------------------------------

  function makeInstanceId() {
    try {
      const c = root.crypto;
      if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '').slice(0, 12);
      if (c && typeof c.getRandomValues === 'function') {
        const a = new Uint32Array(2);
        c.getRandomValues(a);
        return a[0].toString(36) + a[1].toString(36);
      }
    } catch (_) { /* sin crypto */ }
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  // Estado de identidad compartido entre re-evaluaciones del script en el mismo marco
  // (ensureFrames vuelve a inyectar los archivos): ni el id de instancia ni los ids de
  // elemento cambian, así las claves blob/canvas/svg de la selección siguen valiendo.
  const prev = ImgDL.resolve && ImgDL.resolve._state;
  const state = prev && typeof prev.frameInstanceId === 'string' && prev.ids instanceof WeakMap
    ? prev
    : { frameInstanceId: makeInstanceId(), ids: new WeakMap(), next: 0 };
  const frameInstanceId = state.frameInstanceId;

  // Id estable por elemento dentro de este marco (contador, empieza en 1).
  function elementIdOf(el) {
    if (!el || typeof el !== 'object') return 0;
    let id = state.ids.get(el);
    if (!id) {
      id = ++state.next;
      state.ids.set(el, id);
    }
    return id;
  }

  function byteKey(kind, id) {
    return kind + '|' + frameInstanceId + ':' + id;
  }

  // --- utilidades DOM (defensivas: nunca lanzan) -----------------------------

  function tagOf(el) {
    return el && typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  }

  function isSvgEl(el) {
    return !!el && el.namespaceURI === SVG_NS;
  }

  function attr(el, name) {
    try {
      const v = el.getAttribute(name);
      return typeof v === 'string' ? v.trim() : '';
    } catch (_) {
      return '';
    }
  }

  function attrNS(el, ns, name) {
    try {
      const v = el.getAttributeNS(ns, name);
      return typeof v === 'string' ? v.trim() : '';
    } catch (_) {
      return '';
    }
  }

  function docOf(el) {
    return (el && el.ownerDocument) || root.document;
  }

  function viewOf(el) {
    const d = docOf(el);
    return (d && d.defaultView) || root;
  }

  function baseOf(el) {
    try { return docOf(el).baseURI; } catch (_) { return undefined; }
  }

  function rectOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    } catch (_) {
      return { x: 0, y: 0, w: 0, h: 0 };
    }
  }

  function rectContains(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
  }

  function safeComputedStyle(el, pseudo) {
    try { return viewOf(el).getComputedStyle(el, pseudo || null); } catch (_) { return null; }
  }

  // Padre cruzando límites de shadow DOM (ShadowRoot → host).
  function parentOf(node) {
    const p = node && node.parentNode;
    if (!p) return null;
    if (p.nodeType === 1) return p;
    if (p.nodeType === 11 && p.host) return p.host;
    return null;
  }

  function thOf(opts) {
    const t = opts && opts.t;
    return t && t !== DEFAULTS ? Object.assign({}, DEFAULTS, t) : DEFAULTS;
  }

  // URL absoluta http(s)/blob sin fragmento, o la data: tal cual (ni se parsea ni se
  // le quita el '#'); null si no resuelve o el esquema no vale (javascript:, about:…).
  function abs(v, base) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s) return null;
    if (urls.schemeKind(s) === 'data') return s;
    const u = urls.resolveUrl(s, base);
    return u ? urls.stripHash(u) : null;
  }

  // alt / aria-label normalizados; '' si no hay.
  function altOf(el) {
    const a = attr(el, 'alt') || attr(el, 'aria-label');
    return a.replace(/\s+/g, ' ').trim();
  }

  // <img> cuyo src no es una imagen real: ausente, data: diminuta o cargada con
  // natural <= spacerNaturalMax (píxel/spacer). Otros elementos → false.
  function srcIsPlaceholder(el) {
    if (tagOf(el) !== 'IMG') return false;
    const src = attr(el, 'src');
    if (!src) return true;
    if (urls.isTinyDataPlaceholder(src, DEFAULTS.placeholderDataMax)) return true;
    const nw = Number(el.naturalWidth) || 0;
    const nh = Number(el.naturalHeight) || 0;
    return el.complete !== false && nw > 0 && nh > 0 && nw <= DEFAULTS.spacerNaturalMax && nh <= DEFAULTS.spacerNaturalMax;
  }

  // Valor de un atributo lazy débil si debe tenerse en cuenta; '' si no: data:/blob:
  // o pathname con extensión de imagen siempre; otra URL http solo si src es placeholder.
  function weakLazyValue(el, name) {
    const v = attr(el, name);
    if (!v) return '';
    const u = abs(v, baseOf(el));
    if (!u) return '';
    if (urls.schemeKind(u) !== 'http') return v;
    let pathname = '';
    try { pathname = new URL(u).pathname; } catch (_) { return ''; }
    if (urls.isImageExtPath(pathname)) return v;
    return srcIsPlaceholder(el) ? v : '';
  }

  // Alguno de los atributos lazy presente y no vacío (los débiles, con su regla).
  function hasLazyAttr(el) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    for (const a of LAZY_ATTRS) if (attr(el, a)) return true;
    for (const a of LAZY_WEAK_ATTRS) if (weakLazyValue(el, a)) return true;
    return false;
  }

  // --- enlace a tamaño completo ---------------------------------------------

  // href absoluto del <a href> más cercano (el propio elemento cuenta como nivel 0),
  // hasta `max` niveles por encima, cruzando shadow roots; null si no hay.
  function closestAnchorHref(el, max) {
    const limit = Number.isInteger(max) && max >= 0 ? max : ANCHOR_DEPTH;
    let node = el;
    for (let depth = 0; node && depth <= limit; depth++) {
      if (tagOf(node) === 'A') {
        const href = abs(attr(node, 'href') || attrNS(node, XLINK_NS, 'href'), baseOf(node));
        if (href) return href;
      }
      node = parentOf(node);
    }
    return null;
  }

  // Enlace cuyo pathname parece imagen y no es la propia URL. Los que sirven HTML
  // (/wiki/File:X.jpg) los descarta después la guarda MIME de la descarga.
  function fullSizeHintFor(el, url) {
    const href = closestAnchorHref(el, ANCHOR_DEPTH);
    if (!href || urls.schemeKind(href) !== 'http' || href === url) return undefined;
    let pathname;
    try { pathname = new URL(href).pathname; } catch (_) { return undefined; }
    return urls.isImageExtPath(pathname) ? href : undefined;
  }

  // --- construcción de ImageRef ---------------------------------------------

  // ImageRef desde una URL ya absoluta (http/data/blob) y el elemento que la pinta.
  // extra: {rect, alt, nameHint}.
  function refFromUrl(url, el, extra) {
    const kind = urls.schemeKind(url);
    if (!kind || !el) return null;
    const x = extra || {};
    const rect = x.rect || rectOf(el);
    const id = elementIdOf(el);
    const alt = typeof x.alt === 'string' ? x.alt : altOf(el);
    const ref = {
      key: kind === 'blob' ? byteKey('blob', id) : kind + '|' + url,
      kind,
      url
    };
    const hint = fullSizeHintFor(el, url);
    if (hint) ref.fullSizeHint = hint;
    if (alt) ref.alt = alt;
    ref.name = names.buildBaseName({ url, alt: alt || x.nameHint || '' });
    ref.w = Math.round(rect.w);
    ref.h = Math.round(rect.h);
    ref.id = id;
    return ref;
  }

  // ImageRef de tipo byte (canvas/svg): sin url; los bytes se leen en este marco.
  function byteRef(kind, el, extra) {
    const x = extra || {};
    const rect = x.rect || rectOf(el);
    const id = elementIdOf(el);
    const alt = altOf(el);
    const ref = { key: byteKey(kind, id), kind };
    const hint = fullSizeHintFor(el, null);
    if (hint) ref.fullSizeHint = hint;
    if (alt) ref.alt = alt;
    ref.name = names.buildBaseName({ alt: alt || attr(el, 'id') });
    ref.w = Math.round(rect.w);
    ref.h = Math.round(rect.h);
    ref.id = id;
    return ref;
  }

  // --- <img> / <picture> ----------------------------------------------------

  function resolveImg(img, opts) {
    const th = thOf(opts);
    const base = baseOf(img);
    const rect = (opts && opts.rect) || rectOf(img);
    const rawSrc = attr(img, 'src');
    const currentSrc = abs(typeof img.currentSrc === 'string' ? img.currentSrc : '', base);

    // Candidatos (URL absoluta, sin duplicados; el orden decide los empates).
    const cands = [];
    const seen = new Set();
    const push = (c) => {
      if (!c) return;
      const u = abs(c.url, base);
      if (!u || seen.has(u)) return;
      seen.add(u);
      cands.push({ url: u, w: Number(c.w) || 0, x: typeof c.x === 'number' ? c.x : 1 });
    };
    const pushSrcset = (value) => {
      for (const c of urls.parseSrcset(value)) push(c);
    };

    // 1) <picture>: primero el <source> que eligió el navegador (su srcset contiene
    //    currentSrc); los demás pueden ser recortes art-directed o formatos no elegidos.
    const parent = img.parentNode;
    if (currentSrc && parent && tagOf(parent) === 'PICTURE') {
      for (const source of parent.children) {
        if (tagOf(source) !== 'SOURCE') continue;
        const list = urls.parseSrcset(attr(source, 'srcset'));
        if (list.some((c) => abs(c.url, base) === currentSrc)) {
          for (const c of list) push(c);
          break;
        }
      }
    }
    // 2) srcset propio.
    pushSrcset(attr(img, 'srcset'));
    // 3) Atributos lazy: srcsets y URLs sueltas (sin descriptor = 1x).
    for (const a of LAZY_SRCSET_ATTRS) pushSrcset(attr(img, a));
    for (const a of LAZY_SINGLE_ATTRS) {
      const v = attr(img, a);
      if (v) push({ url: v, w: 0, x: 1 });
    }
    for (const a of LAZY_WEAK_ATTRS) {
      const v = weakLazyValue(img, a);
      if (v) push({ url: v, w: 0, x: 1 });
    }

    // 4) ¿src es un placeholder? data: diminuta, natural <= 16 ya cargada, o LQIP
    //    (cargada con atributo lazy y natural muy por debajo del rect × DPR).
    const complete = img.complete !== false;
    const nw = Number(img.naturalWidth) || 0;
    const nh = Number(img.naturalHeight) || 0;
    const lazy = hasLazyAttr(img);
    const placeholder =
      urls.isTinyDataPlaceholder(rawSrc, th.placeholderDataMax) ||
      (complete && nw > 0 && nh > 0 && nw <= th.spacerNaturalMax && nh <= th.spacerNaturalMax) ||
      (complete && lazy && urls.isLqip({
        complete,
        naturalWidth: nw,
        rectWidth: rect.w,
        dpr: viewOf(img).devicePixelRatio || 1,
        hasLazyAttr: lazy
      }, th.lqipRatio));

    // 5) Mayor candidato; si no hay, currentSrc (Chromium da '' en lazy sin cargar) y
    //    luego el atributo src, salvo que sean placeholder. Nada → null.
    const best = urls.pickLargest(cands);
    let url = best ? best.url : null;
    if (!url && !placeholder) url = currentSrc || abs(rawSrc, base);
    if (!url) return null;
    return refFromUrl(url, img, { rect, alt: altOf(img) });
  }

  // --- <svg> inline ---------------------------------------------------------

  // <svg> raíz de un elemento SVG (recorriendo ownerSVGElement); null si no es SVG.
  function outermostSvg(el) {
    let node = isSvgEl(el) ? el : null;
    while (node && node.ownerSVGElement) node = node.ownerSVGElement;
    return node && tagOf(node) === 'SVG' ? node : null;
  }

  function svgImageHref(imageEl) {
    const v = attr(imageEl, 'href') || attrNS(imageEl, XLINK_NS, 'href') || attr(imageEl, 'xlink:href');
    return abs(v, baseOf(imageEl));
  }

  // <image> del <svg> raíz que contiene el punto (el último en orden de documento se
  // pinta encima); null si no hay o el punto no vale. detect lo usa para anclar el chip.
  function svgImageAt(svgRoot, point) {
    if (!svgRoot || !point || typeof point.x !== 'number' || typeof point.y !== 'number') return null;
    let images = [];
    try { images = svgRoot.querySelectorAll('image'); } catch (_) { return null; }
    let found = null;
    for (const im of images) if (rectContains(rectOf(im), point.x, point.y)) found = im;
    return found;
  }

  // opts.point = {x,y} (o opts.x/opts.y): el <image href> bajo el punto → http.
  function resolveSvg(el, opts) {
    const svgRoot = outermostSvg(el);
    if (!svgRoot) return null;
    const o = opts || {};
    const point = o.point || (typeof o.x === 'number' && typeof o.y === 'number' ? { x: o.x, y: o.y } : null);
    // Un <image href> bajo el punto (o el propio elemento si lo es) → su URL.
    const imageEl = (point && svgImageAt(svgRoot, point)) || (tagOf(el) === 'IMAGE' ? el : null);
    if (imageEl) {
      const href = svgImageHref(imageEl);
      if (href) {
        const ref = refFromUrl(href, imageEl, { rect: imageEl === el ? o.rect : undefined, alt: altOf(imageEl) || altOf(svgRoot) });
        if (ref) return ref;
      }
    }
    return byteRef('svg', svgRoot, { rect: o.rect && el === svgRoot ? o.rect : undefined });
  }

  // --- <video> --------------------------------------------------------------

  function resolveVideo(el, opts) {
    const th = thOf(opts);
    const base = baseOf(el);
    const poster = attr(el, 'poster');
    let url = null;
    if (poster && !urls.isTinyDataPlaceholder(poster, th.placeholderDataMax)) url = abs(poster, base);
    if (!url) url = abs(attr(el, 'data-poster'), base);
    return url ? refFromUrl(url, el, { rect: opts && opts.rect }) : null;
  }

  // --- fondos CSS -----------------------------------------------------------

  // Capas url() de cs.backgroundImage en orden de pintado (índice 0 = la de arriba)
  // como ImageRefs; sin capas, el fondo lazy data-bg-hidpi/data-bg. Con opts.includePseudo
  // añade ::before/::after (content:url() o su background-image), una lectura de estilo
  // cada uno. opts.limit corta al llegar a n refs. cs puede ser null (se lee aquí).
  // Acumulador de ImageRefs de un elemento: URLs crudas → refs sin duplicados, hasta limit.
  function refCollector(el, rect, limit) {
    const out = [];
    const base = baseOf(el);
    const seen = new Set();
    const add = (raw) => {
      if (out.length >= limit) return;
      const url = abs(raw, base);
      if (!url || seen.has(url)) return;
      seen.add(url);
      const ref = refFromUrl(url, el, { rect });
      if (ref) out.push(ref);
    };
    return { out, add };
  }

  // ImageRefs de un pseudoelemento ('::before'/'::after') a partir de su estilo pcs
  // (null → se lee aquí, una lectura). content:none/normal → no se genera ni pinta su
  // fondo → []. Si no: content:url() primero y, en su defecto, las capas de
  // background-image. opts = {rect, limit}. Única fuente de esta regla (detect delega).
  function pseudoRefs(el, pseudo, pcs, opts) {
    if (!el || el.nodeType !== 1) return [];
    const o = opts || {};
    const style = pcs || safeComputedStyle(el, pseudo);
    if (!style || /^(?:none|normal)$/i.test(String(style.content).trim())) return [];
    const { out, add } = refCollector(el, o.rect || rectOf(el), o.limit > 0 ? o.limit : Infinity);
    const url = urls.extractContentUrl(style.content);
    if (url) add(url);
    else for (const layer of urls.parseImageLayers(style.backgroundImage)) add(layer.url);
    return out;
  }

  function backgroundRefs(el, cs, opts) {
    if (!el || el.nodeType !== 1) return [];
    const o = opts || {};
    const limit = o.limit > 0 ? o.limit : Infinity;
    const rect = o.rect || rectOf(el);
    const { out, add } = refCollector(el, rect, limit);
    const style = cs || safeComputedStyle(el, null);
    if (style) for (const layer of urls.parseImageLayers(style.backgroundImage)) add(layer.url);
    if (!out.length) {
      const lazyBg = attr(el, 'data-bg-hidpi') || attr(el, 'data-bg');
      if (lazyBg) add(lazyBg);
    }
    if (o.includePseudo) {
      for (const pseudo of PSEUDOS) {
        if (out.length >= limit) break;
        for (const ref of pseudoRefs(el, pseudo, null, { rect, limit: limit - out.length })) {
          if (out.length >= limit) break;
          if (!out.some((r) => r.key === ref.key)) out.push(ref);
        }
      }
    }
    return out;
  }

  function resolveGeneric(el, opts) {
    const includePseudo = !(opts && opts.includePseudo === false);
    const refs = backgroundRefs(el, opts && opts.cs, { includePseudo, limit: 1, rect: opts && opts.rect });
    return refs.length ? refs[0] : null;
  }

  // --- entrada --------------------------------------------------------------

  // opts = {mode:'hover'|'select', point?:{x,y}, rect?, cs?, includePseudo?, t?}
  function resolveImageRef(el, opts) {
    try {
      if (!el || el.nodeType !== 1) return null;
      if (isSvgEl(el)) return resolveSvg(el, opts);
      switch (tagOf(el)) {
        case 'IMG':
          return resolveImg(el, opts);
        case 'PICTURE': {
          const img = el.querySelector('img');
          return img ? resolveImg(img, opts) : null;
        }
        case 'CANVAS':
          return byteRef('canvas', el, { rect: opts && opts.rect });
        case 'VIDEO':
          return resolveVideo(el, opts);
        case 'INPUT': {
          // <input type=image src>
          if (attr(el, 'type').toLowerCase() !== 'image') return resolveGeneric(el, opts);
          const url = abs(attr(el, 'src'), baseOf(el));
          return url ? refFromUrl(url, el, { rect: opts && opts.rect }) : null;
        }
        case 'IFRAME':
        case 'FRAME':
          return null; // lo resuelve la instancia de ese marco
        default:
          return resolveGeneric(el, opts);
      }
    } catch (_) {
      return null;
    }
  }

  const api = {
    resolveImageRef,
    backgroundRefs,
    elementIdOf,
    hasLazyAttr,
    // auxiliares públicos (detect/selection pueden reutilizarlos)
    pseudoRefs,
    svgImageAt,
    refFromUrl,
    closestAnchorHref,
    outermostSvg,
    frameInstanceId,
    _state: state
  };

  root.ImgDL = root.ImgDL || {};
  root.ImgDL.resolve = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
