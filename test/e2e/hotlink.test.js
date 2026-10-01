'use strict';
// Anti-hotlink por Referer (paso 11, con compuerta) con la extensión real: hotlink.html
// muestra una imagen del origen ALTERNO que el servidor solo sirve con Referer de nuestros
// orígenes. chrome.downloads nunca envía Referer (downloads-d1): el peldaño 1 termina
// interrumpido SERVER_FORBIDDEN y se borra; el peldaño 2 (fetch en el offscreen) lleva el
// Referer de la página gracias a la regla DNR de sesión (downloads-d3) y completa con bytes
// PNG; /count muestra el acierto con Referer y getSessionRules() queda vacío. El ZIP envuelve
// off:zip-job con la misma regla: la imagen hotlink entra en el ZIP (no en _fallidas.txt). El
// lote de archivos sueltos también sube al peldaño 2 (la hotlink se descarga, sin toast por
// ítem). La página se abre con un fragmento de SPA (#/album/123): /referers comprueba el valor
// EXACTO de la cabecera, que hacia el origen alterno es solo origin + '/' (como el navegador:
// strict-origin-when-cross-origin), nunca la url con el fragmento.
// Sin el permiso declarativeNetRequestWithHostAccess (compuerta cerrada) el test afirma el
// comportamiento real: toast ERR_403 con "Copiar URL" y la imagen en _fallidas.txt (HTTP_403).
// IMGDL_TAB_ID_NONE=1 prueba la variante de la condición con tabIds:[TAB_ID_NONE] (ambas
// variantes pasan en este Chromium; la predeterminada es sin tabIds).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const H = require('./harness.js');
const S = require('../../lib/strings.js');
const names = require('../../lib/names.js');
const urls = require('../../lib/urls.js');
const { DEFAULTS } = require('../../lib/thresholds.js');

const TMP = path.join(__dirname, '..', '.tmp');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const HOTLINK_PATH = '/hotlink/h.png?w=300&h=300';
const NORMAL_PATH = '/img/normal.png?w=120&h=120';
const HOTLINK_KEY = HOTLINK_PATH.split('?')[0];
const NORMAL_KEY = NORMAL_PATH.split('?')[0];
const FRAGMENT = '#/album/123'; // ruta de SPA en la url de la página: nunca debe viajar en el Referer
const TAB_ID_NONE = process.env.IMGDL_TAB_ID_NONE === '1';

let srv;
let env;
let page;
let tabId;
let hotlinkUrl; // origen alterno
let folder; // Imagenes/<host de la página>
let gated = null; // ¿regla DNR disponible? (permiso presente)

function sw(fn, arg) {
  return env.sw.evaluate(fn, arg);
}

function state() {
  return H.state(env.sw, tabId);
}

function lastNotify() {
  return sw(() => self.__imgdlTest.lastNotify());
}

function lastDownloads() {
  return sw(() => self.__imgdlTest.lastDownloads());
}

function searchUrl(url) {
  return sw((u) => chrome.downloads.search({ url: u }), url);
}

function sessionRules() {
  return sw(() => self.__imgdlTest.sessionRules());
}

function lastJobDone() {
  return sw(() => self.__imgdlTest.lastJobDone());
}

async function hits() {
  return (await fetch(srv.origin + '/count')).json();
}

// Valores exactos de Referer recibidos por ruta (los últimos 8).
async function referersOf(key) {
  return (await (await fetch(srv.origin + '/referers')).json())[key] || [];
}

function pageInfo() {
  return { url: page.url(), title: 'Fixture: anti-hotlink por Referer' };
}

function lastJobDoneFor(jobId) {
  return H.waitFor(async () => (await lastJobDone()).find((j) => j.jobId === jobId), 40000, 100, 'job-done ' + jobId);
}

function waitNotify(pred, label) {
  return H.waitFor(async () => (await lastNotify()).findLast(pred), 20000, 100, label);
}

