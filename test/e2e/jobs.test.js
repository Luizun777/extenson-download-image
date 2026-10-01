'use strict';
// Lotes con la extensión real (pasos 4-6 + ZIP) sobre zip.html: recogida de la
// selección (gather), lote de archivos sueltos en Imagenes/<host>_<sello>/ con nombres
// únicos y fallidas (HTML disfrazado, 500), progreso 'files', tope NEEDS_CONFIRM,
// ZIP en el offscreen (unzip -t, listado, 'ñandú.png', 'a (2).png', _fallidas.txt,
// reintento del 500), cancelación sin ZIP parcial y cierre del documento offscreen.
// Además: un trabajo por pestaña (JOB_RUNNING), lote de archivos cerrado desde los ctx
// restaurados tras perder la memoria del SW, cancelación real de las descargas en vuelo,
// ZIP con data: grandes (una por mensaje) y la carrera retain()/cierre ocioso del offscreen.
// La selección se hace con clics reales en la celda "seleccionar" del chip (o con el
// hook __imgdl.testSelectExpect si el controlador lo expone).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
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

let srv;
let trickle;
let env;
let page;
let tabId;
let batchRe; // ^Imagenes/<host>_<sello>/(nombre)$
let zipRe; // ^Imagenes/<host>_<sello>.zip$
let hookAvailable = null;

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

function lastProgress() {
  return sw(() => self.__imgdlTest.lastProgress());
}

function lastDownloads() {
  return sw(() => self.__imgdlTest.lastDownloads());
}

function storedJobs() {
  return sw(() => self.__imgdlTest.storedJobs());
}

function offscreenContexts() {
  return sw(() => self.__imgdlTest.offscreenContexts());
}

function pageInfo() {
  return { url: page.url(), title: 'Fixture: lote ZIP' };
}

function runFiles(opts) {
  return sw(({ tabId, page, opts }) => self.__imgdlTest.runFiles(tabId, page, opts), { tabId, page: pageInfo(), opts: opts || {} });
}

function runZip(opts) {
  return sw(({ tabId, page, opts }) => self.__imgdlTest.runZip(tabId, page, opts), { tabId, page: pageInfo(), opts: opts || {} });
}

function cancel(jobId) {
  return sw((id) => self.__imgdlTest.cancel(id), jobId);
}

function clearSelection() {
  return sw((id) => self.__imgdlTest.clearSelection(id), tabId);
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

function waitJobDone(jobId, ms = 40000) {
  return H.waitFor(async () => (await lastJobDone()).find((j) => j.jobId === jobId), ms, 100, 'job-done ' + jobId);
}

function waitOffscreenClosed(label) {
  return H.waitFor(async () => (await offscreenContexts()) === 0, DEFAULTS.offscreenIdleMs + 5000, 250, label);
}

// Selección programática si el controlador expone testSelectExpect; si no, clic real en el chip.
async function selectPaths(paths) {
  if (hookAvailable !== false) {
    const n = await sw(({ tabId, paths }) => self.__imgdlTest.selectExpect(tabId, paths), { tabId, paths });
    hookAvailable = typeof n === 'number';
    if (hookAvailable) return n;
  }
  let count = 0;
  for (const p of paths) {
    const key = 'http|' + srv.origin + p;
    await page.evaluate((p) => {
      const el = document.querySelector('[data-expect="' + p + '"]');
      el.scrollIntoView({ block: 'center', inline: 'center' });
    }, p);
    const r = await page.evaluate((p) => {
      const b = document.querySelector('[data-expect="' + p + '"]').getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    }, p);
    await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2);
    const st = await H.waitFor(async () => {
      const s = await state();
      return s && s.hoverKey === key && s.chipRect ? s : null;
    }, 5000, 40, 'chip de ' + p);
    await H.clickChip(page, st, 'select');
    count++;
    await H.waitFor(async () => (await state()).selectionCount >= count, 3000, 40, 'selección de ' + p);
  }
  await page.mouse.move(640, 4);
  return count;
}

