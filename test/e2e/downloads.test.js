'use strict';
// Escalera de descarga con la extensión real: peldaño 1 directo, guarda MIME (HTML
// servido como .jpg) → peldaño 2 (fetch en el offscreen) → NOT_IMAGE → peldaño 3 (aviso
// al frame con "Copiar URL"), 500 → peldaño 2 completa, imagen con cookie en el peldaño 1,
// 403 anti-hotlink recuperado en el peldaño 2 con la regla DNR de Referer (si hay permiso),
// nombres saneados y reintento 'Invalid filename', data URLs y tipos byte, objetivos
// [fullSizeHint, url] (hint HTML, 403 o URL inválida -> peldaño 2 del hint y luego la url),
// cancelación silenciosa, espejo en storage.session tras un reinicio simulado del SW
// (peldaños 1 y 2), blob del peldaño 2 interrumpida → peldaño 3 sin reintentos, registro
// de descargas sin data URLs largas (slimData) y la ruta de mensajes imgdl:download-one
// desde el marco superior, un iframe de otro origen y un marco about:blank.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const H = require('./harness.js');
const S = require('../../lib/strings.js');
const names = require('../../lib/names.js');
const urls = require('../../lib/urls.js');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let srv;
let trickle;
let env;
let page;
let tabId;
let folder; // 'Imagenes/<host>' según la convención de names.buildPaths + urls.hostOf
let referer = null; // ¿regla DNR de Referer disponible? (permiso declarativeNetRequestWithHostAccess)

async function hits() {
  return (await fetch(srv.origin + '/count')).json();
}

// Valores exactos de Referer recibidos por ruta (los últimos 8): {path: [referer, ...]}.
async function referers() {
  return (await fetch(srv.origin + '/referers')).json();
}

function offscreenContexts() {
  return env.sw.evaluate(() => self.__imgdlTest.offscreenContexts());
}

function sessionRules() {
  return env.sw.evaluate(() => self.__imgdlTest.sessionRules());
}

// Servidor que envía las cabeceras y los primeros bytes al momento y el resto tras `ms`:
// la descarga existe como in_progress durante ese tiempo (cancelar, reinicio del SW).
function startTrickle() {
  const png = srv.png('trickle', 64, 64);
  const server = http.createServer((req, res) => {
    const ms = Number(new URL(req.url, 'http://x').searchParams.get('ms')) || 2000;
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' });
    res.write(png.subarray(0, 8));
    const t = setTimeout(() => res.end(png.subarray(8)), ms);
    res.on('close', () => clearTimeout(t));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: 'http://127.0.0.1:' + server.address().port,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); })
      });
    });
  });
}

function refFor(url, name, extra) {
  return Object.assign({ key: 'http|' + url, kind: 'http', url, name, w: 400, h: 300, id: 1 }, extra);
}

function ctxFor(ref, extra) {
  return Object.assign({ ref, page: { url: page.url(), title: 'Fixture: básica' }, tabId, frameId: 0 }, extra);
}

function downloadOne(ctx) {
  return env.sw.evaluate((c) => self.__imgdlTest.downloadOne(c), ctx);
}

function lastNotify() {
  return env.sw.evaluate(() => self.__imgdlTest.lastNotify());
}

function lastDownloads() {
  return env.sw.evaluate(() => self.__imgdlTest.lastDownloads());
}

function pendingNow() {
  return env.sw.evaluate(() => self.__imgdlTest.pending());
}

function searchId(id) {
  return env.sw.evaluate((i) => chrome.downloads.search({ id: i }), id);
}

// Ítems de la estantería con esa URL exacta (vacío si nunca hubo ítem o se borró con erase).
function searchUrl(url) {
  return env.sw.evaluate((u) => chrome.downloads.search({ url: u }), url);
}

// Marcos de una pestaña ({frameId, url}) sin webNavigation: executeScript con allFrames.
function framesOf(tabId) {
  return env.sw.evaluate(async (id) => {
    const r = await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, func: () => location.href });
    return r.map((x) => ({ frameId: x.frameId, url: x.result }));
  }, tabId);
}

// imgdl:download-one enviado desde un marco concreto, con el page que manda el controlador.
function sendFromFrame(tabId, frameId, ref) {
  return env.sw.evaluate(async ({ tabId, frameId, ref }) => {
    const res = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (ref) => chrome.runtime.sendMessage({ to: 'sw', type: 'imgdl:download-one', ref, page: { url: location.href, title: document.title } }),
      args: [ref]
    });
    return res[0].result;
  }, { tabId, frameId, ref });
}

function storedPending() {
  return env.sw.evaluate(async () => (await chrome.storage.session.get('pending')).pending || {});
}

// Primer aviso (el más reciente) que cumple el predicado; los avisos llegan al terminar la descarga.
function waitNotify(pred, label) {
  return H.waitFor(async () => (await lastNotify()).findLast(pred), 15000, 100, label);
}

test.before(async () => {
  srv = await H.startFixtures();
  trickle = await startTrickle();
  env = await H.launch();
  page = await env.context.newPage();
  await page.goto(srv.origin + '/pages/basic.html', { waitUntil: 'load' });
  tabId = await H.tabIdOf(env.sw, page);
  folder = names.buildPaths({ folder: 'Imagenes', host: urls.hostOf(page.url()), stamp: 'S' }).single;
  referer = await env.sw.evaluate(() => self.__imgdlTest.refererRules());
  await env.sw.evaluate(() => self.__imgdlTest.setOffscreenIdle(500)); // cierre ocioso rápido tras el peldaño 2
});

