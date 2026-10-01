'use strict';
// Activación por pestaña: badge y título, idempotencia, toggles solapados, Esc,
// páginas restringidas, navegación same-document y cross-document, recarga,
// cierre de pestaña y descarga de humo.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');
const S = require('../../lib/strings.js');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let srv;
let env;
let page;

async function openBasic() {
  await page.goto(srv.origin + '/pages/basic.html', { waitUntil: 'load' });
  return H.tabIdOf(env.sw, page);
}

function hostCount() {
  return page.evaluate(() => document.querySelectorAll('imgdl-root').length);
}

function activeTabs() {
  return env.sw.evaluate(() => self.__imgdlTest.activeTabs());
}

// Dos toggles sin esperar entre ellos (clic en la barra + Alt+Shift+D, o doble clic).
function toggleTwice(tabId) {
  return env.sw.evaluate((id) => Promise.all([self.__imgdlTest.toggle(id), self.__imgdlTest.toggle(id)]), tabId);
}

test.before(async () => {
  srv = await H.startFixtures();
  env = await H.launch();
  page = await env.context.newPage();
});

test.after(async () => {
  if (env) await env.close();
  if (srv) await srv.close();
});

test('toggle: badge ON, título ON y active true; segundo toggle: badge vacío y host retirado', async () => {
  const tabId = await openBasic();
  assert.equal(await H.badge(env.sw, tabId), '');
  assert.equal(await hostCount(), 0);

  assert.equal(await H.activate(env.sw, tabId), true);
  assert.equal(await H.badge(env.sw, tabId), 'ON');
  assert.equal(await H.title(env.sw, tabId), S.ACTION_TITLE_ON);
  const on = await H.state(env.sw, tabId);
  assert.equal(on.active, true);
  assert.equal(on.hostMounted, true);
  assert.deepEqual(
    { hoverKey: on.hoverKey, chipRect: on.chipRect, barRect: on.barRect, selectionCount: on.selectionCount, selectionTotal: on.selectionTotal, toasts: on.toasts, frameCounts: on.frameCounts, partialFrames: on.partialFrames, progressText: on.progressText },
    { hoverKey: null, chipRect: null, barRect: null, selectionCount: 0, selectionTotal: 0, toasts: [], frameCounts: {}, partialFrames: false, progressText: '' }
  );
  assert.equal(await hostCount(), 1);
  assert.equal(await page.evaluate(() => document.querySelector('imgdl-root').shadowRoot), null, 'shadow root cerrado');
  assert.deepEqual(await activeTabs(), [tabId]);

  assert.equal(await H.activate(env.sw, tabId), false);
  assert.equal(await H.badge(env.sw, tabId), '');
  assert.equal(await H.title(env.sw, tabId), S.ACTION_TITLE_OFF);
  assert.equal((await H.state(env.sw, tabId)).active, false);
  assert.equal(await page.evaluate(() => document.querySelector('imgdl-root')), null);
  assert.deepEqual(await activeTabs(), []);
});

test('toggles solapados: el segundo lee el estado ya aplicado por el primero', async () => {
  const tabId = await openBasic();
  assert.deepEqual(await toggleTwice(tabId), [true, false], 'desde OFF: activa y vuelve a apagar');
  assert.equal(await H.badge(env.sw, tabId), '');
  assert.equal((await H.state(env.sw, tabId)).active, false);
  assert.equal(await hostCount(), 0);
  assert.deepEqual(await activeTabs(), []);

  assert.equal(await H.activate(env.sw, tabId), true);
  assert.deepEqual(await toggleTwice(tabId), [false, true], 'desde ON: apaga y vuelve a activar');
  assert.equal(await H.badge(env.sw, tabId), 'ON');
  assert.equal((await H.state(env.sw, tabId)).active, true);
  assert.equal(await hostCount(), 1);
  assert.deepEqual(await activeTabs(), [tabId]);

  assert.equal(await H.activate(env.sw, tabId), false);
});

