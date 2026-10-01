'use strict';
// Escalera de descarga y seguimiento de descargas pendientes: peldaño 1
// (chrome.downloads.download directo), peldaño 2 (fetch del MISMO objetivo en el documento
// offscreen: cookies, sin CORS, Referer si hay regla DNR; jobs.fetchViaOffscreen) y
// peldaño 3 (aviso al frame de origen con "Copiar URL"). Objetivos [fullSizeHint, url]: si
// el primero falla en el peldaño 1 (rechazo de download(), interrupción de red/HTTP o
// guarda MIME) se borra su ítem, se intenta el peldaño 2 de ese objetivo y, si también falla,
// se pasa al siguiente antes de avisar. El peldaño 2 vale para las descargas sueltas (chip) y
// para los ítems del lote de archivos (quiet: sin avisos al marco, el resumen lo da job-done;
// solo si su trabajo sigue vivo, jobs.rung2Allowed); la reserva por archivo del ZIP pasa
// rung2:false (el offscreen ya hizo ese fetch y falló). Una descarga blob del peldaño 2 que se
// interrumpe no vuelve a los peldaños 1/2: va al 3. Se carga con importScripts en el SW y
// con require en Node (funciones puras; con un chrome simulado, el resto).
(function (root) {
  const lib = (name) => (root.ImgDL && root.ImgDL[name]) || (typeof require === 'function' ? require('../lib/' + name + '.js') : null);
  const strings = lib('strings');
  const urls = lib('urls');
  const thresholds = lib('thresholds');
  const names = lib('names');
  const asyncPool = (root.ImgDL && root.ImgDL.asyncPool) || (typeof require === 'function' ? require('../lib/async-pool.js') : null);

  const PENDING_KEY = 'pending';
  const BYTE_KINDS = ['blob', 'canvas', 'svg'];
  const LOG_MAX = 50;
  const NOTIFY_MAX = 20;
  const DISCARDED_MAX = 20;
  const EARLY_MAX = 20;
  const FALLBACK_BASE = 'imagen';
  const SLIM_MAX = 512;

  // Interrupciones del peldaño 1 que pasan al peldaño 2 (fetch en offscreen) con el código
  // de reserva para el peldaño 3: 403/401 → ERR_403, el resto → ERR_NETWORK.
  const RUNG2_ERRORS = Object.freeze({
    SERVER_FORBIDDEN: 'HTTP_403',
    SERVER_UNAUTHORIZED: 'HTTP_403',
    SERVER_FAILED: 'NETWORK',
    SERVER_BAD_CONTENT: 'NETWORK',
    NETWORK_FAILED: 'NETWORK',
    NETWORK_TIMEOUT: 'NETWORK',
    NETWORK_SERVER_DOWN: 'NETWORK'
  });

  // --- Estado en memoria ---------------------------------------------------------------
  // pending se espeja en storage.session y se restaura de forma perezosa (primer uso
  // tras un reinicio del SW). Las entradas restauradas no conservan callbacks.
  const pending = new Map(); // downloadId -> ctx
  const fetching = new Set(); // ctx en el peldaño 2 (fetch en vuelo, aún sin descarga pendiente)
  const early = new Map(); // deltas llegados antes de registrar su id (carrera download()↔onChanged)
  const notifyLog = []; // últimos avisos enviados a los frames (hook de test)
  const discardedLog = []; // descargas borradas por la guarda MIME (hook de test)
  const ownLog = []; // opciones de download() cuando no existe ImgDL.downloadLog (Node)
  let restorePromise = null;
  let mirrorQueue = Promise.resolve();
  let fallbackSeq = 0;

  function hasChrome(ns) {
    return typeof chrome !== 'undefined' && !!chrome && !!chrome[ns];
  }

  function push(ring, item, max) {
    ring.push(item);
    if (ring.length > max) ring.shift();
  }

  function isHttpUrl(u) {
    return typeof u === 'string' && /^https?:/i.test(u);
  }

  function isDataUrl(u) {
    return typeof u === 'string' && /^data:/i.test(u);
  }

  function baseName(p) {
    if (typeof p !== 'string' || !p) return '';
    return p.split(/[\\/]/).pop() || '';
  }

  function normalizeMime(mime) {
    return String(mime == null ? '' : mime).split(';')[0].trim().toLowerCase();
  }

  // Guarda MIME: HTML o cualquier tipo declarado que no sea imagen ni binario genérico.
  function isNotImage(mime) {
    const m = normalizeMime(mime);
    if (!m) return false;
    if (m === 'text/html') return true;
    return !names.isImageMime(m) && m !== 'application/octet-stream';
  }

  // Cadenas largas (data URLs) fuera de storage.session y de los snapshots.
  function slimData(u) {
    return isDataUrl(u) && u.length > SLIM_MAX ? u.slice(0, 64) + '…(' + u.length + ')' : u;
  }

  function slimAny(s) {
    return typeof s === 'string' && s.length > SLIM_MAX ? s.slice(0, 64) + '…(' + s.length + ')' : s;
  }

  function slimRef(ref) {
    const r = ref || {};
    return {
      key: slimAny(r.key),
      kind: r.kind,
      url: slimAny(r.url),
      fullSizeHint: slimAny(r.fullSizeHint),
      name: r.name,
      w: r.w,
      h: r.h,
      id: r.id
    };
  }

  // Copia serializable del contexto (sin callbacks ni data URLs) para el espejo y los tests.
  function slim(ctx) {
    return {
      ref: slimRef(ctx.ref),
      page: ctx.page,
      tabId: ctx.tabId,
      frameId: ctx.frameId,
      folder: ctx.folder,
      targets: (ctx.targets || []).map(slimData),
      ti: ctx.ti,
      rung: ctx.rung,
      ext: ctx.ext,
      filename: ctx.filename,
      blobUrl: ctx.blobUrl,
      kind: ctx.kind,
      jobId: ctx.jobId,
      itemIndex: ctx.itemIndex,
      quiet: ctx.quiet === true,
      startedAt: ctx.startedAt
    };
  }

  function pendingSnapshot() {
    const out = {};
    for (const [id, ctx] of pending) out[id] = slim(ctx);
    return out;
  }

  // --- Espejo en storage.session ------------------------------------------------------

  function mirror() {
    const snap = pendingSnapshot();
    const run = async () => {
      if (!hasChrome('storage') || !chrome.storage.session) return;
      try { await chrome.storage.session.set({ [PENDING_KEY]: snap }); } catch (_) { /* sin storage */ }
    };
    mirrorQueue = mirrorQueue.then(run, run);
    return mirrorQueue;
  }

  // Primer uso tras un reinicio del SW: la memoria está vacía y el espejo manda.
  function ensureRestored() {
    if (!restorePromise) {
      restorePromise = (async () => {
        if (!hasChrome('storage') || !chrome.storage.session) return;
        let stored = null;
        try {
          const got = await chrome.storage.session.get(PENDING_KEY);
          stored = got && got[PENDING_KEY];
        } catch (_) {
          stored = null;
        }
        if (!stored || typeof stored !== 'object') return;
        for (const [key, ctx] of Object.entries(stored)) {
          const id = Number(key);
          if (!Number.isInteger(id) || pending.has(id) || !ctx || typeof ctx !== 'object') continue;
          pending.set(id, Object.assign({ restored: true }, ctx));
        }
      })();
    }
    return restorePromise;
  }

  // --- Puerta a chrome.downloads.download ------------------------------------------------
  // El SW registra las opciones en ImgDL.downloadLog (anillo de 50, hook de test);
  // sin él (Node) se usa un anillo propio.

  function gate() {
    return root.ImgDL && root.ImgDL.downloadLog;
  }

  function callDownload(opts) {
    const g = gate();
    if (g && typeof g.download === 'function') return g.download(opts);
    push(ownLog, Object.assign({}, opts), LOG_MAX);
    if (!hasChrome('downloads')) return Promise.reject(new Error('chrome.downloads no disponible'));
    return chrome.downloads.download(opts);
  }

  function lastDownloads() {
    const g = gate();
    return g && typeof g.list === 'function' ? g.list() : ownLog.slice();
  }

  // --- Contexto, nombres y objetivos --------------------------------------------------------

  function mapError(code) {
    return strings.format(code);
  }

  function pageUrlOf(ctx) {
    return ctx.page && typeof ctx.page.url === 'string' ? ctx.page.url : '';
  }

  // 'Imagenes/<host>': hostOf quita www. y conserva el puerto no predeterminado;
  // sanitizeHost lo sanea (':' -> '_'), p. ej. 'Imagenes/localhost_3000'. Un marco sin
  // host (about:blank, srcdoc) toma el de la pestaña (page.topUrl) en vez de 'pagina'.
  function defaultFolder(ctx) {
    const topUrl = ctx.page && typeof ctx.page.topUrl === 'string' ? ctx.page.topUrl : '';
    return names.buildPaths({
      folder: thresholds.DEFAULTS.folder,
      host: urls.hostOf(pageUrlOf(ctx)) || urls.hostOf(topUrl),
      stamp: names.stamp(new Date())
    }).single;
  }

  function extFor(ctx) {
    if (ctx.ext) return ctx.ext;
    const fromData = isDataUrl(ctx.dataUrl) ? names.extFromDataUrl(ctx.dataUrl) : null;
    return fromData || names.extForRef(ctx.ref);
  }

  // Objetivos del peldaño 1: [fullSizeHint, url] si se prefiere el enlace a tamaño completo.
  // data: y tipos byte (dataUrl inline, downloads-b1) van directos, sin escalera.
  function targetsFor(ctx) {
    const ref = ctx.ref;
    if (isDataUrl(ctx.dataUrl)) return [ctx.dataUrl];
    const list = [];
    if (ref.kind === 'http' && thresholds.DEFAULTS.preferFullSizeLink && isHttpUrl(ref.fullSizeHint) && ref.fullSizeHint !== ref.url) {
      list.push(ref.fullSizeHint);
    }
    if (typeof ref.url === 'string' && ref.url) list.push(ref.url);
    return list;
  }

  function normalizeCtx(input) {
    const ctx = Object.assign({}, input);
    ctx.ref = ctx.ref && typeof ctx.ref === 'object' ? ctx.ref : {};
    ctx.page = ctx.page && typeof ctx.page === 'object' ? ctx.page : {};
    ctx.tabId = typeof ctx.tabId === 'number' ? ctx.tabId : null;
    ctx.frameId = typeof ctx.frameId === 'number' ? ctx.frameId : 0;
    ctx.folder = typeof ctx.folder === 'string' && ctx.folder ? ctx.folder : defaultFolder(ctx);
    ctx.targets = Array.isArray(ctx.targets) && ctx.targets.length ? ctx.targets.slice() : targetsFor(ctx);
    ctx.ti = Number.isInteger(ctx.ti) && ctx.ti >= 0 ? ctx.ti : 0;
    ctx.rung = 1;
    ctx.ext = extFor(ctx);
    ctx.renamed = false;
    ctx.startedAt = Date.now();
    return ctx;
  }

  function currentTarget(ctx) {
    return ctx.targets && ctx.targets[ctx.ti];
  }

  // ¿Queda otro objetivo tras el actual? (fullSizeHint fallido -> url)
  function moreTargets(ctx) {
    return Array.isArray(ctx.targets) && ctx.ti + 1 < ctx.targets.length;
  }

  // Lo mismo, solo desde el peldaño 1 (una descarga blob del peldaño 2 no salta de objetivo).
  function hasNextTarget(ctx) {
    return ctx.rung === 1 && moreTargets(ctx);
  }

  // Peldaño 2 para cualquier objetivo http(s) (sueltas y lote de archivos, ver cabecera);
  // ctx.rung2 === false lo desactiva (reserva por archivo del ZIP).
  function wantsRung2(ctx) {
    return ctx.rung2 !== false && isHttpUrl(currentTarget(ctx));
  }

  // Ítems de un trabajo con el fetch del peldaño 2 en vuelo (jobs.js: gracia de los ctx restaurados).
  function fetchingOfJob(jobId) {
    let n = 0;
    for (const c of fetching) if (c.jobId === jobId) n++;
    return n;
  }

  // Código del peldaño 2 para el peldaño 3: HTTP_<n> (401/403 → ERR_403 vía strings),
  // NOT_IMAGE → ERR_HTML, TIMEOUT → ERR_TIMEOUT, NETWORK → ERR_NETWORK; otros, el de reserva.
  function rung2Code(code, fallback) {
    const c = typeof code === 'string' ? code : '';
    if (/^HTTP_\d{3}$/.test(c) || c === 'NOT_IMAGE' || c === 'TIMEOUT' || c === 'NETWORK') return c;
    return fallback || 'ERR_GENERIC';
  }

  // Extensión real (sniff del offscreen) en el nombre ya planificado, conservando carpeta y base.
  function applySniffedExt(ctx, ext) {
    const e = typeof ext === 'string' && ext ? ext.toLowerCase() : '';
    if (!e || e === ctx.ext) return;
    ctx.ext = e;
    if (typeof ctx.filename === 'string' && ctx.filename) ctx.filename = ctx.filename.replace(/\.[^./\\]*$/, '') + '.' + e;
  }

  // Siguiente objetivo, mismo peldaño 1. ctx.filename se conserva: el nombre planificado
  // no depende del objetivo, y si fue el de reserva ('Invalid filename') ya sabemos que vale.
  function nextTarget(ctx) {
    ctx.ti++;
    return startRung1(ctx);
  }

  // Nombre planificado: ref.name (o base de la URL/alt) saneado con las reglas de Chromium.
  function planFilename(ctx) {
    const planned = names.planNames([Object.assign({}, ctx.ref, { ext: ctx.ext })])[0].fileName;
    return names.joinPath(ctx.folder, planned);
  }

  // Reintento tras 'Invalid filename': carpeta re-saneada y base 'imagen-NNN'.
  function fallbackFilename(ctx) {
    fallbackSeq++;
    const folder = String(ctx.folder).split('/').filter(Boolean).map((c) => names.sanitizeComponent(c)).join('/');
    return names.joinPath(folder, FALLBACK_BASE + '-' + String(fallbackSeq).padStart(3, '0') + '.' + ctx.ext);
  }

  function codeForRejection(reason) {
    if (reason === 'Invalid URL') return 'INVALID_URL';
    if (reason === 'Invalid filename') return 'INVALID_FILENAME';
    return RUNG2_ERRORS[reason] || 'ERR_GENERIC';
  }

  // --- Avisos al frame de origen (peldaño 3) y callbacks de lote -----------------------------

  function notify(ctx, msg) {
    if (ctx.quiet === true) return Promise.resolve(false); // ítems de lote: el resumen lo da job-done
    const payload = Object.assign({ to: 'content', type: 'imgdl:notify' }, msg);
    const entry = { tabId: ctx.tabId, frameId: ctx.frameId, msg: payload, delivered: null, at: Date.now() };
    push(notifyLog, entry, NOTIFY_MAX);
    if (!hasChrome('tabs') || typeof ctx.tabId !== 'number') {
      entry.delivered = false;
      return Promise.resolve(false);
    }
    const opts = typeof ctx.frameId === 'number' ? { frameId: ctx.frameId } : undefined;
    return Promise.resolve()
      .then(() => chrome.tabs.sendMessage(ctx.tabId, payload, opts))
      .then(() => { entry.delivered = true; return true; }, () => { entry.delivered = false; return false; }); // frame cerrado o sin receptor
  }

  function done(ctx, result) {
    if (typeof ctx.onDone === 'function') {
      try { ctx.onDone(result); } catch (_) { /* callback del lote */ }
    }
  }

  function fail(ctx, code, extra) {
    const text = mapError(code);
    const msg = Object.assign({ level: 'error', code, text }, extra || {});
    const target = currentTarget(ctx);
    if (isHttpUrl(target)) {
      msg.url = target;
      msg.action = 'copy-url';
    }
    notify(ctx, msg);
    const result = { ok: false, code, text };
    if (msg.url) result.url = msg.url;
    done(ctx, result);
    return result;
  }

  // --- Peldaño 1 -----------------------------------------------------------------------------

  async function tryDownload(ctx, url, filename) {
    const opts = { url, filename, conflictAction: 'uniquify', saveAs: false };
    let id;
    try {
      id = await callDownload(opts);
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
    if (typeof id !== 'number') return { ok: false, reason: 'NO_ID' };
    ctx.filename = filename;
    ctx.downloadId = id;
    if (isDataUrl(url)) ctx.targets[ctx.ti] = slimData(url); // la cadena ya no hace falta
    delete ctx.dataUrl;
    pending.set(id, ctx);
    mirror();
    const d = early.get(id);
    if (d) {
      early.delete(id);
      Promise.resolve().then(() => onChanged(d));
    }
    return { ok: true, id };
  }

  async function launch(ctx, url) {
    if (!url) return fail(ctx, 'ERR_GENERIC', { reason: 'NO_URL' });
    let res = await tryDownload(ctx, url, ctx.filename || planFilename(ctx));
    if (!res.ok && res.reason === 'Invalid filename' && !ctx.renamed) {
      ctx.renamed = true;
      res = await tryDownload(ctx, url, fallbackFilename(ctx));
    }
    if (res.ok) return { ok: true, downloadId: res.id };
    // Rechazo sin DownloadItem (downloads-d4): razón de interrupción o URL/nombre inválidos.
    // El nombre no depende del objetivo, así que solo un rechazo distinto de 'Invalid
    // filename' justifica probar el siguiente objetivo.
    if (ctx.rung === 2 && ctx.blobUrl) releaseBlob(ctx.blobUrl); // la descarga blob no arrancó: revocar ya
    if (res.reason !== 'Invalid filename' && hasNextTarget(ctx)) return nextTarget(ctx);
    return fail(ctx, codeForRejection(res.reason), { reason: res.reason });
  }

  function startRung1(ctx) {
    ctx.rung = 1;
    return launch(ctx, currentTarget(ctx));
  }

  // --- Peldaño 2 ---------------------------------------------------------------------------
  // Fetch del objetivo actual en el offscreen (jobs.fetchViaOffscreen) y descarga de la URL
  // blob con el mismo nombre (extensión del sniff). `code` es el de reserva del peldaño 1
  // (RUNG2_ERRORS o NOT_IMAGE) por si el peldaño 2 no aporta uno mejor. Un ítem de lote
  // consulta jobs.rung2Allowed antes del fetch y antes de descargar la blob: con el trabajo
  // cancelado o cerrado termina CANCELLED (silencioso) y la blob se revoca.
  async function startRung2(ctx, code, extra) {
    const jobs = root.ImgDL && root.ImgDL.jobs;
    if (!jobs || typeof jobs.fetchViaOffscreen !== 'function') return afterRung2(ctx, code, extra);
    fetching.add(ctx);
    try {
      if (!(await rung2Allowed(jobs, ctx))) return cancelled(ctx);
      ctx.rung = 2;
      let r = null;
      try {
        r = await jobs.fetchViaOffscreen(ctx);
      } catch (e) {
        r = { ok: false, code: (e && e.code) || 'NETWORK' };
      }
      if (r && r.ok && typeof r.blobUrl === 'string') {
        if (!(await rung2Allowed(jobs, ctx))) {
          releaseBlob(r.blobUrl);
          return cancelled(ctx);
        }
        applySniffedExt(ctx, r.ext);
        ctx.blobUrl = r.blobUrl;
        return await launch(ctx, r.blobUrl); // await: la descarga queda pendiente antes de salir de `fetching`
      }
      const got = r && (r.code || r.error);
      return await afterRung2(ctx, rung2Code(got, code), Object.assign({}, extra || {}, { rung2: got || 'ERR_GENERIC' }));
    } finally {
      fetching.delete(ctx);
    }
  }

  async function rung2Allowed(jobs, ctx) {
    if (typeof jobs.rung2Allowed !== 'function') return true;
    try { return (await jobs.rung2Allowed(ctx)) !== false; } catch (_) { return true; }
  }

  // Ítem de lote cuyo trabajo ya no existe: sin avisos ni más peldaños.
  function cancelled(ctx) {
    ctx.rung = 1;
    delete ctx.blobUrl;
    const result = { ok: false, code: 'CANCELLED', text: mapError('CANCELLED'), silent: true };
    done(ctx, result);
    return result;
  }

  // Tras fallar el peldaño 2: siguiente objetivo (peldaño 1) o peldaño 3.
  function afterRung2(ctx, code, extra) {
    ctx.rung = 1;
    delete ctx.blobUrl;
    if (moreTargets(ctx)) return nextTarget(ctx);
    return fail(ctx, code, extra);
  }

  // ctx = {ref, page:{url,title}, tabId, frameId, folder?, targets?, dataUrl?, onDone?}.
  // Resuelve al INICIAR la descarga: {ok:true, downloadId} | {ok:false, code, text}.
  async function downloadDirect(ctx) {
    await ensureRestored();
    const c = normalizeCtx(ctx);
    if (!c.targets.length) return fail(c, 'ERR_GENERIC', { reason: 'NO_URL' });
    return startRung1(c);
  }

  // ZIPs (y pruebas): blob URL creada en el documento offscreen. Mismo seguimiento que el
  // peldaño 2; pending.blobUrl permite revocarla al terminar.
  async function downloadBlobUrl(ctx, blobUrl) {
    await ensureRestored();
    const c = normalizeCtx(ctx);
    c.rung = 2;
    c.blobUrl = blobUrl;
    return launch(c, blobUrl);
  }

  // --- onChanged -----------------------------------------------------------------------------

  async function findItem(id) {
    try {
      const list = await chrome.downloads.search({ id });
      return (list && list[0]) || null;
    } catch (_) {
      return null;
    }
  }

  // Quita el ítem de la estantería (interrumpido: no hay archivo que borrar).
  async function erase(id) {
    try { await chrome.downloads.erase({ id }); } catch (_) { /* ya borrado */ }
  }

  async function discard(id) {
    try { await chrome.downloads.removeFile(id); } catch (_) { /* sin archivo */ }
    await erase(id);
  }

  async function onComplete(id, ctx) {
    const item = await findItem(id);
    const mime = normalizeMime(item && item.mime);
    // La guarda MIME no aplica al ZIP (application/zip) ni a una blob del peldaño 2 (el
    // offscreen ya verificó los bytes; el tipo del blob es el content-type del servidor).
    if (ctx.kind !== 'zip' && ctx.rung !== 2 && isNotImage(mime)) {
      push(discardedLog, { id, url: slimData(currentTarget(ctx)), filename: item && item.filename, mime, at: Date.now() }, DISCARDED_MAX);
      await discard(id);
      if (wantsRung2(ctx)) return startRung2(ctx, 'NOT_IMAGE', { mime });
      if (hasNextTarget(ctx)) return nextTarget(ctx);
      return fail(ctx, 'NOT_IMAGE', { mime });
    }
    const filename = item && item.filename ? item.filename : ctx.filename;
    const name = baseName(filename);
    const msg = { level: 'info', code: 'STATUS_DONE', text: strings.STATUS_DONE(name) };
    const target = currentTarget(ctx);
    if (isHttpUrl(target)) msg.url = target;
    notify(ctx, msg);
    const result = { ok: true, downloadId: id, filename, name };
    done(ctx, result);
    return result;
  }

  async function onInterrupted(id, ctx, err) {
    const reason = typeof err === 'string' && err ? err : 'UNKNOWN';
    if (reason === 'USER_CANCELED') {
      const result = { ok: false, code: 'USER_CANCELED', text: mapError('USER_CANCELED'), silent: true };
      done(ctx, result);
      return result;
    }
    // RUNG2_ERRORS en el peldaño 1: borrar el ítem interrumpido y peldaño 2 del MISMO
    // objetivo antes de pasar al siguiente (con rung2:false, el siguiente objetivo
    // directamente). Sin más vías, aviso (peldaño 3); el ítem interrumpido solo queda
    // visible en la estantería si no se intentó nada más. Una blob del peldaño 2
    // interrumpida va al peldaño 3 sin reintentos.
    const code = ctx.rung === 1 ? RUNG2_ERRORS[reason] : null;
    if (code && wantsRung2(ctx)) {
      await erase(id);
      return startRung2(ctx, code, { reason });
    }
    if (code && hasNextTarget(ctx)) {
      await erase(id);
      return nextTarget(ctx);
    }
    return fail(ctx, RUNG2_ERRORS[reason] || 'ERR_GENERIC', { reason });
  }

  // Listener de nivel superior del SW. Nunca rechaza; false si el ítem no es nuestro.
  async function onChanged(delta) {
    try {
      if (!delta || typeof delta.id !== 'number' || !delta.state) return false;
      const state = delta.state.current;
      if (state !== 'complete' && state !== 'interrupted') return false;
      await ensureRestored();
      const ctx = pending.get(delta.id);
      if (!ctx) {
        early.set(delta.id, delta);
        if (early.size > EARLY_MAX) early.delete(early.keys().next().value);
        return false;
      }
      pending.delete(delta.id);
      mirror();
      // La blob de ESTA descarga: el peldaño 2 puede dejar otra nueva (en vuelo) en el mismo ctx.
      const blobUrl = ctx.blobUrl;
      const result = state === 'interrupted'
        ? await onInterrupted(delta.id, ctx, delta.error && delta.error.current)
        : await onComplete(delta.id, ctx);
      if (blobUrl) releaseBlob(blobUrl);
      // Si la escalera siguió con otra descarga (siguiente objetivo o blob del peldaño 2) el
      // ctx está pendiente con un id nuevo y `result` solo dice "iniciada": el cierre del
      // trabajo restaurado llega con el onChanged de esa descarga, no ahora.
      const continued = typeof ctx.downloadId === 'number' && ctx.downloadId !== delta.id;
      if (ctx.restored && !continued) restoredDone(ctx, result);
      return result;
    } catch (_) {
      return false;
    }
  }

  // Blob URL creada en el offscreen: revocarla y soltar la referencia al terminar la
  // descarga (complete|interrupted); el documento se cierra tras offscreenIdleMs sin uso.
  function releaseBlob(blobUrl) {
    const off = root.ImgDL && root.ImgDL.offscreen;
    if (typeof off === 'undefined' || !off) return;
    Promise.resolve()
      .then(() => off.sendToOffscreen({ type: 'off:revoke', blobUrl }))
      .catch(() => {})
      .then(() => {
        try { off.release(); } catch (_) { /* sin offscreen */ }
        try { off.closeIfIdle(); } catch (_) { /* sin offscreen */ }
      });
  }

  // Ctx restaurado tras un reinicio del SW (sin callbacks): jobs.js cierra el trabajo.
  function restoredDone(ctx, result) {
    const jobs = root.ImgDL && root.ImgDL.jobs;
    if (!jobs || typeof jobs.onRestoredDone !== 'function') return;
    Promise.resolve().then(() => jobs.onRestoredDone(ctx, result)).catch(() => {});
  }

  // --- Cola del lote de archivos sueltos (paso 6) -----------------------------------------------
  // items: planificados (fileName único) con frameId/kind/url/id. Tipos byte: materialize
  // (frameId, id) de uno en uno -> data URL; data: directo; http: escalera. Cada ítem
  // resuelve al terminar (ctx.onDone en complete/fallo). Progreso por finalización;
  // opts.onItem(result, index, item) por ítem (jobs.js espeja el avance en storage.session).
  // Cada ctx lleva kind:'files', jobId e itemIndex: tras un reinicio del SW el ctx restaurado
  // basta para cerrar el trabajo (jobs.onRestoredDone). Al abortar, los no empezados fallan
  // CANCELLED y los en vuelo se cancelan en Chrome (chrome.downloads.cancel → USER_CANCELED,
  // sin archivo parcial; también la blob del peldaño 2 o el siguiente objetivo, que llevan otro
  // id: se buscan en pending por jobId/itemIndex) y se dan por CANCELLED; un fetch del peldaño 2
  // en vuelo no descarga su blob (jobs.rung2Allowed).
  async function runFilesQueue(items, folder, tabId, onProgress, opts) {
    const o = opts || {};
    const list = Array.isArray(items) ? items : [];
    const page = o.page && typeof o.page === 'object' ? o.page : {};
    const signal = o.signal || null;
    const materialize = typeof o.materialize === 'function' ? o.materialize : null;
    const onItem = typeof o.onItem === 'function' ? o.onItem : null;
    const limit = (thresholds.DEFAULTS && thresholds.DEFAULTS.filesConcurrency) || 4;
    let done = 0;
    let failed = 0;
    const failures = [];
    let matQueue = Promise.resolve();

    const report = () => {
      if (typeof onProgress !== 'function') return;
      try { onProgress({ done, failed, total: list.length, bytes: 0 }); } catch (_) { /* callback del trabajo */ }
    };

    const failure = (code) => ({ ok: false, code, text: mapError(code) });

    const cancelDownload = (id) => {
      if (typeof id !== 'number' || !hasChrome('downloads')) return;
      Promise.resolve().then(() => chrome.downloads.cancel(id)).catch(() => {}); // ya terminada
    };

    // Descargas pendientes de un ítem (peldaño 1, siguiente objetivo o blob del peldaño 2).
    const cancelItem = (index, first) => {
      cancelDownload(first);
      if (o.jobId == null) return;
      for (const [id, c] of pending) {
        if (id !== first && c.jobId === o.jobId && c.itemIndex === index) cancelDownload(id);
      }
    };

    // Materialización en serie: una sola cadena base64 viva a la vez.
    const materializeSerial = (item) => {
      const run = () => (materialize ? materialize(item.frameId, item.id) : Promise.resolve({ id: item.id, code: 'ERR_GENERIC' }));
      const p = matQueue.then(run, run);
      matQueue = p.then(() => {}, () => {});
      return p;
    };

    const runOne = (item, index) => new Promise((resolve) => {
      let settled = false;
      let downloadId = null;
      const onAbort = () => {
        cancelItem(index, downloadId);
        settle(failure('CANCELLED'));
      };
      const settle = (r) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(r || failure('ERR_GENERIC'));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const it = item || {};
      let fileName = typeof it.fileName === 'string' && it.fileName ? it.fileName : null;
      const start = async () => {
        const ctx = { ref: it, page, tabId, frameId: 0, folder, quiet: true, kind: 'files', jobId: o.jobId, itemIndex: index, onDone: settle };
        if (BYTE_KINDS.indexOf(it.kind) !== -1) {
          const m = await materializeSerial(it);
          if (settled) return;
          if (!m || typeof m.dataUrl !== 'string') return settle(failure((m && m.code) || 'ERR_GENERIC'));
          ctx.dataUrl = m.dataUrl;
          // Extensión real distinta de la planificada: renombrar conservando la base.
          const ext = typeof m.ext === 'string' && m.ext ? m.ext.toLowerCase() : names.extFromDataUrl(m.dataUrl);
          if (ext && fileName && !new RegExp('\\.' + ext + '$', 'i').test(fileName)) fileName = fileName.replace(/\.[^.]*$/, '') + '.' + ext;
          if (ext) ctx.ext = ext;
        }
        if (fileName) ctx.filename = names.joinPath(folder, fileName);
        const r = await downloadDirect(ctx);
        if (r && r.ok) {
          downloadId = r.downloadId;
          // Abortado mientras arrancaba: la descarga ya existe, cancelarla ahora.
          if (settled) cancelItem(index, downloadId);
          return;
        }
        settle(r);
      };
      start().catch((e) => settle(failure((e && e.code) || 'ERR_GENERIC')));
      return undefined;
    });

    await asyncPool.pool(list, limit, runOne, {
      signal,
      onSettled: (res, i, item) => {
        const r = res && res.ok ? res.value : failure((res && res.error && res.error.code) || 'CANCELLED');
        const it = item || {};
        if (r && r.ok) {
          done++;
        } else {
          failed++;
          failures.push({ name: it.fileName || it.name || '', url: isHttpUrl(it.url) ? it.url : '', reason: (r && r.code) || 'ERR_GENERIC' });
        }
        if (onItem) {
          try { onItem(r, i, it); } catch (_) { /* callback del trabajo */ }
        }
        report();
      }
    });
    return { done, failed, failures };
  }

  // --- Hooks de test -----------------------------------------------------------------------------

  function lastNotify() {
    return notifyLog.map((e) => Object.assign({}, e, { msg: Object.assign({}, e.msg) }));
  }

  function lastDiscarded() {
    return discardedLog.map((e) => Object.assign({}, e));
  }

  // Simula un reinicio del SW: vacía la memoria (el espejo en storage.session se conserva).
  function resetMemory() {
    pending.clear();
    early.clear();
    restorePromise = null;
  }

  const api = {
    RUNG2_ERRORS,
    downloadDirect,
    downloadBlobUrl,
    runFilesQueue,
    onChanged,
    mapError,
    pendingSnapshot,
    fetchingOfJob,
    lastDownloads,
    lastNotify,
    lastDiscarded,
    resetMemory,
    isNotImage,
    slimData
  };

  root.ImgDL = root.ImgDL || {};
  root.ImgDL.downloads = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