test.after(async () => {
  if (env) await env.close();
  if (trickle) await trickle.close();
  if (srv) await srv.close();
});

test('http: complete, bytes PNG, opciones registradas y aviso STATUS_DONE al frame de origen', async (t) => {
  const ref = refFor(srv.origin + '/img/g1.png?w=400&h=300', 'g1');
  const r = await downloadOne(ctxFor(ref));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(typeof r.downloadId, 'number');

  const item = await H.waitForDownload(env.sw, (it) => it.id === r.downloadId);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  assert.deepEqual(H.readFile(item.filename).subarray(0, 4), PNG_MAGIC);

  const last = await lastDownloads();
  assert.deepEqual(last[last.length - 1], { url: ref.url, filename: folder + '/g1.png', conflictAction: 'uniquify', saveAs: false });
  t.diagnostic('carpeta: ' + folder + ' (hostOf conserva el puerto no predeterminado)');

  const n = await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === ref.url, 'aviso STATUS_DONE');
  assert.equal(n.tabId, tabId);
  assert.equal(n.frameId, 0);
  assert.equal(n.msg.type, 'imgdl:notify');
  assert.equal(n.msg.level, 'info');
  assert.equal(n.msg.text, S.STATUS_DONE(path.basename(item.filename)));
  assert.deepEqual(await pendingNow(), {});
});

test('misma referencia dos veces: ambas completan (uniquify lo resuelve Chrome)', async () => {
  const ref = refFor(srv.origin + '/img/g2.png?w=400&h=300', 'g2');
  const r1 = await downloadOne(ctxFor(ref));
  const r2 = await downloadOne(ctxFor(ref));
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.notEqual(r1.downloadId, r2.downloadId);
  const i1 = await H.waitForDownload(env.sw, (it) => it.id === r1.downloadId);
  const i2 = await H.waitForDownload(env.sw, (it) => it.id === r2.downloadId);
  assert.equal(i1.state, 'complete');
  assert.equal(i2.state, 'complete');
  const last = await lastDownloads();
  assert.equal(last[last.length - 1].filename, folder + '/g2.png');
  assert.equal(last[last.length - 2].filename, folder + '/g2.png');
});

test('guarda MIME: /html-as-jpg.jpg se borra (removeFile + erase), el peldaño 2 devuelve NOT_IMAGE y avisa ERR_HTML con "Copiar URL"', async (t) => {
  const ref = refFor(srv.origin + '/html-as-jpg.jpg', 'html-as-jpg');
  const before = (await lastDownloads()).length;
  const h0 = ((await hits())['/html-as-jpg.jpg'] || { hits: 0 }).hits;
  const r = await downloadOne(ctxFor(ref));
  assert.equal(r.ok, true, JSON.stringify(r)); // arranca; la guarda actúa al completar

  const n = await waitNotify((e) => e.msg.code === 'NOT_IMAGE' && e.msg.url === ref.url, 'aviso NOT_IMAGE');
  assert.equal(n.msg.level, 'error');
  assert.equal(n.msg.text, S.ERR_HTML);
  assert.equal(n.msg.action, 'copy-url');
  assert.equal(n.msg.rung2, 'NOT_IMAGE', 'el peldaño 2 también la rechazó');
  assert.equal(n.tabId, tabId);

  assert.deepEqual(await searchId(r.downloadId), []);
  const disc = (await env.sw.evaluate(() => self.__imgdlTest.lastDiscarded())).find((d) => d.id === r.downloadId);
  assert.ok(disc, 'registro de descartada');
  assert.equal(disc.mime, 'text/html');
  if (disc.filename) assert.equal(fs.existsSync(disc.filename), false, 'archivo borrado: ' + disc.filename);
  // Dos peticiones (descarga directa + fetch del offscreen) y ninguna descarga blob.
  assert.equal((await hits())['/html-as-jpg.jpg'].hits, h0 + 2, 'peldaño 1 + peldaño 2');
  assert.deepEqual((await lastDownloads()).slice(before).map((o) => o.url), [ref.url]);
  t.diagnostic('descartada: ' + JSON.stringify(disc));
  assert.deepEqual(await pendingNow(), {});
  assert.equal((await sessionRules()).length, 0, 'regla de Referer retirada');
});

