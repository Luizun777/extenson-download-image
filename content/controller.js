'use strict';
// Controlador por frame: el único objeto con estado del content script.
// Monta/desmonta el overlay (overlay.js), lleva el hover (pointermove → rAF →
// detect.hitTest → chip tras chipDelayMs), la selección (selection.js: checkbox
// del chip, badges, rebind), la barra del marco principal (recuento propio +
// marcos, descargas en lote, confirmación, cancelar, limpiar, salir), Esc, ciclo
// de vida, mensajes del SW (notify, materialize, frame-count, hover-frame,
// clear-selection, progress, job-done) y debugState().
(function (root) {
  const ImgDL = root.ImgDL || (root.ImgDL = {});
  const thresholds = ImgDL.thresholds || (typeof require === 'function' ? require('../lib/thresholds.js') : null);
  const DEFAULTS = (thresholds && thresholds.DEFAULTS) || {};
  const FRAME_DEBOUNCE_MS = DEFAULTS.frameDebounceMs || 500;
  const CHIP_DELAY_MS = typeof DEFAULTS.chipDelayMs === 'number' ? DEFAULTS.chipDelayMs : 150;
  const RECT_MARGIN = typeof DEFAULTS.rectMargin === 'number' ? DEFAULTS.rectMargin : 8;
  const SCROLL_END_MS = 150;        // fallback cuando no hay 'scrollend'
  // Marcos de otro origen: cuando el puntero sale de un iframe hacia el padre, el
  // iframe no recibe pointerout/pointerleave (verificado en Chromium bajo CDP) y su
  // chip quedaría colgado. Un hueco sin pointermove mayor que HOVER_GAP_MS significa
  // que el puntero estaba en otro marco (o fuera): al reanudarse, este marco avisa
  // imgdl:hover-frame al SW, que lo difunde a todos los marcos de la pestaña, y los
  // demás ocultan su chip. Nunca por postMessage: la página no debe ver ni poder
  // forjar tráfico de la extensión (principio overlay-events-isolation).
  const HOVER_GAP_MS = 100;
  const MiB = 1024 * 1024;
  const BYTE_KINDS = new Set(['blob', 'canvas', 'svg']);
  // Un fallo síncrono de descarga llega dos veces (imgdl:notify + respuesta al
  // mensaje): el mismo texto no se repite dentro de esta ventana.
  const TOAST_DEDUPE_MS = 1000;

  function S() {
    return ImgDL.strings || {};
  }

  function isContextInvalidated(e) {
    return /context invalidated/i.test(String((e && e.message) || e || ''));
  }

  function runtimeAlive() {
    try {
      return !!(root.chrome && root.chrome.runtime && root.chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  // Overlay de reserva si overlay.js no se inyectó (nunca en producción): host
  // vacío para que setActive/debugState sigan funcionando.
  function createOverlayFallback() {
    let host = null;
    const noop = () => false;
    return {
      get host() { return host; },
      mount() {
        if (host && host.isConnected) return true;
        const docEl = document.documentElement;
        if (!docEl) return false;
        host = document.createElement('imgdl-root');
        host.attachShadow({ mode: 'closed' });
        docEl.append(host);
        return true;
      },
      unmount() { if (host) { try { host.remove(); } catch (_) { /* nada */ } host = null; } },
      showChip: noop, hideChip: noop, setBadges: noop, showBar: noop, updateBar: noop, hideBar: noop,
      setProgress: noop, toast: () => ({ dismiss() {}, el: null }), isPointerOnUi: noop, chipHasFocus: noop, layout: noop,
      markDirty: noop, reshow: noop, isPopoverOpen: noop,
      debugRects() { return { chipRect: null, chipCells: null, barRect: null, badges: [], toasts: [], hostParent: null }; }
    };
  }

  // Selección de reserva si selection.js no se inyectó (nunca en producción).
  function createSelectionFallback() {
    const empty = () => [];
    return {
      add: () => false, remove: () => false, toggle: () => false, clear() {}, count: () => 0, entries: empty,
      has: () => false, rebind: () => false, visibleEntries: empty,
      collectSelection: () => ({ frameUrl: location.href, items: [] }),
      materialize: (id) => Promise.resolve({ id, code: 'ERR_GENERIC', text: (ImgDL.strings && ImgDL.strings.ERR_GENERIC) || '' })
    };
  }

  function sumValues(obj) {
    let n = 0;
    for (const k of Object.keys(obj)) {
      const v = Number(obj[k]);
      if (Number.isFinite(v) && v > 0) n += v;
    }
    return n;
  }

  function rectOfEl(el) {
    const dom = ImgDL.detect && ImgDL.detect.dom;
    if (dom && typeof dom.rectOf === 'function') return dom.rectOf(el);
    try {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    } catch (_) {
      return { x: 0, y: 0, w: 0, h: 0, left: 0, top: 0, right: 0, bottom: 0 };
    }
  }

  function rectHas(rect, x, y, margin) {
    const dom = ImgDL.detect && ImgDL.detect.dom;
    if (dom && typeof dom.rectContains === 'function') return dom.rectContains(rect, x, y, margin);
    if (!rect) return false;
    const m = margin || 0;
    return x >= rect.x - m && y >= rect.y - m && x <= rect.x + rect.w + m && y <= rect.y + rect.h + m;
  }

  function sameRect(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.w - b.w) <= 0.5 && Math.abs(a.h - b.h) <= 0.5;
  }

  // contains() que atraviesa shadow roots: el objetivo puede vivir dentro de un
  // shadow tree cuyo host sí es descendiente del contenedor.
  function containsComposed(container, el) {
    let n = el;
    while (n) {
      try { if (container.contains(n)) return true; } catch (_) { return false; }
      const r = typeof n.getRootNode === 'function' ? n.getRootNode() : null;
      n = r && r.host ? r.host : null;
    }
    return false;
  }

  function createController() {
    const isTopFrame = (function () {
      try { return window.self === window.top; } catch (_) { return false; }
    })();

    let active = false;
    let ac = null;            // AbortController de todos los listeners
    let mo = null;            // MutationObserver de iframes tardíos
    let framesTimer = 0;
    let messageListener = null;

    // Hover.
    let px = -1;
    let py = -1;
    let hasPointer = false;
    let raf = 0;
    let current = null;       // {el, ref, rect} del objetivo actual
    let chipTimer = 0;
    let chipShown = false;
    let ro = null;            // ResizeObserver del objetivo
    let roEl = null;          // elemento observado
    let dirty = false;        // scroll/resize/host: el rect cacheado no vale
    let scrollTimer = 0;
    let scrollHides = 0;      // veces que un scroll ocultó el chip (diagnóstico)
    let lastMoveAt = 0;       // último pointermove (hueco → aviso a los demás marcos)
    let hoverToken = '';      // identifica este marco en imgdl:hover-frame (ignora el eco propio)
    let hoverMsgs = { sent: 0, received: 0 }; // diagnóstico

    // Selección (selection.js): se crea en setActive(true) y se destruye en false.
    let selection = null;
    let selAc = null;         // AbortController de la selección
    let lastSentCount = -1;   // último imgdl:selection-changed enviado
    let barShown = false;     // la barra se muestra en el primer cambio de selección
    let batchingSelection = false; // testSelectExpect: un solo repintado al final

    const state = {
      hoverKey: null,
      hoverUrl: null,
      selectionCount: 0,
      selectionTotal: 0,
      frameCounts: {},
      partialFrames: false,   // el SW solo pudo inyectar el marco principal
      progressText: '',
      jobRunning: false,
      jobId: null,
      jobTotal: 0,
      requesting: false,      // imgdl:download-many en vuelo (sin respuesta aún)
      pendingMode: null,      // 'files'|'zip' a la espera de 'Continuar'
      needsConfirm: null      // {n, mb} mientras la barra pide confirmación
    };
    const DONE_IDS_MAX = 16;
    const doneIds = [];       // últimos jobId con job-done (una respuesta tardía no los resucita)

    const callbacks = {
      onDownload,
      onToggleSelect,
      onClear: () => onClearClick(),
      onFiles: () => startJob('files', false),
      onZip: () => startJob('zip', false),
      onCancel: () => cancelJob(),
      onConfirmBig: () => confirmBig(),
      onExit: () => { send({ type: 'imgdl:deactivate' }); },
      onChipBlur: () => onChipBlur()
    };

    const overlay = typeof ImgDL.createOverlay === 'function'
      ? ImgDL.createOverlay({ isTopFrame, callbacks, t: DEFAULTS })
      : createOverlayFallback();

    // Todo acceso a chrome.runtime pasa por aquí: tras recargar la extensión el
    // contexto queda invalidado y el script huérfano se desmonta en silencio.
    function send(msg) {
      if (!runtimeAlive()) {
        teardownSilently();
        return Promise.resolve(undefined);
      }
      try {
        const p = chrome.runtime.sendMessage(Object.assign({ to: 'sw' }, msg));
        return Promise.resolve(p).catch((e) => {
          if (isContextInvalidated(e)) teardownSilently();
          return undefined;
        });
      } catch (e) {
        if (isContextInvalidated(e)) teardownSilently();
        return Promise.resolve(undefined);
      }
    }

    function teardownSilently() {
      try { setActive(false); } catch (_) { /* nada */ }
    }

    let lastToast = { text: '', at: 0 };

    // Mismo texto dentro de TOAST_DEDUPE_MS -> un solo toast (el primero en
    // llegar, sea el imgdl:notify del SW o la respuesta a download-one).
    function toast(text, level, ms, opts) {
      const key = text === undefined || text === null ? '' : String(text);
      const now = Date.now();
      if (key && key === lastToast.text && now - lastToast.at < TOAST_DEDUPE_MS) return null;
      lastToast = { text: key, at: now };
      try { return overlay.toast(text, level, ms, opts); } catch (_) { return null; }
    }

    // Botón "Copiar URL" (texto de ImgDL.strings) para URLs http(s).
    function copyUrlOpts(url) {
      const label = S().COPY_URL;
      if (!label || typeof url !== 'string' || !/^https?:/i.test(url)) return undefined;
      return { actionLabel: label, onAction: () => copyUrl(url) };
    }

    // ---- Acciones del chip / barra ----

    function fmtCode(code) {
      return typeof S().format === 'function' ? S().format(code) : String(code || '');
    }

    function onDownload(ref) {
      if (!ref || !active) return;
      const page = { url: location.href, title: document.title };
      // Tipos byte: los bytes salen de este marco como data URL (mensajes JSON).
      const prep = BYTE_KINDS.has(ref.kind) ? dataUrlFor(ref) : Promise.resolve(undefined);
      prep.then((dataUrl) => {
        if (!active) return;
        if (dataUrl && typeof dataUrl === 'object') { toast(dataUrl.text || fmtCode(dataUrl.code), 'error'); return undefined; }
        const msg = { type: 'imgdl:download-one', ref, page };
        if (typeof dataUrl === 'string') msg.dataUrl = dataUrl;
        return send(msg).then((res) => {
          if (!active || !res || res.ok !== false) return;
          const text = res.text || fmtCode(res.code) || S().ERR_GENERIC || '';
          toast(text, 'error', undefined, copyUrlOpts(res.url));
        });
      });
    }

    // data URL de un tipo byte para una descarga individual: de la selección si ya
    // está materializado; si no, desde el elemento bajo el puntero. Error → {code, text}.
    async function dataUrlFor(ref) {
      const m = ImgDL.materialize;
      try {
        if (selection && selection.has(ref.key)) {
          const r = await selection.materialize(ref.id);
          if (r && typeof r.dataUrl === 'string') return r.dataUrl;
          if (r && r.code) return { code: r.code, text: r.text };
        }
        if (!m) return { code: 'ERR_GENERIC', text: fmtCode('ERR_GENERIC') };
        const el = current && current.ref && current.ref.key === ref.key ? current.el : null;
        const blob = await m.toBlobFor({ ref, el });
        if (blob.size > (DEFAULTS.maxItemBytes || 32 * MiB)) return { code: 'ERR_TOO_BIG_ITEM', text: fmtCode('ERR_TOO_BIG_ITEM') };
        const d = await m.describeBlob(blob, ref.kind);
        return await m.readAsDataUrl(blob, d.mime);
      } catch (e) {
        const code = (e && e.code) || 'ERR_GENERIC';
        return { code, text: fmtCode(code) };
      }
    }

    // Checkbox del chip: checked = estado deseado (el navegador ya lo alternó).
    function onToggleSelect(ref, checked) {
      if (!ref || !active || !selection) return;
      const want = typeof checked === 'boolean' ? checked : !selection.has(ref.key);
      const el = current && current.ref && current.ref.key === ref.key ? current.el : null;
      if (want && !selection.has(ref.key)) selection.add(ref, el);
      else if (!want && selection.has(ref.key)) selection.remove(ref.key);
      syncChip();
    }

    function isSelected(key) {
      return !!(selection && selection.has(key));
    }

    // Re-sincroniza el checkbox del chip con la selección (sin cambiar el objetivo).
    function syncChip() {
      if (!chipShown || !current) return;
      chipShown = !!overlay.showChip(current.rect, current.ref, isSelected(current.ref.key));
    }

    // Nodo recreado con una clave ya seleccionada (lista virtualizada): re-vincular.
    function rebindIfSelected(r) {
      if (selection && r && r.ref && r.el && selection.has(r.ref.key)) selection.rebind(r.ref.key, r.el);
    }

    // ---- Selección, badges y barra ----

    function onSelectionChange(count) {
      if (!selection) return;
      state.selectionCount = count;
      if (batchingSelection) return;
      renderBadges();
      syncChip();
      updateBarState();
      if (count !== lastSentCount) {
        lastSentCount = count;
        send({ type: 'imgdl:selection-changed', count });
      }
    }

    function onSelectionError(code, text) {
      toast(text || fmtCode(code), 'error');
    }

    function renderBadges() {
      overlay.setBadges(selection ? selection.visibleEntries() : []);
    }

    // Barra (solo marco principal): aparece con la primera selección y queda visible.
    function updateBarState() {
      state.selectionTotal = state.selectionCount + sumValues(state.frameCounts);
      if (!isTopFrame) return;
      const st = {
        count: state.selectionCount,
        total: state.jobRunning && state.jobTotal > 0 ? state.jobTotal : state.selectionTotal,
        jobRunning: state.jobRunning,
        busy: state.jobRunning || state.requesting,
        progressText: state.progressText,
        needsConfirm: state.needsConfirm
      };
      if (!barShown) {
        if (state.selectionTotal === 0 && !state.jobRunning && !state.requesting) return;
        barShown = !!overlay.showBar(st);
        return;
      }
      overlay.updateBar(st);
    }

    function resetJob() {
      state.jobRunning = false;
      state.jobId = null;
      state.jobTotal = 0;
      state.requesting = false;
      state.progressText = '';
      state.needsConfirm = null;
      state.pendingMode = null;
    }

    function rememberDone(jobId) {
      if (jobId === undefined || jobId === null) return;
      doneIds.push(jobId);
      if (doneIds.length > DONE_IDS_MAX) doneIds.shift();
    }

    // Mensaje de otro trabajo: con un jobId propio fijado, el resto se ignora
    // (progress/job-done de un trabajo ajeno no tocan la barra).
    function isForeignJob(msg) {
      if (msg.jobId === undefined || msg.jobId === null || state.jobId === null) return false;
      return msg.jobId !== state.jobId;
    }

    // Texto de un fallo del SW: el suyo si es específico; si es el genérico, el
    // del código (p. ej. EMPTY tiene mensaje propio).
    function failText(res, code) {
      const text = res && typeof res.text === 'string' ? res.text : '';
      if (text && text !== S().ERR_GENERIC) return text;
      return fmtCode(code) || text || '';
    }

    // 'Descargar archivos (N)' / 'Descargar ZIP (N)'; confirmBig tras 'Continuar'.
    function startJob(mode, confirmBig) {
      // requesting: un segundo clic mientras el SW no ha contestado no lanza otro trabajo.
      if (!active || !isTopFrame || state.jobRunning || state.requesting) return;
      state.pendingMode = mode;
      state.needsConfirm = null;
      state.requesting = true;
      updateBarState();
      const msg = { type: 'imgdl:download-many', mode, page: { url: location.href, title: document.title } };
      if (confirmBig) msg.confirmBig = true;
      send(msg).then((res) => {
        state.requesting = false;
        if (!active) return;
        if (res && res.ok === true) {
          // Respuesta tardía de un trabajo cuyo job-done ya llegó: no resucitarlo.
          if (res.jobId !== undefined && doneIds.includes(res.jobId)) {
            resetJob();
            updateBarState();
            return;
          }
          state.jobRunning = true;
          state.jobId = res.jobId !== undefined ? res.jobId : null;
          state.jobTotal = Number(res.total) || 0;
          state.progressText = '';
          state.pendingMode = null;
          updateBarState();
          return;
        }
        if (res && res.code === 'NEEDS_CONFIRM') {
          const n = Number(res.total) || state.selectionTotal;
          const bytes = Number(res.estimatedBytes);
          const mb = Number.isFinite(bytes) && bytes > 0 ? Math.ceil(bytes / MiB) : 0;
          state.needsConfirm = { n, mb };
          updateBarState();
          return;
        }
        state.pendingMode = null;
        const code = res && res.code ? res.code : 'ERR_GENERIC';
        // EMPTY: el recuento de marcos estaba desfasado (marco ido sin avisar).
        if (code === 'EMPTY') state.frameCounts = {};
        updateBarState();
        toast(failText(res, code), 'error');
      });
    }

    function confirmBig() {
      const mode = state.pendingMode;
      if (!mode || !state.needsConfirm) return;
      startJob(mode, true);
    }

    function cancelJob() {
      if (!state.jobRunning) return;
      const jobId = state.jobId;
      send({ type: 'imgdl:cancel-job', jobId }).then((res) => {
        if (!active || !state.jobRunning || state.jobId !== jobId) return;
        if (res && res.ok !== false) return; // el SW lo cancela: llegará job-done CANCELLED
        // El SW no conoce el trabajo (reiniciado o rechazado): nunca llegará job-done.
        resetJob();
        updateBarState();
        toast(failText(res, (res && res.code) || 'ERR_GENERIC'), 'error');
      });
    }

    // 'Limpiar': limpia este marco y pide al SW que limpie los demás.
    function onClearClick() {
      if (state.jobRunning || state.requesting) return;
      state.needsConfirm = null;
      state.pendingMode = null;
      clearSelection();
      send({ type: 'imgdl:clear-selection' });
    }

    // imgdl:progress {jobId, phase, done, failed, total, bytes} → texto de la barra.
    function onProgress(msg) {
      if (isForeignJob(msg)) return;
      const s = S();
      const done = Number(msg.done) || 0;
      const total = Number(msg.total) || state.jobTotal || 0;
      let text = state.progressText;
      switch (msg.phase) {
        case 'files': text = typeof s.PROGRESS_FILES === 'function' ? s.PROGRESS_FILES(done, total) : ''; break;
        case 'fetching': text = typeof s.PROGRESS_FETCH === 'function' ? s.PROGRESS_FETCH(done, total) : ''; break;
        case 'zipping': text = s.PROGRESS_ZIP || ''; break;
        case 'saving': text = s.PROGRESS_SAVING || ''; break;
        default: break;
      }
      if (msg.jobId !== undefined && state.jobId === null) state.jobId = msg.jobId;
      state.jobRunning = true;
      if (total > 0) state.jobTotal = total;
      state.progressText = text;
      updateBarState();
    }

    // imgdl:job-done {jobId, ok, done, failed, failures, text}: toast + limpiar si ok.
    function onJobDone(msg) {
      if (isForeignJob(msg)) return;
      rememberDone(msg.jobId);
      resetJob();
      const ok = msg.ok !== false;
      const failed = Number(msg.failed) || 0;
      const text = typeof msg.text === 'string' && msg.text ? msg.text : (ok ? '' : fmtCode(msg.code || 'ERR_GENERIC'));
      if (text) toast(text, ok ? (failed > 0 ? 'warn' : 'success') : 'error');
      if (ok) {
        clearSelection();
        send({ type: 'imgdl:clear-selection' }); // también los demás marcos
      }
      updateBarState();
    }

    // {frameId, count} de un marco (nunca el 0: el propio manda) o {counts} completo.
    function onFrameCount(msg) {
      if (msg.counts && typeof msg.counts === 'object') {
        const next = {};
        for (const k of Object.keys(msg.counts)) {
          const n = Number(msg.counts[k]) || 0;
          if (String(k) !== '0' && n > 0) next[k] = n;
        }
        state.frameCounts = next;
      } else if (typeof msg.frameId === 'number' && msg.frameId !== 0 && msg.count !== undefined) {
        const n = Number(msg.count) || 0;
        if (n > 0) state.frameCounts[msg.frameId] = n;
        else delete state.frameCounts[msg.frameId];
      }
      if (typeof msg.partial === 'boolean') state.partialFrames = msg.partial;
      updateBarState();
    }

    function copyUrl(url) {
      try {
        const p = navigator.clipboard && navigator.clipboard.writeText(url);
        Promise.resolve(p).then(
          () => toast(S().COPIED || '', 'success'),
          () => toast(S().ERR_GENERIC || '', 'error')
        );
      } catch (_) {
        toast(S().ERR_GENERIC || '', 'error');
      }
    }

    // ---- Hover: pointermove → rAF → hitTest → chip ----

    function onPointerMove(e) {
      px = e.clientX;
      py = e.clientY;
      hasPointer = true;
      const now = Date.now();
      if (now - lastMoveAt > HOVER_GAP_MS) announceHover();
      lastMoveAt = now;
      scheduleHit();
    }

    // ---- Otros marcos: "tengo el puntero" (vía SW; la página no ve nada) ----

    // Solo hay a quién avisar si este marco es un iframe o contiene iframes.
    function hasOtherFrames() {
      if (!isTopFrame) return true;
      try { return document.getElementsByTagName('iframe').length > 0 || document.getElementsByTagName('frame').length > 0; } catch (_) { return false; }
    }

    function announceHover() {
      if (!hasOtherFrames()) return;
      hoverMsgs.sent++;
      send({ type: 'imgdl:hover-frame', token: hoverToken });
    }

    // Eco del SW a todos los marcos: los demás ocultan su chip; el emisor se ignora.
    function onHoverFrame(msg) {
      if (!active || !msg || msg.token === hoverToken) return;
      hoverMsgs.received++;
      leave(); // el puntero está en otro marco: nada que mostrar aquí
    }

    // pointerleave/mouseleave del documento (no burbujean; capture en document): el
    // puntero salió del marco. Cinturón además de pointerout con relatedTarget null.
    function onDocLeave(e) {
      if (e.relatedTarget === null && (e.target === document || e.target === document.documentElement)) leave();
    }

    function scheduleHit() {
      if (raf || !active) return;
      raf = requestAnimationFrame(() => { raf = 0; runHit(false); });
    }

    function cancelHit() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }

    // immediate: tras scroll/resize el objetivo no cambió de identidad; el chip
    // se repone sin esperar chipDelayMs.
    function runHit(immediate) {
      if (!active || !hasPointer) return;
      const detect = ImgDL.detect;
      if (!detect || typeof detect.hitTest !== 'function') return;
      // Objetivo actual: se conserva mientras el puntero siga en su rect (+margen)
      // y nada lo haya invalidado. El rect se relee una vez por rAF (dentro del
      // presupuesto): un cambio de layout sin scroll/resize (contenido insertado
      // encima) mueve la imagen y el chip quedaría huérfano sobre otro contenido.
      if (current) {
        if (!current.el || !current.el.isConnected) {
          clearCurrent();
        } else if (!dirty) {
          const live = rectOfEl(current.el);
          if (!sameRect(live, current.rect)) {
            dirty = true;
            current.rect = live;
            if (chipShown) chipShown = !!overlay.showChip(live, current.ref, isSelected(current.ref.key));
          } else if (rectHas(live, px, py, RECT_MARGIN)) {
            return;
          }
        }
      }
      const r = detect.hitTest(px, py, { isPointerOnUi: overlay.isPointerOnUi, hostEl: overlay.host, t: DEFAULTS });
      if (r && r.keep) return; // sobre nuestra UI
      dirty = false;
      if (!r || !r.ref) {
        if (!holdChip()) clearCurrent();
        return;
      }
      if (current && current.ref.key === r.ref.key) {
        current.el = r.el;
        current.rect = r.rect;
        observe(r.el);
        rebindIfSelected(r);
        if (chipShown) overlay.showChip(current.rect, current.ref, isSelected(current.ref.key));
        else if (immediate) showChipNow();
        else if (!chipTimer) scheduleChip();
        return;
      }
      setCurrent(r, immediate);
    }

    function setCurrent(r, immediate) {
      // Con el foco de teclado dentro del chip, cambiar de objetivo no lo oculta ni
      // un instante (ocultarlo haría perder el foco): se repone sobre el nuevo ya.
      const keepChip = chipShown && chipHasFocus();
      clearCurrent(keepChip);
      current = { el: r.el, ref: r.ref, rect: r.rect };
      state.hoverKey = r.ref.key;
      state.hoverUrl = typeof r.ref.url === 'string' ? r.ref.url : null;
      observe(r.el);
      rebindIfSelected(r);
      if (immediate || keepChip) showChipNow();
      else scheduleChip();
    }

    function chipHasFocus() {
      try { return typeof overlay.chipHasFocus === 'function' && overlay.chipHasFocus(); } catch (_) { return false; }
    }

    // Foco de teclado dentro del chip (Tab tras un hover): el objetivo se conserva y el
    // chip se repone sobre él aunque el puntero se haya ido; se suelta al salir el foco
    // (onChipBlur). Devuelve true si retuvo el chip.
    function holdChip() {
      if (!current || !chipShown || !chipHasFocus()) return false;
      if (!current.el || !current.el.isConnected) return false;
      showChipNow(); // relee el rect: el elemento pudo moverse (scroll)
      return true;
    }

    // El foco salió del chip: reevaluar con el puntero donde esté (o soltar el objetivo).
    function onChipBlur() {
      if (!active || !current) return;
      if (!hasPointer) { clearCurrent(); return; }
      dirty = true;
      scheduleHit();
    }

    function scheduleChip() {
      if (chipTimer) clearTimeout(chipTimer);
      chipTimer = setTimeout(() => { chipTimer = 0; showChipNow(); }, CHIP_DELAY_MS);
    }

    function showChipNow() {
      if (!active || !current) return;
      if (!current.el.isConnected) { clearCurrent(); return; }
      current.rect = rectOfEl(current.el);
      chipShown = !!overlay.showChip(current.rect, current.ref, isSelected(current.ref.key));
    }

    function hideChipOnly() {
      if (chipTimer) { clearTimeout(chipTimer); chipTimer = 0; }
      chipShown = false;
      overlay.hideChip();
    }

    // keepChip: el chip sigue visible (cambio de objetivo con el foco dentro).
    function clearCurrent(keepChip) {
      if (keepChip) { if (chipTimer) { clearTimeout(chipTimer); chipTimer = 0; } }
      else hideChipOnly();
      if (ro) { ro.disconnect(); ro = null; roEl = null; }
      current = null;
      state.hoverKey = null;
      state.hoverUrl = null;
    }

    function observe(el) {
      if (ro && roEl === el) return;
      if (ro) { ro.disconnect(); ro = null; roEl = null; }
      if (typeof ResizeObserver !== 'function') return;
      let initial = true; // observe() siempre notifica una vez el tamaño actual
      try {
        ro = new ResizeObserver(() => {
          if (initial) { initial = false; return; }
          if (!current || current.el !== el) return;
          dirty = true;
          if (chipShown) showChipNow(); // el rect cambió: reposicionar
        });
        ro.observe(el);
        roEl = el;
      } catch (_) {
        ro = null;
        roEl = null;
      }
    }

    // Puntero fuera del documento, ventana sin foco, pestaña oculta.
    function onPointerOut(e) {
      if (e.relatedTarget === null) leave();
    }

    function leave() {
      hasPointer = false;
      cancelHit();
      if (!holdChip()) clearCurrent();
    }

    function onVisibility() {
      if (document.visibilityState === 'hidden') leave();
    }

    // Solo cuentan el documento/ventana y los contenedores que contienen al
    // objetivo: un widget con scroll propio (ticker, carrusel) lejos de la imagen
    // no mueve el chip ni debe ocultarlo.
    function scrollRelated(e) {
      const t = e && e.target;
      if (!t || t === document || t === window || !current) return true;
      return typeof t.contains === 'function' && containsComposed(t, current.el);
    }

    function onScroll(e) {
      if (!active) return;
      if (!scrollRelated(e)) {
        if (state.selectionCount > 0) overlay.markDirty(); // badges dentro de ese contenedor
        return;
      }
      dirty = true;
      // Con el foco dentro del chip no se oculta (perdería el foco): se repone al parar.
      if (chipShown && !chipHasFocus()) { scrollHides++; hideChipOnly(); }
      overlay.markDirty();
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(onScrollEnd, SCROLL_END_MS);
    }

    // Sin evento: fin del temporizador de un scroll relacionado.
    function onScrollEnd(e) {
      if (e && !scrollRelated(e)) return;
      if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = 0; }
      if (!active) return;
      if (state.selectionCount > 0) renderBadges(); // nodos recreados o fuera de vista
      overlay.layout();
      dirty = true;
      runHit(true);
    }

    function onResize() {
      if (!active) return;
      dirty = true;
      overlay.layout();
      if (chipShown && current) showChipNow();
    }

    // ---- Ciclo de vida ----

    function onKeyDown(e) {
      // Una etapa: Esc siempre desactiva. Sin stopPropagation (los modales de la página también cierran).
      if (e.key === 'Escape' && !e.isComposing) send({ type: 'imgdl:deactivate' });
    }

    function onPageHide() {
      setActive(false);
    }

    function onNavigateSuccess() {
      if (active) send({ type: 'imgdl:reassert-badge' });
    }

    function scheduleFramesChanged() {
      clearTimeout(framesTimer);
      framesTimer = setTimeout(() => {
        framesTimer = 0;
        if (active) send({ type: 'imgdl:frames-changed' });
      }, FRAME_DEBOUNCE_MS);
    }

    function onLoadCapture(e) {
      const t = e.target;
      if (t && (t.tagName === 'IFRAME' || t.tagName === 'FRAME')) scheduleFramesChanged();
    }

    function hasAddedIframe(records) {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'IFRAME' || n.tagName === 'FRAME') return true;
          if (n.firstElementChild && typeof n.querySelector === 'function' && n.querySelector('iframe,frame')) return true;
        }
      }
      return false;
    }

    // Mensajes del SW hacia este frame (tabs.sendMessage).
    function onMessage(msg, sender, sendResponse) {
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('imgdl:')) return false;
      if (msg.to && msg.to !== 'content') return false;
      switch (msg.type) {
        case 'imgdl:materialize':
          materialize(msg.id).then(sendResponse, (e) => {
            const code = (e && e.code) || 'ERR_GENERIC';
            sendResponse({ id: msg.id, code, text: fmtCode(code) });
          });
          return true; // respuesta asíncrona
        case 'imgdl:clear-selection':
          clearSelection();
          sendResponse({ ok: true });
          break;
        case 'imgdl:frame-count':
          onFrameCount(msg);
          sendResponse({ ok: true });
          break;
        case 'imgdl:hover-frame':
          onHoverFrame(msg);
          sendResponse({ ok: true });
          break;
        case 'imgdl:progress':
          if (active) onProgress(msg);
          sendResponse({ ok: true });
          break;
        case 'imgdl:job-done':
          if (active) onJobDone(msg);
          sendResponse({ ok: true });
          break;
        case 'imgdl:notify':
          onNotify(msg);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, code: 'NOT_IMPLEMENTED' });
      }
      return false;
    }

    // Aviso del SW (resultado de una descarga): toast con la duración del nivel;
    // 'copy-url' añade el botón "Copiar URL" (clipboard dentro del clic).
    function onNotify(msg) {
      if (!active) return;
      const level = typeof msg.level === 'string' ? msg.level : 'info';
      let text = typeof msg.text === 'string' ? msg.text : '';
      if (!text) text = typeof S().format === 'function' ? S().format(msg.code) : String(msg.code || '');
      const opts = msg.action === 'copy-url' ? copyUrlOpts(msg.url) : undefined;
      toast(text, level, undefined, opts);
    }

    function setActive(on) {
      const want = !!on;
      if (want === active) return active;
      if (want) {
        if (!overlay.mount()) return false;
        ac = new AbortController();
        const signal = ac.signal;
        selAc = new AbortController();
        selection = typeof ImgDL.createSelection === 'function'
          ? ImgDL.createSelection({ signal: selAc.signal, onChange: onSelectionChange, onError: onSelectionError })
          : createSelectionFallback();
        lastSentCount = 0;
        barShown = false;
        window.addEventListener('keydown', onKeyDown, { capture: true, signal });
        window.addEventListener('pagehide', onPageHide, { signal });
        window.addEventListener('load', onLoadCapture, { capture: true, signal });
        // Hover.
        window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true, signal });
        window.addEventListener('pointerout', onPointerOut, { capture: true, passive: true, signal });
        document.addEventListener('pointerleave', onDocLeave, { capture: true, passive: true, signal });
        document.addEventListener('mouseleave', onDocLeave, { capture: true, passive: true, signal });
        lastMoveAt = 0;
        hoverToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
        hoverMsgs = { sent: 0, received: 0 };
        window.addEventListener('blur', leave, { signal });
        document.addEventListener('visibilitychange', onVisibility, { signal });
        window.addEventListener('scroll', onScroll, { capture: true, passive: true, signal });
        window.addEventListener('scrollend', onScrollEnd, { capture: true, passive: true, signal });
        window.addEventListener('resize', onResize, { signal });
        if (window.visualViewport) {
          window.visualViewport.addEventListener('resize', onResize, { signal });
          window.visualViewport.addEventListener('scroll', onResize, { signal });
        }
        if (isTopFrame && window.navigation && typeof window.navigation.addEventListener === 'function') {
          try { window.navigation.addEventListener('navigatesuccess', onNavigateSuccess, { signal }); } catch (_) { /* sin Navigation API */ }
        }
        try {
          mo = new MutationObserver((records) => { if (hasAddedIframe(records)) scheduleFramesChanged(); });
          mo.observe(document, { childList: true, subtree: true });
        } catch (_) {
          mo = null;
        }
        messageListener = onMessage;
        try { chrome.runtime.onMessage.addListener(messageListener); } catch (_) { messageListener = null; }
        active = true;
        return true;
      }
      active = false;
      sendCountZero(); // antes de abortar: pagehide despacha sendMessage de forma síncrona
      if (ac) { ac.abort(); ac = null; }
      if (mo) { mo.disconnect(); mo = null; }
      clearTimeout(framesTimer);
      framesTimer = 0;
      if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = 0; }
      cancelHit();
      clearCurrent();
      hasPointer = false;
      dirty = false;
      if (messageListener) {
        try { chrome.runtime.onMessage.removeListener(messageListener); } catch (_) { /* contexto invalidado */ }
        messageListener = null;
      }
      overlay.unmount();
      disposeSelection();
      resetJob();
      state.frameCounts = {};
      state.partialFrames = false;
      return false;
    }

    function isActive() {
      return active;
    }

    // Marco secundario que se va (pagehide, desactivación) con selección contada en
    // el principal: su recuento pasa a 0 para que la barra no mienta. Directo a
    // chrome.runtime (sin send(): nada de teardown reentrante), sin esperar respuesta.
    function sendCountZero() {
      if (isTopFrame || lastSentCount <= 0) return;
      lastSentCount = 0;
      if (!runtimeAlive()) return;
      try {
        const p = chrome.runtime.sendMessage({ to: 'sw', type: 'imgdl:selection-changed', count: 0 });
        Promise.resolve(p).catch(() => { /* SW sin receptor */ });
      } catch (_) { /* contexto invalidado */ }
    }

    // Destruye la selección del montaje actual (abort → clear sin avisar al SW).
    function disposeSelection() {
      const s = selection;
      selection = null;
      if (selAc) { selAc.abort(); selAc = null; }
      else if (s) { try { s.clear(); } catch (_) { /* nada */ } }
      state.selectionCount = 0;
      state.selectionTotal = 0;
      lastSentCount = 0;
      barShown = false;
    }

    // Selección de este frame (refs JSON-safe) para gatherSelection del SW.
    function collectSelection() {
      if (!selection) return { frameUrl: location.href, items: [] };
      return selection.collectSelection();
    }

    // Limpia la selección local; badges, barra y aviso al SW salen de onChange.
    function clearSelection() {
      if (selection) { selection.clear(); return; }
      state.selectionCount = 0;
      state.selectionTotal = sumValues(state.frameCounts);
    }

    function materialize(id) {
      if (!selection) return Promise.resolve({ id, code: 'ERR_GENERIC', text: fmtCode('ERR_GENERIC') });
      return selection.materialize(id);
    }

    // Hook de pruebas: selecciona sin chip los [data-expect] cuyo valor esté en
    // paths (misma resolución que el hover). Devuelve cuántas claves distintas
    // quedaron seleccionadas en este marco; 0 si no está activo.
    function testSelectExpect(paths) {
      if (!active || !selection) return 0;
      const res = ImgDL.resolve;
      if (!res || typeof res.resolveImageRef !== 'function') return 0;
      const want = new Set((Array.isArray(paths) ? paths : [paths]).map(String));
      const keys = new Set();
      batchingSelection = true;
      try {
        for (const el of document.querySelectorAll('[data-expect]')) {
          if (!want.has(el.getAttribute('data-expect'))) continue;
          let ref = null;
          // Rect en la forma {x,y,w,h} de resolve.rectOf: un DOMRect daría w/h NaN (y estimación 0).
          try {
            const b = el.getBoundingClientRect();
            ref = res.resolveImageRef(el, { rect: { x: b.left, y: b.top, w: b.width, h: b.height } });
          } catch (_) { ref = null; }
          if (!ref || typeof ref.key !== 'string' || !ref.key) continue;
          if (selection.add(ref, el)) keys.add(ref.key);
        }
      } finally {
        batchingSelection = false;
      }
      onSelectionChange(selection.count());
      return keys.size;
    }

    function debugState() {
      const host = overlay.host;
      let rects = null;
      try { rects = overlay.debugRects(); } catch (_) { rects = null; }
      const r = rects || {};
      return {
        active,
        hoverKey: state.hoverKey,
        hoverUrl: state.hoverUrl,
        chipRect: r.chipRect || null,
        chipCells: r.chipCells || null,
        barRect: r.barRect || null,
        selectionCount: state.selectionCount,
        selectionTotal: state.selectionTotal,
        toasts: Array.isArray(r.toasts) ? r.toasts.slice() : [],
        frameCounts: Object.assign({}, state.frameCounts),
        partialFrames: state.partialFrames,
        progressText: state.progressText,
        jobRunning: state.jobRunning,
        jobId: state.jobId,
        chipChecked: r.chipChecked === undefined ? null : r.chipChecked,
        badgeCount: typeof r.badgeCount === 'number' ? r.badgeCount : (Array.isArray(r.badges) ? r.badges.length : 0),
        badges: Array.isArray(r.badges) ? r.badges.map((b) => b.key) : [],
        barState: {
          visible: !!r.barRect,
          count: state.selectionCount,
          total: state.selectionTotal,
          jobRunning: state.jobRunning,
          requesting: state.requesting,
          progressText: state.progressText,
          needsConfirm: state.needsConfirm ? Object.assign({}, state.needsConfirm) : null,
          pendingMode: state.pendingMode,
          text: r.barText || null,
          labels: r.barLabels || null,
          buttons: r.barButtons || null,
          disabled: r.barDisabled || null
        },
        // Accesibilidad: región aria-live, control con el foco y etiquetas de los controles.
        liveText: typeof r.liveText === 'string' ? r.liveText : null,
        activeControl: r.activeControl || null,
        controlLabels: Array.isArray(r.controlLabels) ? r.controlLabels : null,
        barLabel: r.barLabel || null,
        barRole: r.barRole || null,
        barTabStops: Array.isArray(r.barTabStops) ? r.barTabStops : null,
        chipLabel: r.chipLabel || null,
        // Extras de diagnóstico:
        hostMounted: !!(host && host.isConnected),
        hostParent: r.hostParent || null,
        popoverOpen: !!overlay.isPopoverOpen(),
        chipShown,
        dirty,
        scrollHides,
        hoverMsgs: Object.assign({}, hoverMsgs),
        isTopFrame
      };
    }

    return { setActive, isActive, collectSelection, clearSelection, materialize, debugState, testSelectExpect };
  }

  const api = { createController };

  root.ImgDL = root.ImgDL || {};
  root.ImgDL.controller = api;
  root.ImgDL.createController = createController;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