async function waitHover(key) {
  const r = await page.evaluate(() => {
    const b = document.getElementById('h').getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.move(r.x, r.y);
  return H.waitFor(async () => {
    const st = await state();
    return st && st.hoverKey === key && st.chipRect ? st : null;
  }, 5000, 50, 'hover ' + key);
}

// Lista + comprobación de un ZIP (unzip -t y zipfile de Python) con el texto de _fallidas.txt.
function inspectZip(item, name) {
  fs.mkdirSync(TMP, { recursive: true });
  const dest = path.join(TMP, name);
  fs.copyFileSync(item.filename, dest);
  assert.match(execFileSync('unzip', ['-t', dest], { encoding: 'utf8' }), /No errors detected/);
  const listing = JSON.parse(execFileSync('python3', ['-c', [
    'import zipfile, sys, json',
    'z = zipfile.ZipFile(sys.argv[1])',
    'out = {"test": z.testzip(), "entries": []}',
    'for i in z.infolist():',
    '    d = z.read(i.filename)',
    '    out["entries"].append({"name": i.filename, "size": i.file_size, "head": list(d[:4]), "text": d.decode("utf-8", "replace") if i.filename.endswith(".txt") else None})',
    'print(json.dumps(out, ensure_ascii=False))'
  ].join('\n'), dest], { encoding: 'utf8' }));
  assert.equal(listing.test, null, 'zipfile.testzip');
  return { dest, entries: listing.entries };
}

test.before(async () => {
  srv = await H.startFixtures();
  env = await H.launch();
  gated = await sw(() => self.__imgdlTest.refererRules());
  if (TAB_ID_NONE) await sw(() => self.__imgdlTest.setTabIdNone(true));
  page = await env.context.newPage();
  await page.goto(srv.origin + '/pages/hotlink.html' + FRAGMENT, { waitUntil: 'load' });
  await page.waitForFunction(() => { const i = document.getElementById('h'); return i.complete && i.naturalWidth > 0; });
  assert.ok(page.url().endsWith(FRAGMENT), page.url());
  tabId = await H.tabIdOf(env.sw, page);
  hotlinkUrl = srv.altOrigin + HOTLINK_PATH;
  folder = names.buildPaths({ folder: 'Imagenes', host: urls.hostOf(page.url()), stamp: 'S' }).single;
  await H.activate(env.sw, tabId);
  await H.waitFor(() => H.badge(env.sw, tabId).then((b) => b === 'ON'), 3000, 50, 'badge ON');
});

test.after(async () => {
  if (env) await env.close();
  if (srv) await srv.close();
});

test('la página carga la imagen con Referer y el permiso DNR está (o no) presente', async (t) => {
  const h = (await hits())[HOTLINK_KEY];
  assert.ok(h && h.hits >= 1 && h.withReferer >= 1, 'carga con Referer: ' + JSON.stringify(h));
  // Lo que envía el propio navegador hacia el origen alterno (strict-origin-when-cross-origin):
  // solo origin + '/', sin el fragmento. Es el valor que la regla DNR debe imitar.
  assert.deepEqual(await referersOf(HOTLINK_KEY), [srv.origin + '/'], 'Referer del navegador');
  assert.equal(await sessionRules().then((r) => r.length), 0, 'sin reglas de sesión al empezar');
  t.diagnostic('compuerta: ' + (gated ? 'declarativeNetRequest disponible' : 'SIN permiso DNR (peldaño 2 sin Referer)') + '; variante tabIds:[TAB_ID_NONE]=' + TAB_ID_NONE);
});

test('clic en el chip: peldaño 1 interrumpido SERVER_FORBIDDEN y borrado; peldaño 2 con Referer completa con bytes PNG', async (t) => {
  await sw(() => self.__imgdlTest.setOffscreenIdle(500));
  const key = 'http|' + hotlinkUrl;
  const st = await waitHover(key);
  const before = (await lastDownloads()).length;
  const h0 = (await hits())[HOTLINK_KEY];
  const refs0 = await referersOf(HOTLINK_KEY);
  await H.clickChip(page, st, 'download');

  if (gated) {
    const n = await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === hotlinkUrl, 'aviso STATUS_DONE (peldaño 2)');
    assert.equal(n.msg.level, 'info');
    assert.equal(n.tabId, tabId);
    const mine = (await lastDownloads()).slice(before);
    assert.equal(mine.length, 2, JSON.stringify(mine));
    assert.equal(mine[0].url, hotlinkUrl, 'peldaño 1: la URL http');
    assert.match(mine[1].url, /^blob:chrome-extension:\/\//, 'peldaño 2: la blob del offscreen');
    // Base 'h' (1 carácter) es genérica para names.js: el nombre sale del alt ('hotlink').
    assert.equal(mine[0].filename, folder + '/hotlink.png');
    assert.equal(mine[1].filename, folder + '/hotlink.png', 'mismo nombre (extensión del sniff: png)');

    // El ítem interrumpido del peldaño 1 se borró; la blob completó con bytes PNG.
    assert.deepEqual(await searchUrl(hotlinkUrl), [], 'sin restos interrumpidos del peldaño 1');
    const items = await searchUrl(mine[1].url);
    assert.equal(items.length, 1, JSON.stringify(items));
    assert.equal(items[0].state, 'complete', JSON.stringify(items[0]));
    assert.deepEqual(H.readFile(items[0].filename).subarray(0, 4), PNG_MAGIC);
    const interrupted = (await sw(() => chrome.downloads.search({ state: 'interrupted' }))).filter((it) => it.url === hotlinkUrl);
    assert.deepEqual(interrupted, []);

    // /count: el fetch del offscreen llevó Referer (además de la carga de la página).
    const h = (await hits())[HOTLINK_KEY];
    assert.ok(h.hits >= h0.hits + 2, 'peldaño 1 (403) + peldaño 2: ' + JSON.stringify({ h0, h }));
    assert.ok(h.withReferer >= h0.withReferer + 1, 'el fetch del offscreen llevó Referer: ' + JSON.stringify({ h0, h }));
    assert.equal(h.hits - h.withReferer, h0.hits - h0.withReferer + 1, 'solo el intento de chrome.downloads fue sin Referer');
    // Valor EXACTO en el cable: la página (location.href con #/album/123) está en otro origen que
    // la imagen, así que solo viaja origin + '/' (como el navegador), nunca el fragmento.
    const refs = await referersOf(HOTLINK_KEY);
    assert.equal(refs.length, refs0.length + 1, JSON.stringify(refs));
    assert.equal(refs[refs.length - 1], srv.origin + '/', 'Referer del peldaño 2');
    assert.ok(!refs.some((x) => /#|album/.test(x)), 'el fragmento nunca viaja: ' + JSON.stringify(refs));

    const toasts = await H.waitFor(async () => { const s = await state(); return s.toasts.some((x) => /^Descargada: /.test(x)) ? s.toasts : null; }, 5000, 50, 'toast Descargada');
    assert.ok(!toasts.includes(S.ERR_403), JSON.stringify(toasts));
    t.diagnostic('peldaño 2 con Referer: ' + JSON.stringify(h) + '; descargas: ' + JSON.stringify(mine.map((o) => o.url.slice(0, 40))));
  } else {
    // Compuerta cerrada: el peldaño 2 también recibe 403 → peldaño 3 (ERR_403 + "Copiar URL").
    const n = await waitNotify((e) => e.msg.code === 'HTTP_403' && e.msg.url === hotlinkUrl, 'aviso HTTP_403');
    assert.equal(n.msg.level, 'error');
    assert.equal(n.msg.text, S.ERR_403);
    assert.equal(n.msg.action, 'copy-url');
    assert.equal(n.msg.reason, 'SERVER_FORBIDDEN');
    assert.equal(n.msg.rung2, 'HTTP_403');
    const mine = (await lastDownloads()).slice(before);
    assert.deepEqual(mine.map((o) => o.url), [hotlinkUrl], 'solo el intento directo');
    assert.deepEqual(await searchUrl(hotlinkUrl), [], 'el ítem interrumpido se borró antes del peldaño 2');
    const h = (await hits())[HOTLINK_KEY];
    assert.equal(h.withReferer, h0.withReferer, 'ningún intento llevó Referer');
    const toasts = await H.waitFor(async () => { const s = await state(); return s.toasts.includes(S.ERR_403) ? s.toasts : null; }, 5000, 50, 'toast ERR_403');
    t.diagnostic('COMPUERTA CERRADA: ' + JSON.stringify(toasts));
  }
  assert.deepEqual(await sw(() => self.__imgdlTest.pending()), {});
  assert.equal(await sessionRules().then((r) => r.length), 0, 'getSessionRules() vacío después');
  assert.deepEqual(await sw(() => self.__imgdlTest.liveRefererRules()), []);
  // La blob se revocó y el offscreen se cierra al quedar ocioso.
  await H.waitFor(async () => (await sw(() => self.__imgdlTest.offscreenContexts())) === 0, 6000, 100, 'offscreen cerrado');
  await sw(() => self.__imgdlTest.setOffscreenIdle(undefined));
});

test('ZIP (hotlink + una normal): off:zip-job envuelto con la regla; la hotlink entra en el ZIP y la regla se retira', async (t) => {
  // Segunda imagen (origen de la página) añadida al vuelo: testSelectExpect la ve por [data-expect].
  await page.evaluate((p) => new Promise((resolve) => {
    const img = document.createElement('img');
    img.id = 'n';
    img.width = 120;
    img.height = 120;
    img.alt = 'normal';
    img.setAttribute('data-expect', p);
    img.onload = () => resolve();
    img.src = p;
    document.body.append(img);
  }), NORMAL_PATH);
  const n = await sw(({ tabId, paths }) => self.__imgdlTest.selectExpect(tabId, paths), { tabId, paths: [HOTLINK_PATH, NORMAL_PATH] });
  assert.equal(n, 2, 'dos seleccionadas');
  const h0 = (await hits())[HOTLINK_KEY];
  const refs0 = await referersOf(HOTLINK_KEY);
  const before = (await lastDownloads()).length;
  const r = await sw(({ tabId, page }) => self.__imgdlTest.runZip(tabId, page, {}), { tabId, page: pageInfo() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.total, 2);
  const done = await lastJobDoneFor(r.jobId);
  assert.equal(done.ok, true, JSON.stringify(done));
  const zipOpts = (await lastDownloads()).slice(before).find((o) => /^blob:/.test(o.url) && /\.zip$/.test(o.filename));
  assert.ok(zipOpts, 'descarga del .zip: ' + JSON.stringify((await lastDownloads()).slice(before)));
  const item = await H.waitForDownload(env.sw, (it) => it.filename === done.zipFilename);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  const z = inspectZip(item, 'hotlink.zip');
  const entryNames = z.entries.map((e) => e.name).sort();
  const h = (await hits())[HOTLINK_KEY];

  if (gated) {
    assert.equal(done.done, 2, JSON.stringify(done));
    assert.equal(done.failed, 0);
    assert.equal(done.fallback, 0);
    assert.deepEqual(entryNames, ['hotlink.png', 'normal.png'], 'la hotlink está en el ZIP (nombre por alt), no en _fallidas.txt');
    for (const e of z.entries) assert.deepEqual(Buffer.from(e.head), PNG_MAGIC, e.name);
    assert.ok(h.withReferer >= h0.withReferer + 1, 'el fetch del ZIP llevó Referer: ' + JSON.stringify({ h0, h }));
    // Una sola regla para los dos hosts: con un objetivo en otro origen el valor es origin + '/'
    // también para la imagen del propio origen (sin fragmento en ningún caso).
    const refs = await referersOf(HOTLINK_KEY);
    assert.equal(refs.length, refs0.length + 1, JSON.stringify(refs));
    assert.equal(refs[refs.length - 1], srv.origin + '/', 'Referer del fetch hotlink del ZIP');
    const refsNormal = await referersOf(NORMAL_KEY);
    assert.equal(refsNormal[refsNormal.length - 1], srv.origin + '/', 'Referer del fetch normal del ZIP: ' + JSON.stringify(refsNormal));
    assert.ok(!refs.concat(refsNormal).some((x) => /#|album/.test(x)), JSON.stringify({ refs, refsNormal }));
    t.diagnostic('zip: ' + z.dest + '; hits: ' + JSON.stringify(h) + '; referers: ' + JSON.stringify(refs));
  } else {
    assert.equal(done.done, 1, JSON.stringify(done));
    assert.equal(done.failed, 1);
    assert.ok(entryNames.includes('_fallidas.txt') && entryNames.includes('normal.png') && !entryNames.includes('hotlink.png'), JSON.stringify(entryNames));
    const failed = z.entries.find((e) => e.name === '_fallidas.txt');
    assert.match(failed.text, /\/hotlink\/h\.png\?w=300&h=300\tHTTP_403$/m, failed.text);
    assert.equal(h.withReferer, h0.withReferer, 'sin Referer en el fetch del ZIP');
    t.diagnostic('COMPUERTA CERRADA: ' + JSON.stringify(entryNames) + ' ' + JSON.stringify(failed.text));
  }
  assert.equal(await sessionRules().then((x) => x.length), 0, 'getSessionRules() vacío tras el ZIP');
  assert.deepEqual(await sw(() => self.__imgdlTest.liveRefererRules()), []);
  await H.waitFor(async () => (await sw(() => self.__imgdlTest.offscreenContexts())) === 0, DEFAULTS.offscreenIdleMs + 5000, 250, 'offscreen cerrado tras el ZIP');
});

test('Descargar archivos (hotlink + normal): el ítem del lote sube al peldaño 2 con Referer y se descarga sin toast por ítem', async (t) => {
  await sw(() => self.__imgdlTest.setOffscreenIdle(500));
  await H.waitFor(async () => { const s = await state(); return s && !s.jobRunning && s.selectionCount === 0; }, 10000, 100, 'sin trabajo y selección limpia tras el ZIP');
  const n = await sw(({ tabId, paths }) => self.__imgdlTest.selectExpect(tabId, paths), { tabId, paths: [HOTLINK_PATH, NORMAL_PATH] });
  assert.equal(n, 2, 'dos seleccionadas');
  const h0 = (await hits())[HOTLINK_KEY];
  const refs0 = await referersOf(HOTLINK_KEY);
  const before = (await lastDownloads()).length;
  const nBefore = (await lastNotify()).length;
  const r = await sw(({ tabId, page }) => self.__imgdlTest.runFiles(tabId, page, {}), { tabId, page: pageInfo() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.total, 2);
  const done = await lastJobDoneFor(r.jobId);
  assert.equal(done.kind, 'files');
  assert.equal(done.ok, true, JSON.stringify(done));
  const mine = (await lastDownloads()).slice(before);
  const direct = mine.filter((o) => o.url === hotlinkUrl);
  assert.equal(direct.length, 1, 'un intento directo de la hotlink: ' + JSON.stringify(mine.map((o) => o.url.slice(0, 48))));
  assert.match(direct[0].filename, /^Imagenes\/[^/]+_\d{8}-\d{4}\/hotlink\.png$/, 'carpeta del lote con sello');
  const h = (await hits())[HOTLINK_KEY];
  const refs = await referersOf(HOTLINK_KEY);

  if (gated) {
    assert.equal(done.done, 2, JSON.stringify(done));
    assert.equal(done.failed, 0);
    assert.deepEqual(done.failures, []);
    assert.equal(done.text, S.SUMMARY_FILES(2, 0));
    // Peldaño 2 del ítem: la blob del offscreen con el MISMO nombre planificado, completa con bytes PNG.
    const blobs = mine.filter((o) => /^blob:chrome-extension:\/\//.test(o.url));
    assert.equal(blobs.length, 1, JSON.stringify(mine.map((o) => o.url.slice(0, 48))));
    assert.equal(blobs[0].filename, direct[0].filename, 'mismo nombre planificado');
    const items = await searchUrl(blobs[0].url);
    assert.equal(items.length, 1, JSON.stringify(items));
    assert.equal(items[0].state, 'complete', JSON.stringify(items[0]));
    assert.deepEqual(H.readFile(items[0].filename).subarray(0, 4), PNG_MAGIC);
    assert.deepEqual(await searchUrl(hotlinkUrl), [], 'el ítem interrumpido del peldaño 1 se borró');
    assert.equal(h.hits, h0.hits + 2, 'directa (403) + fetch del offscreen: ' + JSON.stringify({ h0, h }));
    assert.equal(h.withReferer, h0.withReferer + 1, 'el fetch del lote llevó Referer');
    assert.equal(refs.length, refs0.length + 1, JSON.stringify(refs));
    assert.equal(refs[refs.length - 1], srv.origin + '/', 'solo origin + "/" hacia el otro origen');
    assert.ok(!refs.some((x) => /#|album/.test(x)), JSON.stringify(refs));
    t.diagnostic('lote con peldaño 2: ' + JSON.stringify({ done: done.done, failed: done.failed, hits: h, referer: refs[refs.length - 1] }));
  } else {
    assert.equal(done.done, 1, JSON.stringify(done));
    assert.equal(done.failed, 1);
    assert.deepEqual(done.failures.map((f) => [f.url, f.reason]), [[hotlinkUrl, 'HTTP_403']]);
    assert.equal(h.withReferer, h0.withReferer, 'sin Referer en el fetch del lote');
    t.diagnostic('COMPUERTA CERRADA: ' + JSON.stringify(done.failures));
  }
  // Ítem de lote (quiet): ningún aviso al marco por la hotlink; el resumen va en job-done.
  assert.ok(!(await lastNotify()).slice(nBefore).some((e) => e.msg.url === hotlinkUrl), 'sin toast por ítem');
  assert.deepEqual(await sw(() => self.__imgdlTest.pending()), {});
  assert.equal(await sessionRules().then((x) => x.length), 0, 'getSessionRules() vacío tras el lote');
  assert.deepEqual(await sw(() => self.__imgdlTest.liveRefererRules()), []);
  await H.waitFor(async () => (await sw(() => self.__imgdlTest.offscreenContexts())) === 0, 6000, 100, 'offscreen cerrado tras el lote');
  await sw(() => self.__imgdlTest.setOffscreenIdle(undefined));
});

test('onInstalled/onStartup: clearAll retira reglas de sesión huérfanas (ids ≥ 1000)', async (t) => {
  if (!gated) {
    t.diagnostic('sin permiso DNR: nada que retirar');
    return;
  }
  const added = await sw(async () => {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{
      id: 4321, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: 'http://x.test/' }] },
      condition: { initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'], requestDomains: ['x.test'] }
    }] });
    return (await chrome.declarativeNetRequest.getSessionRules()).length;
  });
  assert.equal(added, 1);
  assert.equal(await sw(() => self.__imgdlTest.clearRefererRules()), 1);
  assert.equal(await sessionRules().then((x) => x.length), 0);
});