test('403 anti-hotlink (/hotlink): peldaño 1 interrumpido y borrado; con regla DNR el peldaño 2 lleva Referer y completa, si no ERR_403 + "Copiar URL"', async (t) => {
  const ref = refFor(srv.origin + '/hotlink/x.png?w=100&h=100', 'x');
  const before = (await lastDownloads()).length;
  const r = await downloadOne(ctxFor(ref));
  assert.equal(r.ok, true, JSON.stringify(r));
  if (referer) {
    const n = await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === ref.url, 'aviso STATUS_DONE (peldaño 2)');
    assert.equal(n.msg.level, 'info');
    const mine = (await lastDownloads()).slice(before);
    assert.equal(mine.length, 2, JSON.stringify(mine));
    assert.equal(mine[0].url, ref.url);
    assert.match(mine[1].url, /^blob:chrome-extension:\/\//);
    assert.deepEqual(mine.map((o) => o.filename), [folder + '/x.png', folder + '/x.png']);
    assert.deepEqual(await searchUrl(ref.url), [], 'el ítem interrumpido del peldaño 1 se borró');
    const items = await searchUrl(mine[1].url);
    assert.equal(items.length, 1);
    assert.equal(items[0].state, 'complete', JSON.stringify(items[0]));
    assert.deepEqual(H.readFile(items[0].filename).subarray(0, 4), PNG_MAGIC);
    const h = (await hits())['/hotlink/x.png'];
    assert.deepEqual({ hits: h.hits, withReferer: h.withReferer }, { hits: 2, withReferer: 1 }, 'chrome.downloads sin Referer; el fetch del offscreen con él');
    // Mismo origen que la página: el Referer es la url completa de la página (como el navegador).
    assert.deepEqual((await referers())['/hotlink/x.png'], [page.url()], 'valor exacto del Referer');
    t.diagnostic('peldaño 2 con Referer: ' + JSON.stringify(h));
  } else {
    const n = await waitNotify((e) => e.msg.code === 'HTTP_403' && e.msg.url === ref.url, 'aviso HTTP_403');
    assert.equal(n.msg.level, 'error');
    assert.equal(n.msg.text, S.ERR_403);
    assert.equal(n.msg.action, 'copy-url');
    assert.equal(n.msg.reason, 'SERVER_FORBIDDEN');
    assert.equal(n.msg.rung2, 'HTTP_403');
    assert.deepEqual((await lastDownloads()).slice(before).map((o) => o.url), [ref.url]);
    assert.deepEqual(await searchUrl(ref.url), [], 'el ítem interrumpido se borró antes del peldaño 2');
    assert.equal((await hits())['/hotlink/x.png'].withReferer, 0, 'sin permiso DNR nadie envía Referer');
    t.diagnostic('SIN permiso DNR: ERR_403 + Copiar URL');
  }
  assert.deepEqual(await pendingNow(), {});
  assert.equal((await sessionRules()).length, 0, 'regla de Referer retirada');
});

