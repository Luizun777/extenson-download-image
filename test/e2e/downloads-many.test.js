'use strict';
// Lotes desde la interfaz real (pasos 5-6) sobre zip.html: selección con clics en el
// checkbox del chip y botones de la barra (debugRects().barButtons). Archivos sueltos
// (5 buenas + HTML disfrazado + 500 → carpeta con sello, 'a.png' y 'a (2).png', HTML
// descartada, progreso en la barra, toast SUMMARY_FILES), ZIP de 5 (unzip -t, listado
// con ñandú.png y a (2).png, offscreen cerrado), ZIP con fallidas (_fallidas.txt con
// NOT_IMAGE, 500 reintentado), 'Cancelar' a mitad (toast CANCELLED, sin .zip),
// 400 pequeñas + lenta → WARN_BIG + 'Continuar' → el trabajo arranca y se cancela, y
// doble clic en 'Descargar ZIP' → un solo trabajo y un solo .zip.
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
const GOOD = [
  '/img/z1.png?w=300&h=300',
  '/img/z2.png?w=300&h=300',
  '/img/a.png?w=300&h=300',
  '/cors/a.png?w=301&h=301',
  '/img/%C3%B1and%C3%BA.png?w=300&h=300'
];
const GOOD_NAMES = ['a (2).png', 'a.png', 'z1.png', 'z2.png', 'ñandú.png'];
const HTML = '/html-as-jpg.jpg';
const FAIL_ONCE = '/fail-once.png';
const SLOW = '/slow.png?ms=5000';
const STAMP_RE = '\\d{8}-\\d{4}';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let srv;
let env;
let page;
let tabId;
let batchRe; // ^Imagenes/<host>_<sello>/(nombre)$
let zipRe; // ^Imagenes/<host>_<sello>.zip$

function sw(fn, arg) {
  return env.sw.evaluate(fn, arg);
}

function state() {
  return H.state(env.sw, tabId);
}

function gather() {
  return sw((id) => self.__imgdlTest.gather(id), tabId);
}

function lastJobDone() {
  return sw(() => self.__imgdlTest.lastJobDone());
}

function lastDownloads() {
  return sw(() => self.__imgdlTest.lastDownloads());
}

function offscreenContexts() {
  return sw(() => self.__imgdlTest.offscreenContexts());
}

function searchDownloads(query) {
  return sw((q) => chrome.downloads.search(q || {}), query || {});
}

async function resetServer() {
  const r = await fetch(srv.origin + '/reset');
  assert.equal(r.status, 200);
}

async function hits() {
  return (await fetch(srv.origin + '/count')).json();
}

function waitOffscreenClosed(label) {
  return H.waitFor(async () => (await offscreenContexts()) === 0, DEFAULTS.offscreenIdleMs + 5000, 250, label);
}

function rectOfExpect(p) {
  return page.evaluate((p) => {
    const el = document.querySelector('[data-expect="' + p + '"]');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, p);
}

// Selección con clics reales en la celda [seleccionar] del chip de cada [data-expect].
async function selectPaths(paths) {
  let count = (await state()).selectionCount;
  for (const p of paths) {
    const key = 'http|' + srv.origin + p;
    const r = await rectOfExpect(p);
    await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2);
    const st = await H.waitFor(async () => {
      const s = await state();
      return s && s.hoverKey === key && s.chipRect ? s : null;
    }, 5000, 40, 'chip de ' + p);
    assert.equal(st.chipChecked, false, p + ' no estaba seleccionada');
    await H.clickChip(page, st, 'select');
    count++;
    await H.waitFor(async () => (await state()).selectionCount === count, 3000, 40, 'selección de ' + p);
  }
  await page.mouse.move(640, 4);
  return count;
}

