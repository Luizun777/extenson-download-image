'use strict';
// Fuentes especiales con la extensión real (paso 8) y clics REALES en el chip sobre
// special.html: data: → .png; blob: viva → PNG; blob: revocada → PNG recodificado por
// canvas; canvas 2D → PNG; canvas contaminado → sin descarga + toast ERR_TAINTED_CANVAS;
// svg inline → .svg con prólogo XML, xmlns y el <symbol id="sym"> inlinado; póster de
// <video> → PNG; blob: de 40 MB → toast ERR_TOO_BIG_ITEM y no se selecciona (ni cuenta ni
// muestra la barra mientras se materializa); y un ZIP
// desde la barra con canvas + blob + svg cuyas entradas llevan bytes/extensión correctos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./harness.js');
const S = require('../../lib/strings.js');
const names = require('../../lib/names.js');
const urls = require('../../lib/urls.js');

const TMP = path.join(__dirname, '..', '.tmp');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let srv;
let env;
let page;
let tabId;
let folder; // Imagenes/<host>

function sw(fn, arg) {
  return env.sw.evaluate(fn, arg);
}

function state() {
  return H.state(env.sw, tabId);
}

function lastDownloads() {
  return sw(() => self.__imgdlTest.lastDownloads());
}

function lastJobDone() {
  return sw(() => self.__imgdlTest.lastJobDone());
}

function searchDownloads() {
  return sw(() => chrome.downloads.search({}));
}

async function maxDownloadId() {
  const items = await searchDownloads();
  return items.reduce((m, it) => Math.max(m, it.id), 0);
}

// Siguiente descarga nueva (id > since) que termina: complete | interrupted.
function waitNewDownload(since, timeoutMs = 15000) {
  return H.waitForDownload(env.sw, (it) => it.id > since, timeoutMs);
}