test('Referer del peldaño 2 como el navegador: sin fragmento (#/ruta, #access_token) ni credenciales (user:pw@), query y ruta intactas al mismo origen', async (t) => {
  if (!referer) {
    t.diagnostic('SIN permiso DNR: no hay Referer que inspeccionar');
    return;
  }
  const url = srv.origin + '/hotlink/ref.png?w=50&h=50';
  const pageUrl = srv.origin.replace('http://', 'http://user:pw@') + '/pages/basic.html?q=1#access_token=SECRETO';
  const before = (await lastDownloads()).length;
  const r = await downloadOne({ ref: refFor(url, 'ref'), page: { url: pageUrl, title: 'Fixture: básica' }, tabId, frameId: 0 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const n = await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === url, 'aviso STATUS_DONE (peldaño 2 con Referer)');
  assert.equal(n.msg.level, 'info');
  const mine = (await lastDownloads()).slice(before);
  assert.equal(mine.length, 2, JSON.stringify(mine));
  assert.match(mine[1].url, /^blob:chrome-extension:\/\//);
  const refs = (await referers())['/hotlink/ref.png'];
  assert.deepEqual(refs, [srv.origin + '/pages/basic.html?q=1'], 'ni fragmento ni credenciales en la cabecera');
  assert.ok(!refs.some((x) => /#|SECRETO|user:pw/.test(x)), JSON.stringify(refs));
  assert.equal((await hits())['/hotlink/ref.png'].hits, 2, 'directa (403) + fetch con Referer');
  assert.deepEqual(await pendingNow(), {});
  assert.equal((await sessionRules()).length, 0, 'regla de Referer retirada');
  t.diagnostic('Referer en el cable: ' + JSON.stringify(refs));
});

test('500 (/fail-once.png): peldaño 1 interrumpido SERVER_FAILED y borrado; el peldaño 2 (fetch en el offscreen) completa', async (t) => {
  const ref = refFor(srv.origin + '/fail-once.png', 'fail-once');
  const before = (await lastDownloads()).length;
  const r = await downloadOne(ctxFor(ref));
  assert.equal(r.ok, true, JSON.stringify(r));
  const n = await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === ref.url, 'aviso STATUS_DONE tras el peldaño 2');
  assert.equal(n.msg.level, 'info');
  const mine = (await lastDownloads()).slice(before);
  assert.equal(mine.length, 2, JSON.stringify(mine));
  assert.equal(mine[0].url, ref.url);
  assert.match(mine[1].url, /^blob:chrome-extension:\/\//);
  assert.deepEqual(mine.map((o) => o.filename), [folder + '/fail-once.png', folder + '/fail-once.png']);
  assert.deepEqual(await searchUrl(ref.url), [], 'el ítem SERVER_FAILED se borró');
  const items = await searchUrl(mine[1].url);
  assert.equal(items.length, 1);
  assert.equal(items[0].state, 'complete', JSON.stringify(items[0]));
  assert.deepEqual(H.readFile(items[0].filename).subarray(0, 4), PNG_MAGIC);
  assert.equal((await hits())['/fail-once.png'].hits, 2, '500 y luego 200');
  assert.ok(!(await lastNotify()).some((e) => e.msg.level === 'error' && e.msg.url === ref.url), 'sin aviso de error');
  assert.deepEqual(await pendingNow(), {});
  // La blob se revocó y el offscreen se cierra al quedar ocioso (idle 500 ms).
  await H.waitFor(async () => (await offscreenContexts()) === 0, 6000, 100, 'offscreen cerrado');
  t.diagnostic('peldaño 2: ' + mine[1].url.slice(0, 48));
});

test('imagen protegida por cookie (cookie.html): completa en el peldaño 1 con la cookie del navegador (/count withCookie)', async (t) => {
  const pc = await env.context.newPage();
  await pc.goto(srv.origin + '/pages/cookie.html', { waitUntil: 'load' });
  await pc.waitForFunction(() => { const i = document.getElementById('c'); return i.complete && i.naturalWidth > 0; });
  const tabC = await H.tabIdOf(env.sw, pc);
  const url = srv.origin + '/cookie/c.png?w=300&h=300';
  const before = (await lastDownloads()).length;
  const h0 = (await hits())['/cookie/c.png'];
  assert.ok(h0 && h0.withCookie >= 1, 'la página la cargó con cookie: ' + JSON.stringify(h0));
  const r = await env.sw.evaluate((c) => self.__imgdlTest.downloadOne(c), { ref: refFor(url, 'cookie'), page: { url: pc.url(), title: 'Fixture: cookie' }, tabId: tabC, frameId: 0 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const item = await H.waitForDownload(env.sw, (it) => it.id === r.downloadId);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  assert.deepEqual(H.readFile(item.filename).subarray(0, 4), PNG_MAGIC);
  const mine = (await lastDownloads()).slice(before);
  assert.deepEqual(mine.map((o) => o.url), [url], 'solo el peldaño 1');
  const h = (await hits())['/cookie/c.png'];
  assert.equal(h.hits, h0.hits + 1);
  assert.equal(h.withCookie, h0.withCookie + 1, 'chrome.downloads envió la cookie');
  await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === url, 'aviso STATUS_DONE (cookie)');
  t.diagnostic('cookie: ' + JSON.stringify(h));
  await pc.close();
});

test('nombres: reservados e ilegales se sanean antes de llamar a download()', async () => {
  const a = refFor(srv.origin + '/img/con.png?w=60&h=60', 'CON');
  const b = refFor(srv.origin + '/img/ab.png?w=60&h=60', 'a?b');
  const ra = await downloadOne(ctxFor(a));
  const rb = await downloadOne(ctxFor(b));
  assert.equal(ra.ok, true, JSON.stringify(ra));
  assert.equal(rb.ok, true, JSON.stringify(rb));
  const last = await lastDownloads();
  assert.equal(last[last.length - 2].filename, folder + '/_CON.png');
  assert.equal(last[last.length - 1].filename, folder + '/a_b.png');
  assert.equal((await H.waitForDownload(env.sw, (it) => it.id === ra.downloadId)).state, 'complete');
  assert.equal((await H.waitForDownload(env.sw, (it) => it.id === rb.downloadId)).state, 'complete');
});

test("'Invalid filename' (carpeta con punto final): un reintento con imagen-NNN y carpeta re-saneada", async (t) => {
  const ref = refFor(srv.origin + '/img/retry.png?w=60&h=60', 'retry');
  const before = (await lastDownloads()).length;
  const r = await downloadOne(ctxFor(ref, { folder: folder + '.' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  const last = await lastDownloads();
  const mine = last.slice(before).filter((o) => o.url === ref.url);
  assert.equal(mine.length, 2, 'dos intentos: ' + JSON.stringify(mine));
  assert.equal(mine[0].filename, folder + './retry.png');
  assert.match(mine[1].filename, new RegExp('^' + folder.replace(/[.]/g, '\\.') + '/imagen-\\d{3}\\.png$'));
  t.diagnostic('reintento: ' + mine[1].filename);
  assert.equal((await H.waitForDownload(env.sw, (it) => it.id === r.downloadId)).state, 'complete');
});

test('data: URL: pasa directa, extensión del MIME y aviso sin URL', async () => {
  const dataUrl = 'data:image/png;base64,' + srv.png('d', 2, 2).toString('base64');
  const ref = { key: 'data|' + dataUrl, kind: 'data', url: dataUrl, name: 'pixel', w: 2, h: 2, id: 3 };
  const r = await downloadOne(ctxFor(ref));
  assert.equal(r.ok, true, JSON.stringify(r));
  const item = await H.waitForDownload(env.sw, (it) => it.id === r.downloadId);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  assert.deepEqual(H.readFile(item.filename).subarray(0, 4), PNG_MAGIC);
  const last = await lastDownloads();
  const rec = last[last.length - 1];
  assert.ok(rec.url.startsWith('data:image/png;base64,'), rec.url.slice(0, 40));
  assert.deepEqual(Object.assign({}, rec, { url: undefined }), { url: undefined, filename: folder + '/pixel.png', conflictAction: 'uniquify', saveAs: false });
  const text = S.STATUS_DONE(path.basename(item.filename));
  const n = await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.text === text, 'aviso STATUS_DONE (data)');
  assert.equal(n.msg.url, undefined);
  assert.equal(n.msg.action, undefined);
});

test('tipo byte (canvas) con dataUrl inline: download({url: dataUrl}) y nombre lienzo.png', async () => {
  const dataUrl = 'data:image/png;base64,' + srv.png('c', 3, 3).toString('base64');
  const ref = { key: 'canvas|f1:7', kind: 'canvas', name: 'lienzo', w: 3, h: 3, id: 7 };
  const r = await downloadOne(ctxFor(ref, { dataUrl }));
  assert.equal(r.ok, true, JSON.stringify(r));
  const last = await lastDownloads();
  const rec = last[last.length - 1];
  assert.ok(rec.url.startsWith('data:image/png;base64,'), rec.url.slice(0, 40));
  assert.deepEqual(Object.assign({}, rec, { url: undefined }), { url: undefined, filename: folder + '/lienzo.png', conflictAction: 'uniquify', saveAs: false });
  const item = await H.waitForDownload(env.sw, (it) => it.id === r.downloadId);
  assert.equal(item.state, 'complete');
  assert.deepEqual(H.readFile(item.filename).subarray(0, 4), PNG_MAGIC);
});

test('registro de descargas: una data URL larga (tipo byte) se recorta en lastDownloads() y Chrome recibe la completa', async (t) => {
  const bytes = Buffer.from(await (await fetch(srv.origin + '/noise.png?mb=0.05&seed=7')).arrayBuffer());
  const dataUrl = 'data:image/png;base64,' + bytes.toString('base64');
  assert.ok(dataUrl.length > 512, 'data URL larga: ' + dataUrl.length);
  const ref = { key: 'canvas|f1:11', kind: 'canvas', name: 'grande', w: 64, h: 64, id: 11 };
  const before = (await lastDownloads()).length;
  const r = await downloadOne(ctxFor(ref, { dataUrl }));
  assert.equal(r.ok, true, JSON.stringify(r));
  const mine = (await lastDownloads()).slice(before);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].filename, folder + '/grande.png');
  assert.ok(mine[0].url.startsWith('data:image/png;base64,'), mine[0].url.slice(0, 40));
  assert.ok(mine[0].url.length < 128, 'recortada: ' + mine[0].url.length + ' chars');
  assert.ok(mine[0].url.endsWith('…(' + dataUrl.length + ')'), 'conserva la longitud original: ' + mine[0].url.slice(-16));
  // pending/espejo tampoco retienen la cadena; la descarga sí recibió la URL completa (bytes íntegros).
  const pend = (await pendingNow())[r.downloadId];
  if (pend) assert.ok(pend.targets.every((x) => x.length < 128), JSON.stringify(pend.targets.map((x) => x.length)));
  const item = await H.waitForDownload(env.sw, (it) => it.id === r.downloadId);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  const file = H.readFile(item.filename);
  assert.deepEqual(file.subarray(0, 4), PNG_MAGIC);
  assert.equal(file.length, bytes.length, 'bytes íntegros');
  t.diagnostic('registro: ' + mine[0].url.slice(0, 32) + ' … (' + dataUrl.length + ' chars en la data URL)');
});

test('tipo byte sin dataUrl: {ok:false, ERR_GENERIC} y aviso sin URL ni acción', async () => {
  const r = await downloadOne(ctxFor({ key: 'blob|f1:9', kind: 'blob', name: 'nada', w: 10, h: 10, id: 9 }));
  assert.deepEqual(r, { ok: false, code: 'ERR_GENERIC', text: S.ERR_GENERIC });
  const n = (await lastNotify()).findLast((e) => e.msg.code === 'ERR_GENERIC' && e.msg.reason === 'NO_URL');
  assert.ok(n, 'aviso ERR_GENERIC');
  assert.equal(n.msg.url, undefined);
  assert.equal(n.msg.action, undefined);
});

test('objetivos [fullSizeHint HTML, url]: el primero se borra y el segundo completa', async () => {
  const hint = srv.origin + '/html-as-jpg.jpg?full=1';
  const ref = refFor(srv.origin + '/img/full.png?w=120&h=80', 'full', { fullSizeHint: hint });
  const before = (await lastDownloads()).length;
  const r = await downloadOne(ctxFor(ref));
  assert.equal(r.ok, true, JSON.stringify(r));

  const n = await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === ref.url, 'aviso STATUS_DONE tras el segundo objetivo');
  assert.equal(n.msg.level, 'info');
  const mine = (await lastDownloads()).slice(before);
  assert.deepEqual(mine.map((o) => o.url), [hint, ref.url]);
  assert.deepEqual(mine.map((o) => o.filename), [folder + '/full.png', folder + '/full.png']);

  assert.deepEqual(await searchId(r.downloadId), [], 'el HTML se borró');
  const disc = (await env.sw.evaluate(() => self.__imgdlTest.lastDiscarded())).find((d) => d.url === hint);
  assert.ok(disc);
  assert.equal(disc.mime, 'text/html');
  const items = await env.sw.evaluate((u) => chrome.downloads.search({ url: u }), ref.url);
  assert.equal(items.length, 1);
  assert.equal(items[0].state, 'complete');
  assert.deepEqual(H.readFile(items[0].filename).subarray(0, 4), PNG_MAGIC);
  assert.ok(!(await lastNotify()).some((e) => e.msg.code === 'NOT_IMAGE' && e.msg.url === hint), 'sin aviso NOT_IMAGE: había otro objetivo');
  assert.deepEqual(await pendingNow(), {});
});

test('objetivos [fullSizeHint 403, url]: el hint interrumpido se borra y pasa al peldaño 2 (con Referer completa el hint; sin él, sigue la url)', async (t) => {
  const hint = srv.origin + '/hotlink/h.png?w=50&h=50';
  const ref = refFor(srv.origin + '/img/ok.png?w=50&h=50', 'ok', { fullSizeHint: hint });
  const before = (await lastDownloads()).length;
  const r = await downloadOne(ctxFor(ref));
  assert.equal(r.ok, true, JSON.stringify(r));

  const counts = srv.hits();
  if (referer) {
    // El peldaño 2 del hint lleva Referer: se recupera la imagen a tamaño completo y la url no se pide.
    const n = await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === hint, 'aviso STATUS_DONE del hint (peldaño 2)');
    assert.equal(n.msg.level, 'info');
    const mine = (await lastDownloads()).slice(before);
    assert.equal(mine.length, 2, JSON.stringify(mine));
    assert.equal(mine[0].url, hint);
    assert.match(mine[1].url, /^blob:chrome-extension:\/\//);
    assert.deepEqual(mine.map((o) => o.filename), [folder + '/ok.png', folder + '/ok.png']);
    assert.deepEqual(await searchUrl(hint), [], 'el ítem interrumpido del hint se borró');
    const items = await searchUrl(mine[1].url);
    assert.equal(items.length, 1);
    assert.equal(items[0].state, 'complete', JSON.stringify(items[0]));
    assert.deepEqual(H.readFile(items[0].filename).subarray(0, 4), PNG_MAGIC);
    const hits = await H.waitFor(async () => { const h = (await (await fetch(srv.origin + '/count')).json())['/hotlink/h.png']; return h && h.hits >= 2 ? h : null; }, 3000, 50, 'dos peticiones del hint');
    assert.deepEqual({ hits: hits.hits, withReferer: hits.withReferer }, { hits: 2, withReferer: 1 }, 'directa sin Referer + fetch con Referer');
    assert.equal(counts['/img/ok.png'], undefined, 'la url nunca se pidió');
    assert.ok(!(await lastNotify()).some((e) => e.msg.level === 'error' && e.msg.url === hint), 'sin aviso HTTP_403 para el hint');
    t.diagnostic('hint recuperado en el peldaño 2: ' + JSON.stringify(hits));
  } else {
    const n = await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === ref.url, 'aviso STATUS_DONE tras el segundo objetivo');
    assert.equal(n.msg.level, 'info');
    const mine = (await lastDownloads()).slice(before);
    assert.deepEqual(mine.map((o) => o.url), [hint, ref.url]);
    assert.deepEqual(mine.map((o) => o.filename), [folder + '/ok.png', folder + '/ok.png']);
    assert.deepEqual(await searchUrl(hint), [], 'el ítem interrumpido del hint se borró');
    const items = await searchUrl(ref.url);
    assert.equal(items.length, 1);
    assert.equal(items[0].state, 'complete');
    assert.deepEqual(H.readFile(items[0].filename).subarray(0, 4), PNG_MAGIC);
    const hits = srv.hits();
    assert.equal(hits['/hotlink/h.png'].hits, 2, 'directa + fetch del offscreen (ambos 403)');
    assert.equal(hits['/img/ok.png'].hits, 1, 'un intento de la url');
    assert.ok(!(await lastNotify()).some((e) => e.msg.url === hint), 'sin aviso HTTP_403 para el hint: había otro objetivo');
    t.diagnostic('SIN permiso DNR: el hint falló en los peldaños 1 y 2; completó la url');
  }
  assert.deepEqual(await pendingNow(), {});
});

test("objetivos [fullSizeHint con URL inválida, url]: download() la rechaza sin ítem y se pasa a la url", async () => {
  const hint = 'http://%zz/full.png'; // isHttpUrl la acepta; Chrome la rechaza con 'Invalid URL' sin crear ítem
  const ref = refFor(srv.origin + '/img/inv.png?w=50&h=50', 'inv', { fullSizeHint: hint });
  const before = (await lastDownloads()).length;
  const r = await downloadOne(ctxFor(ref));
  assert.equal(r.ok, true, JSON.stringify(r));
  const mine = (await lastDownloads()).slice(before);
  assert.deepEqual(mine.map((o) => o.url), [hint, ref.url]);
  const item = await H.waitForDownload(env.sw, (it) => it.id === r.downloadId);
  assert.equal(item.state, 'complete');
  assert.equal(item.url, ref.url, 'el downloadId devuelto es el de la url');
  await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === ref.url, 'aviso STATUS_DONE');
  assert.ok(!(await lastNotify()).some((e) => e.msg.url === hint || e.msg.code === 'INVALID_URL'), 'sin aviso INVALID_URL: había otro objetivo');
  assert.deepEqual(await pendingNow(), {});
});

test("guarda MIME + 'Invalid filename': el nombre de reserva ya aceptado se reutiliza en el segundo objetivo", async (t) => {
  const hint = srv.origin + '/html-as-jpg.jpg?b=1';
  const ref = refFor(srv.origin + '/img/okb.png?w=50&h=50', 'okb', { fullSizeHint: hint });
  const before = (await lastDownloads()).length;
  const r = await downloadOne(ctxFor(ref, { folder: folder + '.' }));
  assert.equal(r.ok, true, JSON.stringify(r));

  await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === ref.url, 'aviso STATUS_DONE tras el segundo objetivo');
  const mine = (await lastDownloads()).slice(before);
  assert.deepEqual(mine.map((o) => o.url), [hint, hint, ref.url], 'hint (rechazado), hint (reserva), url (reserva)');
  assert.equal(mine[0].filename, folder + './okb.png');
  assert.match(mine[1].filename, new RegExp('^' + folder.replace(/[.]/g, '\\.') + '/imagen-\\d{3}\\.png$'));
  assert.equal(mine[2].filename, mine[1].filename, 'mismo nombre de reserva en el segundo objetivo');
  t.diagnostic('reserva reutilizada: ' + mine[1].filename);

  assert.deepEqual(await searchUrl(hint), [], 'el HTML se borró');
  const items = await searchUrl(ref.url);
  assert.equal(items.length, 1);
  assert.equal(items[0].state, 'complete');
  assert.deepEqual(H.readFile(items[0].filename).subarray(0, 4), PNG_MAGIC);
  assert.ok(!(await lastNotify()).some((e) => e.msg.code === 'INVALID_FILENAME'), 'sin aviso INVALID_FILENAME');
  assert.deepEqual(await pendingNow(), {});
});

test('cancelación por el usuario: pending registrado mientras descarga, luego silencio', async () => {
  const ref = refFor(trickle.origin + '/trickle.png?ms=4000', 'lento');
  const r = await downloadOne(ctxFor(ref));
  assert.equal(r.ok, true, JSON.stringify(r));
  const pend = await pendingNow();
  const p = pend[r.downloadId];
  assert.ok(p, 'pendiente en memoria: ' + JSON.stringify(pend));
  assert.deepEqual({ tabId: p.tabId, frameId: p.frameId, ti: p.ti, rung: p.rung, target: p.targets[0], filename: p.filename, folder: p.folder },
    { tabId, frameId: 0, ti: 0, rung: 1, target: ref.url, filename: folder + '/lento.png', folder });
  assert.ok((await storedPending())[r.downloadId], 'espejo en storage.session');

  await env.sw.evaluate((id) => chrome.downloads.cancel(id), r.downloadId);
  const item = await H.waitForDownload(env.sw, (it) => it.id === r.downloadId);
  assert.equal(item.state, 'interrupted');
  assert.equal(item.error, 'USER_CANCELED');
  await H.waitFor(async () => !(await pendingNow())[r.downloadId], 3000, 50, 'pendiente retirado');
  await H.sleep(300);
  assert.ok(!(await lastNotify()).some((e) => e.msg.url === ref.url), 'sin aviso al cancelar');
  assert.deepEqual(await storedPending(), {});
});

test('reinicio simulado del SW: pending se restaura de storage.session al llegar onChanged', async () => {
  const ref = refFor(trickle.origin + '/trickle.png?ms=2000&r=1', 'restaurada');
  const r = await downloadOne(ctxFor(ref));
  assert.equal(r.ok, true, JSON.stringify(r));
  await H.waitFor(async () => (await storedPending())[r.downloadId], 2000, 50, 'espejo escrito');

  await env.sw.evaluate(() => self.__imgdlTest.resetDownloads());
  assert.deepEqual(await pendingNow(), {});

  const item = await H.waitForDownload(env.sw, (it) => it.id === r.downloadId);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  const n = await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === ref.url, 'aviso tras restaurar');
  assert.equal(n.tabId, tabId);
  assert.equal(n.msg.text, S.STATUS_DONE(path.basename(item.filename)));
  await H.waitFor(async () => !(await storedPending())[r.downloadId], 2000, 50, 'espejo limpio');
});

