'use strict';
// Service worker clásico (MV3). Sin estado propio: todo se deriva de la página o
// de storage.session. Todos los listeners chrome.* se registran a nivel superior
// para que sobrevivan a los reinicios del SW.
// Rutas de importScripts relativas a la URL de este script (background/).
importScripts(
  '../lib/strings.js',
  '../lib/urls.js',
  '../lib/thresholds.js',
  '../lib/names.js',
  '../lib/zip-store.js',
  '../lib/async-pool.js',
  'tabs.js',
  'downloads.js',
  'offscreen-client.js',
  'referer-rules.js',
  'jobs.js'
);

(function (root) {
  const ImgDL = root.ImgDL;
  const S = ImgDL.strings;
  const tabs = ImgDL.tabs;
  const downloads = ImgDL.downloads;
  const jobs = ImgDL.jobs;
  const refererRules = ImgDL.refererRules; // inerte sin declarativeNetRequestWithHostAccess

  // --- Registro de descargas (anillo de 50) -------------------------------------------
  // Única puerta a chrome.downloads.download: downloads.js debe llamar a
  // ImgDL.downloadLog.download(opts) para que los tests vean las opciones.
  const DOWNLOAD_LOG_MAX = 50;
  const downloadLog = [];

  function recordDownload(opts) {
    downloadLog.push(opts);
    if (downloadLog.length > DOWNLOAD_LOG_MAX) downloadLog.shift();
  }

  function lastDownloads() {
    return downloadLog.slice();
  }

  // En el registro, las data URLs largas (tipos byte: hasta ~43 MiB cada una) van
  // recortadas como en pending/storage (downloads.slimData): el anillo no retiene bytes.
  function slimUrl(u) {
    const dl = ImgDL.downloads;
    return dl && typeof dl.slimData === 'function' ? dl.slimData(u) : u;
  }

  async function download(opts) {
    const o = Object.assign({}, opts);
    recordDownload(Object.assign({}, o, { url: slimUrl(o.url) }));
    return chrome.downloads.download(o);
  }

  ImgDL.downloadLog = { record: recordDownload, list: lastDownloads, download };

  // --- Router de mensajes (msg.to === 'sw') ----------------------------------------------

  function tabIdOf(sender) {
    return sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
  }

  function needTab(sender) {
    const id = tabIdOf(sender);
    if (id === null) {
      const e = new Error('mensaje sin pestaña de origen');
      e.code = 'ERR_GENERIC';
      throw e;
    }
    return id;
  }

  function notImplemented() {
    return { ok: false, code: 'NOT_IMPLEMENTED', text: S.ERR_GENERIC };
  }

  // page del lote: url del marco emisor (frame 0), topUrl de la pestaña, título.
  function pageOf(msg, sender) {
    const p = msg.page && typeof msg.page === 'object' ? msg.page : {};
    const topUrl = sender.tab && typeof sender.tab.url === 'string' ? sender.tab.url : '';
    return {
      url: typeof p.url === 'string' && p.url ? p.url : sender.url || topUrl,
      topUrl,
      title: typeof p.title === 'string' ? p.title : (sender.tab && sender.tab.title) || ''
    };
  }

  const handlers = {
    'imgdl:deactivate': async (msg, sender) => {
      await tabs.deactivate(needTab(sender));
      return { ok: true };
    },
    'imgdl:reassert-badge': async (msg, sender) => {
      await tabs.reassertBadge(needTab(sender));
      return { ok: true };
    },
    'imgdl:frames-changed': async (msg, sender) => {
      tabs.ensureFrames(needTab(sender)); // debounce 500 ms; no se espera
      return { ok: true };
    },
    // Pendientes de pasos posteriores (downloads.js / jobs.js / offscreen):
    // Descarga de una imagen (chip): ctx desde el mensaje + el remitente (pestaña y frame).
    // page.url es el marco de origen (puede ser about:blank/srcdoc); page.topUrl la pestaña,
    // de donde downloads.js toma el host de la carpeta cuando el marco no tiene.
    'imgdl:download-one': async (msg, sender) => {
      const tabId = needTab(sender);
      return downloads.downloadDirect({
        ref: msg.ref,
        page: pageOf(msg, sender),
        tabId,
        frameId: typeof sender.frameId === 'number' ? sender.frameId : 0,
        dataUrl: typeof msg.dataUrl === 'string' ? msg.dataUrl : undefined
      });
    },
    // Lote desde el frame 0: {mode:'files'|'zip', page, confirmBig?} ->
    // {ok, jobId, total} | {ok:false, code:'NEEDS_CONFIRM', total, estimatedBytes} | error.
    'imgdl:download-many': async (msg, sender) => {
      const tabId = needTab(sender);
      const opts = { confirmBig: msg.confirmBig === true };
      const page = pageOf(msg, sender);
      if (msg.mode === 'zip') return jobs.runZipJob(tabId, page, opts);
      return jobs.runFilesJob(tabId, page, opts);
    },
    // Recuento de un marco -> frame 0 (que suma el suyo propio). El del propio frame 0
    // no se relé: ya lo conoce y evitamos contarlo dos veces.
    'imgdl:selection-changed': async (msg, sender) => {
      const tabId = needTab(sender);
      const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
      if (frameId !== 0) {
        try {
          await chrome.tabs.sendMessage(tabId, { to: 'content', type: 'imgdl:frame-count', frameId, count: Number(msg.count) || 0 }, { frameId: 0 });
        } catch (_) {
          // frame 0 sin receptor (desactivado entre medias).
        }
      }
      return { ok: true };
    },
    'imgdl:clear-selection': async (msg, sender) => {
      await jobs.clearSelectionAll(needTab(sender));
      return { ok: true };
    },
    // "Este marco tiene el puntero" -> todos los marcos de la pestaña (sin frameId:
    // difusión); cada controlador ignora su propio token y los demás ocultan su chip.
    // Por aquí y no por postMessage: la página nunca ve tráfico de la extensión.
    'imgdl:hover-frame': async (msg, sender) => {
      const tabId = needTab(sender);
      const relay = { to: 'content', type: 'imgdl:hover-frame', token: typeof msg.token === 'string' ? msg.token : '' };
      try {
        await chrome.tabs.sendMessage(tabId, relay);
      } catch (_) {
        // Algún marco sin receptor (desactivado entre medias): nada que hacer.
      }
      return { ok: true };
    },
    'imgdl:cancel-job': async (msg) => jobs.cancel(msg.jobId),
    // Del documento offscreen (sin pestaña): progreso y ZIP listo / error. Se responde
    // al momento; la descarga del ZIP y las fallidas siguen en segundo plano.
    'off:progress': (msg) => {
      jobs.onOffscreenMessage(msg);
      return { ok: true };
    },
    'off:zip-ready': (msg) => {
      jobs.onOffscreenMessage(msg);
      return { ok: true };
    }
  };

  // Envoltorio asíncrono: responde siempre y mantiene el canal abierto (return true).
  function onMessageAsync(msg, sender, sendResponse) {
    if (!msg || msg.to !== 'sw' || typeof msg.type !== 'string') return false;
    const handler = handlers[msg.type] || notImplemented;
    Promise.resolve()
      .then(() => handler(msg, sender))
      .then(
        (res) => sendResponse(res === undefined ? { ok: true } : res),
        (e) => {
          const code = (e && e.code) || 'ERR_GENERIC';
          sendResponse({ ok: false, code, text: S.format(code) });
        }
      );
    return true;
  }

  // --- Listeners de nivel superior ---------------------------------------------------------

  chrome.action.onClicked.addListener((tab) => {
    tabs.toggleTab(tab).catch(() => {});
  });

  chrome.runtime.onMessage.addListener(onMessageAsync);

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    tabs.onTabUpdated(tabId, changeInfo, tab).catch(() => {});
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabs.onTabRemoved(tabId).catch(() => {});
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (ImgDL.downloads && typeof ImgDL.downloads.onChanged === 'function') ImgDL.downloads.onChanged(delta);
  });

  // Recarga/instalación de la extensión: los content scripts viejos quedan huérfanos y
  // ninguna regla de sesión de Referer debe sobrevivir (las retira un fetch que no terminó).
  chrome.runtime.onInstalled.addListener(() => {
    tabs.resetState().catch(() => {});
    if (refererRules) refererRules.clearAll().catch(() => {});
  });
  chrome.runtime.onStartup.addListener(() => {
    tabs.resetState().catch(() => {});
    if (refererRules) refererRules.clearAll().catch(() => {});
  });

  // --- Hooks de test (Playwright: sw.evaluate) ---------------------------------------------

  root.__imgdlTest = {
    toggle: async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      return tabs.toggleTab(tab);
    },
    getActive: (tabId) => tabs.getActive(tabId),
    // setActive devuelve boolean (compatibilidad); applyState devuelve {on, partial}.
    setActive: (tabId, on) => tabs.applyState(tabId, !!on).then((r) => r.on),
    applyState: (tabId, on) => tabs.applyState(tabId, !!on),
    ensureFrames: (tabId) => tabs.ensureFrames(tabId),
    activeTabs: async () => Array.from(await tabs.readActiveTabs()),
    gather: (tabId) => jobs.gatherSelection(tabId),
    // Marcos de la pestaña vistos por scripting: [{frameId, result: location.href}]
    // (si allFrames falla, p. ej. marcos sandbox no inyectables, solo el principal).
    frames: async (tabId) => {
      const req = { func: () => location.href };
      let results;
      try {
        results = await chrome.scripting.executeScript(Object.assign({ target: { tabId, allFrames: true } }, req));
      } catch (_) {
        results = await chrome.scripting.executeScript(Object.assign({ target: { tabId, frameIds: [0] } }, req));
      }
      return (results || []).map((r) => ({ frameId: r.frameId, result: r.result }));
    },
    // Selección programática (sin chip): añade los [data-expect] cuyo valor esté en
    // paths en todos los marcos, vía __imgdl.testSelectExpect (lo expone el controlador).
    // Devuelve la suma de los recuentos por marco (null si ningún marco lo expone).
    selectExpect: async (tabId, paths) => {
      const list = Array.isArray(paths) ? paths : [paths];
      let results;
      const req = {
        func: (p) => {
          const c = globalThis.__imgdl;
          return c && typeof c.testSelectExpect === 'function' ? c.testSelectExpect(p) : null;
        },
        args: [list]
      };
      try {
        results = await chrome.scripting.executeScript(Object.assign({ target: { tabId, allFrames: true } }, req));
      } catch (_) {
        results = await chrome.scripting.executeScript(Object.assign({ target: { tabId, frameIds: [0] } }, req));
      }
      let sum = null;
      for (const r of results || []) {
        if (!r || typeof r.result !== 'number') continue;
        sum = (sum || 0) + r.result;
      }
      return sum;
    },
    clearSelection: (tabId) => jobs.clearSelectionAll(tabId).then(() => true),
    runFiles: (tabId, page, opts) => jobs.runFilesJob(tabId, page, opts || {}),
    runZip: (tabId, page, opts) => jobs.runZipJob(tabId, page, opts || {}),
    cancel: (jobId) => jobs.cancel(jobId),
    materialize: (tabId, frameId, id) => jobs.materializeOne(tabId, frameId, id),
    offscreenContexts: async () => {
      const list = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return Array.isArray(list) ? list.length : 0;
    },
    lastJobDone: () => jobs.lastJobDone(),
    lastProgress: () => jobs.lastProgress(),
    jobs: () => jobs.jobsSnapshot(),
    activeJobs: () => jobs.activeJobs(),
    storedJobs: async () => (await chrome.storage.session.get('jobs')).jobs || {},
    pending: () => (ImgDL.downloads && typeof ImgDL.downloads.pendingSnapshot === 'function' ? ImgDL.downloads.pendingSnapshot() : {}),
    // Escalera de descarga sin pasar por el content script (ctx = {ref, page, tabId, frameId, folder?, dataUrl?}).
    downloadOne: (ctx) => downloads.downloadDirect(ctx),
    downloadBlob: (ctx, blobUrl) => downloads.downloadBlobUrl(ctx, blobUrl),
    lastNotify: () => downloads.lastNotify(),
    lastDiscarded: () => downloads.lastDiscarded(),
    resetDownloads: () => downloads.resetMemory(),
    // Peldaño 2 directo (ctx con targets/ti) y regla DNR de Referer (paso 11, con compuerta).
    fetchViaOffscreen: (ctx) => jobs.fetchViaOffscreen(ctx),
    refererRules: () => !!(refererRules && refererRules.enabled()),
    sessionRules: async () => (refererRules && refererRules.enabled() ? chrome.declarativeNetRequest.getSessionRules() : []),
    liveRefererRules: () => (refererRules ? refererRules.liveRules() : []),
    setTabIdNone: (flag) => (refererRules ? refererRules.setUseTabIdNone(flag) : null),
    clearRefererRules: () => (refererRules ? refererRules.clearAll() : 0),
    lastDownloads,
    download
  };
})(globalThis);