// Estado de reposo antes de cada caso (un fallo anterior no debe contaminar al siguiente):
// sin trabajo en marcha y sin selección (si queda alguna, 'Limpiar').
async function ensureClean() {
  await H.waitFor(async () => !(await state()).jobRunning, 20000, 100, 'sin trabajo en marcha');
  if ((await state()).selectionCount > 0) {
    await clickBar('clear');
    await H.waitFor(async () => (await state()).selectionCount === 0, 3000, 40, 'Limpiar previo');
  }
  await page.mouse.move(640, 4);
}

// Clic real en un botón de la barra (clear|files|zip|cancel|exit|confirm) cuando está visible y habilitado.
async function clickBar(name) {
  const st = await H.waitFor(async () => {
    const s = await state();
    const b = s && s.barState && s.barState.buttons ? s.barState.buttons[name] : null;
    return b && !s.barState.disabled[name] ? s : null;
  }, 5000, 40, 'botón de la barra ' + name);
  const b = st.barState.buttons[name];
  await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2);
  await page.mouse.move(640, 4);
  return st;
}

// Muestreo dentro del mundo aislado del marco principal (cada 5 ms): progressText y
// toasts de debugState(). Un lote de pocas imágenes locales termina en < 200 ms, antes
// de que un sondeo desde fuera (executeScript por muestra) llegue a verlo.
function startSampler() {
  return sw((tabId) => chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => {
      const g = globalThis;
      if (g.__imgdlSampler) clearInterval(g.__imgdlSampler);
      g.__imgdlSeen = { texts: [], toasts: [] };
      g.__imgdlSampler = setInterval(() => {
        const s = g.__imgdl && g.__imgdl.debugState();
        const seen = g.__imgdlSeen;
        if (!s || !seen) return;
        if (s.progressText && seen.texts[seen.texts.length - 1] !== s.progressText) seen.texts.push(s.progressText);
        for (const t of s.toasts) if (!seen.toasts.includes(t)) seen.toasts.push(t);
      }, 5);
      return true;
    }
  }).then((r) => r[0].result), tabId);
}

function stopSampler() {
  return sw((tabId) => chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => {
      const g = globalThis;
      if (g.__imgdlSampler) clearInterval(g.__imgdlSampler);
      g.__imgdlSampler = 0;
      const seen = g.__imgdlSeen || { texts: [], toasts: [] };
      g.__imgdlSeen = null;
      return seen;
    }
  }).then((r) => r[0].result), tabId);
}

// Sondea debugState mientras corre el trabajo: textos de progreso y toasts vistos
// (más lo muestreado por startSampler), y el job-done del SW (lastJobDone) cuando llega.
async function watchJob(before, ms = 40000) {
  const deadline = Date.now() + ms;
  const texts = new Set();
  const toasts = new Set();
  let sawRunning = false;
  let jobId = null;
  let done = null;
  while (Date.now() < deadline) {
    const s = await state();
    if (s.jobRunning) sawRunning = true;
    if (s.jobId) jobId = s.jobId;
    if (s.progressText) texts.add(s.progressText);
    for (const t of s.toasts) toasts.add(t);
    const log = await lastJobDone();
    if (log.length > before) {
      done = log[log.length - 1];
      break;
    }
    await H.sleep(15);
  }
  if (!done) throw new Error('watchJob: sin job-done en ' + ms + ' ms; textos ' + JSON.stringify([...texts]));
  // El toast del resumen llega con el job-done: unos sondeos más.
  for (let i = 0; i < 60; i++) {
    const s = await state();
    for (const t of s.toasts) toasts.add(t);
    if (toasts.has(done.text) && !s.jobRunning) break;
    await H.sleep(50);
  }
  const sampled = await stopSampler();
  for (const x of sampled.texts) texts.add(x);
  for (const x of sampled.toasts) toasts.add(x);
  if (sampled.texts.length) sawRunning = true;
  // Un ZIP local de 5 imágenes puede acabar antes del primer sondeo: la prueba determinista de
  // que el trabajo corrió es el anillo de progreso del SW (siempre emite al menos un imgdl:progress).
  const progressed = (await sw(() => self.__imgdlTest.lastProgress()))
    .filter((e) => e.jobId === done.jobId);
  if (progressed.length) sawRunning = true;
  return { done, texts: [...texts], toasts: [...toasts], sawRunning, jobId: jobId || done.jobId, progressed };
}