test('reinicio simulado del SW con una descarga del peldaño 2 en vuelo: el ctx (rung 2, blobUrl) se restaura y revoca la blob', async (t) => {
  // Peldaño 2 "a mano": blob grande del offscreen (16 MB) + descarga con ctx de descarga suelta.
  const url = srv.origin + '/noise.png?mb=16&seed=21';
  const f = await env.sw.evaluate(({ url }) => self.__imgdlTest.fetchOne(url), { url });
  assert.equal(f.ok, true, JSON.stringify(f));
  const ctx = ctxFor(refFor(url, 'ruido16'), { targets: [url] });
  const r = await env.sw.evaluate(async ({ ctx, blobUrl }) => {
    const res = await self.__imgdlTest.downloadBlob(ctx, blobUrl);
    if (!res.ok) return res;
    // Espera a que el espejo tenga el ctx y simula el reinicio (memoria vacía).
    for (let i = 0; i < 200; i++) {
      const got = (await chrome.storage.session.get('pending')).pending || {};
      if (got[res.downloadId]) break;
      await new Promise((d) => setTimeout(d, 5));
    }
    const inMemory = !!self.__imgdlTest.pending()[res.downloadId];
    self.__imgdlTest.resetDownloads();
    return Object.assign({ inMemory }, res);
  }, { ctx, blobUrl: f.blobUrl });
  assert.equal(r.ok, true, JSON.stringify(r));
  const item = await H.waitForDownload(env.sw, (it) => it.id === r.downloadId, 30000);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  assert.deepEqual(H.readFile(item.filename).subarray(0, 4), PNG_MAGIC);
  const n = await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === url, 'aviso tras restaurar (peldaño 2)');
  assert.equal(n.tabId, tabId);
  await H.waitFor(async () => !(await storedPending())[r.downloadId], 3000, 50, 'espejo limpio');
  assert.deepEqual(await pendingNow(), {});
  // El ctx restaurado revoca la blob: el offscreen queda sin URLs vivas y se cierra.
  await H.waitFor(async () => (await offscreenContexts()) === 0, 6000, 100, 'offscreen cerrado tras revocar');
  t.diagnostic(r.inMemory ? 'restaurado desde storage.session (rung 2, blobUrl)' : 'la descarga completó antes del reinicio simulado: restauración no ejercitada esta vez');
});