test('doble activación idempotente: un solo imgdl-root y resultados booleanos por frame', async () => {
  const tabId = await openBasic();
  assert.equal(await H.activate(env.sw, tabId), true);

  // Reinyección de archivos + setActive(true) dos veces (lo que hace ensureFrames).
  for (let i = 0; i < 2; i++) {
    const results = await env.sw.evaluate(async (id) => {
      const inj = await self.ImgDL.tabs.injectFiles(id, true);
      const set = await self.ImgDL.tabs.setActiveAll(id, true);
      return { inject: inj.results.map((r) => ({ frameId: r.frameId, result: r.result })), set: set.map((r) => ({ frameId: r.frameId, result: r.result })), partial: inj.partial };
    }, tabId);
    assert.deepEqual(results.inject, [{ frameId: 0, result: true }], 'executeScript({files}) devuelve isActive() por frame');
    assert.deepEqual(results.set, [{ frameId: 0, result: true }]);
    assert.equal(results.partial, false);
  }
  assert.equal(await env.sw.evaluate((id) => self.__imgdlTest.ensureFrames(id), tabId), true);
  assert.equal(await env.sw.evaluate((id) => self.__imgdlTest.setActive(id, true), tabId), true);
  assert.deepEqual(await env.sw.evaluate((id) => self.__imgdlTest.applyState(id, true), tabId), { on: true, partial: false });
  assert.equal((await H.state(env.sw, tabId)).partialFrames, false);

  assert.equal(await hostCount(), 1);
  assert.equal(await H.badge(env.sw, tabId), 'ON');
  assert.equal(await H.title(env.sw, tabId), S.ACTION_TITLE_ON);

  assert.equal(await H.activate(env.sw, tabId), false);
  assert.equal(await hostCount(), 0);
});

test('Esc desactiva: badge vacío en < 2 s y host retirado', async () => {
  const tabId = await openBasic();
  assert.equal(await H.activate(env.sw, tabId), true);
  assert.equal(await hostCount(), 1);

  await page.keyboard.press('Escape');
  await H.waitFor(async () => (await H.badge(env.sw, tabId)) === '', 2000, 50, 'badge tras Esc');
  await H.waitFor(async () => (await hostCount()) === 0, 2000, 50, 'host tras Esc');
  assert.equal((await H.state(env.sw, tabId)).active, false);
  assert.deepEqual(await activeTabs(), []);
});

test('chrome://version: toggle devuelve false y badge "!" sin excepción', async () => {
  await page.goto('chrome://version/');
  const tabId = await H.tabIdOf(env.sw, page);
  assert.equal(await H.activate(env.sw, tabId), false);
  assert.equal(await H.badge(env.sw, tabId), '!');
  assert.equal(await H.state(env.sw, tabId), null);
  assert.deepEqual(await activeTabs(), []);
});

test('pushState (same-document): imgdl:reassert-badge repone el badge ON y el controlador sigue activo', async (t) => {
  const tabId = await openBasic();
  assert.equal(await H.activate(env.sw, tabId), true);

  // 1) Centinela: si Chrome borrase el badge en la navegación same-document se
  //    vería '' antes de que el reassert escriba 'ON'.
  await env.sw.evaluate((id) => chrome.action.setBadgeText({ tabId: id, text: 'XX' }), tabId);
  assert.equal(await H.badge(env.sw, tabId), 'XX');
  await page.evaluate(() => history.pushState({}, '', '/pages/basic.html?x=1'));
  const seen = [];
  await H.waitFor(async () => {
    const b = await H.badge(env.sw, tabId);
    if (seen[seen.length - 1] !== b) seen.push(b);
    return b === 'ON';
  }, 2000, 10, 'badge tras pushState (centinela)');
  assert.ok(!seen.includes(''), 'Chrome no reinicia el badge en same-document; visto: ' + JSON.stringify(seen));
  t.diagnostic(`same-document (pushState) NO reinicia el badge (verificado): valores vistos ${JSON.stringify(seen)}; lo repone imgdl:reassert-badge`);

  // 2) Badge borrado a mano: solo imgdl:reassert-badge / onUpdated pueden reponerlo.
  await env.sw.evaluate((id) => chrome.action.setBadgeText({ tabId: id, text: '' }), tabId);
  assert.equal(await H.badge(env.sw, tabId), '');
  await page.evaluate(() => history.pushState({}, '', '/pages/basic.html?x=2'));
  await H.waitFor(async () => (await H.badge(env.sw, tabId)) === 'ON', 2000, 50, 'badge tras pushState (borrado)');
  assert.equal(await H.title(env.sw, tabId), S.ACTION_TITLE_ON);
  assert.equal(page.url(), srv.origin + '/pages/basic.html?x=2');
  assert.equal((await H.state(env.sw, tabId)).active, true);
  assert.equal(await hostCount(), 1);
  assert.deepEqual(await activeTabs(), [tabId]);

  assert.equal(await H.activate(env.sw, tabId), false);
});