// Copia un ítem descargado a test/.tmp y lo valida con unzip -t y zipfile de Python.
function stashZip(item, name) {
  fs.mkdirSync(TMP, { recursive: true });
  const dest = path.join(TMP, name);
  fs.copyFileSync(item.filename, dest);
  const bytes = fs.readFileSync(dest);
  assert.deepEqual(bytes.subarray(0, 2), Buffer.from('PK'), 'firma ZIP');
  const test = execFileSync('unzip', ['-t', dest], { encoding: 'utf8' });
  assert.match(test, /No errors detected/, test);
  const listing = JSON.parse(execFileSync('python3', ['-c', [
    'import zipfile, sys, json',
    'z = zipfile.ZipFile(sys.argv[1])',
    'out = {"test": z.testzip(), "entries": []}',
    'for i in z.infolist():',
    '    d = z.read(i.filename)',
    '    out["entries"].append({"name": i.filename, "size": i.file_size, "utf8": bool(i.flag_bits & 0x800), "head": list(d[:4]), "text": d.decode("utf-8", "replace") if i.filename.endswith(".txt") else None})',
    'print(json.dumps(out, ensure_ascii=False))'
  ].join('\n'), dest], { encoding: 'utf8' }));
  assert.equal(listing.test, null, 'zipfile.testzip');
  return { dest, size: bytes.length, entries: listing.entries };
}