test('blob del peldaño 2 que no se puede descargar: aviso de error con "Copiar URL" y sin volver a los peldaños 1/2 ni al siguiente objetivo', async (t) => {
  const url = srv.origin + '/img/r2fail.png?w=40&h=40';
  const other = srv.origin + '/img/r2other.png?w=40&h=40';
  const extId = env.extId;
  const bogus = 'blob:chrome-extension://' + extId + '/00000000-0000-4000-8000-000000000000'; // URL blob no registrada
  const before = (await lastDownloads()).length;
  const ctx = ctxFor(refFor(url, 'r2fail'), { targets: [url, other] });
  const r = await env.sw.evaluate(({ ctx, blobUrl }) => self.__imgdlTest.downloadBlob(ctx, blobUrl), { ctx, blobUrl: bogus });
  const n = await waitNotify((e) => e.msg.level === 'error' && e.msg.url === url, 'aviso de error del peldaño 3');
  assert.equal(n.msg.action, 'copy-url');
  assert.equal(n.msg.text, S.format(n.msg.code));
  assert.notEqual(n.msg.code, 'USER_CANCELED');
  const mine = (await lastDownloads()).slice(before);
  assert.deepEqual(mine.map((o) => o.url), [bogus], 'solo la descarga de la blob: ni peldaño 1 ni 2 ni el otro objetivo');
  assert.equal(srv.hits()['/img/r2fail.png'], undefined);
  assert.equal(srv.hits()['/img/r2other.png'], undefined);
  assert.deepEqual(await pendingNow(), {});
  t.diagnostic('vía: ' + (r.ok ? 'ítem interrumpido ' + n.msg.reason : 'rechazo de download(): ' + n.msg.reason) + ' → ' + n.msg.code);
});