function rectOf(id) {
  return page.evaluate((id) => {
    const el = document.getElementById(id);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, id);
}

// Hover real sobre #id hasta ver el chip con hoverKey que cumpla `match`.
async function hover(id, match) {
  const r = await rectOf(id);
  const px = r.x + r.w / 2;
  const py = r.y + r.h / 2;
  await page.mouse.move(px, py);
  const ok = typeof match === 'function' ? match : (k) => k === match;
  let flip = 0;
  return H.waitFor(async () => {
    const st = await state();
    if (st && st.hoverKey && ok(st.hoverKey) && st.chipRect && st.chipCells) return st;
    flip ^= 1;
    await page.mouse.move(px + flip, py + flip);
    return null;
  }, 4000, 50, 'hover #' + id);
}

async function away() {
  await page.mouse.move(640, 4);
}

// Clic real en [descargar] del chip de #id; devuelve la descarga nueva terminada.
async function downloadViaChip(id, match) {
  const since = await maxDownloadId();
  const st = await hover(id, match);
  await H.clickChip(page, st, 'download');
  await away();
  const item = await waitNewDownload(since);
  const opts = await lastDownloads();
  return { item, opts: opts[opts.length - 1], hoverKey: st.hoverKey };
}

async function selectViaChip(id, match) {
  const st = await hover(id, match);
  assert.equal(st.chipChecked, false, '#' + id + ' no estaba seleccionada');
  await H.clickChip(page, st, 'select');
  return st;
}

function waitCount(n, label) {
  return H.waitFor(async () => {
    const st = await state();
    return st && st.selectionCount === n ? st : null;
  }, 4000, 40, label || 'selectionCount ' + n);
}

function waitToast(text, label) {
  return H.waitFor(async () => {
    const st = await state();
    return st && st.toasts.includes(text) ? st : null;
  }, 4000, 50, label || 'toast ' + text);
}

const isKind = (k) => (key) => typeof key === 'string' && key.startsWith(k + '|');

test.before(async () => {
  srv = await H.startFixtures();
  env = await H.launch();
  page = await env.context.newPage();
  await page.goto(srv.origin + '/pages/special.html', { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const by = (id) => document.getElementById(id);
    return [...document.images].every((i) => i.complete) &&
      by('blob-live').naturalWidth > 0 && by('blob-revoked').naturalWidth > 0 && by('blob-revoked').dataset.revoked === '1' &&
      by('canvas-tainted').dataset.tainted === '1' && by('blob-huge').dataset.huge === 'error';
  }, null, { timeout: 10000 });
  tabId = await H.tabIdOf(env.sw, page);
  assert.equal(await H.activate(env.sw, tabId), true, 'activación');
  folder = names.buildPaths({ folder: 'Imagenes', host: urls.hostOf(page.url()), stamp: 'S' }).single;
});

test.after(async () => {
  if (env) await env.close();
  if (srv) await srv.close();
});

test('#data (data: PNG): descarga completa con extensión png y bytes PNG', async (t) => {
  const { item, opts, hoverKey } = await downloadViaChip('data', isKind('data'));
  assert.equal(item.state, 'complete', JSON.stringify(item));
  assert.deepEqual(H.readFile(item.filename).subarray(0, 4), PNG_MAGIC);
  assert.match(opts.url, /^data:image\/png;base64,/);
  assert.equal(opts.filename, folder + '/data.png');
  assert.equal(opts.conflictAction, 'uniquify');
  t.diagnostic('data: ' + hoverKey.slice(0, 30) + '… → ' + opts.filename + ' (' + item.fileSize + ' B)');
});

test('#blob-live (blob: viva): PNG', async (t) => {
  const { item, opts } = await downloadViaChip('blob-live', isKind('blob'));
  assert.equal(item.state, 'complete', JSON.stringify(item));
  const bytes = H.readFile(item.filename);
  assert.deepEqual(bytes.subarray(0, 4), PNG_MAGIC);
  // Los bytes son los del fetch en el marco (no una recodificación): mismo tamaño que /img/b.png.
  const orig = srv.png('b', 300, 300);
  assert.equal(bytes.length, orig.length, 'bytes originales de la blob:');
  assert.match(opts.url, /^data:image\/png;base64,/, 'tipo byte: llega como data URL al SW');
  assert.equal(opts.filename, folder + '/blob viva.png');
  t.diagnostic('blob viva: ' + opts.filename + ' (' + item.fileSize + ' B)');
});

test('#blob-revoked (blob: revocada tras cargar): PNG recodificado desde el <img>', async (t) => {
  // La blob: ya no se puede leer: la única vía es recodificar el <img> decodificado.
  const readable = await page.evaluate(() => fetch(document.getElementById('blob-revoked').src).then((r) => r.ok).catch(() => false));
  assert.equal(readable, false, 'la blob: revocada no debe poder leerse con fetch');
  const { item, opts } = await downloadViaChip('blob-revoked', isKind('blob'));
  assert.equal(item.state, 'complete', JSON.stringify(item));
  const bytes = H.readFile(item.filename);
  assert.deepEqual(bytes.subarray(0, 4), PNG_MAGIC);
  assert.ok(bytes.length > 100, 'PNG no vacío');
  // Cabecera IHDR: 300×300 (ancho/alto en big-endian en los bytes 16-23).
  assert.equal(bytes.readUInt32BE(16), 300);
  assert.equal(bytes.readUInt32BE(20), 300);
  assert.equal(opts.filename, folder + '/blob revocada.png');
  t.diagnostic('blob revocada: ' + opts.filename + ' (' + item.fileSize + ' B, recodificada)');
});

test('#canvas2d: PNG', async (t) => {
  const { item, opts } = await downloadViaChip('canvas2d', isKind('canvas'));
  assert.equal(item.state, 'complete', JSON.stringify(item));
  const bytes = H.readFile(item.filename);
  assert.deepEqual(bytes.subarray(0, 4), PNG_MAGIC);
  assert.equal(bytes.readUInt32BE(16), 300);
  assert.equal(opts.filename, folder + '/canvas2d.png');
  t.diagnostic('canvas: ' + opts.filename + ' (' + item.fileSize + ' B)');
});

test('#canvas-tainted: sin descarga y toast ERR_TAINTED_CANVAS', async () => {
  const since = await maxDownloadId();
  const before = (await lastDownloads()).length;
  const st = await hover('canvas-tainted', isKind('canvas'));
  await H.clickChip(page, st, 'download');
  await away();
  await waitToast(S.ERR_TAINTED_CANVAS, 'toast lienzo protegido');
  await H.sleep(800);
  assert.equal((await lastDownloads()).length, before, 'ninguna llamada a downloads.download');
  const items = (await searchDownloads()).filter((it) => it.id > since);
  assert.deepEqual(items, [], 'ninguna descarga nueva');
});

test('#svg: .svg con prólogo XML, xmlns y el <symbol id="sym"> inlinado', async (t) => {
  const { item, opts } = await downloadViaChip('svg', isKind('svg'));
  assert.equal(item.state, 'complete', JSON.stringify(item));
  const xml = H.readFile(item.filename).toString('utf8');
  assert.ok(xml.startsWith('<?xml'), xml.slice(0, 40));
  assert.ok(xml.includes('xmlns="http://www.w3.org/2000/svg"'), 'xmlns');
  assert.match(xml, /<symbol[^>]*\bid="sym"/, 'symbol sym inlinado');
  assert.ok(xml.includes('href="#sym"'), 'el <use> sigue apuntando al symbol');
  assert.match(opts.url, /^data:image\/svg\+xml/);
  assert.ok(opts.filename.endsWith('.svg'), opts.filename);
  assert.equal(opts.filename, folder + '/logo.svg'); // aria-label="logo" como alt
  t.diagnostic('svg: ' + opts.filename + ' (' + xml.length + ' chars)');
});

test('#video: póster PNG por http', async (t) => {
  const posterUrl = srv.origin + '/img/poster.png?w=400&h=300';
  const { item, opts } = await downloadViaChip('video', 'http|' + posterUrl);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  assert.deepEqual(H.readFile(item.filename).subarray(0, 4), PNG_MAGIC);
  assert.equal(opts.url, posterUrl);
  assert.equal(opts.filename, folder + '/poster.png');
  t.diagnostic('póster: ' + opts.filename);
});

test('#blob-huge (blob: de 40 MB): seleccionar → toast ERR_TOO_BIG_ITEM y no queda seleccionada; mientras se materializa no cuenta ni aparece la barra', async (t) => {
  const before = await state();
  assert.equal(before.selectionCount, 0);
  assert.equal(before.barState.visible, false, 'sin barra antes');
  const st = await selectViaChip('blob-huge', isKind('blob'));
  assert.equal(st.chipChecked, false);
  // Ventana pendiente (fetch de 40 MB + comprobación de tamaño): muestreo hasta el toast.
  // Nunca "1 seleccionadas", nunca barra, nunca gather con el ítem.
  const samples = [];
  const toasted = await H.waitFor(async () => {
    const s = await state();
    samples.push({ count: s.selectionCount, total: s.selectionTotal, bar: s.barState.visible, live: s.liveText });
    return s.toasts.includes(S.ERR_TOO_BIG_ITEM) ? s : null;
  }, 4000, 10, 'toast demasiado grande');
  for (const smp of samples) {
    assert.equal(smp.count, 0, 'recuento durante la materialización: ' + JSON.stringify(smp));
    assert.equal(smp.total, 0, JSON.stringify(smp));
    assert.equal(smp.bar, false, 'la barra no aparece para una selección que falla: ' + JSON.stringify(smp));
    assert.notEqual(smp.live, S.BAR_SELECTED(1), 'anuncio: ' + JSON.stringify(smp));
  }
  assert.equal(toasted.barState.visible, false, 'sin barra tras el fallo');
  const after = await H.waitFor(async () => {
    const s = await state();
    return s.selectionCount === 0 && s.chipChecked === false ? s : null;
  }, 4000, 40, 'no seleccionada (checkbox desmarcado)');
  assert.equal(after.badgeCount, 0);
  assert.equal(after.barState.visible, false);
  assert.deepEqual(await sw((id) => self.__imgdlTest.gather(id), tabId), []);
  t.diagnostic('muestras durante la materialización: ' + samples.length);
  await away();
});

test('ZIP desde la barra con #canvas2d + #blob-live + #svg: entradas .png, .png, .svg con bytes correctos', async (t) => {
  await selectViaChip('canvas2d', isKind('canvas'));
  await waitCount(1);
  await selectViaChip('blob-live', isKind('blob'));
  await waitCount(2);
  await selectViaChip('svg', isKind('svg'));
  await waitCount(3);
  await away();
  const st = await H.waitFor(async () => {
    const s = await state();
    const b = s && s.barState && s.barState.buttons ? s.barState.buttons.zip : null;
    return b && !s.barState.disabled.zip ? s : null;
  }, 5000, 40, 'botón ZIP');
  assert.equal(st.barState.labels.zip, S.BAR_ZIP(3));
  const before = (await lastJobDone()).length;
  const since = await maxDownloadId();
  const b = st.barState.buttons.zip;
  await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2);
  await away();
  const done = await H.waitFor(async () => {
    const l = await lastJobDone();
    return l.length > before ? l[l.length - 1] : null;
  }, 30000, 50, 'job-done del ZIP');
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.done, 3, JSON.stringify(done));
  assert.equal(done.failed, 0, JSON.stringify(done));
  assert.equal(done.text, S.SUMMARY_ZIP(3, 3, 0));

  // Playwright guarda con nombre GUID (sin .zip): el ZIP se reconoce por su URL blob del offscreen y el MIME.
  const item = await H.waitForDownload(env.sw, (it) => it.id > since && /^blob:chrome-extension:/.test(it.url || '') && it.state === 'complete', 20000);
  assert.equal(item.mime, 'application/zip', JSON.stringify(item));
  const opts = (await lastDownloads()).pop();
  assert.ok(/^Imagenes\/.+_\d{8}-\d{4}\.zip$/.test(opts.filename), 'nombre del ZIP: ' + opts.filename);
  fs.mkdirSync(TMP, { recursive: true });
  const dest = path.join(TMP, 'special-sources.zip');
  fs.copyFileSync(item.filename, dest);
  const z = H.listZip(dest);
  assert.equal(z.ok, true, 'unzip -t');
  assert.equal(z.pyOk, true, 'zipfile.testzip');
  assert.ok(Array.isArray(z.entries), 'listado con zipfile');
  assert.deepEqual(z.names.map((n) => path.extname(n)).sort(), ['.png', '.png', '.svg']);
  for (const e of z.entries) {
    assert.ok(e.size > 0, e.name);
    if (e.name.endsWith('.png')) assert.deepEqual(Buffer.from(e.head), PNG_MAGIC, e.name);
    else {
      assert.ok(e.text.startsWith('<?xml'), e.name);
      assert.ok(e.text.includes('xmlns="http://www.w3.org/2000/svg"'), e.name);
      assert.match(e.text, /<symbol[^>]*\bid="sym"/, e.name);
    }
  }
  assert.ok(z.names.includes('canvas2d.png'), z.names.join(', '));
  assert.ok(z.names.includes('logo.svg'), z.names.join(', '));
  t.diagnostic('zip: ' + dest + ' (' + item.fileSize + ' B): ' + z.names.join(', '));
  await H.waitFor(async () => (await state()).selectionCount === 0, 5000, 50, 'selección limpiada tras el ZIP');
});
