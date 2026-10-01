'use strict';
// Documento offscreen (reason BLOBS). Aquí vive el trabajo largo que el SW no
// puede hacer (zip-b3: muere a los 30 s; zip-c1: no tiene URL.createObjectURL):
// fetch de las imágenes con cookies, verificación, ZIP STORE y URLs blob.
// Solo dispone de chrome.runtime. Router de mensajes con msg.to === 'offscreen';
// el resultado del ZIP vuelve como mensaje off:zip-ready (no como respuesta).
// Respuestas de error: {ok:false, error, code} (mismo valor; jobs.js lee `code`).
(function (root) {
  const ImgDL = root.ImgDL;
  const strings = ImgDL.strings;
  const names = ImgDL.names;
  const zipStore = ImgDL.zipStore;
  const asyncPool = ImgDL.asyncPool;
  const DEFAULTS = ImgDL.thresholds.DEFAULTS;

  const SNIFF_BYTES = 64; // sniffExt necesita 64 B para HTML con BOM/espacios y AVIF mif1
  const FAILED_LIST = strings.FAILED_LIST_NAME;
  const DEFAULT_BASE = names.buildBaseName({}); // nombre por defecto de names.js
  const STASH_TTL_MS = 10 * 60 * 1000; // stash de off:zip-bytes sin off:zip-job (SW muerto)
  const EXT_ALIAS = { jpeg: 'jpg', jpe: 'jpg', jfif: 'jpg', tiff: 'tif', heif: 'heic' };
  const BYTE_KINDS = ['blob', 'canvas', 'svg']; // sus bytes llegan solo por off:zip-bytes

  // --- Estado ------------------------------------------------------------------------------
  const jobs = new Map(); // jobId -> {abort, stash:Map<id, Blob>, bytes, started, createdAt}
  const blobUrls = new Map(); // blobUrl -> Blob (revocación explícita)
  let fetches = 0; // off:fetch-one en curso (off:status: no cerrar el documento)

  if (typeof document !== 'undefined' && strings.APP_NAME) document.title = strings.APP_NAME;

  function hasChrome() {
    return typeof chrome !== 'undefined' && !!chrome && !!chrome.runtime;
  }

  function codedError(code, message, extra) {
    const e = new Error(message || code);
    e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
  }

  // Razón de fallo de un ítem (protocolo: HTTP_<n> | NOT_IMAGE | TIMEOUT | NETWORK | ABORTED | NO_BYTES).
  function reasonOf(err) {
    if (err && typeof err.code === 'string' && err.code) return err.code;
    if (err instanceof TypeError || (err && err.name === 'TypeError')) return 'NETWORK';
    if (err && err.name === 'AbortError') return 'ABORTED';
    if (err && err.name === 'TimeoutError') return 'TIMEOUT';
    return 'ERR_GENERIC';
  }

  function failure(code) {
    return { ok: false, error: code, code };
  }

  function send(msg) {
    if (!hasChrome()) return Promise.resolve();
    return Promise.resolve()
      .then(() => chrome.runtime.sendMessage(Object.assign({ to: 'sw' }, msg)))
      .catch(() => {}); // SW dormido sin receptor: se ignora
  }

  function getJob(jobId) {
    let job = jobs.get(jobId);
    if (!job) {
      job = { abort: new AbortController(), stash: new Map(), bytes: 0, started: false, createdAt: Date.now() };
      jobs.set(jobId, job);
    }
    return job;
  }

  function revokeUrl(url) {
    if (typeof url !== 'string' || !url) return;
    try { URL.revokeObjectURL(url); } catch (_) { /* ya revocada */ }
    blobUrls.delete(url);
  }

  // Stashes huérfanos (bytes sin trabajo arrancado) tras STASH_TTL_MS desde el último
  // off:zip-bytes (SW muerto a medias).
  function sweepStale() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (!job.started && now - job.createdAt > STASH_TTL_MS) jobs.delete(id);
    }
  }

  // --- Progreso (<= 1 mensaje cada progressThrottleMs, con flanco final) ---------------------
  function makeProgress(jobId) {
    const every = DEFAULTS.progressThrottleMs;
    let last = 0;
    let timer = null;
    let state = null;
    let closed = false;
    const flush = () => {
      timer = null;
      if (closed || !state) return;
      last = Date.now();
      send(Object.assign({ type: 'off:progress', jobId }, state));
    };
    return {
      set(next) {
        if (closed) return;
        state = next;
        if (timer) return;
        const wait = every - (Date.now() - last);
        if (wait <= 0) flush();
        else timer = setTimeout(flush, wait);
      },
      close() {
        closed = true;
        if (timer) clearTimeout(timer);
        timer = null;
      }
    };
  }

  // --- Fetch y verificación ----------------------------------------------------------------

  function normalizeMime(mime) {
    return String(mime == null ? '' : mime).split(';')[0].trim().toLowerCase();
  }

  async function sniffBlob(blob) {
    const head = new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer());
    return names.sniffExt(head);
  }

  // Un intento: respuesta !ok -> HTTP_<status> (status numérico para shouldRetry).
  async function fetchOnce(url, signal) {
    const res = await fetch(url, { credentials: 'include', redirect: 'follow', signal });
    if (!res.ok) throw codedError('HTTP_' + res.status, 'HTTP ' + res.status, { status: res.status });
    const blob = await res.blob();
    return { blob, contentType: normalizeMime(res.headers.get('content-type')) };
  }

  // Verifica que son bytes de imagen: HTML detectado manda; si no, vale el content-type
  // image/* o una firma de imagen. Devuelve {blob, mime, ext|null}.
  async function verifyImage(fetched) {
    const sniff = await sniffBlob(fetched.blob);
    if (sniff && sniff.mime === 'text/html') throw codedError('NOT_IMAGE', 'HTML en lugar de imagen');
    const ctIsImage = names.isImageMime(fetched.contentType);
    if (!ctIsImage && !(sniff && sniff.ext)) throw codedError('NOT_IMAGE', 'no es una imagen');
    const mime = (sniff && sniff.mime) || fetched.contentType;
    const ext = (sniff && sniff.ext) || names.extFromMime(fetched.contentType) || null;
    return { blob: fetched.blob, mime, ext };
  }

  // Timeout por intento y un reintento en 429/5xx/red (zip-d2).
  function fetchImage(url, timeoutMs, parentSignal) {
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULTS.fetchTimeoutMs;
    return asyncPool.retryOnce(
      () => asyncPool.withTimeout((signal) => fetchOnce(url, signal).then(verifyImage), ms, parentSignal),
      asyncPool.RETRY_DELAY_MS,
      parentSignal
    );
  }

  // --- Nombres ------------------------------------------------------------------------------

  function splitName(name) {
    const m = /^(.*)\.([^.\s/]{1,10})$/.exec(name);
    return m ? { base: m[1], ext: m[2] } : { base: name, ext: '' };
  }

  function sameExt(a, b) {
    const n = (x) => { const e = String(x || '').toLowerCase(); return EXT_ALIAS[e] || e; };
    return n(a) === n(b);
  }

  // Si la extensión detectada difiere de la planificada, se renombra conservando la base.
  function renameByExt(name, ext) {
    if (!ext) return name;
    const parts = splitName(name);
    if (parts.ext && sameExt(parts.ext, ext)) return name;
    return parts.base + '.' + ext;
  }

  function registerBlobUrl(blob) {
    const url = URL.createObjectURL(blob);
    blobUrls.set(url, blob);
    return url;
  }

  // --- Trabajo ZIP ----------------------------------------------------------------------------

  async function zipWorker(job, item, timeoutMs, hardBytes) {
    const id = item.id;
    const planned = typeof item.name === 'string' && item.name ? item.name : DEFAULT_BASE;
    let blob;
    let ext = null;
    const stashed = job.stash.get(id);
    if (stashed) {
      blob = stashed;
      job.stash.delete(id);
      const sniff = await sniffBlob(blob);
      ext = (sniff && sniff.ext) || null;
    } else if (BYTE_KINDS.indexOf(item.kind) !== -1 || typeof item.url !== 'string' || !item.url) {
      // Tipo byte sin stash (documento recreado o stash barrido) o ítem sin URL: no hay
      // nada que traer; fallo inmediato, sin fetch ni reintento.
      throw codedError('NO_BYTES', 'sin bytes');
    } else if (item.kind === 'data') {
      const res = await fetch(item.url, { signal: job.abort.signal });
      blob = await res.blob();
      ext = names.extFromMime(blob.type) || null;
    } else {
      const got = await fetchImage(item.url, timeoutMs, job.abort.signal);
      blob = got.blob;
      ext = got.ext;
    }
    job.bytes += blob.size;
    if (job.bytes > hardBytes) {
      job.abort.abort(codedError('ERR_ZIP_TOO_BIG', 'suma de bytes > tope'));
      throw codedError('ERR_ZIP_TOO_BIG', 'suma de bytes > tope');
    }
    return { id, name: renameByExt(planned, ext), blob };
  }

  function jobErrorCode(job) {
    const reason = job.abort.signal.reason;
    if (reason && typeof reason.code === 'string' && reason.code !== 'ABORTED') return reason.code;
    return 'CANCELLED';
  }

  function zipLimitCode(err) {
    if (err && err.name === 'ZipLimitError') {
      if (err.code === 'TOO_MANY') return 'ERR_ZIP_TOO_MANY';
      if (err.code === 'TOO_BIG') return 'ERR_ZIP_TOO_BIG';
    }
    return 'ERR_GENERIC';
  }

  async function runZipJob(msg) {
    const jobId = msg.jobId;
    const job = getJob(jobId);
    job.started = true;
    const items = Array.isArray(msg.items) ? msg.items : [];
    const concurrency = Number.isFinite(msg.concurrency) && msg.concurrency > 0 ? msg.concurrency : DEFAULTS.fetchConcurrency;
    const timeoutMs = Number.isFinite(msg.timeoutMs) && msg.timeoutMs > 0 ? msg.timeoutMs : DEFAULTS.fetchTimeoutMs;
    const hardBytes = Number.isFinite(msg.hardBytes) && msg.hardBytes > 0 ? msg.hardBytes : DEFAULTS.zipHardBytes;
    const addFailedList = msg.addFailedList !== false;
    const progress = makeProgress(jobId);
    const finish = (payload) => {
      progress.close();
      jobs.delete(jobId);
      return send(Object.assign({ type: 'off:zip-ready', jobId }, payload));
    };

    try {
      if (items.length > DEFAULTS.zipMaxEntries) return finish({ error: 'ERR_ZIP_TOO_MANY' });
      if (job.abort.signal.aborted) return finish({ error: jobErrorCode(job) });

      // 1) Todo a Blobs antes de empaquetar (zip-e1); fallos por ítem, no por trabajo.
      const total = items.length;
      let done = 0;
      let failed = 0;
      const results = await asyncPool.pool(items, concurrency, (item) => zipWorker(job, item, timeoutMs, hardBytes), {
        signal: job.abort.signal,
        onSettled: (r) => {
          if (r.ok) done++; else failed++;
          progress.set({ phase: 'fetching', done, failed, total, bytes: job.bytes });
        }
      });
      if (job.abort.signal.aborted) return finish({ error: jobErrorCode(job) });

      const successes = [];
      const failures = [];
      results.forEach((r, i) => {
        const item = items[i] || {};
        if (r.ok) successes.push(r.value);
        else failures.push({ id: item.id, name: item.name, url: item.url, reason: reasonOf(r.error) });
      });

      // 2) Entradas: éxitos + lista de fallidas; nombres únicos sin distinguir mayúsculas (zip-e2).
      const entries = successes.map((s) => ({ name: s.name, blob: s.blob, lastModified: Date.now() }));
      if (failures.length && addFailedList) {
        const lines = failures.map((f) => (f.url || f.name || '') + '\t' + f.reason).join('\n') + '\n';
        entries.push({ name: FAILED_LIST, blob: new Blob([lines], { type: 'text/plain' }), lastModified: Date.now() });
      }
      const unique = names.dedupeNames(entries.map((e) => e.name));
      entries.forEach((e, i) => { e.name = unique[i]; });

      // 3) ZIP STORE (CRC en streaming: el heap solo retiene un trozo, zip-d1). El progreso
      // cuenta imágenes, no entradas: la lista de fallidas no suma y el total es el de ítems.
      let zip;
      try {
        zip = await zipStore.buildStoreZip(entries, {
          onProgress: (p) => progress.set({
            phase: 'zipping',
            done: Math.min(p.done, successes.length),
            failed: failures.length,
            total,
            bytes: p.bytes
          })
        });
      } catch (e) {
        return finish({ error: zipLimitCode(e) });
      }
      if (job.abort.signal.aborted) return finish({ error: jobErrorCode(job) });

      // 4) URL blob viva hasta off:revoke (zip-c1). entries = imágenes dentro del ZIP.
      const blobUrl = registerBlobUrl(zip);
      return finish({
        blobUrl,
        size: zip.size,
        entries: successes.length,
        zipEntries: entries.length,
        failures
      });
    } catch (e) {
      return finish({ error: job.abort.signal.aborted ? jobErrorCode(job) : reasonOf(e) });
    }
  }

  // --- Manejadores ----------------------------------------------------------------------------

  const handlers = {
    // Bytes de un tipo byte (blob/canvas/svg) materializados en su marco: un ítem por mensaje.
    // Cada stash renueva createdAt: el TTL cuenta desde la última subida, no desde la primera.
    'off:zip-bytes': async (msg) => {
      const job = getJob(msg.jobId);
      const res = await fetch(msg.dataUrl);
      job.stash.set(msg.id, await res.blob());
      job.createdAt = Date.now();
      return { ok: true };
    },
    'off:zip-job': (msg) => {
      if (typeof msg.jobId !== 'string' && typeof msg.jobId !== 'number') return failure('ERR_GENERIC');
      const existing = jobs.get(msg.jobId);
      if (existing && existing.started) return failure('JOB_RUNNING');
      runZipJob(msg); // responde de inmediato; el resultado llega como off:zip-ready
      return { ok: true, accepted: true };
    },
    // Peldaño 2 de una descarga suelta: fetch con cookies + URL blob.
    'off:fetch-one': async (msg) => {
      fetches++;
      try {
        const got = await fetchImage(msg.url, msg.timeoutMs, undefined);
        const blobUrl = registerBlobUrl(got.blob);
        return { ok: true, blobUrl, mime: got.mime, ext: got.ext, size: got.blob.size };
      } catch (e) {
        return failure(reasonOf(e));
      } finally {
        fetches--;
      }
    },
    'off:revoke': (msg) => {
      revokeUrl(msg.blobUrl);
      return { ok: true };
    },
    'off:abort': (msg) => {
      const job = jobs.get(msg.jobId);
      if (!job) return { ok: true, found: false };
      if (!job.started) { jobs.delete(msg.jobId); return { ok: true, found: true }; }
      job.abort.abort(codedError('CANCELLED', 'cancelado por el usuario'));
      return { ok: true, found: true };
    },
    // Estado para closeIfIdle: no cerrar con trabajos, fetch en curso o URLs blob vivas.
    'off:status': () => {
      let running = 0;
      for (const job of jobs.values()) if (job.started) running++;
      return { ok: true, jobs: running, stashed: jobs.size - running, fetches, blobUrls: blobUrls.size };
    }
  };

  // Nunca lanza: tipo desconocido -> {ok:false, error:'UNKNOWN_MESSAGE', code}; no dirigido -> se ignora.
  function onMessage(msg, sender, sendResponse) {
    if (!msg || msg.to !== 'offscreen' || typeof msg.type !== 'string') return false;
    sweepStale();
    const handler = handlers[msg.type];
    Promise.resolve()
      .then(() => (handler ? handler(msg, sender) : failure('UNKNOWN_MESSAGE')))
      .then(
        (res) => sendResponse(res === undefined ? { ok: true } : res),
        (e) => sendResponse(failure(reasonOf(e)))
      );
    return true;
  }

  if (hasChrome() && chrome.runtime.onMessage) chrome.runtime.onMessage.addListener(onMessage);

  // Depuración (sin API pública: solo manejadores de mensajes).
  root.__imgdlOffscreen = {
    jobs: () => Array.from(jobs.keys()),
    blobUrls: () => Array.from(blobUrls.keys()),
    onMessage
  };
})(globalThis);