// Servidor que envía cabeceras y los primeros bytes al momento y el resto tras `ms`: la
// descarga existe como in_progress durante ese tiempo (cancelar, memoria del SW perdida).
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

// Inyecta <img src=url data-expect=url> (caja fija) en la página y espera a que carguen.
function injectImages(urls) {
  return page.evaluate((list) => Promise.all(list.map((u) => new Promise((resolve) => {
    const img = document.createElement('img');
    img.className = 'injected';
    img.width = 200;
    img.height = 200;
    img.style.cssText = 'display:block;width:200px;height:200px';
    img.setAttribute('data-expect', u);
    img.onload = () => resolve(u);
    img.onerror = () => resolve(u);
    img.src = u;
    document.body.appendChild(img);
  }))), urls);
}

function removeInjected() {
  return page.evaluate(() => { document.querySelectorAll('img.injected').forEach((el) => el.remove()); });
}

function pendingNow() {
  return sw(() => self.__imgdlTest.pending());
}

function activeJobs() {
  return sw(() => self.__imgdlTest.activeJobs());
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

test.before(async () => {
  srv = await H.startFixtures();
  trickle = await startTrickle();
  env = await H.launch();
  page = await env.context.newPage();
  await page.goto(srv.origin + '/pages/zip.html', { waitUntil: 'load' });
  tabId = await H.tabIdOf(env.sw, page);
  // names.buildBaseName trata una base de 1 carácter ('a') como genérica y usa el alt
  // (a1/a2): con alt 'a' en ambas, el lote planifica 'a.png' y 'a (2).png'.
  await page.evaluate(() => { for (const id of ['a1', 'a2']) document.getElementById(id).alt = 'a'; });
  assert.equal(await H.activate(env.sw, tabId), true, 'activación');
  const paths = names.buildPaths({ folder: DEFAULTS.folder, host: urls.hostOf(page.url()), stamp: 'S' });
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  batchRe = new RegExp('^' + esc(paths.batch.slice(0, -1)) + STAMP_RE + '/(.+)$');
  zipRe = new RegExp('^' + esc(paths.batch.slice(0, -1)) + STAMP_RE + '\\.zip$');
});

test.after(async () => {
  if (env) await env.close();
  if (trickle) await trickle.close();
  if (srv) await srv.close();
});

test('archivos sueltos: 7 seleccionadas → 6 descargadas (la 500 por el peldaño 2), HTML fallida, carpeta con sello y nombres únicos', async (t) => {
  await resetServer();
  const n = await selectPaths(GOOD.concat([HTML, FAIL_ONCE]));
  assert.equal(n, 7);
  t.diagnostic('selección vía ' + (hookAvailable ? 'testSelectExpect' : 'clics reales en el chip'));
  const gathered = await gather();
  assert.equal(gathered.length, 7, JSON.stringify(gathered.map((g) => g.url)));
  assert.ok(gathered.every((g) => g.frameId === 0 && g.kind === 'http'));

  const before = (await lastDownloads()).length;
  const r = await runFiles({});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.total, 7);
  assert.equal(typeof r.jobId, 'string');

  // Escalera completa también en el lote: la 500 (peldaño 1 SERVER_FAILED) se recupera con el
  // fetch del offscreen (peldaño 2); la HTML queda NOT_IMAGE tras los peldaños 1 y 2.
  const done = await waitJobDone(r.jobId);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.done, 6, JSON.stringify(done));
  assert.equal(done.failed, 1, JSON.stringify(done));
  assert.equal(done.text, S.SUMMARY_FILES(6, 1));
  assert.deepEqual(done.failures.map((f) => [f.url, f.reason]), [[srv.origin + HTML, 'NOT_IMAGE']], JSON.stringify(done.failures));
  assert.equal((await hits())['/fail-once.png'].hits, 2, '500 (chrome.downloads) y luego 200 (offscreen)');
  t.diagnostic('fail-once (500): recuperada en el peldaño 2; fallidas ' + JSON.stringify(done.failures));

  // Opciones de download(): 7 del peldaño 1 + la blob del peldaño 2 de fail-once, todas en la
  // MISMA carpeta Imagenes/<host>_<sello>/ y con los nombres planificados.
  const opts = (await lastDownloads()).slice(before);
  assert.equal(opts.length, 8, JSON.stringify(opts));
  const folders = new Set();
  const basenames = [];
  for (const o of opts) {
    const m = batchRe.exec(o.filename);
    assert.ok(m, 'carpeta del lote: ' + o.filename);
    folders.add(o.filename.slice(0, o.filename.lastIndexOf('/')));
    basenames.push(m[1]);
    assert.equal(o.conflictAction, 'uniquify');
    assert.equal(o.saveAs, false);
  }
  assert.equal(folders.size, 1, [...folders].join(', '));
  assert.deepEqual(basenames.slice().sort(), GOOD_NAMES.concat(['fail-once.png', 'fail-once.png', 'html-as-jpg.jpg']).sort());
  const blobOpts = opts.filter((o) => /^blob:chrome-extension:\/\//.test(o.url));
  assert.equal(blobOpts.length, 1, JSON.stringify(opts.map((o) => o.url)));
  assert.match(blobOpts[0].filename, /\/fail-once\.png$/);
  t.diagnostic('carpeta: ' + [...folders][0]);

  // 6 completas con bytes PNG (5 directas + la blob); la HTML borrada (guarda MIME) y el ítem
  // SERVER_FAILED de la 500 borrado antes del peldaño 2.
  const items = await searchDownloads({});
  const complete = items.filter((it) => it.state === 'complete' && GOOD.some((p) => it.url === srv.origin + p));
  assert.equal(complete.length, 5, JSON.stringify(items.map((i) => [i.url, i.state])));
  for (const it of complete) assert.deepEqual(H.readFile(it.filename).subarray(0, 4), PNG_MAGIC);
  const blobItem = items.find((it) => it.url === blobOpts[0].url);
  assert.ok(blobItem && blobItem.state === 'complete', JSON.stringify(blobItem));
  assert.deepEqual(H.readFile(blobItem.filename).subarray(0, 4), PNG_MAGIC);
  assert.equal(items.filter((it) => it.url === srv.origin + HTML).length, 0, 'HTML borrada de la estantería');
  assert.equal(items.filter((it) => it.url === srv.origin + FAIL_ONCE).length, 0, 'el ítem 500 del peldaño 1 se borró');

  // Progreso 'files' por finalización y selección limpiada por el contenido al terminar ok.
  const prog = (await lastProgress()).filter((p) => p.jobId === r.jobId);
  assert.ok(prog.length >= 1, 'progreso');
  assert.ok(prog.every((p) => p.phase === 'files' && p.total === 7));
  const last = prog[prog.length - 1];
  assert.equal(last.done + last.failed, 7, JSON.stringify(last));
  await H.waitFor(async () => (await gather()).length === 0, 5000, 100, 'selección limpiada tras job-done ok');
  assert.equal((await state()).selectionCount, 0);
  assert.deepEqual(await sw(() => self.__imgdlTest.jobs()), {});
});