async function waitZipItem(done) {
  assert.equal(typeof done.zipFilename, 'string', 'zipFilename en job-done: ' + JSON.stringify(done));
  const item = await H.waitForDownload(env.sw, (it) => it.filename === done.zipFilename);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  assert.match(item.url, /^blob:chrome-extension:\/\//);
  return item;
}

test.before(async () => {
  srv = await H.startFixtures();
  env = await H.launch();
  page = await env.context.newPage();
  await page.goto(srv.origin + '/pages/zip.html', { waitUntil: 'load' });
  await page.waitForFunction(() => [...document.images].filter((i) => i.id !== 'slow').every((i) => i.complete));
  tabId = await H.tabIdOf(env.sw, page);
  // names.buildBaseName trata una base de 1 carácter ('a') como genérica y usa el alt
  // (a1/a2): con alt 'a' en ambas, el lote planifica 'a.png' y 'a (2).png'.
  await page.evaluate(() => { for (const id of ['a1', 'a2']) document.getElementById(id).alt = 'a'; });
  assert.equal(await H.activate(env.sw, tabId), true, 'activación');
  const paths = names.buildPaths({ folder: DEFAULTS.folder, host: urls.hostOf(page.url()), stamp: 'S' });
  batchRe = new RegExp('^' + esc(paths.batch.slice(0, -1)) + STAMP_RE + '/(.+)$');
  zipRe = new RegExp('^' + esc(paths.batch.slice(0, -1)) + STAMP_RE + '\\.zip$');
});

test.after(async () => {
  if (env) await env.close();
  if (srv) await srv.close();
});

test('Descargar archivos (7): 6 completas en una carpeta con sello (a.png, a (2).png; la 500 por el peldaño 2), HTML descartada, progreso en la barra y toast SUMMARY_FILES', async (t) => {
  await ensureClean();
  await resetServer();
  assert.equal(await selectPaths(GOOD.concat([HTML, FAIL_ONCE])), 7);
  let st = await state();
  assert.equal(st.barState.labels.files, S.BAR_FILES(7));
  // Los badges solo se dibujan sobre las seleccionadas visibles (tras el scrollIntoView
  // de la última, alguna fila puede quedar fuera del viewport).
  assert.ok(st.badgeCount >= 1 && st.badgeCount <= 7, 'badges visibles: ' + st.badgeCount);
  t.diagnostic('seleccionadas 7; badges visibles ' + st.badgeCount);

  // El peldaño 2 de fail-once abre el offscreen: cierre ocioso rápido para que el ZIP
  // siguiente lo cree de nuevo (y su progreso sea observable).
  await sw(() => self.__imgdlTest.setOffscreenIdle(500));
  const before = (await lastJobDone()).length;
  const dlBefore = (await lastDownloads()).length;
  await startSampler();
  await clickBar('files');
  const w = await watchJob(before);
  t.diagnostic('archivos: progreso visto ' + JSON.stringify(w.texts) + '; toasts ' + JSON.stringify(w.toasts));
  assert.equal(w.sawRunning, true, 'la barra pasó por jobRunning');
  assert.equal(w.done.kind, 'files');
  assert.equal(w.done.ok, true, JSON.stringify(w.done));
  // Escalera completa en el lote: la 500 se recupera en el peldaño 2 (fetch del offscreen).
  assert.equal(w.done.done, 6);
  assert.equal(w.done.failed, 1);
  assert.equal(w.done.text, S.SUMMARY_FILES(6, 1));
  assert.ok(w.toasts.includes(S.SUMMARY_FILES(6, 1)), 'toast resumen: ' + JSON.stringify(w.toasts));
  assert.deepEqual(w.done.failures.map((f) => [f.url, f.reason]), [[srv.origin + HTML, 'NOT_IMAGE']], JSON.stringify(w.done.failures));
  assert.equal((await hits())['/fail-once.png'].hits, 2, 'fail-once: 500 directa y luego 200 en el offscreen');

  // Progreso 'files' visible en la barra: 'Descargando k/7…'.
  const progRe = new RegExp('^' + esc(S.PROGRESS_FILES('§', 7)).replace('§', '\\d+') + '$');
  assert.ok(w.texts.some((x) => progRe.test(x)), 'texto PROGRESS_FILES en la barra: ' + JSON.stringify(w.texts));

  // download(): 7 llamadas del peldaño 1 + la blob del peldaño 2 (fail-once), todas a la MISMA
  // carpeta Imagenes/<host>_<sello>/ con los nombres planificados.
  const opts = (await lastDownloads()).slice(dlBefore);
  assert.equal(opts.length, 8, JSON.stringify(opts));
  const folders = new Set();
  const basenames = [];
  for (const o of opts) {
    const m = batchRe.exec(o.filename);
    assert.ok(m, 'carpeta del lote: ' + o.filename);
    folders.add(o.filename.slice(0, o.filename.lastIndexOf('/')));
    basenames.push(m[1]);
  }
  assert.equal(folders.size, 1, [...folders].join(', '));
  assert.ok(basenames.includes('a.png') && basenames.includes('a (2).png'), basenames.join(', '));
  assert.deepEqual(basenames.slice().sort(), GOOD_NAMES.concat(['fail-once.png', 'fail-once.png', 'html-as-jpg.jpg']).sort());
  const blobOpt = opts.find((o) => /^blob:chrome-extension:\/\//.test(o.url));
  assert.ok(blobOpt && /\/fail-once\.png$/.test(blobOpt.filename), JSON.stringify(opts.map((o) => [o.url.slice(0, 40), o.filename])));
  t.diagnostic('carpeta: ' + [...folders][0]);

  // 6 completas con bytes PNG (5 directas + la blob de fail-once); ni la HTML ni el ítem 500
  // del peldaño 1 quedan en la estantería.
  const items = await searchDownloads({});
  const complete = items.filter((it) => it.state === 'complete' && GOOD.some((p) => it.url === srv.origin + p));
  assert.equal(complete.length, 5, JSON.stringify(items.map((i) => [i.url, i.state])));
  for (const it of complete) assert.deepEqual(H.readFile(it.filename).subarray(0, 4), PNG_MAGIC);
  const blobItem = items.find((it) => it.url === blobOpt.url);
  assert.ok(blobItem && blobItem.state === 'complete', JSON.stringify(blobItem));
  assert.deepEqual(H.readFile(blobItem.filename).subarray(0, 4), PNG_MAGIC);
  assert.equal(items.filter((it) => it.url === srv.origin + HTML).length, 0, 'HTML descartada');
  assert.equal(items.filter((it) => it.url === srv.origin + FAIL_ONCE).length, 0, 'el ítem 500 del peldaño 1 se borró');

  // Tras ok: selección limpiada, barra en 0 y sin trabajo.
  st = await H.waitFor(async () => {
    const s = await state();
    return s.selectionCount === 0 && !s.jobRunning ? s : null;
  }, 5000, 50, 'selección limpiada');
  assert.equal(st.badgeCount, 0);
  assert.equal(st.progressText, '');
  assert.equal(st.barState.labels.files, S.BAR_FILES(0));
  assert.equal(st.barState.buttons.cancel, null, 'Cancelar oculto al terminar');
  assert.deepEqual(await gather(), []);
  assert.deepEqual(await sw(() => self.__imgdlTest.jobs()), {});
  // La blob del peldaño 2 se revocó y el offscreen se cierra al quedar ocioso.
  await H.waitFor(async () => (await offscreenContexts()) === 0, 6000, 100, 'offscreen cerrado tras el lote');
  await sw(() => self.__imgdlTest.setOffscreenIdle(undefined));
});

test('Descargar ZIP (5): un .zip íntegro con 5 entradas (ñandú.png, a (2).png), toast SUMMARY_ZIP y offscreen cerrado', async (t) => {
  await ensureClean();
  assert.equal(await selectPaths(GOOD), 5);
  const before = (await lastJobDone()).length;
  const dlBefore = (await lastDownloads()).length;
  await startSampler();
  await clickBar('zip');
  const w = await watchJob(before);
  t.diagnostic('zip: progreso visto ' + JSON.stringify(w.texts) + '; toasts ' + JSON.stringify(w.toasts));
  assert.equal(w.sawRunning, true);
  assert.equal(w.done.kind, 'zip');
  assert.equal(w.done.ok, true, JSON.stringify(w.done));
  assert.equal(w.done.done, 5);
  assert.equal(w.done.failed, 0);
  assert.equal(w.done.text, S.SUMMARY_ZIP(5, 5, 0));
  assert.ok(w.toasts.includes(S.SUMMARY_ZIP(5, 5, 0)), 'toast resumen: ' + JSON.stringify(w.toasts));
  const zipTexts = [S.PROGRESS_ZIP, S.PROGRESS_SAVING, S.PROGRESS_FETCH('§', 5)];
  assert.ok(w.texts.some((x) => zipTexts.includes(x) || x.startsWith(S.PROGRESS_FETCH('', 5).slice(0, 10))), 'algún texto de progreso del ZIP: ' + JSON.stringify(w.texts));

  const opts = (await lastDownloads()).slice(dlBefore);
  assert.equal(opts.length, 1, 'una sola descarga (la URL blob): ' + JSON.stringify(opts));
  assert.match(opts[0].url, /^blob:chrome-extension:\/\//);
  assert.match(opts[0].filename, zipRe);

  const item = await waitZipItem(w.done);
  const z = stashZip(item, 'ui-lote-5.zip');
  assert.equal(z.size, item.fileSize);
  assert.deepEqual(z.entries.map((e) => e.name).sort(), GOOD_NAMES.slice().sort());
  for (const e of z.entries) {
    assert.deepEqual(Buffer.from(e.head), PNG_MAGIC, e.name);
    assert.ok(e.size > 0, e.name);
  }
  assert.equal(z.entries.find((e) => e.name === 'ñandú.png').utf8, true, 'bit 11 UTF-8');
  // unzip -l en macOS escapa los nombres no ASCII ('+?and+?.png'): ñandú.png se comprueba
  // arriba con zipfile (bit 11); aquí unzip -t y el nombre con ' (2)'.
  const listing = H.listZip(z.dest);
  assert.equal(listing.ok, true, 'unzip -t');
  assert.ok(listing.names.includes('a (2).png'), listing.names.join(', '));
  assert.equal(listing.names.length, 5);
  t.diagnostic('zip: ' + z.dest + ' (' + z.size + ' B): ' + z.entries.map((e) => e.name).join(', '));

  await H.waitFor(async () => (await state()).selectionCount === 0, 5000, 50, 'selección limpiada');
  assert.deepEqual(await gather(), []);
  await waitOffscreenClosed('offscreen cerrado tras el ZIP');
  t.diagnostic('contextos offscreen tras el ZIP: ' + (await offscreenContexts()));
});

test('Descargar ZIP con HTML y 500: _fallidas.txt con NOT_IMAGE, fail-once reintentada con éxito (2 peticiones)', async (t) => {
  await ensureClean();
  await resetServer();
  assert.equal(await selectPaths(GOOD.concat([HTML, FAIL_ONCE])), 7);
  const before = (await lastJobDone()).length;
  await startSampler();
  await clickBar('zip');
  const w = await watchJob(before);
  assert.equal(w.done.ok, true, JSON.stringify(w.done));
  assert.equal(w.done.done, 6);
  assert.equal(w.done.failed, 1);
  assert.equal(w.done.failures.length, 1);
  assert.equal(w.done.failures[0].url, srv.origin + HTML);
  assert.equal(w.done.failures[0].reason, 'NOT_IMAGE');
  assert.equal(w.done.text, S.SUMMARY_ZIP(6, 7, 0));
  assert.ok(w.toasts.includes(S.SUMMARY_ZIP(6, 7, 0)), 'toast resumen: ' + JSON.stringify(w.toasts));

  const item = await waitZipItem(w.done);
  const z = stashZip(item, 'ui-lote-fallidas.zip');
  assert.deepEqual(z.entries.map((e) => e.name).sort(), GOOD_NAMES.concat(['_fallidas.txt', 'fail-once.png']).sort());
  const failed = z.entries.find((e) => e.name === '_fallidas.txt');
  assert.match(failed.text, new RegExp('^' + esc(srv.origin + HTML) + '\\tNOT_IMAGE$', 'm'), failed.text);
  assert.ok(!/fail-once/.test(failed.text), 'fail-once no está en _fallidas.txt');
  assert.deepEqual(Buffer.from(z.entries.find((e) => e.name === 'fail-once.png').head), PNG_MAGIC);
  const counts = await hits();
  const failHits = counts['/fail-once.png'];
  assert.ok(failHits && failHits.hits >= 2, 'reintento del 500: ' + JSON.stringify(failHits));
  t.diagnostic('zip: ' + z.dest + '; hits fail-once: ' + JSON.stringify(failHits) + '; _fallidas.txt: ' + JSON.stringify(failed.text));
  await H.waitFor(async () => (await state()).selectionCount === 0, 5000, 50, 'selección limpiada');
});

test('Cancelar a mitad de un ZIP (lenta + 2): toast CANCELLED, sin .zip y la selección se conserva hasta Limpiar', async (t) => {
  await ensureClean();
  assert.equal(await selectPaths([SLOW, GOOD[0], GOOD[1]]), 3);
  const before = (await lastJobDone()).length;
  const blobsBefore = (await searchDownloads({})).filter((it) => /^blob:/.test(it.url)).length;
  await clickBar('zip');
  const running = await H.waitFor(async () => {
    const s = await state();
    return s.jobRunning && s.barState.buttons.cancel ? s : null;
  }, 5000, 30, 'trabajo en marcha con Cancelar');
  assert.equal(running.barState.labels.cancel, S.BAR_CANCEL);
  await H.sleep(200);
  const t0 = Date.now();
  await clickBar('cancel');
  const w = await watchJob(before, 15000);
  t.diagnostic('cancelación atendida en ' + (Date.now() - t0) + ' ms; toasts ' + JSON.stringify(w.toasts));
  assert.equal(w.done.ok, false, JSON.stringify(w.done));
  assert.equal(w.done.code, 'CANCELLED');
  assert.equal(w.done.text, S.CANCELLED);
  assert.ok(w.toasts.includes(S.CANCELLED), 'toast Cancelado: ' + JSON.stringify(w.toasts));
  await H.sleep(500);
  const blobsAfter = (await searchDownloads({})).filter((it) => /^blob:/.test(it.url)).length;
  assert.equal(blobsAfter, blobsBefore, 'sin descarga de ZIP parcial');

  // Cancelado: la selección sigue (3) y la barra vuelve a reposo; 'Limpiar' → 0.
  const st = await H.waitFor(async () => {
    const s = await state();
    return !s.jobRunning && s.selectionCount === 3 ? s : null;
  }, 3000, 40, 'selección intacta tras cancelar');
  assert.equal(st.barState.buttons.cancel, null);
  assert.equal(st.barState.labels.zip, S.BAR_ZIP(3));
  assert.equal((await gather()).length, 3);
  await clickBar('clear');
  await H.waitFor(async () => (await state()).selectionCount === 0, 3000, 40, 'Limpiar → 0');
  assert.deepEqual(await gather(), []);
  assert.deepEqual(await sw(() => self.__imgdlTest.jobs()), {});
});

test('400 pequeñas + lenta: WARN_BIG con Continuar en la barra; Continuar arranca el ZIP y Cancelar lo detiene', async (t) => {
  await ensureClean();
  // Abrir <details id="many"> con un clic real y dar a cada imagen una URL distinta.
  await page.click('#many > summary');
  await page.waitForFunction(() => document.getElementById('many').open);
  const paths = await page.evaluate(() => {
    const list = [];
    document.querySelectorAll('img.many').forEach((img, i) => {
      const p = '/img/m.png?w=120&h=120&i=' + i;
      img.src = p;
      img.dataset.expect = p;
      list.push(p);
    });
    return list;
  });
  assert.equal(paths.length, 400);
  await page.waitForFunction(() => [...document.querySelectorAll('img.many')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 });
  await page.mouse.move(640, 4);

  // La lenta por chip (para que el trabajo no termine antes de cancelar) y las 400 por el hook.
  assert.equal(await selectPaths([SLOW]), 1);
  const n = await sw(({ tabId, paths }) => self.__imgdlTest.selectExpect(tabId, paths), { tabId, paths });
  assert.equal(n, 400, 'testSelectExpect en el marco principal');
  let st = await H.waitFor(async () => {
    const s = await state();
    return s.selectionCount === 401 ? s : null;
  }, 5000, 50, '401 seleccionadas');
  assert.ok(st.badgeCount <= DEFAULTS.badgeCap, 'badges con tope ' + DEFAULTS.badgeCap + ': ' + st.badgeCount);
  assert.equal(st.barState.labels.zip, S.BAR_ZIP(401));
  assert.equal((await gather()).length, 401);

  // 'Descargar ZIP' → NEEDS_CONFIRM: WARN_BIG + 'Continuar' en la barra, sin trabajo.
  const before = (await lastJobDone()).length;
  await clickBar('zip');
  st = await H.waitFor(async () => {
    const s = await state();
    return s.barState.needsConfirm && s.barState.buttons.confirm ? s : null;
  }, 5000, 40, 'WARN_BIG en la barra');
  assert.equal(st.jobRunning, false);
  assert.equal(st.barState.needsConfirm.n, 401);
  assert.ok(st.barState.needsConfirm.mb >= 1, 'MB estimados: ' + JSON.stringify(st.barState.needsConfirm));
  assert.equal(st.barState.labels.confirmText, S.WARN_BIG(401, st.barState.needsConfirm.mb));
  assert.equal(st.barState.labels.confirm, S.BAR_CONTINUE);
  assert.equal(st.barState.pendingMode, 'zip');
  assert.equal((await lastJobDone()).length, before, 'sin job-done');
  t.diagnostic('barra: ' + JSON.stringify(st.barState.labels.confirmText));

  // 'Continuar' → el trabajo arranca (jobRunning, Cancelar visible, progreso 'fetching').
  await clickBar('confirm');
  const running = await H.waitFor(async () => {
    const s = await state();
    return s.jobRunning && s.jobId && s.barState.buttons.cancel ? s : null;
  }, 8000, 30, 'ZIP en marcha tras Continuar');
  assert.equal(running.barState.needsConfirm, null, 'la confirmación desaparece');
  assert.equal(running.barState.buttons.confirm, null);
  assert.equal(running.barState.total, 401);
  const prog = await H.waitFor(async () => {
    const s = await state();
    return s.progressText ? s : null;
  }, 8000, 30, 'progreso del ZIP en la barra');
  t.diagnostic('ZIP de 401 en marcha: ' + JSON.stringify(prog.progressText));
  await clickBar('cancel');
  const w = await watchJob(before, 15000);
  assert.equal(w.done.ok, false, JSON.stringify(w.done));
  assert.equal(w.done.code, 'CANCELLED');
  assert.ok(w.toasts.includes(S.CANCELLED), 'toast Cancelado: ' + JSON.stringify(w.toasts));

  await clickBar('clear');
  await H.waitFor(async () => (await state()).selectionCount === 0, 5000, 40, 'Limpiar → 0');
  assert.deepEqual(await gather(), []);
  await page.evaluate(() => { document.getElementById('many').open = false; });
  await waitOffscreenClosed('offscreen cerrado tras cancelar');
});

test("doble clic en 'Descargar ZIP (3)': un solo trabajo, un solo job-done y un solo .zip", async (t) => {
  await ensureClean();
  assert.equal(await selectPaths(GOOD.slice(0, 3)), 3);
  const before = (await lastJobDone()).length;
  const dlBefore = (await lastDownloads()).length;
  const st = await H.waitFor(async () => {
    const s = await state();
    return s.barState && s.barState.buttons.zip && !s.barState.disabled.zip ? s : null;
  }, 5000, 40, 'botón zip');
  const b = st.barState.buttons.zip;
  await page.mouse.dblclick(b.x + b.w / 2, b.y + b.h / 2);
  await page.mouse.move(640, 4);
  const w = await watchJob(before);
  assert.equal(w.done.ok, true, JSON.stringify(w.done));
  assert.equal(w.done.done, 3);
  await H.sleep(1500); // margen para un hipotético segundo trabajo
  const jobsDone = (await lastJobDone()).slice(before);
  assert.equal(jobsDone.length, 1, 'un solo job-done: ' + JSON.stringify(jobsDone.map((j) => [j.jobId, j.text])));
  const zips = (await lastDownloads()).slice(dlBefore).filter((o) => zipRe.test(o.filename));
  assert.equal(zips.length, 1, 'un solo .zip: ' + JSON.stringify(zips.map((o) => o.filename)));
  assert.ok(!w.toasts.includes(S.ERR_JOB_RUNNING), 'el segundo clic no llega al SW (requesting) ni muestra JOB_RUNNING: ' + JSON.stringify(w.toasts));
  await H.waitFor(async () => {
    const s = await state();
    return s.selectionCount === 0 && !s.jobRunning;
  }, 5000, 50, 'selección limpiada y barra en reposo');
  assert.deepEqual(await sw(() => self.__imgdlTest.jobs()), {});
  assert.deepEqual(await sw(() => self.__imgdlTest.activeJobs()), {});
  t.diagnostic('doble clic → ' + jobsDone.length + ' trabajo, ' + zips.length + ' zip');
});
