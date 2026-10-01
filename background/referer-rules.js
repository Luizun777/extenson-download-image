'use strict';
// Regla de sesión declarativeNetRequest que fija la cabecera Referer en los fetch PROPIOS
// de la extensión (documento offscreen: peldaño 2 y trabajo ZIP), nunca en las descargas
// de chrome.downloads iniciadas desde el SW (no pasan por DNR, downloads-d2/d3). Requiere
// el permiso 'declarativeNetRequestWithHostAccess' (sin aviso de instalación) más los
// host_permissions. Sin el permiso, chrome.declarativeNetRequest no existe y todo aquí es
// inerte: enabled() false, addRefererRule resuelve null y removeRule/clearAll no hacen nada.
// Ids desde un contador en storage.session ('dnrNextId', empieza en 1000; en memoria si no
// hay storage). Se carga con importScripts en el SW y con require en Node (chrome simulado).
(function (root) {
  const RULE_ID_START = 1000;
  const ID_KEY = 'dnrNextId';
  const REFERER_MAX = 2048; // page.url más larga: solo origin + '/'
  const HOSTS_MAX = 100; // por encima no se filtra por requestDomains (la regla dura lo que el fetch)
  // Variante de la condición: tabIds:[TAB_ID_NONE] (peticiones sin pestaña, como las del
  // offscreen). Compuerta del paso 11 (hotlink.test.js con IMGDL_TAB_ID_NONE=0 y =1): en este
  // Chromium AMBAS variantes casan con el fetch del offscreen y hacen llegar el Referer. Por
  // defecto se queda la condición sin tabIds (no hace falta acotar más); la otra sigue
  // disponible para pruebas (setUseTabIdNone).
  const USE_TAB_ID_NONE = false;

  let useTabIdNone = USE_TAB_ID_NONE;
  let memoryNext = RULE_ID_START; // contador sin storage.session (Node)
  let idQueue = Promise.resolve(); // serializa nextId(): dos reglas a la vez no comparten id
  const live = new Set(); // ids añadidos por este SW y aún no retirados (hook de test)

  function dnr() {
    if (typeof chrome === 'undefined' || !chrome || typeof chrome.declarativeNetRequest === 'undefined') return null;
    const d = chrome.declarativeNetRequest;
    return d && typeof d.updateSessionRules === 'function' ? d : null;
  }

  function enabled() {
    return !!dnr();
  }

  function sessionStore() {
    return typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.session ? chrome.storage.session : null;
  }

  function isHttpUrl(u) {
    return typeof u === 'string' && /^https?:/i.test(u);
  }

  // Hosts distintos (hostname sin puerto, ya en minúsculas) de una lista de URLs http(s).
  function hostsOf(list) {
    const out = [];
    const seen = new Set();
    for (const u of Array.isArray(list) ? list : [list]) {
      if (!isHttpUrl(u)) continue;
      let host = '';
      try { host = new URL(u).hostname; } catch (_) { host = ''; }
      if (!host || seen.has(host)) continue;
      seen.add(host);
      out.push(host);
    }
    return out;
  }

  // Referer para una página: su url http(s) (o topUrl si el marco no tiene, p. ej. about:blank)
  // como la enviaría el navegador (RFC 7231 §5.5.2 y strict-origin-when-cross-origin): nunca
  // el fragmento ni las credenciales (user:pw@), y solo origin + '/' si algún objetivo es de
  // otro origen (incluida la bajada https→http) o si la url no cabe en 2 KB. targets: url(s)
  // http(s) que cubrirá la regla (opcional; sin ellas se asume el mismo origen).
  // '' si no hay ninguna URL http(s).
  function refererFor(page, targets) {
    const p = page && typeof page === 'object' ? page : {};
    const url = [p.url, p.topUrl].find(isHttpUrl);
    if (!url) return '';
    let u;
    try { u = new URL(url); } catch (_) { return ''; }
    u.hash = '';
    u.username = '';
    u.password = '';
    const list = (Array.isArray(targets) ? targets : [targets]).filter(isHttpUrl);
    const crossOrigin = list.some((t) => {
      try { return new URL(t).origin !== u.origin; } catch (_) { return true; }
    });
    if (crossOrigin || u.href.length > REFERER_MAX) return u.origin + '/';
    return u.href;
  }

  // Regla completa (pura): la condición acota a los fetch (xmlhttprequest) iniciados por la
  // propia extensión y, si son ≤ 100, a los hosts dados.
  function buildRule(id, hosts, referer, opts) {
    const o = opts || {};
    const extId = typeof o.extensionId === 'string' && o.extensionId
      ? o.extensionId
      : (typeof chrome !== 'undefined' && chrome && chrome.runtime ? chrome.runtime.id : '');
    const list = Array.isArray(hosts) ? hosts.filter((h) => typeof h === 'string' && h) : [];
    const condition = { initiatorDomains: [extId], resourceTypes: ['xmlhttprequest'] };
    if (list.length && list.length <= HOSTS_MAX) condition.requestDomains = list;
    const tabIdNone = typeof o.useTabIdNone === 'boolean' ? o.useTabIdNone : useTabIdNone;
    if (tabIdNone) {
      const none = typeof chrome !== 'undefined' && chrome && chrome.tabs && typeof chrome.tabs.TAB_ID_NONE === 'number' ? chrome.tabs.TAB_ID_NONE : -1;
      condition.tabIds = [none];
    }
    return {
      id,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }] },
      condition
    };
  }

  // Siguiente id: contador en storage.session (sobrevive al reinicio del SW) o en memoria.
  function nextId() {
    const run = async () => {
      const store = sessionStore();
      if (!store) return memoryNext++;
      let next = RULE_ID_START;
      try {
        const got = await store.get(ID_KEY);
        const n = got && got[ID_KEY];
        if (Number.isInteger(n) && n >= RULE_ID_START) next = n;
      } catch (_) { /* sin storage: desde 1000 */ }
      try { await store.set({ [ID_KEY]: next + 1 }); } catch (_) { /* sin storage */ }
      if (next < memoryNext) next = memoryNext; // reinicio con storage vacío: no repetir ids vivos
      memoryNext = next + 1;
      return next;
    };
    const p = idQueue.then(run, run);
    idQueue = p.then(() => {}, () => {});
    return p;
  }

  // addRefererRule(hosts, referer) -> Promise<ruleId|null>: null si DNR no está disponible,
  // no hay referer o Chrome rechaza la regla (el fetch sigue sin Referer).
  async function addRefererRule(hosts, referer) {
    const d = dnr();
    if (!d || typeof referer !== 'string' || !referer) return null;
    const id = await nextId();
    const rule = buildRule(id, hosts, referer);
    try {
      await d.updateSessionRules({ addRules: [rule] });
    } catch (_) {
      return null;
    }
    live.add(id);
    return id;
  }

  async function removeRule(id) {
    const d = dnr();
    if (!d || !Number.isInteger(id)) return false;
    live.delete(id);
    try {
      await d.updateSessionRules({ removeRuleIds: [id] });
      return true;
    } catch (_) {
      return false;
    }
  }

  // Arranque/instalación: retira toda regla de sesión que quedara viva (ids ≥ 1000, las nuestras).
  async function clearAll() {
    const d = dnr();
    if (!d || typeof d.getSessionRules !== 'function') return 0;
    let rules = [];
    try { rules = await d.getSessionRules(); } catch (_) { rules = []; }
    const ids = (Array.isArray(rules) ? rules : []).map((r) => r && r.id).filter((id) => Number.isInteger(id) && id >= RULE_ID_START);
    live.clear();
    if (!ids.length) return 0;
    try { await d.updateSessionRules({ removeRuleIds: ids }); } catch (_) { return 0; }
    return ids.length;
  }

  // Hooks de test: variante con tabIds y reglas vivas según este SW.
  function setUseTabIdNone(flag) {
    if (typeof flag === 'boolean') useTabIdNone = flag;
    return useTabIdNone;
  }

  function liveRules() {
    return Array.from(live);
  }

  const api = {
    USE_TAB_ID_NONE,
    RULE_ID_START,
    REFERER_MAX,
    HOSTS_MAX,
    enabled,
    hostsOf,
    refererFor,
    buildRule,
    nextId,
    addRefererRule,
    removeRule,
    clearAll,
    setUseTabIdNone,
    liveRules
  };

  root.ImgDL = root.ImgDL || {};
  root.ImgDL.refererRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