test('NEEDS_CONFIRM: 400 imágenes bajo #many sin confirmBig (archivos y ZIP)', async (t) => {
  if (hookAvailable === false) {
    t.skip('el controlador no expone testSelectExpect: 400 clics reales no son viables; needsConfirm se cubre en test/unit/jobs.test.js');
    return;
  }
  const paths = await page.evaluate(() => {
    document.getElementById('many').open = true;
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
  const n = await selectPaths(paths);
  assert.equal(n, 400);
  const files = await runFiles({});
  assert.equal(files.ok, false);
  assert.equal(files.code, 'NEEDS_CONFIRM', JSON.stringify(files));
  assert.equal(files.total, 400);
  assert.equal(typeof files.estimatedBytes, 'number');
  const zip = await runZip({});
  assert.equal(zip.code, 'NEEDS_CONFIRM', JSON.stringify(zip));
  assert.equal(zip.total, 400);
  assert.deepEqual(await lastJobDone().then((l) => l.filter((j) => j.jobId === files.jobId || j.jobId === zip.jobId)), []);
  await clearSelection();
  assert.equal((await gather()).length, 0);
  await page.evaluate(() => { document.getElementById('many').open = false; });
});

test('ZIP: 5 buenas → un .zip íntegro con 5 entradas (ñandú.png, a (2).png), progreso saving y offscreen cerrado', async (t) => {
  const n = await selectPaths(GOOD);
  assert.equal(n, 5);
  const before = (await lastDownloads()).length;
  const r = await runZip({});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.total, 5);

  const done = await waitJobDone(r.jobId);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.done, 5);
  assert.equal(done.failed, 0);
  assert.equal(done.fallback, 0);
  assert.deepEqual(done.failures, []);
  assert.equal(done.text, S.SUMMARY_ZIP(5, 5, 0));
  assert.equal(typeof done.zipFilename, 'string');

  // Una sola descarga: la blob URL del offscreen con nombre Imagenes/<host>_<sello>.zip.
  const opts = (await lastDownloads()).slice(before);
  assert.equal(opts.length, 1, JSON.stringify(opts));
  assert.match(opts[0].url, /^blob:chrome-extension:\/\//);
  assert.match(opts[0].filename, zipRe);
  assert.equal(opts[0].conflictAction, 'uniquify');

  const item = await H.waitForDownload(env.sw, (it) => it.filename === done.zipFilename);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  const z = stashZip(item, 'lote-5.zip');
  assert.equal(z.size, item.fileSize);
  assert.deepEqual(z.entries.map((e) => e.name).sort(), GOOD_NAMES.slice().sort());
  for (const e of z.entries) {
    assert.deepEqual(Buffer.from(e.head), PNG_MAGIC, e.name);
    assert.ok(e.size > 0, e.name);
  }
  assert.equal(z.entries.find((e) => e.name === 'ñandú.png').utf8, true, 'bit 11 UTF-8');
  t.diagnostic('zip: ' + z.dest + ' (' + z.size + ' B)');

  const phases = (await lastProgress()).filter((p) => p.jobId === r.jobId).map((p) => p.phase);
  assert.ok(phases.includes('saving'), 'fases: ' + phases.join(','));
  t.diagnostic('fases de progreso: ' + phases.join(' → '));
  await H.waitFor(async () => (await gather()).length === 0, 5000, 100, 'selección limpiada');
  await H.waitFor(async () => !(r.jobId in (await storedJobs())), 5000, 100, 'espejo del trabajo borrado');
  await waitOffscreenClosed('offscreen cerrado tras el ZIP');
});

test('ZIP con fallidas: HTML excluida en _fallidas.txt (NOT_IMAGE) y el 500 reintentado con éxito; fallback por archivo', async (t) => {
  await resetServer();
  const n = await selectPaths(GOOD.concat([HTML, FAIL_ONCE]));
  assert.equal(n, 7);
  const r = await runZip({});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.total, 7);

  const done = await waitJobDone(r.jobId);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.done, 6, JSON.stringify(done));
  assert.equal(done.fallback, 0, 'la HTML tampoco vale como descarga directa');
  assert.equal(done.failed, 1);
  assert.equal(done.failures.length, 1);
  assert.equal(done.failures[0].url, srv.origin + HTML);
  assert.equal(done.failures[0].reason, 'NOT_IMAGE');
  assert.equal(done.text, S.SUMMARY_ZIP(6, 7, 0));

  const item = await H.waitForDownload(env.sw, (it) => it.filename === done.zipFilename);
  assert.equal(item.state, 'complete');
  const z = stashZip(item, 'lote-fallidas.zip');
  const entryNames = z.entries.map((e) => e.name).sort();
  assert.deepEqual(entryNames, GOOD_NAMES.concat(['_fallidas.txt', 'fail-once.png']).sort());
  const failed = z.entries.find((e) => e.name === '_fallidas.txt');
  assert.match(failed.text, new RegExp('^' + srv.origin.replace(/[.]/g, '\\.') + '/html-as-jpg\\.jpg\\tNOT_IMAGE$', 'm'), failed.text);
  assert.ok(!/fail-once/.test(failed.text), 'fail-once no está en _fallidas.txt');
  assert.deepEqual(Buffer.from(z.entries.find((e) => e.name === 'fail-once.png').head), PNG_MAGIC);

  // El 500 se pidió dos veces (500 y luego 200) y la HTML tuvo su intento de descarga directa (borrada por la guarda MIME).
  const counts = await hits();
  const failHits = counts['/fail-once.png'];
  assert.ok(failHits && failHits.hits >= 2, 'reintento del 500: ' + JSON.stringify(failHits));
  const items = await searchDownloads({});
  assert.equal(items.filter((it) => it.url === srv.origin + HTML).length, 0, 'fallback HTML borrado de la estantería');
  t.diagnostic('zip: ' + z.dest + '; hits fail-once: ' + JSON.stringify(failHits));
  await H.waitFor(async () => (await gather()).length === 0, 5000, 100, 'selección limpiada');
});

