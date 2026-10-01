'use strict';
// background/tabs.js con un chrome simulado: cola por pestaña (toggles solapados),
// inyección parcial ({on, partial}, título, partialFrames en el frame 0) y las
// formas reales de chrome.tabs.onUpdated (loading+url, complete, loading sin url).
const test = require('node:test');
const assert = require('node:assert/strict');

// --- chrome simulado -------------------------------------------------------------
// Cada executeScript cede el hilo (setTimeout) para que dos operaciones solapadas
// SIN cola lean el mismo estado viejo: así el test detecta la falta de serialización.
function makeChrome() {
  const tabs = new Map();
  const session = {};
  let fileInjections = 0;

  function tab(id) {
    const t = tabs.get(id);
    if (!t) throw new Error('No tab with id: ' + id);
    return t;
  }

  function frameIdsOf(t, target) {
    if (target.allFrames) return Array.from(t.frames.keys());
    return target.frameIds || [0];
  }

  function yieldTurn() {
    return new Promise((r) => setTimeout(r, 2));
  }

  const chrome = {
    scripting: {
      async executeScript(opts) {
        const t = tab(opts.target.tabId);
        await yieldTurn();
        if (opts.target.allFrames && t.rejectAllFrames) throw new Error('Cannot access contents of the page');
        if (opts.files) {
          fileInjections++;
          return frameIdsOf(t, opts.target).map((frameId) => {
            const f = t.frames.get(frameId);
            f.controller = f.controller || { active: false, partial: false };
            return { frameId, result: f.controller.active };
          });
        }
        const name = opts.func && opts.func.name;
        return frameIdsOf(t, opts.target).map((frameId) => {
          const c = t.frames.get(frameId).controller;
          if (name === 'pageIsActive') return { frameId, result: !!(c && c.active) };
          if (name === 'pageStatus') return { frameId, result: { active: !!(c && c.active), partial: !!(c && c.active && c.partial) } };
          if (name === 'pageSetActive') {
            if (!c) return { frameId, result: false };
            c.active = !!opts.args[0];
            if (!c.active) c.partial = false;
            return { frameId, result: c.active };
          }
          throw new Error('func desconocida: ' + name);
        });
      }
    },
    action: {
      async setBadgeText({ tabId, text }) { tab(tabId).badge = text; },
      async getBadgeText({ tabId }) { return tab(tabId).badge; },
      async setBadgeBackgroundColor({ tabId, color }) { tab(tabId).color = color; },
      async setTitle({ tabId, title }) { tab(tabId).title = title; },
      async getTitle({ tabId }) { return tab(tabId).title; }
    },
    storage: {
      session: {
        async get(key) { return key in session ? { [key]: session[key] } : {}; },
        async set(obj) { Object.assign(session, obj); },
        async remove(key) { delete session[key]; }
      }
    },
    tabs: {
      async get(id) { return { id, url: tab(id).url }; },
      async sendMessage(tabId, msg, opts) {
        const t = tab(tabId);
        const f = t.frames.get((opts && opts.frameId) || 0);
        if (!f || !f.controller || !f.controller.active) throw new Error('Could not establish connection. Receiving end does not exist.');
        t.messages.push(msg);
        if (msg.type === 'imgdl:frame-count' && typeof msg.partial === 'boolean') f.controller.partial = msg.partial;
        return { ok: true };
      }
    },
    extension: { isAllowedFileSchemeAccess(cb) { cb(false); } }
  };

  function addTab(id, { url = 'http://127.0.0.1/pages/basic.html', frames = [0], rejectAllFrames = false } = {}) {
    const t = { url, frames: new Map(), rejectAllFrames, badge: '', color: '', title: '', messages: [] };
    for (const fid of frames) t.frames.set(fid, { controller: null });
    tabs.set(id, t);
    return t;
  }

  // Navegación cross-document: documento nuevo sin controlador.
  function navigate(id, url) {
    const t = tab(id);
    t.url = url;
    t.badge = ''; // Chrome reinicia el badge de pestaña al cambiar de documento
    for (const f of t.frames.values()) f.controller = null;
  }

  return { chrome, addTab, tab, navigate, fileInjections: () => fileInjections };
}

