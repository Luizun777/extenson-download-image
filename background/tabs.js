'use strict';
// Activación por pestaña: inyección bajo demanda, estado derivado SIEMPRE de la
// página (nunca de la memoria del SW), badge y espejo de pestañas activas en
// chrome.storage.session. Se carga con importScripts en el SW y con require en Node
// (funciones puras; con un chrome simulado también el resto: test/unit/tabs.test.js).
(function (root) {
  const strings = (root.ImgDL && root.ImgDL.strings) || (typeof require === 'function' ? require('../lib/strings.js') : null);
  const thresholds = (root.ImgDL && root.ImgDL.thresholds) || (typeof require === 'function' ? require('../lib/thresholds.js') : null);

  // Única fuente de verdad del orden de inyección. Añadir aquí los módulos nuevos
  // (resolve, detect, overlay, selection van antes de controller.js).
  const CONTENT_FILES = [
    'lib/strings.js',
    'lib/urls.js',
    'lib/thresholds.js',
    'lib/names.js',
    'content/resolve.js',
    'content/detect.js',
    'content/overlay.js',
    'content/selection.js',
    'content/controller.js',
    'content/main.js'
  ];

  const BADGE_COLOR = '#1a73e8';
  const RESTRICTED_COLOR = '#d93025';
  const RESTRICTED_MS = 3000;
  const STORAGE_KEY = 'activeTabs';
  const FRAME_DEBOUNCE_MS = (thresholds && thresholds.DEFAULTS && thresholds.DEFAULTS.frameDebounceMs) || 500;
  // Nota del título cuando solo se pudo inyectar el marco principal. Se usa si
  // strings.js aún no define ACTION_TITLE_ON_PARTIAL.
  const PARTIAL_NOTE = ' · activa solo en el marco principal';

  function text(key) {
    return (strings && strings[key]) || key;
  }

  function titleFor(on, partial) {
    if (!on) return text('ACTION_TITLE_OFF');
    if (!partial) return text('ACTION_TITLE_ON');
    return (strings && strings.ACTION_TITLE_ON_PARTIAL) || (text('ACTION_TITLE_ON') + PARTIAL_NOTE);
  }

  // --- Cola de operaciones por pestaña -------------------------------------------
  // Toda operación que lee el estado de la página y luego lo cambia (toggle,
  // deactivate, reassert, ensure, onUpdated) se encadena por pestaña: dos toggles
  // solapados (clic + atajo, doble clic) ya no leen el mismo estado viejo.

  const tabQueues = new Map(); // tabId -> última promesa de la cola

  function noop() {}

  function enqueue(tabId, fn) {
    const prev = tabQueues.get(tabId) || Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    // La cola nunca rechaza (el error lo recibe quien llamó a enqueue) y se
    // retira del mapa cuando ya no quedan operaciones pendientes.
    const tail = next.then(noop, noop).then(() => {
      if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId);
    });
    tabQueues.set(tabId, tail);
    return next;
  }

  // Pestañas con operaciones en curso (diagnóstico y tests).
  function pendingTabs() {
    return Array.from(tabQueues.keys());
  }

  // --- Elegibilidad de la URL ---------------------------------------------------

  function isStoreHost(u) {
    const host = u.hostname.toLowerCase();
    if (host === 'chromewebstore.google.com' || host === 'microsoftedge.microsoft.com') return true;
    if (host === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return true;
    return false;
  }

  // Síncrona y pura. file: solo si opts.fileAllowed (ver canInject).
  function isInjectable(url, opts) {
    if (typeof url !== 'string' || !url) return false;
    let u;
    try { u = new URL(url); } catch (_) { return false; }
    const scheme = u.protocol;
    if (scheme === 'http:' || scheme === 'https:') return !isStoreHost(u);
    if (scheme === 'file:') return !!(opts && opts.fileAllowed);
    // chrome:, chrome-extension:, edge:, brave:, about:, devtools:, view-source:, data:, blob:…
    return false;
  }

  function fileAccessAllowed() {
    return new Promise((resolve) => {
      try {
        if (!chrome.extension || typeof chrome.extension.isAllowedFileSchemeAccess !== 'function') return resolve(false);
        chrome.extension.isAllowedFileSchemeAccess((ok) => resolve(!!ok));
      } catch (_) { resolve(false); }
    });
  }

  async function canInject(url) {
    if (isInjectable(url)) return true;
    if (typeof url === 'string' && /^file:/i.test(url)) return isInjectable(url, { fileAllowed: await fileAccessAllowed() });
    return false;
  }

  // --- Funciones que se ejecutan DENTRO de la página (serializadas por executeScript) ---

  function pageIsActive() {
    const c = globalThis.__imgdl;
    return !!(c && typeof c.isActive === 'function' && c.isActive());
  }

  // Estado + si la inyección cubrió solo el marco principal (lo anota el SW en
  // el controlador vía imgdl:frame-count {partial}).
  function pageStatus() {
    const c = globalThis.__imgdl;
    const active = !!(c && typeof c.isActive === 'function' && c.isActive());
    let partial = false;
    if (active && typeof c.debugState === 'function') {
      try { partial = c.debugState().partialFrames === true; } catch (_) { partial = false; }
    }
    return { active, partial };
  }

  function pageSetActive(on) {
    const c = globalThis.__imgdl;
    return !!(c && typeof c.setActive === 'function' && c.setActive(on) === true);
  }

  // --- Inyección y difusión ------------------------------------------------------

  // Inyecta los archivos en todos los frames; si algún frame rechaza la inyección
  // (sandbox, about:blank…) reintenta solo con el principal y marca partial.
  async function injectFiles(tabId, allFrames) {
    const base = { files: CONTENT_FILES, injectImmediately: true };
    if (allFrames !== false) {
      try {
        const results = await chrome.scripting.executeScript(Object.assign({ target: { tabId, allFrames: true } }, base));
        return { results, partial: false };
      } catch (e) {
        const results = await chrome.scripting.executeScript(Object.assign({ target: { tabId, frameIds: [0] } }, base));
        return { results, partial: true, error: String((e && e.message) || e) };
      }
    }
    const results = await chrome.scripting.executeScript(Object.assign({ target: { tabId, frameIds: [0] } }, base));
    return { results, partial: false };
  }

  // Estado real del frame principal. false si la pestaña no es accesible.
  async function getActive(tabId) {
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: pageIsActive });
      return !!(r && r[0] && r[0].result === true);
    } catch (_) {
      return false;
    }
  }

  // {active, partial} del frame principal. Inactivo si la pestaña no es accesible.
  async function getStatus(tabId) {
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: pageStatus });
      const s = r && r[0] && r[0].result;
      return { active: !!(s && s.active === true), partial: !!(s && s.active === true && s.partial === true) };
    } catch (_) {
      return { active: false, partial: false };
    }
  }

  // Difunde setActive(on) explícito a todos los frames (fallback: solo el principal).
  async function setActiveAll(tabId, on) {
    const req = { func: pageSetActive, args: [!!on] };
    try {
      return await chrome.scripting.executeScript(Object.assign({ target: { tabId, allFrames: true } }, req));
    } catch (_) {
      return await chrome.scripting.executeScript(Object.assign({ target: { tabId, frameIds: [0] } }, req));
    }
  }

  // Anota en el frame principal si la inyección fue parcial (debugState().partialFrames).
  // Mejor esfuerzo: solo tiene receptor cuando el controlador está activo.
  async function notifyPartial(tabId, partial) {
    try {
      await chrome.tabs.sendMessage(tabId, { to: 'content', type: 'imgdl:frame-count', partial: !!partial }, { frameId: 0 });
    } catch (_) {
      // Sin receptor (frame inactivo o pestaña cerrada).
    }
  }

  // --- Badge -----------------------------------------------------------------------

  async function setBadge(tabId, on, partial) {
    try {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' }),
        chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }),
        chrome.action.setTitle({ tabId, title: titleFor(!!on, !!on && !!partial) })
      ]);
    } catch (_) {
      // Pestaña cerrada entre medias.
    }
  }

  // Página no inyectable: '!' durante 3 s y vuelta al estado apagado.
  async function showRestricted(tabId) {
    try {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text: '!' }),
        chrome.action.setBadgeBackgroundColor({ tabId, color: RESTRICTED_COLOR }),
        chrome.action.setTitle({ tabId, title: text('ACTION_TITLE_RESTRICTED') })
      ]);
    } catch (_) {
      return;
    }
    setTimeout(async () => {
      try {
        const t = await chrome.action.getBadgeText({ tabId });
        if (t === '!') await setBadge(tabId, false);
      } catch (_) { /* pestaña cerrada */ }
    }, RESTRICTED_MS);
  }

  // --- Pestañas activas en storage.session (espejo, serializado) ------------------

  let storageQueue = Promise.resolve();

  async function readActiveTabs() {
    try {
      const got = await chrome.storage.session.get(STORAGE_KEY);
      const list = got && Array.isArray(got[STORAGE_KEY]) ? got[STORAGE_KEY] : [];
      return new Set(list.filter((n) => typeof n === 'number'));
    } catch (_) {
      return new Set();
    }
  }

  function markActive(tabId, on) {
    const run = async () => {
      const set = await readActiveTabs();
      if (on ? set.has(tabId) : !set.has(tabId)) return;
      if (on) set.add(tabId); else set.delete(tabId);
      try { await chrome.storage.session.set({ [STORAGE_KEY]: Array.from(set) }); } catch (_) { /* sin storage */ }
    };
    storageQueue = storageQueue.then(run, run);
    return storageQueue;
  }

  async function resetState() {
    for (const entry of ensureTimers.values()) clearTimeout(entry.timer);
    ensureTimers.clear();
    try { await chrome.storage.session.remove(STORAGE_KEY); } catch (_) { /* sin storage */ }
  }

  // --- Activación -------------------------------------------------------------------

  // Aplica el estado deseado SIN pasar por la cola (solo desde operaciones ya
  // encoladas): inyecta (si procede), difunde setActive, badge y espejo.
  // Devuelve {on, partial}: el estado real tras aplicarlo (el frame 0 manda) y si
  // solo se pudo inyectar el marco principal (paso 4 del algoritmo: partialFrames).
  async function applyStateNow(tabId, desired) {
    let partial = false;
    if (desired) {
      try {
        partial = !!(await injectFiles(tabId, true)).partial;
      } catch (_) {
        await showRestricted(tabId);
        return { on: false, partial: false };
      }
    }
    let on = false;
    try {
      const results = await setActiveAll(tabId, desired);
      const top = (results || []).find((r) => r && r.frameId === 0);
      on = !!desired && !!top && top.result === true;
    } catch (_) {
      on = false;
    }
    partial = on && partial;
    await setBadge(tabId, on, partial);
    await markActive(tabId, on);
    if (on) await notifyPartial(tabId, partial);
    return { on, partial };
  }

  // Versión encolada (hooks de test y usos externos). Devuelve {on, partial}.
  function applyState(tabId, desired) {
    return enqueue(tabId, () => applyStateNow(tabId, !!desired));
  }

  // action.onClicked (clic y atajo _execute_action) y __imgdlTest.toggle.
  // Devuelve el estado real tras alternar (boolean).
  function toggleTab(tab) {
    const tabId = tab && typeof tab.id === 'number' ? tab.id : null;
    if (tabId === null) return Promise.resolve(false);
    return enqueue(tabId, async () => {
      let url = typeof tab.url === 'string' ? tab.url : '';
      if (!url) {
        try { url = (await chrome.tabs.get(tabId)).url || ''; } catch (_) { url = ''; }
      }
      if (!(await canInject(url))) {
        await showRestricted(tabId);
        return false;
      }
      const current = await getActive(tabId);
      return (await applyStateNow(tabId, !current)).on;
    });
  }

  function deactivate(tabId) {
    return enqueue(tabId, async () => (await applyStateNow(tabId, false)).on);
  }

  // Lee el estado real del frame principal y lo refleja en badge, título y espejo.
  async function rederive(tabId) {
    const st = await getStatus(tabId);
    await setBadge(tabId, st.active, st.partial);
    await markActive(tabId, st.active);
    return st.active;
  }

  // Frame 0 avisa tras una navegación same-document (SPA): reafirmar solo si sigue activo.
  function reassertBadge(tabId) {
    return enqueue(tabId, () => rederive(tabId));
  }

  // iframes tardíos: reinyectar + setActive(true), con debounce de 500 ms por pestaña.
  const ensureTimers = new Map(); // tabId -> {timer, promise, resolve}

  function runEnsure(tabId) {
    return enqueue(tabId, async () => {
      if (!(await getActive(tabId))) return false;
      const inj = await injectFiles(tabId, true);
      await setActiveAll(tabId, true);
      await setBadge(tabId, true, inj.partial);
      await notifyPartial(tabId, inj.partial);
      return true;
    });
  }

  function ensureFrames(tabId) {
    let entry = ensureTimers.get(tabId);
    if (entry) {
      clearTimeout(entry.timer);
    } else {
      entry = {};
      entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
      ensureTimers.set(tabId, entry);
    }
    entry.timer = setTimeout(() => {
      ensureTimers.delete(tabId);
      runEnsure(tabId).then(entry.resolve, () => entry.resolve(false));
    }, FRAME_DEBOUNCE_MS);
    return entry.promise;
  }

  // --- Eventos de pestañas ----------------------------------------------------------

  // Solo para pestañas del espejo: re-deriva badge, título y espejo del estado real.
  // Formas reales de changeInfo (Chromium, verificado con una sonda):
  //   pushState   -> {status:'loading', url} y después {status:'complete'}
  //   navegación  -> {status:'loading', url} … {status:'complete'}
  //   recarga     -> {status:'loading'} … {status:'complete'}
  // Se atienden el cambio de URL y 'complete'; 'loading' sin URL se ignora.
  // Aquí no se reinyecta: un documento nuevo nunca está activo y los iframes
  // tardíos del mismo documento ya los avisa el controlador (imgdl:frames-changed).
  async function onTabUpdated(tabId, changeInfo) {
    if (!changeInfo) return;
    const complete = changeInfo.status === 'complete';
    const urlChanged = typeof changeInfo.url === 'string';
    if (!complete && !urlChanged) return;
    const set = await readActiveTabs();
    if (!set.has(tabId)) return;
    await enqueue(tabId, () => rederive(tabId));
  }

  async function onTabRemoved(tabId) {
    const entry = ensureTimers.get(tabId);
    if (entry) {
      clearTimeout(entry.timer);
      ensureTimers.delete(tabId);
      entry.resolve(false);
    }
    await markActive(tabId, false);
  }

  const api = {
    CONTENT_FILES,
    isInjectable,
    canInject,
    injectFiles,
    getActive,
    getStatus,
    setActiveAll,
    toggleTab,
    applyState,
    deactivate,
    reassertBadge,
    ensureFrames,
    setBadge,
    showRestricted,
    readActiveTabs,
    resetState,
    pendingTabs,
    onTabUpdated,
    onTabRemoved
  };

  root.ImgDL = root.ImgDL || {};
  root.ImgDL.tabs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