test('cancelar un ZIP a mitad: job-done CANCELLED, sin .zip, selección intacta y offscreen cerrado', async (t) => {
  const n = await selectPaths([SLOW, GOOD[0], GOOD[1]]);
  assert.equal(n, 3);
  const blobsBefore = (await searchDownloads({})).filter((it) => /^blob:/.test(it.url)).length;
  const dlBefore = (await lastDownloads()).length;
  const r = await runZip({});
  assert.equal(r.ok, true, JSON.stringify(r));
  await H.sleep(300);
  const c = await cancel(r.jobId);
  assert.equal(c.ok, true, JSON.stringify(c));

  const done = await waitJobDone(r.jobId, 15000);
  assert.equal(done.ok, false, JSON.stringify(done));
  assert.equal(done.code, 'CANCELLED');
  assert.equal(done.text, S.CANCELLED);
  await H.sleep(500);
  const blobsAfter = (await searchDownloads({})).filter((it) => /^blob:/.test(it.url)).length;
  assert.equal(blobsAfter, blobsBefore, 'sin descarga de ZIP parcial');
  // Las opciones de download() son {url, filename, conflictAction, saveAs}: se mira la ventana del trabajo.
  assert.ok(!(await lastDownloads()).slice(dlBefore).some((o) => zipRe.test(o.filename)), 'sin download() del .zip tras cancelar');

  // Cancelado: la selección sigue (no se limpia) hasta 'Limpiar'.
  assert.equal((await gather()).length, 3);
  await clearSelection();
  assert.equal((await gather()).length, 0);
  assert.deepEqual(await sw(() => self.__imgdlTest.jobs()), {});
  await waitOffscreenClosed('offscreen cerrado tras cancelar');
  t.diagnostic('cancelación atendida; contextos offscreen: ' + (await offscreenContexts()));
});