const fake = makeChrome();
globalThis.chrome = fake.chrome;
const tabs = require('../../background/tabs.js');
const S = require('../../lib/strings.js');

async function activeTabs() {
  return Array.from(await tabs.readActiveTabs()).sort();
}

test('exporta la API acordada', () => {
  for (const k of ['CONTENT_FILES', 'isInjectable', 'injectFiles', 'getActive', 'setActiveAll', 'toggleTab', 'ensureFrames', 'setBadge', 'onTabUpdated', 'onTabRemoved', 'applyState', 'deactivate', 'reassertBadge', 'readActiveTabs', 'pendingTabs']) {
    assert.equal(typeof tabs[k], k === 'CONTENT_FILES' ? 'object' : 'function', k);
  }
});

test('toggleTab: dos toggles solapados desde OFF -> [true, false], badge vacío y fuera del espejo', async () => {
  const id = 1;
  fake.addTab(id, { frames: [0, 1] });
  const tab = await fake.chrome.tabs.get(id);
  assert.deepEqual(await Promise.all([tabs.toggleTab(tab), tabs.toggleTab(tab)]), [true, false]);
  assert.equal(fake.tab(id).badge, '');
  assert.equal(fake.tab(id).title, S.ACTION_TITLE_OFF);
  assert.equal(await tabs.getActive(id), false);
  assert.deepEqual(await activeTabs(), []);

  // Desde ON: el segundo lee el estado ya aplicado por el primero -> [false, true].
  assert.equal(await tabs.toggleTab(tab), true);
  assert.deepEqual(await Promise.all([tabs.toggleTab(tab), tabs.toggleTab(tab)]), [false, true]);
  assert.equal(fake.tab(id).badge, 'ON');
  assert.equal(fake.tab(id).title, S.ACTION_TITLE_ON);
  assert.deepEqual(await activeTabs(), [id]);

  assert.equal(await tabs.deactivate(id), false);
  assert.deepEqual(await activeTabs(), []);
  assert.deepEqual(tabs.pendingTabs(), [], 'la cola se retira al vaciarse');
});

test('deactivate y reassertBadge solapados: gana el orden de llegada (badge vacío al final)', async () => {
  const id = 2;
  fake.addTab(id);
  const tab = await fake.chrome.tabs.get(id);
  assert.equal(await tabs.toggleTab(tab), true);
  const [off, reasserted] = await Promise.all([tabs.deactivate(id), tabs.reassertBadge(id)]);
  assert.equal(off, false);
  assert.equal(reasserted, false, 'reassert lee el estado ya desactivado');
  assert.equal(fake.tab(id).badge, '');
  assert.deepEqual(await activeTabs(), []);
  assert.deepEqual(tabs.pendingTabs(), []);
});

