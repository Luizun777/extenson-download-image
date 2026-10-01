'use strict';
// Hit-test del hover: elementsFromPoint + expansión de shadow roots + fallback
// geométrico (pointer-events:none). Sin estado salvo el presupuesto por llamada.
// hitTest nunca lanza: todo acceso al DOM va en try/catch.
(function (root) {
  const ImgDL = root.ImgDL || (root.ImgDL = {});
  const urls = ImgDL.urls;
  const thresholds = ImgDL.thresholds;
  const DEFAULTS = (thresholds && thresholds.DEFAULTS) || {};

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HOST_TAG = 'imgdl-root';
  const MAX_SHADOW_QUERIES = 3;            // ShadowRoot.elementsFromPoint por llamada
  const MAX_GEO_SCANNED = 200;             // nodos (lecturas de rect) del fallback por llamada
  const FRAME_TAGS = new Set(['iframe', 'frame', 'object', 'embed']);
  const MEDIA_TAGS = new Set(['img', 'canvas', 'video']);
  const GEO_SELECTOR = 'img,svg,canvas,video[poster],video[data-poster]';
  const PSEUDOS = ['::before', '::after'];
  // Centinela: el puntero está sobre nuestra UI; el controlador conserva el objetivo.
  const KEEP = Object.freeze({ keep: true });

  // resolve.js se inyecta antes que este módulo; se lee en cada llamada para no
  // depender del orden de carga en los tests.
  function resolver() {
    return ImgDL.resolve || null;
  }

  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }

  // Un objeto parcial se fusiona con DEFAULTS (misma regla que thresholds).
  function mergeT(t) {
    return t && t !== DEFAULTS ? Object.assign({}, DEFAULTS, t) : DEFAULTS;
  }

  // Presupuesto de una llamada a hitTest. Exportado para tests.
  function newBudget(t) {
    const th = mergeT(t);
    return {
      styleReads: 0,
      maxStyleReads: th.maxStyleReads || 6,
      shadowQueries: 0,
      maxShadowQueries: MAX_SHADOW_QUERIES,
      queries: 0,
      maxQueries: th.geoAncestors || 5,
      candidates: 0,
      maxCandidates: th.geoCandidates || 50,
      scanned: 0,
      maxScanned: th.geoScanned || MAX_GEO_SCANNED,
      maxStack: th.maxStack || 12,
      maxShadowDepth: th.maxShadowDepth || 3
    };
  }

  // --- Rects (px CSS del viewport) ------------------------------------------

  function toRect(x, y, w, h) {
    return { x, y, w, h, left: x, top: y, right: x + w, bottom: y + h };
  }

  // Acepta {x,y,w,h} o un DOMRect ({left,top,width,height}).
  function norm(rect) {
    if (!rect || typeof rect !== 'object') return toRect(0, 0, 0, 0);
    const x = num(rect.x !== undefined ? rect.x : rect.left);
    const y = num(rect.y !== undefined ? rect.y : rect.top);
    const w = num(rect.w !== undefined ? rect.w : rect.width);
    const h = num(rect.h !== undefined ? rect.h : rect.height);
    return toRect(x, y, w, h);
  }

  function rectOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return toRect(num(r.left), num(r.top), num(r.width), num(r.height));
    } catch (_) {
      return toRect(0, 0, 0, 0);
    }
  }

  function rectContains(rect, x, y, margin) {
    const r = norm(rect);
    const m = num(margin);
    return x >= r.x - m && x <= r.x + r.w + m && y >= r.y - m && y <= r.y + r.h + m;
  }

  function inflate(rect, margin) {
    const r = norm(rect);
    const m = num(margin);
    return toRect(r.x - m, r.y - m, r.w + 2 * m, r.h + 2 * m);
  }

  // --- Árbol -----------------------------------------------------------------

  function tagOf(el) {
    try {
      return el && typeof el.localName === 'string' ? el.localName.toLowerCase() : '';
    } catch (_) {
      return '';
    }
  }

  function isSvgEl(el) {
    try {
      return !!el && el.namespaceURI === SVG_NS;
    } catch (_) {
      return false;
    }
  }

  // <svg> raíz más externo que contiene a el (ownerSVGElement); null si no es SVG.
  function outermostSvg(el) {
    let cur = el;
    let last = null;
    let guard = 0;
    while (cur && guard++ < 64) {
      if (isSvgEl(cur) && tagOf(cur) === 'svg') last = cur;
      try { cur = cur.ownerSVGElement || null; } catch (_) { cur = null; }
    }
    return last;
  }

  // Padre cruzando límites de shadow DOM: parentElement o el host del root.
  function parentOf(el) {
    try {
      if (el.parentElement) return el.parentElement;
      const r = el.getRootNode();
      return r && r.host ? r.host : null;
    } catch (_) {
      return null;
    }
  }

  // [el, padre, abuelo, …] con `max` elementos como máximo (el propio incluido).
  function parentChain(el, max) {
    const out = [];
    const n = typeof max === 'number' && max > 0 ? max : 5;
    const seen = new Set();
    let cur = el;
    while (cur && out.length < n && !seen.has(cur)) {
      seen.add(cur);
      out.push(cur);
      cur = parentOf(cur);
    }
    return out;
  }

  // Shadow root abierto o (en la extensión) cerrado; null si no hay o no se puede.
  function shadowRootOf(el) {
    try {
      if (!el || el.nodeType !== 1) return null;
      if (el.shadowRoot) return el.shadowRoot;
      if (typeof chrome !== 'undefined' && chrome.dom && typeof chrome.dom.openOrClosedShadowRoot === 'function') {
        return chrome.dom.openOrClosedShadowRoot(el) || null;
      }
    } catch (_) {
      // Host sin shadow o API no disponible en este contexto.
    }
    return null;
  }

  // Expande cada host con shadow root: inserta ANTES del host los elementos de
  // root.elementsFromPoint(x,y) que pertenecen a ese root (sin duplicados),
  // recursivamente hasta `depth`. Máximo 3 consultas de shadow y 12 entradas.
  function expandStack(stack, x, y, depth, budget) {
    const b = budget || newBudget();
    const seen = new Set();
    const out = [];
    const d = typeof depth === 'number' ? depth : b.maxShadowDepth;

    function visit(list, level) {
      for (const el of list) {
        if (out.length >= b.maxStack) return;
        if (!el || seen.has(el)) continue;
        if (level > 0 && b.shadowQueries < b.maxShadowQueries) {
          const sr = shadowRootOf(el);
          if (sr && typeof sr.elementsFromPoint === 'function') {
            b.shadowQueries++;
            let inner = [];
            try { inner = sr.elementsFromPoint(x, y) || []; } catch (_) { inner = []; }
            const own = [];
            for (const e of inner) {
              try {
                if (e && e.getRootNode() === sr && !seen.has(e)) own.push(e);
              } catch (_) {
                // Nodo sin getRootNode: se ignora.
              }
            }
            visit(own, level - 1);
            if (out.length >= b.maxStack) return;
          }
        }
        seen.add(el);
        out.push(el);
      }
    }

    let list = [];
    try { list = Array.from(stack || []); } catch (_) { list = []; }
    visit(list, d);
    return out.slice(0, b.maxStack);
  }

  // getComputedStyle con presupuesto por llamada: null si se agotó o falla.
  function safeComputedStyle(el, pseudo, budget) {
    if (budget) {
      if (budget.styleReads >= budget.maxStyleReads) return null;
      budget.styleReads++;
    }
    try {
      return root.getComputedStyle(el, pseudo || null);
    } catch (_) {
      return null;
    }
  }

  // Elemento modal del top layer (<dialog> showModal / fullscreen) o null.
  function isModalPresent() {
    try {
      return document.querySelector(':modal');
    } catch (_) {
      return null;
    }
  }

  // href absoluto sin fragmento del <a> más cercano (el propio o hasta `max`
  // ancestros, cruzando shadow DOM); solo http(s)/data/blob. null si no hay.
  // Delega en resolve.closestAnchorHref (mismo valor canónico que fullSizeHint).
  function closestAnchorHref(el, max) {
    const res = resolver();
    if (res && typeof res.closestAnchorHref === 'function') {
      try { return res.closestAnchorHref(el, max) || null; } catch (_) { return null; }
    }
    const n = typeof max === 'number' && max > 0 ? max : 6;
    const chain = parentChain(el, n + 1);
    let base = '';
    try { base = document.baseURI || ''; } catch (_) { base = ''; }
    for (const a of chain) {
      if (tagOf(a) !== 'a') continue;
      let href = null;
      try {
        if (typeof a.href === 'string') href = a.href;                       // HTML
        else if (a.href && typeof a.href.baseVal === 'string') href = a.href.baseVal; // SVG
      } catch (_) {
        href = null;
      }
      if (!href) continue;
      const abs = urls ? urls.resolveUrl(href, base) : href;
      if (abs) return urls ? urls.stripHash(abs) : abs;
    }
    return null;
  }

  // Un <img> dentro de <details> cerrado conserva rect no nulo pero no se ve.
  function isRendered(el) {
    try {
      return typeof el.checkVisibility === 'function' ? el.checkVisibility() : true;
    } catch (_) {
      return true;
    }
  }

  // --- Candidatos ------------------------------------------------------------

  function classify(facts, t) {
    try {
      return thresholds.classifyFacts(facts, 'hover', t);
    } catch (_) {
      return { accept: false, reason: 'error' };
    }
  }

  function makeRef(res, el, opts) {
    try {
      return res.resolveImageRef(el, opts) || null;
    } catch (_) {
      return null;
    }
  }

  // Fondo del propio elemento (capa superior); el rect ya leído evita otra lectura.
  function refsFrom(res, el, cs, rect) {
    try {
      const r = res.backgroundRefs(el, cs, { rect, limit: 1 });
      return Array.isArray(r) ? r : [];
    } catch (_) {
      return [];
    }
  }

  // Imagen de un pseudoelemento: la regla (content:none, content:url() antes que
  // background-image) vive en resolve.pseudoRefs; sin ella no se ofrecen pseudos.
  function pseudoRefsFrom(res, el, pseudo, pcs, rect) {
    if (typeof res.pseudoRefs !== 'function') return [];
    try {
      const r = res.pseudoRefs(el, pseudo, pcs, { rect, limit: 1 });
      return Array.isArray(r) ? r : [];
    } catch (_) {
      return [];
    }
  }

  function px(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  // Caja pintada de un pseudoelemento: tamaño de pcs.width/height (+ padding y borde
  // si no es border-box) cuando resuelven a px; posición exacta solo si es absoluto
  // respecto al propio elemento (cs.position no estático), sin transform y con
  // left/top en px. Si no → el rect del elemento, exact:false.
  function pseudoBox(rect, cs, pcs) {
    let w = null;
    let h = null;
    let exact = false;
    let x = rect.x;
    let y = rect.y;
    try {
      w = px(pcs.width);
      h = px(pcs.height);
      if (w === null || h === null || w <= 0 || h <= 0) return { rect, exact };
      if (pcs.boxSizing !== 'border-box') {
        w += (px(pcs.paddingLeft) || 0) + (px(pcs.paddingRight) || 0) + (px(pcs.borderLeftWidth) || 0) + (px(pcs.borderRightWidth) || 0);
        h += (px(pcs.paddingTop) || 0) + (px(pcs.paddingBottom) || 0) + (px(pcs.borderTopWidth) || 0) + (px(pcs.borderBottomWidth) || 0);
      }
      const tf = pcs.transform;
      if (pcs.position === 'absolute' && cs && cs.position !== 'static' && (!tf || tf === 'none')) {
        const l = px(pcs.left);
        const tp = px(pcs.top);
        if (l !== null && tp !== null) {
          x = rect.x + (px(cs.borderLeftWidth) || 0) + (px(pcs.marginLeft) || 0) + l;
          y = rect.y + (px(cs.borderTopWidth) || 0) + (px(pcs.marginTop) || 0) + tp;
          exact = true;
        }
      }
    } catch (_) {
      return { rect, exact: false };
    }
    return { rect: toRect(x, y, w, h), exact };
  }

  function imgFacts(img, rect, res) {
    let complete = true;
    let nw = 0;
    let nh = 0;
    try {
      complete = img.complete !== false;
      nw = num(img.naturalWidth);
      nh = num(img.naturalHeight);
    } catch (_) {
      complete = true;
    }
    let lazy = false;
    try {
      lazy = !!(res && typeof res.hasLazyAttr === 'function' && res.hasLazyAttr(img));
    } catch (_) {
      lazy = false;
    }
    return {
      tag: 'img',
      rect: { w: rect.w, h: rect.h },
      natural: complete ? { w: nw, h: nh } : null,
      complete,
      isSvgRoot: false,
      hasLazyAttr: lazy
    };
  }

  function plainFacts(tag, rect, isSvgRoot) {
    return { tag, rect: { w: rect.w, h: rect.h }, natural: null, complete: true, isSvgRoot: !!isSvgRoot, hasLazyAttr: false };
  }

  // <image> del <svg> bajo el punto: el propio `el` si lo es (viene de
  // elementsFromPoint, ya contiene el punto) o, si no, el que diga resolve.
  function svgImageAt(res, el, svg, x, y) {
    if (tagOf(el) === 'image') return el;
    if (typeof res.svgImageAt !== 'function') return null;
    try { return res.svgImageAt(svg, { x, y }) || null; } catch (_) { return null; }
  }

  // img / svg / canvas / video → {el, ref, rect} | null. Para SVG el objetivo es
  // el <svg> raíz más externo, salvo que haya un <image href> bajo el punto: entonces
  // el chip se ancla a ese raster y la ref es http. `known` = rect ya leído (fallback).
  function evalMedia(el, x, y, t, res, known) {
    const point = { x, y };
    if (isSvgEl(el)) {
      const svg = outermostSvg(el);
      if (!svg) return null;
      const rect = known || rectOf(svg);
      if (!classify(plainFacts('svg', rect, true), t).accept) return null;
      const im = svgImageAt(res, el, svg, x, y);
      if (im) {
        const irect = rectOf(im);
        const ref = makeRef(res, im, { point, rect: irect, t, mode: 'hover' });
        if (ref && ref.kind !== 'svg') return { el: im, ref, rect: irect };
      }
      const ref = makeRef(res, svg, { rect, t, mode: 'hover' });
      return ref ? { el: svg, ref, rect } : null;
    }
    const tag = tagOf(el);
    if (tag === 'img') {
      const rect = known || rectOf(el);
      if (!classify(imgFacts(el, rect, res), t).accept) return null;
      const ref = makeRef(res, el, { point, rect, t, mode: 'hover' });
      return ref ? { el, ref, rect } : null;
    }
    if (tag === 'canvas' || tag === 'video') {
      if (tag === 'video') {
        let poster = '';
        try { poster = el.poster || el.getAttribute('data-poster') || ''; } catch (_) { poster = ''; }
        if (!poster) return null;
      }
      const rect = known || rectOf(el);
      if (!classify(plainFacts(tag, rect, false), t).accept) return null;
      const ref = makeRef(res, el, { point, rect, t, mode: 'hover' });
      return ref ? { el, ref, rect } : null;
    }
    return null;
  }

  // Fondo CSS del elemento y de sus ::before/::after (1–3 lecturas de estilo).
  // Un pseudo se juzga por su propia caja: tamaño (hoverMin) y, si su posición es
  // exacta, solo cuando contiene el punto; entonces el rect devuelto es el suyo.
  function evalBackground(el, rect, x, y, t, res, budget) {
    const cs = safeComputedStyle(el, null, budget);
    if (!cs) return null;
    const refs = refsFrom(res, el, cs, rect);
    if (refs.length) return { el, ref: refs[0], rect };
    for (const pseudo of PSEUDOS) {
      const pcs = safeComputedStyle(el, pseudo, budget);
      if (!pcs) break; // presupuesto agotado
      const box = pseudoBox(rect, cs, pcs);
      if (box.exact && !rectContains(box.rect, x, y, 0)) continue; // no está bajo el puntero
      if (!classify(plainFacts('pseudo', box.rect, false), t).accept) continue;
      const prefs = pseudoRefsFrom(res, el, pseudo, pcs, box.rect);
      if (prefs.length) return { el, ref: prefs[0], rect: box.exact ? box.rect : rect };
    }
    return null;
  }

  // Fallback geométrico: pointer-events:none no aparece en elementsFromPoint.
  // Hasta 5 querySelectorAll (base + ancestros), 200 nodos leídos (1 rect cada
  // uno) y 50 candidatos (los que contienen el punto: checkVisibility + evalMedia);
  // el rect más pequeño que contiene el punto gana.
  function geoFallback(base, x, y, t, res, budget) {
    const chain = parentChain(base, budget.maxQueries);
    const seen = new Set();
    let best = null;
    const exhausted = () => budget.scanned >= budget.maxScanned || budget.candidates >= budget.maxCandidates;
    for (const a of chain) {
      if (budget.queries >= budget.maxQueries || exhausted()) break;
      budget.queries++;
      let list = [];
      try { list = a.querySelectorAll(GEO_SELECTOR); } catch (_) { list = []; }
      for (const cand of list) {
        if (exhausted()) break;
        let el = cand;
        if (isSvgEl(cand)) el = outermostSvg(cand);
        if (!el || seen.has(el)) continue;
        seen.add(el);
        budget.scanned++;
        const rect = rectOf(el);
        if (!rectContains(rect, x, y, 0)) continue; // no cuenta como candidato
        budget.candidates++;
        if (!isRendered(el)) continue;
        const hit = evalMedia(el, x, y, t, res, rect);
        if (!hit) continue;
        const area = hit.rect.w * hit.rect.h;
        if (!best || area < best.area) best = { hit, area };
      }
    }
    return best ? best.hit : null;
  }

  // --- hitTest ---------------------------------------------------------------

  function hitTestInner(x, y, ctx) {
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const t = mergeT(c.t);

    // 1) Sobre nuestra UI: conservar el objetivo actual.
    let onUi = null;
    if (typeof c.isPointerOnUi === 'function') onUi = c.isPointerOnUi;
    else if (c.overlay && typeof c.overlay.isPointerOnUi === 'function') onUi = (px, py) => c.overlay.isPointerOnUi(px, py);
    if (onUi) {
      try { if (onUi(x, y)) return KEEP; } catch (_) { /* UI sin rects aún */ }
    }

    const res = resolver();
    if (!res) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    try {
      if (x < 0 || y < 0 || x > root.innerWidth || y > root.innerHeight) return null;
    } catch (_) {
      // Sin viewport medible: se sigue igualmente.
    }

    const hostEl = c.hostEl || (c.overlay && c.overlay.host) || null;
    const budget = newBudget(t);

    // 3) Pila: 1 elementsFromPoint del documento, sin nuestro host, con shadows.
    let raw = [];
    try { raw = document.elementsFromPoint(x, y) || []; } catch (_) { raw = []; }
    const base = [];
    for (const e of raw) {
      if (e && e !== hostEl && tagOf(e) !== HOST_TAG) base.push(e);
    }
    const stack = expandStack(base, x, y, budget.maxShadowDepth, budget);

    // 4) Recorrido de arriba abajo.
    let body = null;
    let html = null;
    try { body = document.body; html = document.documentElement; } catch (_) { /* nada */ }
    for (const el of stack) {
      if (el === body || el === html) break;
      if (!isRendered(el)) continue;
      let target = el;
      let tag = tagOf(el);
      if (tag === 'picture') {
        try { target = el.querySelector('img'); } catch (_) { target = null; }
        if (!target) continue;
        tag = 'img';
      }
      if (MEDIA_TAGS.has(tag) || isSvgEl(target)) {
        const hit = evalMedia(target, x, y, t, res);
        if (hit) return hit;
        continue; // pixel, spacer, small, svg-small, sin URL…
      }
      // Otro marco: su propia instancia se encarga; nunca se cruza.
      if (FRAME_TAGS.has(tag)) return null;
      // Otro elemento: fondos CSS y pseudoelementos, con presupuesto de estilos.
      const rect = rectOf(el);
      if (rect.w < t.hoverMin || rect.h < t.hoverMin) continue;
      if (budget.styleReads >= budget.maxStyleReads) continue;
      const hit = evalBackground(el, rect, x, y, t, res, budget);
      if (hit) return hit;
    }

    // 5) Nada aceptado: fallback geométrico.
    const start = stack.length ? stack[0] : body;
    if (!start) return null;
    return geoFallback(start, x, y, t, res, budget);
  }

  // → {el, ref, rect} | KEEP ({keep:true}, puntero sobre nuestra UI) | null.
  // ctx = {isPointerOnUi(x,y), hostEl, t}. Nunca lanza.
  function hitTest(x, y, ctx) {
    try {
      return hitTestInner(x, y, ctx);
    } catch (_) {
      return null;
    }
  }

  const dom = {
    rectOf,
    rectContains,
    inflate,
    outermostSvg,
    parentChain,
    shadowRootOf,
    expandStack,
    safeComputedStyle,
    isModalPresent,
    closestAnchorHref,
    isRendered,
    newBudget
  };

  const api = { hitTest, KEEP, dom };

  root.ImgDL = root.ImgDL || {};
  root.ImgDL.detect = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