test('un trabajo por pestaña: dos runZip simultáneos → el segundo JOB_RUNNING y un solo .zip', async (t) => {
  const n = await selectPaths(GOOD.slice(0, 3));
  assert.equal(n, 3);
  const dlBefore = (await lastDownloads()).length;
  const [r1, r2] = await sw(({ tabId, page }) => Promise.all([
    self.__imgdlTest.runZip(tabId, page, {}),
    self.__imgdlTest.runZip(tabId, page, {})
  ]), { tabId, page: pageInfo() });
  const started = [r1, r2].filter((r) => r.ok === true);
  const refused = [r1, r2].filter((r) => r.ok !== true);
  assert.equal(started.length, 1, JSON.stringify([r1, r2]));
  assert.equal(refused.length, 1);
  assert.equal(refused[0].code, 'JOB_RUNNING', JSON.stringify(refused[0]));
  assert.equal(refused[0].text, S.ERR_JOB_RUNNING);
  assert.equal(refused[0].jobId, started[0].jobId, 'el rechazo nombra al trabajo en marcha');
  assert.deepEqual(await activeJobs(), { [tabId]: started[0].jobId });

  const done = await waitJobDone(started[0].jobId);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.done, 3);
  await H.sleep(500);
  const zips = (await lastDownloads()).slice(dlBefore).filter((o) => zipRe.test(o.filename));
  assert.equal(zips.length, 1, 'exactamente un .zip: ' + JSON.stringify(zips));
  assert.equal((await lastJobDone()).filter((j) => j.jobId === started[0].jobId).length, 1);
  assert.deepEqual(await activeJobs(), {}, 'la pestaña queda libre al terminar');
  assert.deepEqual(await sw(() => self.__imgdlTest.jobs()), {});
  await H.waitFor(async () => (await gather()).length === 0, 5000, 100, 'selección limpiada');
  // La pestaña libre vuelve a aceptar trabajos (EMPTY: ya no hay selección).
  const again = await runZip({});
  assert.equal(again.code, 'EMPTY', JSON.stringify(again));
  t.diagnostic('rechazo: ' + JSON.stringify(refused[0]));
});

