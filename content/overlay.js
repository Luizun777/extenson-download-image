'use strict';
// Overlay del content script: host <imgdl-root> + shadow root CERRADO + capa
// div[popover=manual] en el top layer (fallback: position:fixed + z-index máximo).
// Chip [seleccionar][descargar], badges y anillos de selección, barra de acciones
// (solo marco principal; role=toolbar con el patrón APG: una sola parada de Tab,
// tabindex itinerante y flechas/Inicio/Fin entre sus botones), toasts,
// posicionamiento en un rAF (leer, luego escribir),
// aislamiento de eventos en el shadow root, vigilancia del top layer (dialog modal
// y fullscreen) y guardia contra páginas que eliminan o mueven el host.
// Reglas CSP: <style> con textContent fijado ANTES de insertarlo, estilos del host
// con style.setProperty, sin innerHTML, sin url(), sin fuentes; iconos SVG con
// createElementNS. Todo texto visible sale de ImgDL.strings.
(function (root) {
  const ImgDL = root.ImgDL || (root.ImgDL = {});
  const S = ImgDL.strings || {};
  const DEFAULTS = (ImgDL.thresholds && ImgDL.thresholds.DEFAULTS) || {};

  const HOST_TAG = 'imgdl-root';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CELL = 32;                 // cada celda del chip (WCAG 2.5.8: >= 24, preferido 32)
  const CHIP_W = CELL * 2 + 2;     // 66: dos celdas + borde de 1 px por lado
  const CHIP_H = CELL + 2;         // 34
  const CHIP_INSET = 4;            // separación respecto a la esquina de la imagen
  const BADGE_SIZE = 22;
  const TOAST_MAX = 5;
  const TOAST_MS = { info: 4000, success: 4000, warn: 6000, error: 8000 };
  const GUARD_THROTTLE_MS = 500;
  const GUARD_WINDOW_MS = 60000;
  const GUARD_MAX = 20;
  const STOP_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchend'];
  const LEVELS = ['info', 'success', 'warn', 'error'];
  const LIVE_MS = 150;             // ventana de coalescencia de la región aria-live

  // Estilos inline del host con !important: CSSOM, nunca bloqueado por la CSP.
  const HOST_STYLE = {
    all: 'initial',
    display: 'block',
    position: 'fixed',
    left: '0',
    top: '0',
    width: '0',
    height: '0',
    overflow: 'visible',
    'z-index': '2147483647',
    'pointer-events': 'none',
    contain: 'layout style'
  };

  // :host con all:initial y las props de layout re-declaradas DESPUÉS con !important:
  // el !important del contexto interno gana a las reglas !important de la página y
  // al propio atributo style del host (verdict overlay-cascade-host-isolation).
  // Variables con prefijo --imgdl- (all no las reinicia y las de la página heredan).
  const CSS = [
    ':host{all:initial !important;display:block !important;position:fixed !important;left:0 !important;top:0 !important;width:0 !important;height:0 !important;overflow:visible !important;z-index:2147483647 !important;pointer-events:none !important;contain:layout style !important}',
    '.layer{--imgdl-bg:rgba(17,17,17,.92);--imgdl-fg:#fff;--imgdl-ring:rgba(255,255,255,.9);--imgdl-accent:#1a73e8;--imgdl-warn:#ffd666;--imgdl-error:#ff6b6b;--imgdl-ok:#5cd65c;position:fixed;inset:0;width:auto;height:auto;max-width:none;max-height:none;margin:0;border:0;padding:0;background:transparent;overflow:visible;pointer-events:none;color-scheme:light;font:13px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff;box-sizing:border-box;text-align:left;direction:ltr;white-space:normal;letter-spacing:normal;word-spacing:normal;text-transform:none}',
    '.layer.fixed-fallback{display:block;z-index:2147483647}',
    '.ui{pointer-events:auto;background:var(--imgdl-bg);color:var(--imgdl-fg);border:1px solid var(--imgdl-ring);box-shadow:0 1px 4px rgba(0,0,0,.5);border-radius:6px;box-sizing:border-box}',
    '.chip,.badge,.ring,.bar{position:absolute;left:0;top:0}',
    '.chip{display:flex;padding:0;overflow:hidden;will-change:transform}',
    '.cell{position:relative;flex:none;width:' + CELL + 'px;height:' + CELL + 'px;display:flex;align-items:center;justify-content:center;margin:0;padding:0;border:0;border-radius:0;background:transparent;color:inherit;font:inherit;cursor:pointer;appearance:none;-webkit-appearance:none}',
    '.cell+.cell{box-shadow:-1px 0 0 rgba(255,255,255,.35)}',
    '.cell:hover{background:rgba(255,255,255,.15)}',
    '.cell svg{display:block;pointer-events:none}',
    '.box{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;border-radius:0;background:transparent;appearance:none;-webkit-appearance:none;cursor:pointer}',
    '.mark{display:none}',
    '.box:checked~svg .mark{display:inline}',
    '.box:checked~svg .frame{fill:var(--imgdl-accent);stroke:var(--imgdl-accent)}',
    // Anillo de foco bicolor (blanco + acento): visible sobre cualquier imagen. El outline
    // transparente existe para forced-colors, donde pasa a color de sistema y las sombras desaparecen.
    '.box:focus-visible,.dl:focus-visible{outline:2px solid transparent;outline-offset:-4px;box-shadow:inset 0 0 0 2px #fff,inset 0 0 0 4px var(--imgdl-accent)}',
    '.bar button:focus-visible,.toast button:focus-visible{outline:2px solid transparent;outline-offset:2px;box-shadow:0 0 0 2px #fff,0 0 0 4px var(--imgdl-accent)}',
    // Región aria-live oculta visualmente (nunca display:none: los lectores la ignorarían).
    '.live{position:absolute;left:0;top:0;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;pointer-events:none}',
    '.badges{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none}',
    '.ring{pointer-events:none;outline:2px solid var(--imgdl-accent);outline-offset:-2px;box-shadow:inset 0 0 0 4px rgba(255,255,255,.85);border-radius:2px;will-change:transform}',
    '.badge{width:' + BADGE_SIZE + 'px;height:' + BADGE_SIZE + 'px;display:flex;align-items:center;justify-content:center;pointer-events:none;border-radius:50%;background:var(--imgdl-accent);will-change:transform}',
    '.badge svg{display:block}',
    '.bar{left:50%;top:auto;bottom:16px;transform:translateX(-50%);display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px;padding:8px 12px;max-width:calc(100vw - 32px)}',
    '.bar .count{font-weight:600;padding:0 4px;white-space:nowrap}',
    '.bar button,.toast button{appearance:none;-webkit-appearance:none;margin:0;padding:6px 10px;min-height:32px;border:1px solid rgba(255,255,255,.6);border-radius:4px;background:rgba(255,255,255,.1);color:inherit;font:inherit;cursor:pointer;white-space:nowrap}',
    '.bar button:hover,.toast button:hover{background:rgba(255,255,255,.22)}',
    '.bar button:disabled{opacity:.5;cursor:default}',
    '.bar .primary{background:var(--imgdl-accent);border-color:var(--imgdl-accent)}',
    '.bar .primary:hover{background:#2b7de9}',
    '.progress{flex:1 0 100%;text-align:center;min-height:1.2em;opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.progress:empty{display:none}',
    '.confirm{display:flex;flex:1 0 100%;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px;color:var(--imgdl-warn)}',
    '.toasts{position:absolute;right:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;max-width:min(380px,calc(100vw - 32px))}',
    '.toast{position:relative;display:flex;align-items:center;gap:10px;padding:10px 12px;max-width:100%;overflow-wrap:anywhere;transition:opacity .15s ease}',
    '.toast.warn{border-color:var(--imgdl-warn)}',
    '.toast.error{border-color:var(--imgdl-error)}',
    '.toast.success{border-color:var(--imgdl-ok)}',
    '.toast .text{flex:1 1 auto}',
    '[hidden]{display:none !important}',
    // Alto contraste: colores de sistema y bordes reales (las sombras y los fondos
    // semitransparentes desaparecen en forced-colors).
    '@media (forced-colors:active){' +
      '.ui,.bar button,.toast button,.ring,.badge{forced-color-adjust:none}' +
      '.ui,.bar button,.toast button{background:ButtonFace;color:ButtonText;border:1px solid ButtonText;box-shadow:none}' +
      '.cell+.cell{box-shadow:none;border-left:1px solid ButtonText}' +
      '.cell:hover,.bar button:hover,.toast button:hover{background:Highlight;color:HighlightText}' +
      '.bar .primary{background:Highlight;color:HighlightText;border-color:Highlight}' +
      '.bar button:disabled{opacity:1;color:GrayText;border-color:GrayText;background:ButtonFace}' +
      '.ring{outline:2px solid Highlight;box-shadow:inset 0 0 0 4px Canvas}' +
      '.box:checked~svg .frame{fill:Highlight;stroke:Highlight}' +
      '.badge{background:Highlight;color:HighlightText;border:1px solid ButtonText}' +
      '.box:focus-visible,.dl:focus-visible,.bar button:focus-visible,.toast button:focus-visible{outline:2px solid Highlight;box-shadow:none}' +
    '}',
    '@media (prefers-reduced-motion:reduce){*{transition:none !important;animation:none !important}}'
  ].join('\n');

  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }

  function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), Math.max(lo, hi));
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  // Acepta DOMRect ({x,y,width,height} o left/top) y {x,y,w,h}.
  function normRect(r) {
    if (!r || typeof r !== 'object') return null;
    const x = num(r.x !== undefined ? r.x : r.left);
    const y = num(r.y !== undefined ? r.y : r.top);
    const w = num(r.w !== undefined ? r.w : r.width);
    const h = num(r.h !== undefined ? r.h : r.height);
    return { x, y, w, h };
  }

  function rectOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return { x: round2(r.x), y: round2(r.y), w: round2(r.width), h: round2(r.height) };
    } catch (_) {
      return null;
    }
  }

  function contains(rect, x, y, margin) {
    if (!rect) return false;
    const m = num(margin);
    return x >= rect.x - m && x <= rect.x + rect.w + m && y >= rect.y - m && y <= rect.y + rect.h + m;
  }

  // Viewport de layout (sin barras de scroll): el bloque contenedor de position:fixed.
  function viewport() {
    const d = document.documentElement;
    return {
      vw: (d && d.clientWidth) || window.innerWidth || 0,
      vh: (d && d.clientHeight) || window.innerHeight || 0
    };
  }

  function txt(key, fallback) {
    return typeof S[key] === 'string' ? S[key] : (fallback || '');
  }

  function fmt(key, args, fallback) {
    if (typeof S[key] === 'function') {
      try { return String(S[key](...args)); } catch (_) { /* cae al fallback */ }
    }
    return fallback || '';
  }

  function isModalPresent() {
    try { return document.querySelector(':modal'); } catch (_) { return null; }
  }

  function el(tag, cls, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
    return e;
  }

  // Icono SVG inline (sin url(), sin innerHTML).
  function svgIcon(size, children, strokeWidth) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size));
    s.setAttribute('height', String(size));
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', String(strokeWidth || 2));
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    for (const c of children) {
      const n = document.createElementNS(SVG_NS, c.tag);
      for (const k of Object.keys(c.attrs)) n.setAttribute(k, c.attrs[k]);
      s.append(n);
    }
    return s;
  }

  function iconDownload() {
    return svgIcon(18, [
      { tag: 'path', attrs: { d: 'M12 4v11' } },
      { tag: 'path', attrs: { d: 'M7 10l5 5 5-5' } },
      { tag: 'path', attrs: { d: 'M4 19h16' } }
    ]);
  }

  function iconCheckbox() {
    return svgIcon(18, [
      { tag: 'rect', attrs: { class: 'frame', x: '4', y: '4', width: '16', height: '16', rx: '3' } },
      { tag: 'path', attrs: { class: 'mark', d: 'M8 12.5l2.8 2.8 5.7-6.3' } }
    ]);
  }

  function iconCheck() {
    return svgIcon(14, [{ tag: 'path', attrs: { d: 'M5 12l5 5L19 7' } }], 3);
  }

  function createOverlay(opts) {
    const o = opts || {};
    const outerSignal = o.signal || null;
    const callbacks = o.callbacks || {};
    const t = o.t && o.t !== DEFAULTS ? Object.assign({}, DEFAULTS, o.t) : DEFAULTS;
    const badgeCap = t.badgeCap || 300;
    const rectMargin = typeof t.rectMargin === 'number' ? t.rectMargin : 8;
    // Guardia del host (sobreescribible en tests).
    const guardThrottleMs = t.guardThrottleMs || GUARD_THROTTLE_MS;
    const guardWindowMs = t.guardWindowMs || GUARD_WINDOW_MS;
    const guardMax = t.guardMax || GUARD_MAX;
    const isTopFrame = typeof o.isTopFrame === 'boolean' ? o.isTopFrame : (function () {
      try { return window.self === window.top; } catch (_) { return false; }
    })();

    // Estado del DOM del overlay (null cuando no está montado).
    let host = null;
    let shadow = null;
    let layer = null;
    let chip = null;
    let selBox = null;
    let dlBtn = null;
    let badgesBox = null;
    let bar = null;
    let barParts = null;
    let toastsBox = null;
    let live = null;          // región aria-live (una por marco)
    let liveTimer = 0;        // anuncios coalescidos (LIVE_MS)
    let livePending = null;
    let lastCountAnnounced = -1;
    let mounted = false;
    let ac = null;            // AbortController interno: listeners de este montaje
    let topMo = null;         // vigilancia de dialog[open]
    let guardMo = null;       // guardia del host
    let raf = 0;              // layout pendiente
    let topRaf = 0;           // sincronización del top layer pendiente
    let dirty = false;
    let guardTimer = 0;
    let guardTimes = [];
    let guardDead = false;
    let lastReadd = 0;
    const timers = new Set();
    const badgeMap = new Map(); // key -> {ring, badge, el, rect}

    // Chip.
    let chipVisible = false;
    let chipRef = null;
    let chipTarget = null;    // rect objetivo {x,y,w,h}
    let chipPos = null;       // posición escrita {x,y}

    // Barra.
    let barVisible = false;
    let barState = { count: 0, total: 0, jobRunning: false, progressText: '', needsConfirm: null };
    let barRectCache = null;

    function cb(name) {
      const f = callbacks[name];
      if (typeof f !== 'function') return undefined;
      const args = Array.prototype.slice.call(arguments, 1);
      try { return f.apply(null, args); } catch (_) { return undefined; }
    }

    function isControl(target) {
      try { return !!(target && target.closest && target.closest('button,input,a,[role=button]')); } catch (_) { return false; }
    }

    function isPopoverOpen() {
      try { return !!(layer && layer.matches(':popover-open')); } catch (_) { return false; }
    }

    // showPopover con fallback fixed.
    function show() {
      if (!layer) return false;
      try {
        if (typeof layer.showPopover !== 'function') throw new Error('sin popover');
        if (!layer.matches(':popover-open')) layer.showPopover();
        layer.classList.remove('fixed-fallback');
        return true;
      } catch (_) {
        layer.classList.add('fixed-fallback');
        return false;
      }
    }

    // Quitar y volver a mostrar: entra el último en el top layer (pinta encima).
    function reshow() {
      if (!layer) return false;
      try { if (layer.matches(':popover-open')) layer.hidePopover(); } catch (_) { /* ya oculto */ }
      return show();
    }

    function modalDialog() {
      const m = isModalPresent();
      return m && m.tagName === 'DIALOG' ? m : null;
    }

    // Coloca el host donde toca: dentro del <dialog> modal (lo de fuera es inerte)
    // o bajo <html>. Fullscreen (modal que no es dialog): solo re-mostrar.
    function placeHost() {
      if (!host || !mounted) return;
      const docEl = document.documentElement;
      if (!docEl) return;
      const modal = isModalPresent();
      const parent = (modal && modal.tagName === 'DIALOG') ? modal : docEl;
      const moved = host.parentNode !== parent;
      if (moved) {
        try { parent.append(host); } catch (_) {
          try { docEl.append(host); } catch (_) { return; }
        }
        observeGuard();
      }
      if (moved || (modal && modal.tagName !== 'DIALOG')) reshow();
      else if (!isPopoverOpen() && !layer.classList.contains('fixed-fallback')) show();
    }

    function scheduleTopLayer() {
      if (topRaf || !mounted) return;
      topRaf = requestAnimationFrame(() => {
        topRaf = 0;
        placeHost();
      });
    }

    function watchTopLayer(signal) {
      document.addEventListener('fullscreenchange', scheduleTopLayer, { signal });
      try {
        topMo = new MutationObserver((records) => {
          for (const r of records) {
            if (r.target && r.target.tagName === 'DIALOG') { scheduleTopLayer(); return; }
          }
        });
        topMo.observe(document, { subtree: true, attributes: true, attributeFilter: ['open'] });
      } catch (_) {
        topMo = null;
      }
    }

    // Guardia: la página elimina o mueve el host -> reparar (acelerador 500 ms,
    // máximo 20 veces por minuto; después toast ERR_UI_REMOVED y se rinde).
    // Observa <html>, el padre real del host (el <dialog> modal cuando vive
    // dentro) y el padre de este: una eliminación desde dentro del diálogo
    // solo genera una mutación childList en el propio diálogo.
    function observeGuard() {
      if (!guardMo || !host) return;
      guardMo.disconnect();
      const docEl = document.documentElement;
      try { if (docEl) guardMo.observe(docEl, { childList: true }); } catch (_) { /* nada */ }
      const p = host.parentNode;
      if (p && p !== docEl) {
        try { guardMo.observe(p, { childList: true }); } catch (_) { /* nada */ }
        if (p.parentNode) {
          try { guardMo.observe(p.parentNode, { childList: true }); } catch (_) { /* nada */ }
        }
      }
    }

    // Hace falta reparar cuando el host está fuera del DOM, cuelga de un padre
    // inesperado (la página lo movió: quitar un popover abierto del DOM lo
    // cierra) o el popover quedó cerrado sin estar en el fallback fixed.
    function needsRepair() {
      if (!host || !layer) return false;
      if (!host.isConnected) return true;
      const expected = modalDialog() || document.documentElement;
      if (host.parentNode !== expected) return true;
      return !isPopoverOpen() && !layer.classList.contains('fixed-fallback');
    }

    function readd() {
      guardTimer = 0;
      if (!mounted || !host || guardDead || !needsRepair()) return;
      const now = Date.now();
      guardTimes = guardTimes.filter((ts) => now - ts < guardWindowMs);
      guardTimes.push(now);
      lastReadd = now;
      placeHost();
      if (guardTimes.length >= guardMax) {
        guardDead = true;
        if (guardMo) guardMo.disconnect();
        toast(txt('ERR_UI_REMOVED'), 'error', 0);
      }
    }

    function onGuard() {
      if (!mounted || !host || guardDead || guardTimer || !needsRepair()) return;
      const wait = lastReadd + guardThrottleMs - Date.now();
      if (wait > 0) guardTimer = setTimeout(readd, wait);
      else readd();
    }

    function startGuard() {
      try {
        guardMo = new MutationObserver(onGuard);
      } catch (_) {
        guardMo = null;
        return;
      }
      observeGuard();
    }

    // Aislamiento de eventos: burbuja en el shadow root. preventDefault solo en
    // mousedown de controles (no roba el foco ni inicia selección de texto).
    function onStop(e) {
      if (e.type === 'mousedown' && isControl(e.target)) e.preventDefault();
      e.stopPropagation();
    }

    function onKey(e) {
      if (e.key !== 'Escape') e.stopPropagation();
    }

    // ---- Barra como toolbar (APG): tabindex itinerante y flechas ----

    // Botones de la barra en orden visual.
    function barControls() {
      return barParts ? [barParts.clear, barParts.files, barParts.zip, barParts.cancel, barParts.exit, barParts.go] : [];
    }

    function isFocusable(b) {
      return !!b && !b.disabled && !b.hidden && !(b.parentNode && b.parentNode.hidden);
    }

    // Una sola parada de Tab: el botón con el foco si sigue operativo, si no el primero
    // operativo; el resto tabindex=-1. Si el que tenía el foco se deshabilitó u ocultó
    // (p. ej. 'Descargar ZIP' al arrancar el lote), el foco pasa a la parada para no
    // caer al <body>.
    function updateRoving() {
      if (!barParts) return;
      const all = barControls();
      const list = all.filter(isFocusable);
      let a = null;
      try { a = shadow ? shadow.activeElement : null; } catch (_) { a = null; }
      const inBar = !!(a && bar && bar.contains(a));
      const stop = inBar && list.includes(a) ? a : list[0] || null;
      for (const b of all) b.tabIndex = b === stop ? 0 : -1;
      if (inBar && stop && stop !== a) {
        try { stop.focus(); } catch (_) { /* nada */ }
      }
    }

    function onBarKey(e) {
      if (!barParts || e.altKey || e.ctrlKey || e.metaKey) return;
      const list = barControls().filter(isFocusable);
      if (!list.length) return;
      let a = null;
      try { a = shadow ? shadow.activeElement : null; } catch (_) { a = null; }
      const i = list.indexOf(a);
      let next = null;
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': next = list[i < 0 ? 0 : (i + 1) % list.length]; break;
        case 'ArrowLeft': case 'ArrowUp': next = list[i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length]; break;
        case 'Home': next = list[0]; break;
        case 'End': next = list[list.length - 1]; break;
        default: return;
      }
      e.preventDefault();
      if (next && next !== a) {
        try { next.focus(); } catch (_) { /* nada */ }
        updateRoving();
      }
    }

    // ---- Chip: foco de teclado ----

    function chipHasFocus() {
      try {
        const a = shadow ? shadow.activeElement : null;
        return !!(a && chip && chip.contains(a));
      } catch (_) {
        return false;
      }
    }

    // El foco salió del chip (Tab, clic en la página): el controlador decide si lo suelta.
    function onChipFocusOut(e) {
      const to = e && e.relatedTarget;
      if (to && chip && chip.contains(to)) return;
      cb('onChipBlur');
    }

    function wireEvents(signal) {
      for (const type of STOP_EVENTS) {
        shadow.addEventListener(type, onStop, { signal, passive: type.startsWith('touch') });
      }
      shadow.addEventListener('keydown', onKey, { signal });
      shadow.addEventListener('keyup', onKey, { signal });
      shadow.addEventListener('keypress', onKey, { signal });
      dlBtn.addEventListener('click', () => { if (chipRef) cb('onDownload', chipRef); }, { signal });
      selBox.addEventListener('change', () => { if (chipRef) cb('onToggleSelect', chipRef, selBox.checked); }, { signal });
      // Enter también alterna el checkbox (Espacio ya lo hace de forma nativa).
      selBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.repeat) selBox.click(); }, { signal });
      chip.addEventListener('focusout', onChipFocusOut, { signal });
      if (barParts) {
        bar.addEventListener('keydown', onBarKey, { signal });
        barParts.clear.addEventListener('click', () => cb('onClear'), { signal });
        barParts.files.addEventListener('click', () => cb('onFiles'), { signal });
        barParts.zip.addEventListener('click', () => cb('onZip'), { signal });
        barParts.cancel.addEventListener('click', () => cb('onCancel'), { signal });
        barParts.exit.addEventListener('click', () => cb('onExit'), { signal });
        barParts.go.addEventListener('click', () => cb('onConfirmBig'), { signal });
      }
    }

    function buildChip() {
      chip = el('div', 'chip ui', { role: 'group', 'aria-label': txt('CHIP_GROUP'), hidden: '' });
      const selCell = el('span', 'cell sel');
      selBox = el('input', 'box', { type: 'checkbox', 'aria-label': txt('CHIP_SELECT') });
      selCell.append(selBox, iconCheckbox());
      dlBtn = el('button', 'cell dl', { type: 'button', 'aria-label': txt('CHIP_DOWNLOAD') });
      dlBtn.append(iconDownload());
      chip.append(selCell, dlBtn);
    }

    // Botón nativo con texto visible y aria-label (ambos de ImgDL.strings).
    function button(label, cls) {
      const b = el('button', cls || '', { type: 'button' });
      setLabel(b, label);
      return b;
    }

    function setLabel(b, label) {
      const s = label === undefined || label === null ? '' : String(label);
      b.textContent = s;
      if (s) b.setAttribute('aria-label', s);
      else b.removeAttribute('aria-label');
    }

    function buildBar() {
      bar = el('div', 'bar ui', { role: 'toolbar', 'aria-label': txt('BAR_LABEL') || txt('APP_NAME'), hidden: '' });
      const count = el('span', 'count');
      const clear = button(txt('BAR_CLEAR'));
      const files = button('', 'primary');
      const zip = button('', 'primary');
      const cancel = button(txt('BAR_CANCEL'));
      cancel.hidden = true;
      const exit = button(txt('BAR_EXIT'));
      const confirm = el('div', 'confirm');
      confirm.hidden = true;
      const confirmText = el('span', 'ctext');
      const go = button(txt('BAR_CONTINUE'), 'primary');
      confirm.append(confirmText, go);
      // El progreso se anuncia por la región aria-live única (sin segundo live region).
      const progress = el('div', 'progress');
      bar.append(count, clear, files, zip, cancel, exit, confirm, progress);
      barParts = { count, clear, files, zip, cancel, exit, confirm, confirmText, go, progress };
      updateRoving();
    }

    // ---- Región aria-live (una por marco) ----

    function buildLive() {
      live = el('div', 'live', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
      return live;
    }

    function flushLive() {
      liveTimer = 0;
      if (!live || livePending === null) return;
      const text = livePending;
      livePending = null;
      if (live.textContent === text) {
        // Mismo texto: vaciar y volver a escribir en otra tarea para que se re-anuncie.
        live.textContent = '';
        const t = setTimeout(() => { timers.delete(t); if (live) live.textContent = text; }, 30);
        timers.add(t);
        return;
      }
      live.textContent = text;
    }

    // Anuncio coalescido (LIVE_MS): varios cambios seguidos → solo el último.
    function announce(text) {
      if (!mounted || !live) return;
      const s = text === undefined || text === null ? '' : String(text);
      if (!s) return;
      livePending = s;
      if (liveTimer) return;
      liveTimer = setTimeout(() => { timers.delete(liveTimer); flushLive(); }, LIVE_MS);
      timers.add(liveTimer);
    }

    function liveText() {
      return live ? live.textContent : null;
    }

    function build() {
      host = document.createElement(HOST_TAG);
      for (const p of Object.keys(HOST_STYLE)) host.style.setProperty(p, HOST_STYLE[p], 'important');
      shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = CSS; // ANTES de insertarlo
      shadow.append(style);
      layer = el('div', 'layer');
      layer.setAttribute('popover', 'manual'); // dentro del shadow: [popover] de la página no lo alcanza
      badgesBox = el('div', 'badges');
      buildChip();
      toastsBox = el('div', 'toasts');
      layer.append(badgesBox, chip);
      if (isTopFrame) {
        buildBar();
        layer.append(bar);
      }
      layer.append(toastsBox, buildLive());
      shadow.append(layer);
    }

    // Solo documentos HTML/XHTML: en un SVG o XML abierto directamente
    // createElement devuelve un Element sin namespace (sin .style) y nada se
    // puede montar. Nunca lanza: setActive devuelve false.
    function canMountHere() {
      try {
        const docEl = document.documentElement;
        if (!docEl || typeof HTMLElement !== 'function' || !(docEl instanceof HTMLElement)) return false;
        return typeof document.createElement('div').style !== 'undefined';
      } catch (_) {
        return false;
      }
    }

    function mount() {
      if (host && host.isConnected && mounted) return true;
      if (host) unmount();
      if (!canMountHere()) return false; // documento SVG/XML sin raíz utilizable
      const docEl = document.documentElement;
      ac = new AbortController();
      const signal = ac.signal;
      try {
        build();
        wireEvents(signal);
      } catch (_) {
        if (host) unmount();
        else if (ac) { ac.abort(); ac = null; }
        return false;
      }
      const parent = modalDialog() || docEl;
      try { parent.append(host); } catch (_) { docEl.append(host); }
      mounted = true;
      guardDead = false;
      guardTimes = [];
      lastReadd = 0;
      show();
      watchTopLayer(signal);
      startGuard();
      return true;
    }

    function unmount() {
      if (!host) return;
      mounted = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (topRaf) { cancelAnimationFrame(topRaf); topRaf = 0; }
      if (guardTimer) { clearTimeout(guardTimer); guardTimer = 0; }
      for (const id of timers) clearTimeout(id);
      timers.clear();
      if (topMo) { topMo.disconnect(); topMo = null; }
      if (guardMo) { guardMo.disconnect(); guardMo = null; }
      try { if (layer && layer.matches(':popover-open')) layer.hidePopover(); } catch (_) { /* ya oculto */ }
      try { host.remove(); } catch (_) { /* ya fuera del DOM */ }
      if (ac) { ac.abort(); ac = null; }
      badgeMap.clear();
      host = null; shadow = null; layer = null; chip = null; selBox = null; dlBtn = null;
      badgesBox = null; bar = null; barParts = null; toastsBox = null;
      live = null; liveTimer = 0; livePending = null; lastCountAnnounced = -1;
      chipVisible = false; chipRef = null; chipTarget = null; chipPos = null;
      barVisible = false; barRectCache = null;
      barState = { count: 0, total: 0, jobRunning: false, progressText: '', needsConfirm: null };
    }

    // ---- Posicionamiento ----

    function chipPosition(r, vp) {
      return {
        x: clamp(r.x + r.w - (CHIP_W + CHIP_INSET), CHIP_INSET, vp.vw - (CHIP_W + 6)),
        y: clamp(r.y + CHIP_INSET, CHIP_INSET, vp.vh - (CHIP_H + 2))
      };
    }

    function placeChip(vp) {
      if (!chip || !chipTarget) return;
      chipPos = chipPosition(chipTarget, vp);
      chip.style.transform = 'translate(' + chipPos.x + 'px,' + chipPos.y + 'px)';
    }

    function placeBadge(b, r, vp) {
      const visible = !!r && r.w > 0 && r.h > 0 && r.x < vp.vw && r.y < vp.vh && r.x + r.w > 0 && r.y + r.h > 0;
      b.ring.hidden = !visible;
      b.badge.hidden = !visible;
      if (!visible) return;
      b.ring.style.transform = 'translate(' + r.x + 'px,' + r.y + 'px)';
      b.ring.style.width = r.w + 'px';
      b.ring.style.height = r.h + 'px';
      b.badge.style.transform = 'translate(' + (r.x + 4) + 'px,' + (r.y + 4) + 'px)';
    }

    function runLayout() {
      raf = 0;
      dirty = false;
      if (!mounted) return;
      const vp = viewport();
      // LECTURA: rects de los seleccionados visibles (el elemento si sigue conectado).
      const reads = [];
      for (const b of badgeMap.values()) {
        let r = b.rect;
        if (b.el && b.el.isConnected) {
          try { r = normRect(b.el.getBoundingClientRect()); } catch (_) { /* usa el rect guardado */ }
        }
        reads.push([b, r]);
      }
      const barH = bar && barVisible ? bar.offsetHeight : 0;
      // ESCRITURA.
      if (chipVisible) placeChip(vp);
      for (const [b, r] of reads) placeBadge(b, r, vp);
      liftToasts(barH);
      barRectCache = null;
    }

    function schedule() {
      if (raf || !mounted) return;
      raf = requestAnimationFrame(runLayout);
    }

    function layout() {
      schedule();
    }

    function markDirty() {
      dirty = true;
      schedule();
    }

    // ---- Chip ----

    function showChip(rect, ref, isSelected) {
      if (!mounted) return false;
      const r = normRect(rect);
      if (!r) return false;
      chipTarget = r;
      chipRef = ref || null;
      selBox.checked = !!isSelected;
      chipVisible = true;
      placeChip(viewport()); // solo escritura: visible en este mismo frame
      chip.hidden = false;
      return true;
    }

    function hideChip() {
      if (!chip) return;
      chipVisible = false;
      chipRef = null;
      chipTarget = null;
      chipPos = null;
      chip.hidden = true;
    }

    function chipRectNow() {
      return chipVisible && chipPos ? { x: chipPos.x, y: chipPos.y, w: CHIP_W, h: CHIP_H } : null;
    }

    // ---- Badges / anillos ----

    function buildBadge() {
      const b = el('div', 'badge ui', { 'aria-hidden': 'true' });
      b.append(iconCheck());
      return b;
    }

    // entries: [{key, rect, name, el?}]; tope badgeCap.
    function setBadges(entries) {
      if (!mounted) return;
      const list = Array.isArray(entries) ? entries.slice(0, badgeCap) : [];
      const keep = new Set();
      for (const e of list) {
        if (!e || typeof e.key !== 'string' || keep.has(e.key)) continue;
        keep.add(e.key);
        let b = badgeMap.get(e.key);
        if (!b) {
          b = { ring: el('div', 'ring', { hidden: '' }), badge: buildBadge(), el: null, rect: null };
          badgesBox.append(b.ring, b.badge);
          badgeMap.set(e.key, b);
        }
        b.el = e.el && e.el.nodeType === 1 ? e.el : null;
        b.rect = normRect(e.rect) || b.rect;
      }
      for (const [key, b] of badgeMap) {
        if (keep.has(key)) continue;
        b.ring.remove();
        b.badge.remove();
        badgeMap.delete(key);
      }
      schedule();
    }

    // ---- Barra (solo marco principal) ----

    function renderBar() {
      if (!bar || !barParts) return;
      const st = barState;
      const n = Number.isFinite(st.total) && st.total > 0 ? st.total : num(st.count);
      const running = !!st.jobRunning;
      // busy: trabajo en marcha o petición en vuelo (sin respuesta del SW): sin
      // Limpiar/descargar; 'Cancelar' solo con trabajo confirmado.
      const busy = running || !!st.busy;
      const confirm = st.needsConfirm && typeof st.needsConfirm === 'object' ? st.needsConfirm : null;
      const countText = fmt('BAR_SELECTED', [n], String(n));
      barParts.count.textContent = countText;
      setLabel(barParts.files, fmt('BAR_FILES', [n], String(n)));
      setLabel(barParts.zip, fmt('BAR_ZIP', [n], String(n)));
      barParts.clear.disabled = busy;
      barParts.files.disabled = busy || n === 0 || !!confirm;
      barParts.zip.disabled = busy || n === 0 || !!confirm;
      barParts.cancel.hidden = !running;
      setProgressText(st.progressText);
      // Recuento: se anuncia solo cuando cambia (nunca en cada repintado).
      if (n !== lastCountAnnounced) {
        lastCountAnnounced = n;
        announce(countText);
      }
      if (confirm) {
        const cn = Number.isFinite(confirm.n) ? confirm.n : n;
        const mb = Number.isFinite(confirm.mb) ? confirm.mb : 0;
        barParts.confirmText.textContent = fmt('WARN_BIG', [cn, mb], '');
        barParts.confirm.hidden = false;
      } else {
        barParts.confirm.hidden = true;
      }
      updateRoving();
      barRectCache = null;
      schedule(); // los toasts se elevan en el rAF (lectura de offsetHeight sin forzar layout)
    }

    // Con la barra visible, los toasts se apilan por encima de ella (no se solapan).
    // Solo escritura: la altura la lee runLayout en su fase de lectura.
    function liftToasts(barHeight) {
      if (!toastsBox) return;
      const h = bar && barVisible ? num(barHeight) : 0;
      toastsBox.style.bottom = (h > 0 ? 16 + h + 12 : 16) + 'px';
    }

    function mergeBar(state) {
      if (state && typeof state === 'object') {
        for (const k of ['count', 'total', 'jobRunning', 'busy', 'progressText', 'needsConfirm']) {
          if (state[k] !== undefined) barState[k] = state[k];
        }
      }
    }

    function showBar(state) {
      if (!mounted || !bar) return false;
      mergeBar(state);
      barVisible = true;
      bar.hidden = false;
      renderBar();
      return true;
    }

    function updateBar(state) {
      if (!mounted || !bar) return false;
      mergeBar(state);
      if (barVisible) renderBar();
      return barVisible;
    }

    function hideBar() {
      if (!bar) return;
      barVisible = false;
      bar.hidden = true;
      barRectCache = null;
      schedule();
    }

    // Línea de progreso: escribe el texto y lo anuncia si cambió.
    function setProgressText(text) {
      const s = text ? String(text) : '';
      if (!barParts || barParts.progress.textContent === s) return;
      barParts.progress.textContent = s;
      if (s) announce(s);
    }

    function setProgress(text) {
      barState.progressText = text ? String(text) : '';
      setProgressText(barState.progressText);
      barRectCache = null;
    }

    function barRectNow() {
      if (!bar || !barVisible) return null;
      if (!barRectCache) barRectCache = rectOf(bar);
      return barRectCache;
    }

    // ---- Toasts ----

    function toast(text, level, ms, opts) {
      const noop = { dismiss() {}, el: null };
      if (!mounted || !toastsBox) return noop;
      const lv = LEVELS.includes(level) ? level : 'info';
      // Errores: role=alert en el propio nodo (se anuncia al insertarse). El resto va
      // por la región aria-live polite (un nodo nuevo con role=status no se anuncia).
      const node = el('div', 'toast ui ' + lv, lv === 'error' ? { role: 'alert' } : null);
      const span = el('span', 'text');
      const msg = text === undefined || text === null ? '' : String(text);
      span.textContent = msg;
      node.append(span);
      if (lv !== 'error') announce(msg);
      let timer = 0;
      const dismiss = () => {
        if (timer) { clearTimeout(timer); timers.delete(timer); timer = 0; }
        node.remove();
      };
      if (opts && opts.actionLabel) {
        const b = button(String(opts.actionLabel));
        // onAction corre dentro del click: conserva la activación de usuario (clipboard).
        b.addEventListener('click', () => {
          try { if (typeof opts.onAction === 'function') opts.onAction(); } catch (_) { /* nada */ }
          dismiss();
        }, { signal: ac.signal });
        node.append(b);
      }
      toastsBox.append(node);
      while (toastsBox.childElementCount > TOAST_MAX) toastsBox.firstElementChild.remove();
      const delay = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : TOAST_MS[lv];
      if (delay > 0) {
        timer = setTimeout(() => { timers.delete(timer); timer = 0; node.remove(); }, delay);
        timers.add(timer);
      }
      return { dismiss, el: node };
    }

    // ---- Consultas ----

    function isPointerOnUi(x, y) {
      if (!mounted) return false;
      if (contains(chipRectNow(), x, y, rectMargin)) return true;
      if (contains(barRectNow(), x, y, rectMargin)) return true;
      if (toastsBox && toastsBox.childElementCount && contains(rectOf(toastsBox), x, y, rectMargin)) return true;
      return false;
    }

    function debugRects() {
      const badges = [];
      for (const [key, b] of badgeMap) badges.push({ key, rect: b.ring.hidden ? null : rectOf(b.ring) });
      let hostParent = null;
      try { hostParent = host && host.parentNode ? host.parentNode.tagName : null; } catch (_) { /* nada */ }
      // Botones de la barra: rect si visible (ni él ni su contenedor [hidden]), label y disabled.
      const barOn = !!(bar && barVisible);
      const BTNS = { clear: 'clear', files: 'files', zip: 'zip', cancel: 'cancel', exit: 'exit', confirm: 'go' };
      let barButtons = null;
      let barLabels = null;
      let barDisabled = null;
      if (barOn && barParts) {
        barButtons = {};
        barLabels = { count: barParts.count.textContent, confirmText: barParts.confirmText.textContent };
        barDisabled = {};
        for (const k of Object.keys(BTNS)) {
          const b = barParts[BTNS[k]];
          const shown = !!b && !b.hidden && !(b.parentNode && b.parentNode.hidden);
          barButtons[k] = shown ? rectOf(b) : null;
          barLabels[k] = b ? b.textContent : null;
          barDisabled[k] = !!(b && b.disabled);
        }
      }
      // Accesibilidad: control con el foco (aria-label), etiquetas de todos los controles,
      // role de la barra y sus paradas de Tab (tabindex=0 operativos: una sola en el toolbar).
      let activeControl = null;
      let controlLabels = null;
      let barTabStops = null;
      try {
        const a = shadow ? shadow.activeElement : null;
        activeControl = a ? (a.getAttribute('aria-label') || a.textContent || a.tagName) : null;
        controlLabels = shadow ? Array.from(shadow.querySelectorAll('button,input'), (c) => c.getAttribute('aria-label') || '') : null;
        if (barOn) barTabStops = barControls().filter((b) => isFocusable(b) && b.tabIndex === 0).map((b) => b.getAttribute('aria-label') || '');
      } catch (_) { /* nada */ }
      return {
        chipRect: chipVisible ? rectOf(chip) : null,
        chipCells: chipVisible ? { select: rectOf(selBox), download: rectOf(dlBtn) } : null,
        chipChecked: chipVisible ? !!selBox.checked : null,
        liveText: liveText(),
        activeControl,
        controlLabels,
        barLabel: bar ? bar.getAttribute('aria-label') : null,
        barRole: bar ? bar.getAttribute('role') : null,
        barTabStops,
        chipLabel: chip ? chip.getAttribute('aria-label') : null,
        barRect: barOn ? rectOf(bar) : null,
        barText: barOn ? bar.innerText : null, // innerText omite los [hidden]
        barButtons,
        barLabels,
        barDisabled,
        badges,
        badgeCount: badgeMap.size,
        badgeVisible: badges.filter((b) => b.rect).length,
        toasts: toastsBox ? Array.from(toastsBox.children, (n) => (n.firstChild ? n.firstChild.textContent : n.textContent)) : [],
        popoverOpen: isPopoverOpen(),
        fallback: !!(layer && layer.classList.contains('fixed-fallback')),
        hostParent,
        dirty
      };
    }

    if (outerSignal) {
      if (outerSignal.aborted) mounted = false;
      else outerSignal.addEventListener('abort', () => unmount(), { once: true });
    }

    return {
      get host() { return host; },
      mount,
      unmount,
      showChip,
      hideChip,
      setBadges,
      showBar,
      updateBar,
      hideBar,
      setProgress,
      toast,
      announce,
      liveText,
      isPointerOnUi,
      chipHasFocus,
      layout,
      markDirty,
      reshow,
      isPopoverOpen,
      debugRects
    };
  }

  const api = { createOverlay, HOST_TAG, CHIP_W, CHIP_H };

  root.ImgDL = root.ImgDL || {};
  root.ImgDL.overlay = api;
  root.ImgDL.createOverlay = createOverlay;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