test('ruta de mensajes: imgdl:download-one desde el contexto de la página (tabId y frameId del remitente)', async () => {
  const ref = refFor(srv.origin + '/img/g3.png?w=400&h=300', 'g3');
  const reply = await sendFromFrame(tabId, 0, ref);
  assert.equal(reply && reply.ok, true, JSON.stringify(reply));
  assert.equal(typeof reply.downloadId, 'number');
  const item = await H.waitForDownload(env.sw, (it) => it.id === reply.downloadId);
  assert.equal(item.state, 'complete');
  const last = await lastDownloads();
  assert.equal(last[last.length - 1].filename, folder + '/g3.png');
  const n = await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === ref.url, 'aviso STATUS_DONE (mensaje)');
  assert.equal(n.tabId, tabId);
  assert.equal(n.frameId, 0);
});

test('ruta de mensajes desde un iframe de otro origen: el aviso va al frameId del remitente y la carpeta es la del marco', async (t) => {
  const p2 = await env.context.newPage();
  await p2.goto(srv.origin + '/pages/iframe.html', { waitUntil: 'load' });
  const tab2 = await H.tabIdOf(env.sw, p2);
  const frames = await framesOf(tab2);
  const child = frames.find((f) => f.frameId !== 0 && f.url.startsWith(srv.altOrigin + '/'));
  assert.ok(child, 'marco hijo en el origen alterno: ' + JSON.stringify(frames));

  const ref = refFor(srv.altOrigin + '/img/in1.png?w=300&h=300', 'in1');
  const reply = await sendFromFrame(tab2, child.frameId, ref);
  assert.equal(reply && reply.ok, true, JSON.stringify(reply));
  const item = await H.waitForDownload(env.sw, (it) => it.id === reply.downloadId);
  assert.equal(item.state, 'complete');
  assert.deepEqual(H.readFile(item.filename).subarray(0, 4), PNG_MAGIC);

  const childFolder = names.buildPaths({ folder: 'Imagenes', host: urls.hostOf(child.url), stamp: 'S' }).single;
  assert.notEqual(childFolder, folder, 'el iframe vive en el origen alterno');
  const last = await lastDownloads();
  assert.equal(last[last.length - 1].filename, childFolder + '/in1.png');
  t.diagnostic('marco hijo ' + child.frameId + ' -> ' + childFolder);

  const n = await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === ref.url, 'aviso STATUS_DONE (marco hijo)');
  assert.equal(n.tabId, tab2);
  assert.equal(n.frameId, child.frameId);
  assert.notEqual(n.frameId, 0, 'el aviso no se dirige al marco superior');
  await p2.close();
});