test('archivos sueltos con la memoria de downloads perdida a medias: los ctx restaurados (kind/jobId) cierran el trabajo con job-done ok', async (t) => {
  const urls = [1, 2, 3].map((i) => trickle.origin + '/t.png?ms=2000&lost=' + i);
  await injectImages(urls);
  assert.equal(await selectPaths(urls), 3);
  const before = (await lastJobDone()).length;
  const r = await runFiles({});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.total, 3);
  assert.ok(r.jobId in (await storedJobs()), 'el lote se espeja en storage.session');

  // Las 3 descargas en vuelo (cuerpo tras 2 s) llevan la etiqueta del lote.
  const pend = await H.waitFor(async () => {
    const p = await pendingNow();
    return Object.keys(p).length === 3 ? p : null;
  }, 5000, 50, '3 pendientes');
  for (const ctx of Object.values(pend)) {
    assert.equal(ctx.kind, 'files');
    assert.equal(ctx.jobId, r.jobId);
    assert.equal(typeof ctx.itemIndex, 'number');
  }
  // Memoria de downloads.js vacía (mismo efecto que perder los cierres del SW): sin onDone.
  await sw(() => self.__imgdlTest.resetDownloads());
  assert.deepEqual(await pendingNow(), {});

  const done = await waitJobDone(r.jobId, 15000);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.kind, 'files');
  assert.equal(done.done, 3);
  assert.equal(done.failed, 0);
  assert.equal(done.text, S.SUMMARY_FILES(3, 0));
  assert.equal((await lastJobDone()).length, before + 1, 'un solo job-done');
  const items = await searchDownloads({});
  assert.equal(items.filter((it) => urls.includes(it.url) && it.state === 'complete').length, 3, JSON.stringify(items.map((i) => [i.url, i.state])));
  // La barra no se queda colgada y el trabajo deja de existir.
  const st = await H.waitFor(async () => {
    const s = await state();
    return s && !s.jobRunning && s.selectionCount === 0 ? s : null;
  }, 5000, 50, 'barra en reposo tras job-done');
  assert.equal(st.progressText, '');
  assert.deepEqual(await sw(() => self.__imgdlTest.jobs()), {});
  assert.deepEqual(await activeJobs(), {});
  await H.waitFor(async () => !(r.jobId in (await storedJobs())), 3000, 50, 'espejo del lote borrado');
  await removeInjected();
  t.diagnostic('job-done tras resetDownloads: ' + JSON.stringify({ done: done.done, failed: done.failed, text: done.text }));
});