test('navegación cross-document con la extensión activa: badge vacío, sin controlador y fuera de activeTabs', async () => {
  const tabId = await openBasic();
  assert.equal(await H.activate(env.sw, tabId), true);

  await page.goto(srv.origin + '/pages/basic.html?doc=2', { waitUntil: 'load' });
  await H.waitFor(async () => (await H.badge(env.sw, tabId)) === '', 2000, 50, 'badge tras navegar');
  assert.equal(await H.state(env.sw, tabId), null, '__imgdl no existe en el documento nuevo');
  assert.equal(await hostCount(), 0);
  await H.waitFor(async () => !(await activeTabs()).includes(tabId), 2000, 50, 'activeTabs tras navegar');
});

test('reload: badge vacío, sin controlador y fuera de activeTabs', async () => {
  const tabId = await openBasic();
  assert.equal(await H.activate(env.sw, tabId), true);

  await page.reload({ waitUntil: 'load' });
  await H.waitFor(async () => (await H.badge(env.sw, tabId)) === '', 2000, 50, 'badge tras reload');
  assert.equal(await H.state(env.sw, tabId), null, '__imgdl no existe en el documento nuevo');
  assert.equal(await hostCount(), 0);
  await H.waitFor(async () => !(await activeTabs()).includes(tabId), 2000, 50, 'activeTabs tras reload');
});

test('cerrar la pestaña la elimina de activeTabs', async () => {
  const other = await env.context.newPage();
  await other.goto(srv.origin + '/pages/basic.html', { waitUntil: 'load' });
  const otherId = await H.tabIdOf(env.sw, other);
  assert.equal(await H.activate(env.sw, otherId), true);
  assert.ok((await activeTabs()).includes(otherId));

  await other.close();
  await H.waitFor(async () => !(await activeTabs()).includes(otherId), 2000, 50, 'activeTabs tras cerrar');
});

test('descarga de humo desde el SW: complete, bytes PNG y opciones registradas', async (t) => {
  const opts = { url: srv.origin + '/img/a.png?w=50&h=50', filename: 'Imagenes/test/a.png', conflictAction: 'uniquify' };
  const id = await env.sw.evaluate((o) => self.__imgdlTest.download(o), opts);
  assert.equal(typeof id, 'number');

  const item = await H.waitForDownload(env.sw, (it) => it.id === id);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  const bytes = H.readFile(item.filename);
  assert.deepEqual(bytes.subarray(0, 4), PNG_MAGIC);
  assert.ok(item.filename.startsWith(env.downloadsDir), 'guardado en downloadsPath: ' + item.filename);

  const last = await env.sw.evaluate(() => self.__imgdlTest.lastDownloads());
  assert.deepEqual(last[last.length - 1], opts);

  const base = require('node:path').basename(item.filename);
  t.diagnostic(`nombre en disco: ${base} (GUID: ${/^[0-9a-f-]{36}$/i.test(base)}); incluye 'Imagenes/test': ${item.filename.includes('Imagenes/test')}; mime: ${item.mime}; bytes: ${bytes.length}`);
});