test('marco about:blank (sandbox.html): la carpeta toma el host de la pestaña, no "pagina"', async (t) => {
  const p3 = await env.context.newPage();
  await p3.goto(srv.origin + '/pages/sandbox.html', { waitUntil: 'load' });
  const tab3 = await H.tabIdOf(env.sw, p3);
  const frames = await framesOf(tab3);
  const blank = frames.find((f) => f.url === 'about:blank');
  assert.ok(blank, 'marco about:blank: ' + JSON.stringify(frames));
  assert.notEqual(blank.frameId, 0);

  // Sin el host de la pestaña, el marco caería en 'Imagenes/pagina'.
  assert.equal(names.buildPaths({ folder: 'Imagenes', host: urls.hostOf('about:blank'), stamp: 'S' }).single, 'Imagenes/pagina');
  const ref = refFor(srv.origin + '/img/blank.png?w=300&h=300', 'blank');
  const reply = await sendFromFrame(tab3, blank.frameId, ref);
  assert.equal(reply && reply.ok, true, JSON.stringify(reply));
  const last = await lastDownloads();
  assert.equal(last[last.length - 1].filename, folder + '/blank.png', 'carpeta del host de la pestaña (sandbox.html comparte origen con basic.html)');
  t.diagnostic('about:blank (marco ' + blank.frameId + ') -> ' + last[last.length - 1].filename);

  const item = await H.waitForDownload(env.sw, (it) => it.id === reply.downloadId);
  assert.equal(item.state, 'complete');
  const n = await waitNotify((e) => e.msg.code === 'STATUS_DONE' && e.msg.url === ref.url, 'aviso STATUS_DONE (about:blank)');
  assert.equal(n.tabId, tab3);
  assert.equal(n.frameId, blank.frameId);
  await p3.close();
});