test('cancelar un lote de archivos a mitad: las descargas en vuelo se cancelan en Chrome (USER_CANCELED) y no quedan archivos', async (t) => {
  const urls = [1, 2, 3].map((i) => trickle.origin + '/t.png?ms=2500&cancel=' + i);
  await injectImages(urls);
  assert.equal(await selectPaths(urls), 3);
  const r = await runFiles({});
  assert.equal(r.ok, true, JSON.stringify(r));
  await H.waitFor(async () => Object.keys(await pendingNow()).length === 3, 5000, 50, '3 pendientes');
  const c = await cancel(r.jobId);
  assert.equal(c.ok, true, JSON.stringify(c));

  const done = await waitJobDone(r.jobId, 15000);
  assert.equal(done.ok, false, JSON.stringify(done));
  assert.equal(done.code, 'CANCELLED');
  assert.equal(done.text, S.CANCELLED);
  assert.equal(done.done, 0);
  assert.equal(done.failed, 3);
  assert.deepEqual(done.failures.map((f) => f.reason), ['CANCELLED', 'CANCELLED', 'CANCELLED']);
  assert.deepEqual(done.failures.map((f) => f.url).sort(), urls.slice().sort());

  for (const u of urls) {
    const item = await H.waitForDownload(env.sw, (it) => it.url === u, 10000);
    assert.equal(item.state, 'interrupted', JSON.stringify(item));
    assert.equal(item.error, 'USER_CANCELED', JSON.stringify(item));
    if (item.filename) assert.equal(fs.existsSync(item.filename), false, 'sin archivo parcial: ' + item.filename);
  }
  await H.waitFor(async () => Object.keys(await pendingNow()).length === 0, 5000, 50, 'pendientes retirados');
  // Cancelado: la selección sigue hasta 'Limpiar'; la pestaña queda libre.
  assert.equal((await gather()).length, 3);
  assert.deepEqual(await activeJobs(), {});
  await clearSelection();
  assert.equal((await gather()).length, 0);
  assert.deepEqual(await sw(() => self.__imgdlTest.jobs()), {});
  await removeInjected();
  t.diagnostic('fallidas: ' + JSON.stringify(done.failures.map((f) => f.reason)));
});

test('ZIP con 3 imágenes data: de 24 MiB (96 MB de base64 en total): una por mensaje → ZIP íntegro con 3 entradas', async (t) => {
  const MB = 24;
  const built = await page.evaluate(async (MB) => {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const b = await (await fetch('/noise.png?mb=' + MB + '&seed=' + (i + 1))).blob();
      const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
      const img = document.createElement('img');
      img.className = 'injected';
      img.style.cssText = 'display:block;width:200px;height:200px';
      img.setAttribute('data-expect', 'big-data-' + i);
      img.src = dataUrl;
      document.body.appendChild(img);
      await new Promise((r) => { img.onload = r; img.onerror = r; });
      out.push({ len: dataUrl.length, bytes: b.size, w: img.naturalWidth, h: img.naturalHeight });
    }
    return out;
  }, MB);
  assert.equal(built.length, 3);
  const totalChars = built.reduce((n, b) => n + b.len, 0);
  assert.ok(totalChars > 64 * 1024 * 1024, 'la suma supera el tope de 64 MiB por mensaje: ' + totalChars);
  assert.equal(await selectPaths(built.map((_, i) => 'big-data-' + i)), 3);
  const g = await gather();
  assert.deepEqual(g.map((x) => x.kind), ['data', 'data', 'data']);

  const dlBefore = (await lastDownloads()).length;
  const r = await runZip({ confirmBig: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.total, 3);
  const done = await waitJobDone(r.jobId, 90000);
  assert.equal(done.ok, true, JSON.stringify(Object.assign({}, done, { failures: done.failures })));
  assert.equal(done.done, 3);
  assert.equal(done.failed, 0);
  assert.deepEqual(done.failures, []);
  assert.equal(done.text, S.SUMMARY_ZIP(3, 3, 0));
  const opts = (await lastDownloads()).slice(dlBefore);
  assert.equal(opts.filter((o) => zipRe.test(o.filename)).length, 1, JSON.stringify(opts.map((o) => o.filename)));

  const item = await H.waitForDownload(env.sw, (it) => it.filename === done.zipFilename, 60000);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  const z = stashZip(item, 'lote-data-grandes.zip');
  assert.equal(z.entries.length, 3, JSON.stringify(z.entries.map((e) => [e.name, e.size])));
  const sizes = z.entries.map((e) => e.size).sort((a, b) => a - b);
  assert.deepEqual(sizes, built.map((b) => b.bytes).sort((a, b) => a - b), 'cada entrada conserva los bytes del PNG');
  for (const e of z.entries) assert.deepEqual(Buffer.from(e.head), PNG_MAGIC, e.name);
  fs.rmSync(z.dest, { force: true }); // 72 MiB: no dejarlo en test/.tmp
  t.diagnostic('zip de ' + (z.size / 1048576).toFixed(1) + ' MiB con ' + z.entries.map((e) => e.name).join(', '));
  await H.waitFor(async () => (await gather()).length === 0, 5000, 100, 'selección limpiada');
  await removeInjected();
  await waitOffscreenClosed('offscreen cerrado tras el ZIP de data: grandes');
});

