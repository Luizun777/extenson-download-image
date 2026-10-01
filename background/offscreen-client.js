'use strict';
// Ciclo de vida del documento offscreen desde el SW. Solo puede existir uno
// (downloads-c1): comprobación con runtime.getContexts + UNA promesa de creación
// compartida. Refcount de trabajos y URLs blob vivas; cierre offscreenIdleMs después
// de quedar libre, y solo si el propio documento confirma que está ocioso (el
// refcount se pierde al reiniciar el SW; el documento es la fuente de verdad).
// El cierre se serializa con el uso: `generation` sube en cada retain() y se
// comprueba justo antes de closeDocument (tras cada espera asíncrona), y `closing`
// hace que ensureOffscreen/sendToOffscreen esperen a que termine un cierre en curso.
// Emisor mínimo: 'zip-ready' y 'progress' desde el listener de nivel superior.
(function (root) {
  const ImgDL = root.ImgDL;
  const DEFAULTS = ImgDL.thresholds.DEFAULTS;

  const URL_PATH = 'offscreen/offscreen.html';
  const JUSTIFICATION = 'Crear URLs blob y ensamblar el ZIP de las imágenes seleccionadas';
  const NO_RECEIVER = /Receiving end does not exist|message port closed/i;
  const SEND_RETRIES = [50, 150, 400]; // ms: el documento recién creado puede tardar en escuchar
  const PROGRESS_MAX = 50;

  let creating = null; // promesa compartida (getContexts + createDocument)
  let closing = null; // promesa del closeDocument en curso
  let refcount = 0;
  let generation = 0; // sube en cada retain(): invalida un cierre ocioso ya decidido
  let idleTimer = null;
  let idleMs = DEFAULTS.offscreenIdleMs;
  const listeners = new Map(); // evento -> Set<cb>
  const progressLog = []; // últimos off:progress recibidos (hook de test)

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function hasDocument() {
    if (typeof chrome.runtime.getContexts === 'function') {
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return ctxs.length > 0;
    }
    if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') return chrome.offscreen.hasDocument();
    return false;
  }

  function ensureOffscreen() {
    if (creating) return creating;
    creating = (async () => {
      if (closing) await closing; // no crear encima de un cierre a medias
      if (await hasDocument()) return;
      try {
        await chrome.offscreen.createDocument({ url: URL_PATH, reasons: ['BLOBS'], justification: JUSTIFICATION });
      } catch (e) {
        // Carrera con otro contexto (p. ej. incógnito dividido): ya existe, vale.
        if (!/single offscreen|already exists/i.test(String((e && e.message) || e))) throw e;
      }
    })().finally(() => { creating = null; });
    return creating;
  }

  async function sendRaw(msg) {
    return chrome.runtime.sendMessage(Object.assign({}, msg, { to: 'offscreen' }));
  }

  // ensureOffscreen en cada intento: si el documento se cerró entre medias, se recrea.
  async function sendToOffscreen(msg) {
    let lastErr = null;
    for (let i = 0; i <= SEND_RETRIES.length; i++) {
      await ensureOffscreen();
      try {
        return await sendRaw(msg);
      } catch (e) {
        lastErr = e;
        if (!NO_RECEIVER.test(String((e && e.message) || e)) || i === SEND_RETRIES.length) throw e;
        await sleep(SEND_RETRIES[i]);
      }
    }
    throw lastErr;
  }

  // --- Refcount y cierre ocioso ----------------------------------------------------------------

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function retain() {
    refcount++;
    generation++;
    clearIdle();
    return refcount;
  }

  function release() {
    if (refcount > 0) refcount--;
    return refcount;
  }

  // ¿Sigue siendo válido el cierre decidido en la generación `gen`? Nadie retuvo desde
  // entonces, nada retenido ahora y ninguna creación en curso.
  function canClose(gen) {
    return refcount === 0 && generation === gen && !creating;
  }

  // ¿Ocioso de verdad? Sin refcount, sin trabajos ni fetch en curso ni URLs blob vivas.
  async function documentIdle() {
    if (!(await hasDocument())) return false;
    try {
      const st = await sendRaw({ type: 'off:status' });
      if (!st || !st.ok) return true; // sin respuesta útil: el refcount decide
      return st.jobs === 0 && st.blobUrls === 0 && !(st.fetches > 0);
    } catch (_) {
      return true;
    }
  }

  // Cierra solo si la decisión sigue vigente tras cada espera (gen = generación al decidir).
  async function closeNow(gen) {
    if (!canClose(gen)) return false;
    if (!(await hasDocument())) return false;
    if (!canClose(gen)) return false;
    closing = chrome.offscreen.closeDocument().then(() => true, () => false).finally(() => { closing = null; });
    return closing;
  }

  function closeIfIdle() {
    if (refcount > 0) return;
    clearIdle();
    idleTimer = setTimeout(async () => {
      idleTimer = null;
      const gen = generation;
      if (!canClose(gen)) return;
      try {
        if (await documentIdle()) await closeNow(gen);
      } catch (_) { /* sin documento */ }
    }, idleMs);
  }

  function setIdleMs(ms) {
    idleMs = Number.isFinite(ms) && ms >= 0 ? ms : DEFAULTS.offscreenIdleMs;
    return idleMs;
  }

  // --- Emisor ---------------------------------------------------------------------------------

  function on(event, cb) {
    if (typeof cb !== 'function') return () => {};
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => off(event, cb);
  }

  function off(event, cb) {
    const set = listeners.get(event);
    if (set) set.delete(cb);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return 0;
    for (const cb of Array.from(set)) {
      try { cb(payload); } catch (_) { /* un oyente roto no para a los demás */ }
    }
    return set.size;
  }

  function onZipReady(cb) {
    return on('zip-ready', cb);
  }

  // Listener de nivel superior: sobrevive al reinicio del SW (el ZIP llega como mensaje).
  // Solo mensajes de la propia extensión que no vengan de un content script.
  function onMessage(msg, sender) {
    if (!msg || msg.to !== 'sw' || typeof msg.type !== 'string') return false;
    if (sender && (sender.tab || (sender.id && sender.id !== chrome.runtime.id))) return false;
    if (msg.type === 'off:zip-ready') emit('zip-ready', msg);
    else if (msg.type === 'off:progress') {
      progressLog.push(Object.assign({ at: Date.now() }, msg));
      if (progressLog.length > PROGRESS_MAX) progressLog.shift();
      emit('progress', msg);
    }
    return false; // la respuesta la da el router principal
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(onMessage);
  }

  function lastProgress() {
    return progressLog.map((p) => Object.assign({}, p));
  }

  const api = {
    ensureOffscreen,
    sendToOffscreen,
    retain,
    release,
    closeIfIdle,
    hasDocument,
    setIdleMs,
    on,
    off,
    emit,
    onZipReady,
    lastProgress,
    refcount: () => refcount
  };

  root.ImgDL.offscreen = api;

  // --- Hooks de test ----------------------------------------------------------------------------
  // Se fusionan en una microtarea: service-worker.js asigna root.__imgdlTest tras importScripts,
  // y la microtarea corre cuando ese script ya terminó (antes de cualquier evento).

  let seq = 0;
  const testJobs = new Set(); // jobIds lanzados por zipDirect (no están en el registro de jobs.js)
  let jobsShielded = false;

  // jobs.js revoca la URL blob de todo off:zip-ready de un trabajo que no conoce; los
  // trabajos de prueba se filtran antes de llegar a jobs.onOffscreenMessage (el router
  // del SW lo busca en el objeto ImgDL.jobs en cada llamada). Solo afecta a los tests.
  function shieldTestJobs() {
    if (jobsShielded) return;
    const jobs = root.ImgDL.jobs;
    if (!jobs || typeof jobs.onOffscreenMessage !== 'function') return;
    const orig = jobs.onOffscreenMessage;
    jobs.onOffscreenMessage = (msg) => (msg && testJobs.has(msg.jobId) ? Promise.resolve(false) : orig(msg));
    jobsShielded = true;
  }

  function waitZipReady(jobId) {
    return new Promise((resolve) => {
      const unsub = on('zip-ready', (msg) => {
        if (msg.jobId !== jobId) return;
        unsub();
        resolve(msg);
      });
    });
  }

  // zipDirect(items, opts): items [{id, name, kind, url?, dataUrl?}]; resuelve con el
  // off:zip-ready difundido por el documento y captado por el listener de nivel superior
  // (el mismo camino que producción). Con blobUrl el refcount sigue retenido hasta
  // revoke(blobUrl); con error se libera.
  async function zipDirect(items, opts) {
    const o = opts || {};
    const jobId = o.jobId || 'test-' + Date.now() + '-' + (++seq);
    const list = Array.isArray(items) ? items : [];
    shieldTestJobs();
    testJobs.add(jobId);
    await ensureOffscreen();
    retain();
    const ready = waitZipReady(jobId);
    try {
      for (const it of list) {
        if (typeof it.dataUrl === 'string') {
          await sendToOffscreen({ type: 'off:zip-bytes', jobId, id: it.id, dataUrl: it.dataUrl });
        }
      }
      const r = await sendToOffscreen({
        type: 'off:zip-job',
        jobId,
        items: list.map((it) => ({ id: it.id, name: it.name, kind: it.kind, url: it.url })),
        concurrency: Number.isFinite(o.concurrency) ? o.concurrency : DEFAULTS.fetchConcurrency,
        timeoutMs: Number.isFinite(o.timeoutMs) ? o.timeoutMs : DEFAULTS.fetchTimeoutMs,
        hardBytes: Number.isFinite(o.hardBytes) ? o.hardBytes : DEFAULTS.zipHardBytes,
        addFailedList: o.addFailedList !== false
      });
      if (!r || !r.ok) {
        release();
        closeIfIdle();
        return Object.assign({ jobId }, r || { ok: false, error: 'ERR_GENERIC', code: 'ERR_GENERIC' });
      }
      const result = await ready;
      if (!result.blobUrl) {
        release();
        closeIfIdle();
      }
      return result;
    } catch (e) {
      release();
      closeIfIdle();
      return { jobId, error: (e && e.code) || 'ERR_GENERIC', message: String((e && e.message) || e) };
    }
  }

  async function fetchOne(url, timeoutMs) {
    await ensureOffscreen();
    retain();
    const r = await sendToOffscreen({ type: 'off:fetch-one', url, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULTS.fetchTimeoutMs });
    if (!r || !r.ok) {
      release();
      closeIfIdle();
    }
    return r;
  }

  async function revoke(blobUrl) {
    const r = await sendToOffscreen({ type: 'off:revoke', blobUrl });
    release();
    closeIfIdle();
    return r;
  }

  async function offscreenContexts() {
    if (typeof chrome.runtime.getContexts !== 'function') return (await hasDocument()) ? 1 : 0;
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length;
  }

  const hooks = {
    ensureOffscreen,
    zipDirect,
    fetchOne,
    revoke,
    abortZip: (jobId) => sendToOffscreen({ type: 'off:abort', jobId }),
    offscreenSend: (msg) => sendToOffscreen(msg),
    offscreenStatus: () => sendToOffscreen({ type: 'off:status' }),
    offscreenContexts,
    offscreenRefcount: () => refcount,
    offscreenGeneration: () => generation,
    offscreenRelease: () => { release(); closeIfIdle(); return refcount; },
    setOffscreenIdle: setIdleMs,
    closeOffscreenIfIdle: closeIfIdle,
    offProgress: lastProgress
  };

  queueMicrotask(() => {
    root.__imgdlTest = Object.assign(root.__imgdlTest || {}, hooks);
  });
})(globalThis);