test('pestaña inexistente: applyState no rechaza ({on:false}) y la cola queda limpia', async () => {
  const id = 3;
  fake.addTab(id);
  assert.deepEqual(await tabs.applyState(99, true), { on: false, partial: false });
  assert.deepEqual(await tabs.applyState(id, true), { on: true, partial: false });
  assert.deepEqual(await tabs.applyState(id, false), { on: false, partial: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(tabs.pendingTabs(), []);
});

test('inyección parcial: applyState -> {on:true, partial:true}, título con nota y partialFrames en el frame 0', async () => {
  const id = 4;
  fake.addTab(id, { frames: [0, 1], rejectAllFrames: true });
  const before = fake.fileInjections();
  assert.deepEqual(await tabs.applyState(id, true), { on: true, partial: true });
  assert.equal(fake.fileInjections() - before, 1, 'allFrames rechazó y solo se inyectó frameIds:[0]');
  assert.equal(fake.tab(id).frames.get(1).controller, null, 'el iframe no recibió los archivos');
  assert.equal(fake.tab(id).badge, 'ON');
  assert.notEqual(fake.tab(id).title, S.ACTION_TITLE_ON);
  assert.match(fake.tab(id).title, /marco principal/);
  const partialMsgs = fake.tab(id).messages.filter((m) => m.type === 'imgdl:frame-count' && m.partial === true);
  assert.equal(partialMsgs.length, 1, 'se avisa al frame 0 con imgdl:frame-count {partial:true}');
  assert.deepEqual(await tabs.getStatus(id), { active: true, partial: true });

  // La nota parcial sobrevive a reassertBadge (se relee de la página, no del SW).
  fake.tab(id).title = 'borrado';
  assert.equal(await tabs.reassertBadge(id), true);
  assert.match(fake.tab(id).title, /marco principal/);

  // toggleTab sigue devolviendo boolean y al apagar vuelve el título normal.
  assert.equal(await tabs.toggleTab({ id, url: fake.tab(id).url }), false);
  assert.equal(fake.tab(id).title, S.ACTION_TITLE_OFF);
  assert.deepEqual(await tabs.getStatus(id), { active: false, partial: false });
});

test('ensureFrames: si la reinyección cubre todos los marcos, la nota parcial desaparece', async () => {
  const id = 5;
  const t = fake.addTab(id, { frames: [0, 1], rejectAllFrames: true });
  assert.deepEqual(await tabs.applyState(id, true), { on: true, partial: true });
  t.rejectAllFrames = false; // el marco conflictivo desapareció
  assert.equal(await tabs.ensureFrames(id), true);
  assert.equal(t.title, S.ACTION_TITLE_ON);
  assert.equal(t.frames.get(1).controller.active, true, 'el iframe ya está activo');
  assert.deepEqual(await tabs.getStatus(id), { active: true, partial: false });
  await tabs.deactivate(id);
});

test('onTabUpdated: {status:"loading", url} (pushState) re-deriva el badge sin reinyectar', async () => {
  const id = 6;
  fake.addTab(id, { frames: [0, 1] });
  assert.deepEqual(await tabs.applyState(id, true), { on: true, partial: false });
  fake.tab(id).badge = ''; // simula un badge perdido
  const before = fake.fileInjections();
  await tabs.onTabUpdated(id, { status: 'loading', url: fake.tab(id).url + '?p=1' });
  assert.equal(fake.tab(id).badge, 'ON');
  await tabs.onTabUpdated(id, { status: 'complete' });
  assert.equal(fake.tab(id).badge, 'ON');
  assert.equal(fake.fileInjections(), before, 'ni loading+url ni complete reinyectan');
  assert.deepEqual(await activeTabs(), [id]);
  await tabs.deactivate(id);
});

test('onTabUpdated: {status:"loading"} sin url se ignora; documento nuevo -> badge vacío y fuera del espejo', async () => {
  const id = 7;
  fake.addTab(id);
  assert.deepEqual(await tabs.applyState(id, true), { on: true, partial: false });
  fake.tab(id).badge = 'XX';
  await tabs.onTabUpdated(id, { status: 'loading' });
  assert.equal(fake.tab(id).badge, 'XX', 'loading sin url no toca el badge');

  fake.navigate(id, 'http://127.0.0.1/pages/other.html');
  await tabs.onTabUpdated(id, { status: 'loading', url: 'http://127.0.0.1/pages/other.html' });
  assert.equal(fake.tab(id).badge, '');
  assert.deepEqual(await activeTabs(), []);
  // Ya fuera del espejo: 'complete' no hace nada (ni siquiera encola).
  await tabs.onTabUpdated(id, { status: 'complete' });
  assert.deepEqual(tabs.pendingTabs(), []);
});

test('onTabUpdated ignora pestañas que no están en el espejo', async () => {
  const id = 8;
  fake.addTab(id);
  await tabs.onTabUpdated(id, { status: 'complete' });
  assert.equal(fake.tab(id).badge, '');
  assert.equal(fake.tab(id).title, '', 'no se escribió ningún título');
});

test('onTabRemoved saca la pestaña del espejo', async () => {
  const id = 9;
  fake.addTab(id);
  assert.equal(await tabs.toggleTab({ id, url: fake.tab(id).url }), true);
  assert.deepEqual(await activeTabs(), [id]);
  await tabs.onTabRemoved(id);
  assert.deepEqual(await activeTabs(), []);
});