test('cierre ocioso del offscreen: un retain() durante la consulta off:status anula el cierre (el documento sigue vivo)', async (t) => {
  const out = await sw(async () => {
    const off = self.ImgDL.offscreen;
    const log = [];
    const t0 = Date.now();
    const L = (s) => log.push((Date.now() - t0) + 'ms ' + s);
    const origClose = chrome.offscreen.closeDocument.bind(chrome.offscreen);
    const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    let closeCalls = 0;
    let statusSent = false;
    chrome.offscreen.closeDocument = async (...a) => { closeCalls++; L('closeDocument() con refcount=' + off.refcount()); return origClose(...a); };
    // Determinista: B retiene justo cuando llega la respuesta de off:status, antes de que
    // documentIdle() devuelva el control al temporizador de cierre.
    chrome.runtime.sendMessage = (msg, ...rest) => {
      const p = origSend(msg, ...rest);
      if (!msg || msg.type !== 'off:status') return p;
      L('off:status enviado');
      return p.then((r) => {
        if (!statusSent) {
          statusSent = true;
          off.retain();
          L('retain() de B durante documentIdle(): refcount=' + off.refcount());
        }
        return r;
      });
    };
    try {
      off.setIdleMs(0);
      await off.ensureOffscreen();
      // A termina (refcount 0 → cierre ocioso); B retiene mientras A consulta off:status.
      off.retain();
      off.release();
      off.closeIfIdle();
      const deadline = Date.now() + 1000;
      while (!statusSent && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
      await new Promise((r) => setTimeout(r, 500));
      const alive = await off.hasDocument();
      L('documento vivo: ' + alive + ' refcount=' + off.refcount());
      return { log, statusSent, alive, closeCalls, refcount: off.refcount() };
    } finally {
      chrome.offscreen.closeDocument = origClose;
      chrome.runtime.sendMessage = origSend;
      off.release();
      off.setIdleMs(undefined);
      off.closeIfIdle();
    }
  });
  t.diagnostic(out.log.join(' | '));
  assert.equal(out.statusSent, true, 'el temporizador llegó a consultar off:status');
  assert.equal(out.alive, true, 'el documento sigue vivo con refcount ' + out.refcount);
  assert.equal(out.closeCalls, 0, 'closeDocument() no se llamó con un retain() vigente');
  assert.equal(out.refcount, 1);
  await waitOffscreenClosed('offscreen cerrado al soltar B');
});
