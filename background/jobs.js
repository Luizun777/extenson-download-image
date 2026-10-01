'use strict';
// Orquestación de lotes (pasos 4-6 y ZIP): recogida de la selección entre marcos,
// materialización de tipos byte (UN ítem por mensaje: el transporte es JSON con tope
// de 64 MiB; las data: también van de una en una), lote de archivos sueltos (cola en
// downloads.js), trabajo ZIP en el documento offscreen, relé de progreso al marco
// principal y registro de trabajos. Un solo trabajo en marcha por pestaña.
// El registro vive en memoria; cada trabajo se espeja en storage.session para que
// off:zip-ready o los ctx restaurados de downloads.js lo cierren tras un reinicio del SW.
// Se carga con importScripts en el SW (y con require en Node para las funciones puras).
(function (root) {
  const lib = (name, file) => (root.ImgDL && root.ImgDL[name]) || (typeof require === 'function' ? require('../lib/' + (file || name) + '.js') : null);
  const strings = lib('strings');
  const urls = lib('urls');
  const thresholds = lib('thresholds');
  const names = lib('names');
  const asyncPool = lib('asyncPool', 'async-pool');
  const D = thresholds.DEFAULTS;

  const JOBS_KEY = 'jobs';
  const DONE_MAX = 20;
  const PROGRESS_MAX = 60;
  const FALLBACK_CONCURRENCY = 2;
  const PIXEL_BYTES = 0.5; // estimación: w*h*0.5 bytes por imagen (JPEG medio)
  const BYTE_KINDS = Object.freeze(['blob', 'canvas', 'svg']);
  const DATA_URL_MAX = Math.ceil(D.maxItemBytes * 4 / 3) + 128; // base64 de maxItemBytes + cabecera
  const LOST_GRACE_MS = 1500; // ctx restaurados: espera antes de dar por perdidos los no llegados
  const SIZE_ERROR = /exceeded maximum allowed size/i; // runtime.sendMessage > 64 MiB

  // --- Estado en memoria ---------------------------------------------------------------
  const registry = new Map(); // jobId -> job
  const activeByTab = new Map(); // tabId -> jobId (un trabajo en marcha por pestaña)
  const doneLog = []; // últimos imgdl:job-done (hook de test)
  const progressLog = []; // últimos imgdl:progress enviados (hook de test)
  const throttles = new Map(); // jobId -> {last, timer, pending}
  let storeQueue = Promise.resolve();
  let seq = 0;

  function hasChrome(ns) {
    return typeof chrome !== 'undefined' && !!chrome && !!chrome[ns];
  }

  function push(ring, item, max) {
    ring.push(item);
    if (ring.length > max) ring.shift();
  }

  function isByteKind(kind) {
    return BYTE_KINDS.indexOf(kind) !== -1;
  }

  function isHttpUrl(u) {
    return typeof u === 'string' && /^https?:/i.test(u);
  }

  function baseName(p) {
    if (typeof p !== 'string' || !p) return '';
    return p.split(/[\\/]/).pop() || '';
  }

  function downloads() {
    return root.ImgDL && root.ImgDL.downloads;
  }

  function offscreen() {
    return root.ImgDL && root.ImgDL.offscreen;
  }

  // Regla DNR de Referer (paso 11, con compuerta): inerte si no se cargó referer-rules.js o
  // falta el permiso declarativeNetRequestWithHostAccess (enabled() false).
  function refererRules() {
    const rr = root.ImgDL && root.ImgDL.refererRules;
    return rr && typeof rr.addRefererRule === 'function' && rr.enabled() ? rr : null;
  }

  // Añade la regla (Referer de la página según refererFor: sin fragmento ni credenciales, solo
  // el origen si algún objetivo es de otro origen) para los hosts dados. null si no aplica.
  async function addReferer(hosts, page, targets) {
    const rr = refererRules();
    if (!rr || !hosts.length) return null;
    const referer = rr.refererFor(page, targets);
    if (!referer) return null;
    try { return await rr.addRefererRule(hosts, referer); } catch (_) { return null; }
  }

  async function removeReferer(id) {
    if (!Number.isInteger(id)) return false;
    const rr = refererRules();
    if (!rr) return false;
    try { return await rr.removeRule(id); } catch (_) { return false; }
  }

  // Retira la regla del trabajo ZIP (idempotente; la primera vía que llega gana).
  function dropJobReferer(job) {
    const id = job && job.refererRuleId;
    if (!Number.isInteger(id)) return Promise.resolve(false);
    job.refererRuleId = null;
    return removeReferer(id);
  }

  // Peldaño 2 de una descarga suelta o de un ítem del lote de archivos (downloads.js): fetch
  // del objetivo actual en el documento offscreen (cookies con credentials:'include', sin CORS
  // por los host_permissions, Referer de la página mientras dura la regla DNR, una regla por
  // fetch). Devuelve la respuesta de off:fetch-one:
  // {ok:true, blobUrl, mime, ext, size} | {ok:false, code}. Con éxito el offscreen queda
  // retenido hasta que downloads.js revoque la URL blob al terminar la descarga (releaseBlob);
  // con fallo se libera aquí. Nunca rechaza.
  async function fetchViaOffscreen(ctx) {
    const off = offscreen();
    const c = ctx || {};
    const url = Array.isArray(c.targets) ? c.targets[c.ti] : c.url;
    if (!off || !isHttpUrl(url)) return { ok: false, code: 'ERR_GENERIC' };
    let retained = false;
    let ruleId = null;
    let result = { ok: false, code: 'ERR_GENERIC' };
    try {
      await off.ensureOffscreen();
      off.retain();
      retained = true;
      const rr = refererRules();
      ruleId = await addReferer(rr ? rr.hostsOf([url]) : [], c.page, [url]);
      const r = await off.sendToOffscreen({ type: 'off:fetch-one', url, timeoutMs: D.fetchTimeoutMs });
      if (r && r.ok && typeof r.blobUrl === 'string') result = r;
      else result = { ok: false, code: (r && (r.code || r.error)) || 'ERR_GENERIC' };
    } catch (e) {
      result = { ok: false, code: errorCode(e, 'NETWORK') };
    } finally {
      await removeReferer(ruleId);
      if (retained && !result.ok) {
        try { off.release(); } catch (_) { /* sin offscreen */ }
        try { off.closeIfIdle(); } catch (_) { /* sin offscreen */ }
      }
    }
    return result;
  }

  // Código de un error: el propio; el de tamaño de runtime.sendMessage → ERR_TOO_BIG_ITEM.
  function errorCode(e, fallback) {
    if (e && typeof e.code === 'string' && e.code) return e.code;
    if (SIZE_ERROR.test(String((e && e.message) || e || ''))) return 'ERR_TOO_BIG_ITEM';
    return fallback || 'ERR_GENERIC';
  }

  function newJobId() {
    seq++;
    return 'job-' + Date.now().toString(36) + '-' + seq + '-' + Math.random().toString(36).slice(2, 6);
  }

  function normalizePage(page) {
    const p = page && typeof page === 'object' ? page : {};
    return {
      url: typeof p.url === 'string' ? p.url : '',
      topUrl: typeof p.topUrl === 'string' ? p.topUrl : '',
      title: typeof p.title === 'string' ? p.title : ''
    };
  }

  // {batch:'Imagenes/<host>_<sello>', zip:'Imagenes/<host>_<sello>.zip'}; sin host en el
  // marco (about:blank) se usa el de la pestaña.
  function pathsFor(page) {
    return names.buildPaths({
      folder: D.folder,
      host: urls.hostOf(page.url) || urls.hostOf(page.topUrl),
      stamp: names.stamp(new Date())
    });
  }

  function splitName(name) {
    const s = String(name == null ? '' : name);
    const i = s.lastIndexOf('.');
    return i > 0 ? { stem: s.slice(0, i), ext: s.slice(i + 1) } : { stem: s, ext: '' };
  }

  // Cambia la extensión conservando la base ('foto.jpg' + 'png' -> 'foto.png').
  function withExt(name, ext) {
    const e = String(ext == null ? '' : ext).toLowerCase().replace(/^\./, '');
    if (!e) return name;
    const p = splitName(name);
    return p.ext.toLowerCase() === e ? name : p.stem + '.' + e;
  }

  // --- Funciones ejecutadas DENTRO de la página (serializadas por executeScript) ---------

  function pageCollect() {
    const c = globalThis.__imgdl;
    return c && typeof c.collectSelection === 'function' ? c.collectSelection() : null;
  }

  function pageClear() {
    const c = globalThis.__imgdl;
    if (c && typeof c.clearSelection === 'function') c.clearSelection();
    return true;
  }

  // Todos los marcos; si alguno rechaza la inyección (sandbox, about:blank), solo el principal.
  async function execAllFrames(tabId, func, args) {
    const req = { func };
    if (args) req.args = args;
    try {
      return await chrome.scripting.executeScript(Object.assign({ target: { tabId, allFrames: true } }, req));
    } catch (_) {
      return await chrome.scripting.executeScript(Object.assign({ target: { tabId, frameIds: [0] } }, req));
    }
  }

  // --- Selección entre marcos ---------------------------------------------------------------

  // Dedupe puro: claves http/data gana la primera (marco 0 primero); las claves de tipo
  // byte son únicas por marco (llevan el id de instancia del marco).
  function flattenSelection(results) {
    const list = (results || [])
      .filter((r) => r && r.result && Array.isArray(r.result.items))
      .map((r) => ({ frameId: typeof r.frameId === 'number' ? r.frameId : 0, frameUrl: r.result.frameUrl, items: r.result.items }))
      .sort((a, b) => a.frameId - b.frameId);
    const seen = new Set();
    const out = [];
    for (const fr of list) {
      for (const it of fr.items) {
        if (!it || typeof it !== 'object') continue;
        const k = (isByteKind(it.kind) ? fr.frameId + '|' : 'g|') + String(it.key);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(Object.assign({}, it, { frameId: fr.frameId, frameUrl: fr.frameUrl }));
      }
    }
    return out;
  }

  async function gatherSelection(tabId) {
    return flattenSelection(await execAllFrames(tabId, pageCollect));
  }

  function clearSelectionAll(tabId) {
    return execAllFrames(tabId, pageClear);
  }

  // Estimación de bytes: w*h*0.5 por ítem con tamaño; sin tamaño solo cuenta.
  function estimateBytes(items) {
    let bytes = 0;
    for (const it of items || []) {
      const w = Number(it && it.w);
      const h = Number(it && it.h);
      if (w > 0 && h > 0) bytes += w * h * PIXEL_BYTES;
    }
    return Math.round(bytes);
  }

  // Tope blando: NEEDS_CONFIRM por encima de zipSoftFiles o zipSoftBytes salvo confirmBig.
  function needsConfirm(items, confirmBig) {
    if (confirmBig) return null;
    const total = items.length;
    const estimatedBytes = estimateBytes(items);
    if (total <= D.zipSoftFiles && estimatedBytes <= D.zipSoftBytes) return null;
    const mb = Math.round(estimatedBytes / (1024 * 1024));
    return { ok: false, code: 'NEEDS_CONFIRM', total, estimatedBytes, text: strings.WARN_BIG(total, mb) };
  }

  // Un ítem por mensaje al marco dueño del elemento.
  async function materializeOne(tabId, frameId, id) {
    const fail = (code) => ({ id, code, text: strings.format(code) });
    if (!hasChrome('tabs')) return fail('ERR_FRAME');
    try {
      const r = await chrome.tabs.sendMessage(tabId, { to: 'content', type: 'imgdl:materialize', id }, { frameId: typeof frameId === 'number' ? frameId : 0 });
      if (r && typeof r === 'object') {
        if (typeof r.dataUrl === 'string') return r;
        return Object.assign({ id }, r, { code: r.code || 'ERR_GENERIC', text: r.text || strings.format(r.code || 'ERR_GENERIC') });
      }
      return fail('ERR_FRAME');
    } catch (_) {
      return fail('ERR_FRAME'); // marco cerrado o sin receptor
    }
  }

  // --- Mensajes al marco principal ------------------------------------------------------------

  function sendToTop(tabId, payload) {
    if (!hasChrome('tabs') || typeof tabId !== 'number') return Promise.resolve(false);
    const msg = Object.assign({ to: 'content' }, payload);
    return Promise.resolve()
      .then(() => chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }))
      .then(() => true, () => false);
  }

  function notifyTop(tabId, msg) {
    return sendToTop(tabId, Object.assign({ type: 'imgdl:notify' }, msg));
  }

  function emitProgress(tabId, payload) {
    const p = Object.assign({ type: 'imgdl:progress' }, payload);
    push(progressLog, Object.assign({ tabId, at: Date.now() }, p), PROGRESS_MAX);
    return sendToTop(tabId, p);
  }

  // Como mucho uno cada progressThrottleMs por trabajo; el último estado nunca se pierde
  // (borde de salida) y flushProgress lo adelanta.
  function progress(tabId, payload) {
    const jobId = payload.jobId;
    const now = Date.now();
    let t = throttles.get(jobId);
    if (!t) {
      t = { last: 0, timer: null, pending: null };
      throttles.set(jobId, t);
    }
    const wait = D.progressThrottleMs - (now - t.last);
    if (wait <= 0 && !t.timer) {
      t.last = now;
      emitProgress(tabId, payload);
      return;
    }
    t.pending = payload;
    if (!t.timer) {
      t.timer = setTimeout(() => {
        t.timer = null;
        const p = t.pending;
        t.pending = null;
        if (p) {
          t.last = Date.now();
          emitProgress(tabId, p);
        }
      }, Math.max(wait, 1));
    }
  }

  function flushProgress(tabId, jobId) {
    const t = throttles.get(jobId);
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    throttles.delete(jobId);
    if (t.pending) emitProgress(tabId, t.pending);
  }

  // --- Registro y espejo en storage.session ---------------------------------------------------

  // Un trabajo por pestaña: el segundo 'Descargar…' (doble clic) responde JOB_RUNNING.
  function busyReply(tabId) {
    const id = activeByTab.get(tabId);
    if (id === undefined) return null;
    if (!registry.has(id)) {
      activeByTab.delete(tabId); // registro perdido: no bloquear la pestaña
      return null;
    }
    return { ok: false, code: 'JOB_RUNNING', jobId: id, text: strings.ERR_JOB_RUNNING };
  }

  function createJob(kind, tabId, page, extra) {
    const job = Object.assign({
      jobId: newJobId(),
      kind,
      tabId,
      page,
      abort: new AbortController(),
      cancelled: false,
      dispatched: false,
      retained: false,
      finished: false,
      pre: [],
      sent: 0,
      done: 0,
      failed: 0,
      failures: [],
      startedAt: Date.now()
    }, extra || {});
    registry.set(job.jobId, job);
    activeByTab.set(tabId, job.jobId);
    return job;
  }

  // Copia serializable (sin AbortController ni callbacks) para storage.session.
  function storedRecord(job) {
    return {
      jobId: job.jobId,
      kind: job.kind,
      tabId: job.tabId,
      page: job.page,
      zipName: job.zipName,
      folder: job.folder,
      total: job.total,
      sent: job.sent,
      pre: job.pre,
      done: job.done,
      failed: job.failed,
      failures: job.failures,
      dispatched: !!job.dispatched,
      refererRuleId: Number.isInteger(job.refererRuleId) ? job.refererRuleId : undefined,
      downloadId: typeof job.downloadId === 'number' ? job.downloadId : undefined,
      cancelled: !!job.cancelled,
      startedAt: job.startedAt
    };
  }

  function withStore(fn) {
    const run = async () => {
      if (!hasChrome('storage') || !chrome.storage.session) return;
      try { await fn(); } catch (_) { /* sin storage */ }
    };
    storeQueue = storeQueue.then(run, run);
    return storeQueue;
  }

  async function readStored() {
    try {
      const got = await chrome.storage.session.get(JOBS_KEY);
      const all = got && got[JOBS_KEY];
      return all && typeof all === 'object' ? all : {};
    } catch (_) {
      return {};
    }
  }

  function remember(job) {
    if (job.finished) return Promise.resolve(); // nunca reescribir un trabajo ya olvidado
    const rec = storedRecord(job);
    return withStore(async () => {
      const all = await readStored();
      all[rec.jobId] = rec;
      await chrome.storage.session.set({ [JOBS_KEY]: all });
    });
  }

  function forget(jobId) {
    return withStore(async () => {
      const all = await readStored();
      if (!(jobId in all)) return;
      delete all[jobId];
      await chrome.storage.session.set({ [JOBS_KEY]: all });
    });
  }

  // Tras un reinicio del SW: reconstruye el trabajo desde el espejo. Un ZIP vuelve a
  // retener el documento offscreen (finish lo libera); un lote de archivos no tiene cola:
  // lo cierran los ctx restaurados de downloads.js (onRestoredDone) o cancel().
  async function revive(jobId) {
    if (registry.has(jobId)) return registry.get(jobId);
    await storeQueue;
    if (!hasChrome('storage') || !chrome.storage.session) return null;
    const rec = (await readStored())[jobId];
    if (!rec || typeof rec !== 'object') return null;
    if (registry.has(jobId)) return registry.get(jobId);
    const job = Object.assign({}, rec, {
      abort: new AbortController(),
      dispatched: rec.dispatched === true,
      retained: false,
      revived: true,
      finished: false,
      pre: Array.isArray(rec.pre) ? rec.pre : [],
      failures: Array.isArray(rec.failures) ? rec.failures : [],
      done: Number(rec.done) || 0,
      failed: Number(rec.failed) || 0
    });
    registry.set(jobId, job);
    if (!activeByTab.has(job.tabId)) activeByTab.set(job.tabId, jobId);
    const off = offscreen();
    if (job.kind === 'zip' && off && typeof off.retain === 'function') {
      off.retain();
      job.retained = true;
    }
    return job;
  }

  function releaseJob(job) {
    if (!job.retained) return;
    job.retained = false;
    const off = offscreen();
    if (!off) return;
    try { off.release(); } catch (_) { /* sin offscreen */ }
    try { off.closeIfIdle(); } catch (_) { /* sin offscreen */ }
  }

  // Cierre idempotente: la primera vía que llega gana (cola, zip-ready, ctx restaurado o cancel).
  function finish(job, payload) {
    if (job.finished) return Promise.resolve(false);
    job.finished = true;
    if (job.lostTimer) {
      clearTimeout(job.lostTimer);
      job.lostTimer = null;
    }
    releaseJob(job);
    dropJobReferer(job); // red de seguridad: lo normal es retirarla al llegar off:zip-ready
    const p = Object.assign({ type: 'imgdl:job-done', jobId: job.jobId, kind: job.kind }, payload);
    flushProgress(job.tabId, job.jobId);
    push(doneLog, Object.assign({ tabId: job.tabId, at: Date.now() }, p), DONE_MAX);
    registry.delete(job.jobId);
    if (activeByTab.get(job.tabId) === job.jobId) activeByTab.delete(job.tabId);
    forget(job.jobId);
    return sendToTop(job.tabId, p);
  }

  function errorText(code) {
    return strings.format(code);
  }

  function failPayload(job, code, failures) {
    const c = code === 'ABORTED' || code === 'USER_CANCELED' ? 'CANCELLED' : (code || 'ERR_GENERIC');
    return {
      ok: false,
      code: c,
      done: 0,
      failed: job.total,
      fallback: 0,
      total: job.total,
      failures: Array.isArray(failures) ? failures : [],
      text: errorText(c)
    };
  }

  function thinFailure(f) {
    return { name: f && f.name, url: f && typeof f.url === 'string' ? f.url : '', reason: (f && f.reason) || 'ERR_GENERIC' };
  }

  // --- Lote de archivos sueltos ------------------------------------------------------------------

  async function runFilesJob(tabId, page, opts) {
    const o = opts || {};
    const busy = busyReply(tabId);
    if (busy) return busy;
    const items = await gatherSelection(tabId);
    if (!items.length) return { ok: false, code: 'EMPTY', text: strings.format('EMPTY') };
    const confirm = needsConfirm(items, o.confirmBig);
    if (confirm) return confirm;
    const late = busyReply(tabId); // tras los awaits: el primero en registrarse gana
    if (late) return late;
    const pg = normalizePage(page);
    const paths = pathsFor(pg);
    const planned = names.planNames(items);
    const job = createJob('files', tabId, pg, { total: planned.length, folder: paths.batch });
    await remember(job);
    runFiles(job, planned).catch((e) => finish(job, failPayload(job, errorCode(e), job.failures.map(thinFailure))));
    return { ok: true, jobId: job.jobId, total: planned.length };
  }

  async function runFiles(job, planned) {
    const dl = downloads();
    const onProgress = (p) => progress(job.tabId, Object.assign({ jobId: job.jobId, phase: 'files' }, p));
    // Avance por ítem al espejo: tras un reinicio del SW, onRestoredDone sigue contando desde aquí.
    const onItem = (r, i, item) => {
      if (job.finished) return;
      if (r && r.ok) job.done++;
      else {
        job.failed++;
        job.failures.push({ name: item.fileName || item.name || '', url: isHttpUrl(item.url) ? item.url : '', reason: (r && r.code) || 'ERR_GENERIC' });
      }
      remember(job);
    };
    const res = await dl.runFilesQueue(planned, job.folder, job.tabId, onProgress, {
      page: job.page,
      signal: job.abort.signal,
      jobId: job.jobId,
      materialize: (frameId, id) => materializeOne(job.tabId, frameId, id),
      onItem
    });
    if (job.finished) return false; // cerrado por los ctx restaurados (memoria perdida a medias)
    const cancelled = job.cancelled || job.abort.signal.aborted;
    const payload = {
      ok: !cancelled,
      done: res.done,
      failed: res.failed,
      fallback: 0,
      total: planned.length,
      failures: (res.failures || []).map(thinFailure),
      text: cancelled ? strings.CANCELLED : strings.SUMMARY_FILES(res.done, res.failed)
    };
    if (cancelled) payload.code = 'CANCELLED';
    return finish(job, payload);
  }

  // ctx pendientes en downloads.js que pertenecen a un trabajo (tras un reinicio: los en vuelo).
  function pendingOfJob(jobId) {
    const dl = downloads();
    if (!dl || typeof dl.pendingSnapshot !== 'function') return [];
    const out = [];
    for (const [id, ctx] of Object.entries(dl.pendingSnapshot())) {
      if (ctx && ctx.jobId === jobId) out.push({ downloadId: Number(id), ctx });
    }
    return out;
  }

  function cancelPendingOf(jobId) {
    if (!hasChrome('downloads')) return;
    for (const p of pendingOfJob(jobId)) {
      Promise.resolve().then(() => chrome.downloads.cancel(p.downloadId)).catch(() => {}); // ya terminada
    }
  }

  // Lote de archivos cerrado desde los ctx restaurados: los ítems que nunca arrancaron
  // (cola perdida con el SW) cuentan como fallidos.
  function finishFilesRestored(job) {
    const lost = Math.max(0, job.total - job.done - job.failed);
    const failed = job.failed + lost;
    const cancelled = !!job.cancelled;
    const payload = {
      ok: !cancelled,
      done: job.done,
      failed,
      fallback: 0,
      total: job.total,
      failures: job.failures.map(thinFailure),
      text: cancelled ? strings.CANCELLED : strings.SUMMARY_FILES(job.done, failed)
    };
    if (cancelled) payload.code = 'CANCELLED';
    return finish(job, payload);
  }

  async function onRestoredFiles(ctx, result) {
    const job = await revive(ctx.jobId);
    if (!job || job.finished) return false;
    const r = result && typeof result === 'object' ? result : { ok: false, code: 'ERR_GENERIC' };
    if (r.ok) job.done++;
    else {
      job.failed++;
      const code = r.code === 'USER_CANCELED' || r.code === 'ABORTED' ? 'CANCELLED' : (r.code || 'ERR_GENERIC');
      job.failures.push({ name: baseName(ctx.filename) || (ctx.ref && ctx.ref.name) || '', url: ctx.ref && isHttpUrl(ctx.ref.url) ? ctx.ref.url : '', reason: code });
    }
    progress(job.tabId, { jobId: job.jobId, phase: 'files', done: job.done, failed: job.failed, total: job.total, bytes: 0 });
    if (job.done + job.failed >= job.total) return finishFilesRestored(job);
    await remember(job);
    if (job.lostTimer) clearTimeout(job.lostTimer);
    // Sin más descargas en vuelo de este trabajo: gracia breve (otro onChanged simultáneo
    // puede estar en camino) y cierre con los no llegados como fallidos.
    job.lostTimer = setTimeout(() => {
      job.lostTimer = null;
      if (job.finished) return;
      if (pendingOfJob(job.jobId).length === 0 && fetchingOfJob(job.jobId) === 0) finishFilesRestored(job);
    }, LOST_GRACE_MS);
    return true;
  }

  // Ítems del trabajo en el peldaño 2 (fetch en el offscreen en vuelo, aún sin descarga pendiente).
  function fetchingOfJob(jobId) {
    const dl = downloads();
    return dl && typeof dl.fetchingOfJob === 'function' ? dl.fetchingOfJob(jobId) : 0;
  }

  // ¿Puede un ítem subir al peldaño 2? (downloads.startRung2 lo consulta antes del fetch y antes
  // de descargar la blob.) Sueltas: siempre. Ítems de lote: solo si su trabajo sigue vivo (ni
  // cancelado ni cerrado; se revive el espejo tras un reinicio del SW).
  async function rung2Allowed(ctx) {
    const jobId = ctx && ctx.jobId;
    if (!jobId) return true;
    const job = await revive(jobId);
    return !!job && !job.cancelled && !job.finished;
  }

  // --- Trabajo ZIP ---------------------------------------------------------------------------------

  async function runZipJob(tabId, page, opts) {
    const o = opts || {};
    const busy = busyReply(tabId);
    if (busy) return busy;
    const items = await gatherSelection(tabId);
    if (!items.length) return { ok: false, code: 'EMPTY', text: strings.format('EMPTY') };
    if (items.length > D.zipMaxEntries) return { ok: false, code: 'ERR_ZIP_TOO_MANY', text: strings.ERR_ZIP_TOO_MANY };
    const confirm = needsConfirm(items, o.confirmBig);
    if (confirm) return confirm;
    if (!offscreen()) return { ok: false, code: 'ERR_GENERIC', text: strings.ERR_GENERIC };
    const late = busyReply(tabId); // tras los awaits: el primero en registrarse gana
    if (late) return late;
    const pg = normalizePage(page);
    const paths = pathsFor(pg);
    const planned = names.planNames(items);
    const job = createJob('zip', tabId, pg, { total: planned.length, folder: paths.batch, zipName: paths.zip });
    await remember(job);
    runZip(job, planned).catch((e) => {
      releaseJob(job);
      const code = errorCode(e);
      notifyTop(job.tabId, { level: 'error', code, text: errorText(code) });
      finish(job, failPayload(job, code, job.pre.map(thinFailure)));
    });
    return { ok: true, jobId: job.jobId, total: planned.length };
  }

  // id único en el offscreen: el id de ImageRef es un contador por marco.
  function offscreenId(item) {
    return String(item.frameId) + ':' + String(item.id);
  }

  // Bytes de un ítem al offscreen (off:zip-bytes), uno por mensaje. {ok} | {ok:false, code}.
  async function stashBytes(job, id, dataUrl) {
    const off = offscreen();
    let r = null;
    try {
      r = await off.sendToOffscreen({ type: 'off:zip-bytes', jobId: job.jobId, id, dataUrl });
    } catch (e) {
      return { ok: false, code: errorCode(e) };
    }
    if (!r || !r.ok) return { ok: false, code: (r && (r.code || r.error)) || 'ERR_GENERIC' };
    return { ok: true };
  }

  async function runZip(job, planned) {
    const off = offscreen();
    await off.ensureOffscreen();
    off.retain();
    job.retained = true;
    const sent = [];
    for (const it of planned) {
      if (job.abort.signal.aborted) break;
      const entry = { id: offscreenId(it), name: it.fileName, kind: it.kind };
      if (isByteKind(it.kind)) {
        const m = await materializeOne(job.tabId, it.frameId, it.id);
        if (job.abort.signal.aborted) break;
        if (!m || typeof m.dataUrl !== 'string') {
          job.pre.push({ id: entry.id, name: it.fileName, url: '', reason: (m && m.code) || 'ERR_GENERIC' });
          continue;
        }
        if (m.ext) entry.name = withExt(entry.name, m.ext);
        const r = await stashBytes(job, entry.id, m.dataUrl);
        if (!r.ok) {
          job.pre.push({ id: entry.id, name: it.fileName, url: '', reason: r.code });
          continue;
        }
      } else if (it.kind === 'data') {
        // data: también de una en una (tope de 64 MiB por mensaje); por encima de maxItemBytes no cabe.
        if (typeof it.url !== 'string' || it.url.length > DATA_URL_MAX) {
          job.pre.push({ id: entry.id, name: it.fileName, url: '', reason: 'ERR_TOO_BIG_ITEM' });
          continue;
        }
        const r = await stashBytes(job, entry.id, it.url);
        if (!r.ok) {
          job.pre.push({ id: entry.id, name: it.fileName, url: '', reason: r.code });
          continue;
        }
      } else {
        entry.url = it.url;
      }
      sent.push(entry);
    }
    if (job.abort.signal.aborted) {
      releaseJob(job);
      notifyTop(job.tabId, { level: 'info', code: 'CANCELLED', text: strings.CANCELLED });
      return finish(job, failPayload(job, 'CANCELLED', job.pre.map(thinFailure)));
    }
    job.sent = sent.length;
    await remember(job);
    if (!sent.length) {
      releaseJob(job);
      const code = (job.pre[0] && job.pre[0].reason) || 'ERR_GENERIC';
      notifyTop(job.tabId, { level: 'error', code, text: errorText(code) });
      return finish(job, failPayload(job, code, job.pre.map(thinFailure)));
    }
    // Referer de la página para los fetch http del offscreen (paso 11): la regla vive hasta
    // off:zip-ready; su id se espeja para poder retirarla tras un reinicio del SW.
    const rr = refererRules();
    if (rr) {
      const httpUrls = sent.filter((e) => isHttpUrl(e.url)).map((e) => e.url);
      job.refererRuleId = await addReferer(rr.hostsOf(httpUrls), job.page, httpUrls);
      if (Number.isInteger(job.refererRuleId)) await remember(job);
    }
    const r = await off.sendToOffscreen({
      type: 'off:zip-job',
      jobId: job.jobId,
      items: sent,
      concurrency: D.fetchConcurrency,
      timeoutMs: D.fetchTimeoutMs,
      hardBytes: D.zipHardBytes,
      addFailedList: true
    });
    if (!r || !r.ok) {
      const e = new Error('el offscreen no aceptó el trabajo');
      e.code = (r && (r.code || r.error)) || 'ERR_GENERIC';
      throw e;
    }
    job.dispatched = true;
    await remember(job); // tras un reinicio, cancel sabe que el offscreen tiene el trabajo
    // Cancelado entre la comprobación y el despacho: abortar ahora en el offscreen.
    if (job.cancelled) await abortOffscreen(job.jobId);
    // El resto llega como off:zip-ready (listener de nivel superior).
    return true;
  }

  // off:abort sin crear un documento para ello. true solo si el offscreen conocía el trabajo
  // (entonces responderá con off:zip-ready CANCELLED).
  async function abortOffscreen(jobId) {
    const off = offscreen();
    if (!off) return false;
    try {
      if (typeof off.hasDocument === 'function' && !(await off.hasDocument())) return false;
      const r = await off.sendToOffscreen({ type: 'off:abort', jobId });
      return !!(r && r.ok && r.found !== false);
    } catch (_) {
      return false;
    }
  }

  async function revokeBlob(blobUrl) {
    const off = offscreen();
    if (!off || typeof blobUrl !== 'string') return;
    try { await off.sendToOffscreen({ type: 'off:revoke', blobUrl }); } catch (_) { /* documento cerrado */ }
  }

  // Descarga del ZIP: resuelve al terminar (complete/interrupted) o al no poder iniciarse.
  // {result, started}: al arrancar, el ctx pendiente (blobUrl) pasa a ser quien revoca y
  // libera el offscreen (gancho de downloads), así que el trabajo deja de retenerlo.
  function downloadZip(job, blobUrl) {
    const dl = downloads();
    return new Promise((resolve) => {
      let started = false;
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolve({ result: result || { ok: false, code: 'ERR_GENERIC', text: errorText('ERR_GENERIC') }, started });
      };
      const ctx = {
        ref: { kind: 'http', name: splitName(job.zipName.split('/').pop()).stem, url: '' },
        page: job.page,
        tabId: job.tabId,
        frameId: 0,
        kind: 'zip',
        jobId: job.jobId,
        filename: job.zipName,
        ext: 'zip',
        quiet: true,
        onDone: settle
      };
      dl.downloadBlobUrl(ctx, blobUrl).then(
        (r) => {
          if (r && r.ok) {
            started = true;
            job.downloadId = r.downloadId;
            job.retained = false;
            remember(job);
          } else {
            settle(r);
          }
        },
        (e) => settle({ ok: false, code: errorCode(e), text: errorText(errorCode(e)) })
      );
    });
  }

  // Fallidas http del ZIP: descarga directa (SOLO peldaño 1, cookies del navegador, sin CORS;
  // rung2:false porque el offscreen ya hizo ese mismo fetch y falló) en la carpeta del lote,
  // concurrencia 2. Devuelve {fallback, remaining}.
  async function fallbackDownloads(job, failures) {
    const dl = downloads();
    const http = failures.filter((f) => isHttpUrl(f.url));
    let fallback = 0;
    const remaining = [];
    if (http.length) {
      const worker = (f) => new Promise((resolve) => {
        const ctx = {
          ref: { kind: 'http', url: f.url, name: splitName(f.name).stem },
          page: job.page,
          tabId: job.tabId,
          frameId: 0,
          folder: job.folder,
          quiet: true,
          rung2: false,
          onDone: resolve
        };
        dl.downloadDirect(ctx).then(
          (r) => { if (!r || !r.ok) resolve(r || { ok: false, code: 'ERR_GENERIC' }); },
          (e) => resolve({ ok: false, code: errorCode(e) })
        );
      });
      await asyncPool.pool(http, FALLBACK_CONCURRENCY, worker, {
        onSettled: (res, i, f) => {
          const r = res && res.ok ? res.value : null;
          if (r && r.ok) fallback++;
          else remaining.push(Object.assign({}, f, { reason: (r && r.code) || f.reason || 'ERR_GENERIC' }));
        }
      });
    }
    for (const f of failures) if (!isHttpUrl(f.url)) remaining.push(f);
    return { fallback, remaining };
  }

  async function handleZipReady(msg) {
    const jobId = msg.jobId;
    const job = await revive(jobId);
    if (!job || job.finished) {
      if (msg.blobUrl) revokeBlob(msg.blobUrl); // trabajo desconocido o ya cerrado: no dejar la blob URL viva
      return false;
    }
    await dropJobReferer(job); // los fetch del offscreen ya terminaron
    if (msg.error) {
      const code = msg.error === 'CANCELLED' || msg.error === 'ABORTED' ? 'CANCELLED' : String(msg.error);
      releaseJob(job);
      notifyTop(job.tabId, { level: code === 'CANCELLED' ? 'info' : 'error', code, text: errorText(code) });
      return finish(job, failPayload(job, code, job.pre.map(thinFailure)));
    }
    if (job.cancelled) {
      await revokeBlob(msg.blobUrl);
      releaseJob(job);
      notifyTop(job.tabId, { level: 'info', code: 'CANCELLED', text: strings.CANCELLED });
      return finish(job, failPayload(job, 'CANCELLED', job.pre.map(thinFailure)));
    }
    const failures = (Array.isArray(msg.failures) ? msg.failures : []).map(thinFailure);
    const okCount = Math.max(0, job.sent - failures.length);
    flushProgress(job.tabId, jobId);
    emitProgress(job.tabId, { jobId, phase: 'saving', done: okCount, failed: failures.length, total: job.total, bytes: Number(msg.size) || 0 });
    const { result, started } = await downloadZip(job, msg.blobUrl);
    if (!started) {
      await revokeBlob(msg.blobUrl);
      releaseJob(job);
    }
    if (!result.ok) {
      const code = result.code === 'USER_CANCELED' ? 'CANCELLED' : (result.code || 'ERR_GENERIC');
      notifyTop(job.tabId, { level: code === 'CANCELLED' ? 'info' : 'error', code, text: errorText(code) });
      return finish(job, failPayload(job, code, failures.concat(job.pre.map(thinFailure))));
    }
    const fb = await fallbackDownloads(job, failures);
    const remaining = fb.remaining.concat(job.pre.map(thinFailure));
    return finish(job, {
      ok: true,
      done: okCount,
      failed: remaining.length,
      fallback: fb.fallback,
      total: job.total,
      zipFilename: result.filename,
      failures: remaining,
      text: strings.SUMMARY_ZIP(okCount, job.total, fb.fallback)
    });
  }

  async function handleOffProgress(msg) {
    const job = await revive(msg.jobId);
    if (!job || job.finished) return false;
    progress(job.tabId, {
      jobId: msg.jobId,
      phase: typeof msg.phase === 'string' ? msg.phase : 'fetching',
      done: Number(msg.done) || 0,
      failed: Number(msg.failed) || 0,
      total: Number(msg.total) || job.total || 0,
      bytes: Number(msg.bytes) || 0
    });
    return true;
  }

  // Mensajes del offscreen (to:'sw'). Nunca rechaza.
  async function onOffscreenMessage(msg) {
    try {
      if (!msg || typeof msg.type !== 'string') return false;
      if (msg.type === 'off:progress') return await handleOffProgress(msg);
      if (msg.type === 'off:zip-ready') return await handleZipReady(msg);
      return false;
    } catch (_) {
      return false;
    }
  }

  // Ctx restaurado tras un reinicio (sin onDone): cierra el trabajo con lo que hay.
  // ZIP: el único ítem es el .zip; archivos: un ítem más del lote (onRestoredFiles).
  async function onRestoredDone(ctx, result) {
    try {
      if (!ctx || !ctx.jobId) return false;
      if (ctx.kind === 'files') return await onRestoredFiles(ctx, result);
      if (ctx.kind !== 'zip') return false;
      const job = await revive(ctx.jobId);
      if (!job || job.finished) return false;
      if (result && result.ok && !job.cancelled) {
        return finish(job, { ok: true, done: job.sent, failed: 0, fallback: 0, total: job.total, zipFilename: result.filename, failures: [], text: strings.SUMMARY_ZIP(job.sent, job.total, 0) });
      }
      const code = job.cancelled || (result && result.code === 'USER_CANCELED') ? 'CANCELLED' : ((result && result.code) || 'ERR_GENERIC');
      return finish(job, failPayload(job, code));
    } catch (_) {
      return false;
    }
  }

  // --- Cancelación ---------------------------------------------------------------------------------
  // Siempre acaba en un imgdl:job-done: en memoria lo cierra la vía en curso (cola de archivos
  // por su señal, off:zip-ready CANCELLED o la descarga del ZIP cancelada); si no hay nadie
  // que lo haga (trabajo revivido, ZIP sin despachar o desconocido para el offscreen), aquí.
  async function cancel(jobId) {
    const job = registry.get(jobId) || (await revive(jobId));
    if (!job) return { ok: false, code: 'ERR_GENERIC', text: strings.ERR_GENERIC };
    if (job.cancelled || job.finished) return { ok: true, jobId };
    job.cancelled = true;
    try { job.abort.abort(); } catch (_) { /* ya abortado */ }
    let closeHere = !!job.revived;
    if (job.kind === 'zip') {
      let found = false;
      if (job.dispatched) found = await abortOffscreen(jobId);
      else abortOffscreen(jobId); // libera el stash si lo hubiera
      if (typeof job.downloadId === 'number' && hasChrome('downloads')) {
        try { await chrome.downloads.cancel(job.downloadId); } catch (_) { /* ya terminada */ }
      } else if (!job.dispatched || !found) closeHere = true;
    } else if (job.revived) {
      cancelPendingOf(jobId); // sin cola en memoria: cancelar las descargas en vuelo en Chrome
    }
    if (closeHere) {
      const failures = job.kind === 'zip' ? job.pre.map(thinFailure) : job.failures.map(thinFailure);
      finish(job, failPayload(job, 'CANCELLED', failures));
    } else {
      remember(job);
    }
    return { ok: true, jobId };
  }

  // --- Hooks de test -------------------------------------------------------------------------------

  function lastJobDone() {
    return doneLog.map((e) => Object.assign({}, e, { failures: (e.failures || []).map((f) => Object.assign({}, f)) }));
  }

  function lastProgress() {
    return progressLog.map((e) => Object.assign({}, e));
  }

  function jobsSnapshot() {
    const out = {};
    for (const [id, j] of registry) {
      out[id] = { kind: j.kind, tabId: j.tabId, total: j.total, sent: j.sent, done: j.done, failed: j.failed, cancelled: !!j.cancelled, dispatched: !!j.dispatched, retained: !!j.retained, revived: !!j.revived };
    }
    return out;
  }

  function activeJobs() {
    return Object.fromEntries(activeByTab);
  }

  const api = {
    BYTE_KINDS,
    gatherSelection,
    flattenSelection,
    clearSelectionAll,
    estimateBytes,
    needsConfirm,
    materializeOne,
    fetchViaOffscreen,
    rung2Allowed,
    runFilesJob,
    runZipJob,
    cancel,
    onOffscreenMessage,
    onRestoredDone,
    registry,
    lastJobDone,
    lastProgress,
    jobsSnapshot,
    activeJobs,
    withExt,
    errorCode
  };

  root.ImgDL = root.ImgDL || {};
  root.ImgDL.jobs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
