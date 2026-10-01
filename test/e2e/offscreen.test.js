'use strict';
// Documento offscreen (paso 6, corte vertical) con la extensión real, sin content script:
// ZIP directo con 5 imágenes http (una con ñ) verificado con unzip -t y zipfile, fallidas
// (HTML → NOT_IMAGE, 403 → HTTP_403, 500→200 reintentado) con _fallidas.txt, cookies con
// credentials:'include', tope de bytes, cancelación, revocación + cierre ocioso + creación
// compartida, carrera cierre ocioso/trabajo nuevo, off:fetch-one, bytes stash/data: y guardas
// de nombres, tipo byte sin bytes (NO_BYTES), contadores de progreso, jobId repetido y
// mensajes desconocidos. Todo resultado de ZIP llega por el camino de producción: off:zip-ready
// difundido por el documento y captado por el listener de nivel superior del SW.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const H = require('./harness.js');
const S = require('../../lib/strings.js');

const TMP = path.join(__dirname, '..', '.tmp');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const FAILED = S.FAILED_LIST_NAME;

let srv;
let env;
let page;

function sw(fn, arg) {
  return env.sw.evaluate(fn, arg);
}

function zipDirect(items, opts) {
  return sw(({ items, opts }) => self.__imgdlTest.zipDirect(items, opts), { items, opts });
}

function fetchOne(url, timeoutMs) {
  return sw(({ url, timeoutMs }) => self.__imgdlTest.fetchOne(url, timeoutMs), { url, timeoutMs });
}

function revoke(blobUrl) {
  return sw((u) => self.__imgdlTest.revoke(u), blobUrl);
}

function contexts() {
  return sw(() => self.__imgdlTest.offscreenContexts());
}

function status() {
  return sw(() => self.__imgdlTest.offscreenStatus());
}

function progressOf(jobId) {
  return sw((id) => self.__imgdlTest.offProgress().filter((p) => p.jobId === id), jobId);
}

async function fetchBytes(url) {
  const res = await fetch(url);
  return Buffer.from(await res.arrayBuffer());
}

function httpItem(id, name, url) {
  return { id, name, kind: 'http', url };
}

// Respuesta de error del offscreen: el mismo código en `error` (protocolo) y `code` (jobs.js).
function errReply(code) {
  return { ok: false, error: code, code };
}

// Descarga una URL blob desde el SW (como hace jobs.js) y devuelve el DownloadItem terminado.
async function downloadBlob(blobUrl, filename) {
  const id = await sw(({ url, filename }) => chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false }), { url: blobUrl, filename });
  assert.equal(typeof id, 'number');
  return H.waitForDownload(env.sw, (it) => it.id === id);
}

// Copia el archivo descargado (nombre GUID de Playwright) a test/.tmp y lo lista con zipfile.
function copyZip(item, name) {
  const dest = path.join(TMP, name);
  fs.copyFileSync(item.filename, dest);
  return dest;
}

function pyList(zipPath) {
  const script = [
    'import zipfile, json, sys',
    'z = zipfile.ZipFile(sys.argv[1])',
    'names = z.namelist()',
    'out = {"test": z.testzip(), "entries": [[i.filename, i.file_size, i.compress_type, bool(i.flag_bits & 0x800)] for i in z.infolist()]}',
    'out["fallidas"] = z.read(sys.argv[2]).decode("utf-8") if sys.argv[2] in names else None',
    'print(json.dumps(out, ensure_ascii=False))'
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', script, zipPath, FAILED], { encoding: 'utf8' }));
}

// Tamaño exacto de un ZIP STORE: cabecera local 30 + nombre + datos, central 46 + nombre, EOCD 22.
function storeSize(entries) {
  let n = 22;
  for (const e of entries) n += 30 + 46 + 2 * Buffer.byteLength(e.name, 'utf8') + e.size;
  return n;
}

test.before(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  srv = await H.startFixtures();
  env = await H.launch();
  page = await env.context.newPage();
  await page.goto(srv.origin + '/pages/basic.html', { waitUntil: 'load' });
  await H.waitFor(() => sw(() => typeof self.__imgdlTest.zipDirect === 'function'), 5000, 50, 'hooks offscreen');
});

test.after(async () => {
  if (env) await env.close();
  if (srv) await srv.close();
});

test('zipDirect: 5 imágenes http (una con ñ) → ZIP STORE íntegro con los bytes exactos', async (t) => {
  const specs = [['z1', 200, 150], ['z2', 120, 120], ['z3', 300, 100], ['z4', 64, 64], ['niño', 150, 150]];
  const items = specs.map(([seg, w, h], i) => httpItem(i + 1, seg + '.png', srv.origin + '/img/' + encodeURIComponent(seg) + '.png?w=' + w + '&h=' + h));
  const expected = await Promise.all(items.map((it) => fetchBytes(it.url)));
  assert.ok(expected.every((b) => b.subarray(0, 4).equals(PNG_MAGIC)), 'los fixtures son PNG');

  const r = await zipDirect(items, { jobId: 'j1' });
  t.after(() => (r.blobUrl ? revoke(r.blobUrl) : null));
  assert.equal(r.error, undefined, JSON.stringify(r));
  // Camino de producción: el resultado es el mensaje off:zip-ready difundido (to:'sw').
  assert.deepEqual({ type: r.type, to: r.to, jobId: r.jobId }, { type: 'off:zip-ready', to: 'sw', jobId: 'j1' });
  assert.match(r.blobUrl, /^blob:chrome-extension:\/\//);
  assert.equal(r.entries, 5);
  assert.equal(r.zipEntries, 5);
  assert.deepEqual(r.failures, []);
  assert.equal(r.size, storeSize(items.map((it, i) => ({ name: it.name, size: expected[i].length }))));
  assert.equal(await contexts(), 1);

  const item = await downloadBlob(r.blobUrl, 'Imagenes/test/x.zip');
  assert.equal(item.state, 'complete', JSON.stringify(item));
  const zipPath = copyZip(item, 'offscreen-1.zip');
  const lz = H.listZip(zipPath);
  assert.equal(lz.ok, true, 'unzip -t: ' + lz.raw);
  const py = pyList(zipPath);
  assert.equal(py.test, null);
  assert.deepEqual(py.entries, items.map((it, i) => [it.name, expected[i].length, 0, true]));

  // Progreso: al menos un off:progress del trabajo, nunca más de 4/s.
  const prog = await progressOf('j1');
  assert.ok(prog.length >= 1, 'hubo progreso');
  assert.ok(prog.every((p) => (p.phase === 'fetching' || p.phase === 'zipping') && p.total === 5 && p.done <= 5));
  for (let i = 1; i < prog.length; i++) assert.ok(prog[i].at - prog[i - 1].at >= 240, 'progreso acelerado: ' + JSON.stringify(prog));

  await revoke(r.blobUrl);
  r.blobUrl = null;
  const st = await status();
  assert.deepEqual({ jobs: st.jobs, blobUrls: st.blobUrls }, { jobs: 0, blobUrls: 0 });
  t.diagnostic('ZIP ' + r.size + ' B, progreso: ' + prog.length + ' mensajes');
});

test('fallidas: HTML → NOT_IMAGE, 403 → HTTP_403, 500→200 reintentado; _fallidas.txt en el ZIP', async (t) => {
  srv.reset();
  const items = [
    httpItem(1, 'ok.png', srv.origin + '/img/ok.png?w=80&h=80'),
    httpItem(2, 'html.jpg', srv.origin + '/html-as-jpg.jpg'),
    httpItem(3, 'x.png', srv.origin + '/hotlink/x.png'),
    httpItem(4, 'fail-once.png', srv.origin + '/fail-once.png')
  ];
  const okBytes = await fetchBytes(items[0].url);
  const failOnceBytes = srv.png('fail-once', 200, 200); // lo que sirve tras el 500
  srv.reset();

  const r = await zipDirect(items, { jobId: 'j2' });
  t.after(() => (r.blobUrl ? revoke(r.blobUrl) : null));
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.entries, 2);
  assert.equal(r.zipEntries, 3);
  assert.deepEqual(r.failures, [
    { id: 2, name: 'html.jpg', url: items[1].url, reason: 'NOT_IMAGE' },
    { id: 3, name: 'x.png', url: items[2].url, reason: 'HTTP_403' }
  ]);
  const hits = srv.hits();
  assert.equal(hits['/fail-once.png'].hits, 2, 'reintento tras 500');
  assert.equal(hits['/hotlink/x.png'].hits, 1, '403 no se reintenta');
  assert.equal(hits['/html-as-jpg.jpg'].hits, 1);
  // El fetch del offscreen sale del origen de la extensión: sin Referer de la página → 403.
  t.diagnostic('/hotlink/x.png withReferer=' + hits['/hotlink/x.png'].withReferer);

  const item = await downloadBlob(r.blobUrl, 'Imagenes/test/fallidas.zip');
  assert.equal(item.state, 'complete');
  const zipPath = copyZip(item, 'offscreen-2.zip');
  assert.equal(H.listZip(zipPath).ok, true);
  const py = pyList(zipPath);
  assert.equal(py.test, null);
  const lines = items[1].url + '\tNOT_IMAGE\n' + items[2].url + '\tHTTP_403\n';
  assert.deepEqual(py.entries, [
    ['ok.png', okBytes.length, 0, true],
    ['fail-once.png', failOnceBytes.length, 0, true],
    [FAILED, Buffer.byteLength(lines), 0, true]
  ]);
  assert.equal(py.fallidas, lines);
});

test('cookies: el fetch del offscreen envía la cookie del origen (credentials:include)', async (t) => {
  await env.context.addCookies([{ name: 'auth', value: '1', url: srv.origin + '/' }]);
  srv.reset();
  const url = srv.origin + '/cookie/c.png?w=70&h=70';
  const r = await zipDirect([httpItem(1, 'c.png', url)], { jobId: 'j3' });
  t.after(() => (r.blobUrl ? revoke(r.blobUrl) : null));
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.entries, 1);
  assert.deepEqual(r.failures, []);
  const c = srv.hits()['/cookie/c.png'];
  assert.ok(c && c.withCookie >= 1, JSON.stringify(c));
});

test('hardBytes: la suma de bytes por encima del tope → ERR_ZIP_TOO_BIG y sin URL blob', async () => {
  const items = [1, 2, 3].map((i) => httpItem(i, 'big' + i + '.png', srv.origin + '/img/big' + i + '.png?w=600&h=600'));
  const sizes = await Promise.all(items.map((it) => fetchBytes(it.url).then((b) => b.length)));
  assert.ok(sizes.reduce((a, b) => a + b, 0) > 1000, 'premisa: ' + sizes);
  const r = await zipDirect(items, { jobId: 'j4', hardBytes: 1000 });
  assert.equal(r.type, 'off:zip-ready');
  assert.equal(r.error, 'ERR_ZIP_TOO_BIG');
  assert.equal(r.blobUrl, undefined);
  const st = await status();
  assert.deepEqual({ jobs: st.jobs, blobUrls: st.blobUrls }, { jobs: 0, blobUrls: 0 });
});

test('off:abort a mitad del trabajo → CANCELLED en menos de 1,5 s y sin ZIP', async (t) => {
  const items = [1, 2].map((i) => httpItem(i, 'slow' + i + '.png', srv.origin + '/slow.png?ms=5000&i=' + i));
  await sw(({ items }) => {
    self.__imgdlZipPending = self.__imgdlTest.zipDirect(items, { jobId: 'j5' });
    return true;
  }, { items });
  await H.sleep(300);
  assert.equal((await status()).jobs, 1, 'trabajo en curso');
  const t0 = Date.now();
  const a = await sw(() => self.__imgdlTest.abortZip('j5'));
  assert.deepEqual(a, { ok: true, found: true });
  const r = await sw(() => self.__imgdlZipPending);
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, 'tardó ' + ms + ' ms');
  assert.equal(r.error, 'CANCELLED');
  assert.equal(r.blobUrl, undefined);
  assert.equal((await status()).jobs, 0);
  // Abortar un trabajo desconocido también responde.
  assert.deepEqual(await sw(() => self.__imgdlTest.abortZip('nadie')), { ok: true, found: false });
  t.diagnostic('cancelación en ' + ms + ' ms');
});

test('off:zip-job repetido con un jobId en curso → JOB_RUNNING en error y code; off:zip-result ya no existe', async () => {
  const items = [httpItem(1, 'dup.png', srv.origin + '/slow.png?ms=3000&dup=1')];
  await sw(({ items }) => {
    self.__imgdlZipDup = self.__imgdlTest.zipDirect(items, { jobId: 'dup' });
    return true;
  }, { items });
  await H.sleep(200);
  assert.equal((await status()).jobs, 1, 'trabajo en curso');
  const second = await sw(() => self.__imgdlTest.offscreenSend({ type: 'off:zip-job', jobId: 'dup', items: [] }));
  assert.deepEqual(second, errReply('JOB_RUNNING'));
  // Lo que jobs.js lee (r.code) ya no degrada a ERR_GENERIC.
  assert.equal((second && second.code) || 'ERR_GENERIC', 'JOB_RUNNING');
  assert.deepEqual(await sw(() => self.__imgdlTest.abortZip('dup')), { ok: true, found: true });
  const r = await sw(() => self.__imgdlZipDup);
  assert.equal(r.error, 'CANCELLED');
  assert.deepEqual(await sw(() => self.__imgdlTest.offscreenSend({ type: 'off:zip-job', jobId: null, items: [] })), errReply('ERR_GENERIC'));
  assert.deepEqual(await sw(() => self.__imgdlTest.offscreenSend({ type: 'off:zip-result', jobId: 'dup' })), errReply('UNKNOWN_MESSAGE'));
});

test('off:revoke + closeIfIdle: cierre tras el tiempo ocioso; creación concurrente → un solo documento', async () => {
  await sw(() => self.__imgdlTest.setOffscreenIdle(300));
  const base = await sw(() => self.__imgdlTest.offscreenRefcount());
  const r = await fetchOne(srv.origin + '/img/idle.png?w=50&h=50');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await contexts(), 1);
  assert.equal(await sw(() => self.__imgdlTest.offscreenRefcount()), base + 1);
  await revoke(r.blobUrl);
  assert.equal(await sw(() => self.__imgdlTest.offscreenRefcount()), base);
  await H.waitFor(async () => (await contexts()) === 0, 3000, 50, 'cierre ocioso');

  // Tres ensureOffscreen a la vez comparten la promesa: un documento y ningún rechazo.
  const n = await sw(async () => {
    await Promise.all([1, 2, 3].map(() => self.__imgdlTest.ensureOffscreen()));
    return self.__imgdlTest.offscreenContexts();
  });
  assert.equal(n, 1);
  // Con una URL blob viva el cierre ocioso no se ejecuta aunque el refcount esté a cero.
  const r2 = await fetchOne(srv.origin + '/img/idle2.png?w=50&h=50');
  assert.equal(r2.ok, true);
  await sw(() => { self.__imgdlTest.offscreenRelease(); });
  await H.sleep(700);
  assert.equal(await contexts(), 1, 'sigue abierto con URL blob viva');
  await sw(() => { self.__imgdlTest.offscreenSend({ type: 'off:revoke', blobUrl: null }); });
  await revoke(r2.blobUrl);
  await H.waitFor(async () => (await contexts()) === 0, 3000, 50, 'cierre tras revocar');
  await sw(() => self.__imgdlTest.setOffscreenIdle(undefined));
});

test('carrera: un trabajo que arranca cuando el cierre ocioso ya está decidido no se pierde (llega off:zip-ready)', async (t) => {
  await sw(() => self.__imgdlTest.setOffscreenIdle(300));
  const f = await fetchOne(srv.origin + '/img/race.png?w=40&h=40');
  assert.equal(f.ok, true, JSON.stringify(f));
  await revoke(f.blobUrl); // refcount 0 → temporizador ocioso a 300 ms
  // Ensancha la ventana: la 2.ª getContexts tras el revoke (la de closeNow, ya decidido el
  // cierre) tarda 400 ms. Antes de la corrección el documento se cerraba igualmente con el
  // trabajo retenido y aceptado, y off:zip-ready no llegaba nunca.
  await sw(() => {
    const orig = chrome.runtime.getContexts.bind(chrome.runtime);
    const origClose = chrome.offscreen.closeDocument.bind(chrome.offscreen);
    self.__race = { calls: [], closedAt: null, t0: Date.now(), getContexts: chrome.runtime.getContexts, closeDocument: chrome.offscreen.closeDocument };
    let n = 0;
    chrome.runtime.getContexts = async (q) => {
      n++;
      self.__race.calls.push({ n, at: Date.now() - self.__race.t0 });
      if (n === 2) await new Promise((r) => setTimeout(r, 400));
      return orig(q);
    };
    chrome.offscreen.closeDocument = async () => {
      self.__race.closedAt = Date.now() - self.__race.t0;
      return origClose();
    };
  });
  t.after(() => sw(() => {
    chrome.runtime.getContexts = self.__race.getContexts;
    chrome.offscreen.closeDocument = self.__race.closeDocument;
    self.__imgdlTest.setOffscreenIdle(undefined);
  }));
  await H.sleep(450); // t≈450: el temporizador (300) ya pasó documentIdle y espera en closeNow
  const genBefore = await sw(() => self.__imgdlTest.offscreenGeneration());
  const items = [1, 2].map((i) => httpItem(i, 'race' + i + '.png', srv.origin + '/slow.png?ms=1500&i=' + i));
  const r = await zipDirect(items, { jobId: 'race' });
  t.after(() => (r.blobUrl ? revoke(r.blobUrl) : null));
  const info = await sw(() => ({ calls: self.__race.calls, closedAt: self.__race.closedAt, refcount: self.__imgdlTest.offscreenRefcount(), generation: self.__imgdlTest.offscreenGeneration() }));
  assert.equal(r.error, undefined, JSON.stringify({ r, info }));
  assert.deepEqual({ type: r.type, entries: r.entries, failures: r.failures }, { type: 'off:zip-ready', entries: 2, failures: [] });
  assert.match(r.blobUrl, /^blob:chrome-extension:\/\//);
  // Premisa de la carrera: la 2.ª getContexts (retardada) ocurrió antes de arrancar el trabajo.
  assert.ok(info.calls.length >= 3 && info.calls[1].at < 450, 'ventana ensanchada: ' + JSON.stringify(info));
  assert.equal(info.generation, genBefore + 1, 'retain() subió la generación');
  assert.equal(info.closedAt, null, 'no se cerró con el trabajo retenido: ' + JSON.stringify(info));
  assert.equal(await contexts(), 1);
  // Al soltar la URL blob el documento sí se cierra (el ciclo de vida sigue intacto).
  await revoke(r.blobUrl);
  r.blobUrl = null;
  await H.waitFor(async () => (await contexts()) === 0, 3000, 50, 'cierre ocioso tras el trabajo');
  t.diagnostic('getContexts: ' + JSON.stringify(info.calls));
});

test('off:fetch-one: {ok, blobUrl, mime image/png, ext png, size}; la URL blob se descarga; errores con error y code', async (t) => {
  const url = srv.origin + '/img/a.png?w=96&h=96';
  const expected = await fetchBytes(url);
  const r = await fetchOne(url);
  t.after(() => (r.blobUrl ? revoke(r.blobUrl) : null));
  assert.deepEqual({ ok: r.ok, mime: r.mime, ext: r.ext, size: r.size }, { ok: true, mime: 'image/png', ext: 'png', size: expected.length });
  assert.match(r.blobUrl, /^blob:chrome-extension:\/\//);
  const item = await downloadBlob(r.blobUrl, 'Imagenes/test/a.png');
  assert.equal(item.state, 'complete', JSON.stringify(item));
  assert.deepEqual(H.readFile(item.filename), expected);
  await revoke(r.blobUrl);
  r.blobUrl = null;

  assert.deepEqual(await fetchOne(srv.origin + '/html-as-jpg.jpg'), errReply('NOT_IMAGE'));
  assert.deepEqual(await fetchOne(srv.origin + '/hotlink/x.png'), errReply('HTTP_403'));
  assert.deepEqual(await fetchOne(srv.origin + '/slow.png?ms=3000', 400), errReply('TIMEOUT'));
  assert.deepEqual(await fetchOne('http://127.0.0.1:1/nada.png'), errReply('NETWORK'));
  const st = await status();
  assert.deepEqual({ blobUrls: st.blobUrls, fetches: st.fetches }, { blobUrls: 0, fetches: 0 });
});

test('off:zip-bytes (stash) y data:, extensión corregida por firma y nombres duplicados', async (t) => {
  const png = srv.png('bytes', 40, 40);
  const dataUrl = 'data:image/png;base64,' + png.toString('base64');
  const items = [
    { id: 1, name: 'lienzo.png', kind: 'canvas', dataUrl },
    { id: 2, name: 'inline.png', kind: 'data', url: dataUrl },
    httpItem(3, 'mal.jpg', srv.origin + '/img/mal.png?w=40&h=40'), // firma PNG: se renombra mal.png
    httpItem(4, 'Dup.png', srv.origin + '/img/d1.png?w=40&h=40'),
    httpItem(5, 'dup.png', srv.origin + '/img/d2.png?w=40&h=40')
  ];
  const r = await zipDirect(items, { jobId: 'j8' });
  t.after(() => (r.blobUrl ? revoke(r.blobUrl) : null));
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.entries, 5);
  const item = await downloadBlob(r.blobUrl, 'Imagenes/test/bytes.zip');
  const py = pyList(copyZip(item, 'offscreen-8.zip'));
  assert.equal(py.test, null);
  assert.deepEqual(py.entries.map((e) => [e[0], e[1]]), [
    ['lienzo.png', png.length],
    ['inline.png', png.length],
    ['mal.png', png.length],
    ['Dup.png', png.length],
    ['dup (2).png', png.length]
  ]);
});

test('tipo byte sin stash o ítem sin URL → NO_BYTES al instante (sin fetch ni reintento de 1 s)', async (t) => {
  const items = [
    { id: 7, name: 'lienzo.png', kind: 'canvas' }, // sin off:zip-bytes previo
    { id: 8, name: 'dibujo.svg', kind: 'svg' },
    { id: 9, name: 'sinurl.png', kind: 'http' },
    httpItem(10, 'ok.png', srv.origin + '/img/ok10.png?w=20&h=20')
  ];
  const okBytes = await fetchBytes(items[3].url);
  const t0 = Date.now();
  const r = await zipDirect(items, { jobId: 'nobytes' });
  const ms = Date.now() - t0;
  t.after(() => (r.blobUrl ? revoke(r.blobUrl) : null));
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.ok(ms < 900, 'tardó ' + ms + ' ms (¿reintento de 1 s de un fetch("undefined")?)');
  assert.deepEqual(r.failures, [
    { id: 7, name: 'lienzo.png', reason: 'NO_BYTES' },
    { id: 8, name: 'dibujo.svg', reason: 'NO_BYTES' },
    { id: 9, name: 'sinurl.png', reason: 'NO_BYTES' }
  ]);
  assert.deepEqual({ entries: r.entries, zipEntries: r.zipEntries }, { entries: 1, zipEntries: 2 });
  const item = await downloadBlob(r.blobUrl, 'Imagenes/test/nobytes.zip');
  const py = pyList(copyZip(item, 'offscreen-nobytes.zip'));
  assert.equal(py.test, null);
  const lines = 'lienzo.png\tNO_BYTES\ndibujo.svg\tNO_BYTES\nsinurl.png\tNO_BYTES\n';
  assert.deepEqual(py.entries, [['ok.png', okBytes.length, 0, true], [FAILED, Buffer.byteLength(lines), 0, true]]);
  assert.equal(py.fallidas, lines);
  t.diagnostic('NO_BYTES en ' + ms + ' ms');
});

test('progreso: total = ítems en las dos fases, done ≤ éxitos y failed estable; _fallidas.txt no cuenta', async (t) => {
  const png = srv.png('prog', 8, 8);
  const dataUrl = 'data:image/png;base64,' + png.toString('base64');
  const N = 3000; // suficientes entradas para que la fase zipping dure > progressThrottleMs
  const items = [];
  for (let i = 1; i <= N; i++) items.push({ id: i, name: 'p' + i + '.png', kind: 'data', url: dataUrl });
  items.push(httpItem(N + 1, 'h.jpg', srv.origin + '/html-as-jpg.jpg'));
  items.push(httpItem(N + 2, 'x.png', srv.origin + '/hotlink/x.png'));
  const r = await zipDirect(items, { jobId: 'prog' });
  t.after(() => (r.blobUrl ? revoke(r.blobUrl) : null));
  assert.equal(r.error, undefined, JSON.stringify(r).slice(0, 400));
  assert.deepEqual({ entries: r.entries, zipEntries: r.zipEntries, failures: r.failures.length }, { entries: N, zipEntries: N + 1, failures: 2 });
  const prog = await progressOf('prog');
  const brief = prog.map((p) => [p.phase, p.done, p.failed, p.total]);
  assert.ok(prog.length >= 1, 'hubo progreso');
  for (const p of prog) {
    assert.equal(p.total, N + 2, 'total constante: ' + JSON.stringify(brief));
    assert.ok(p.done <= N && p.failed <= 2 && p.done + p.failed <= N + 2, 'contadores: ' + JSON.stringify(brief));
  }
  const zipping = prog.filter((p) => p.phase === 'zipping');
  assert.ok(zipping.length >= 1, 'hubo progreso de la fase zipping: ' + JSON.stringify(brief));
  for (const p of zipping) assert.equal(p.failed, 2, 'failed no se pierde al empaquetar: ' + JSON.stringify(brief));
  t.diagnostic('progreso: ' + JSON.stringify(brief));
});

test('mensajes desconocidos o no dirigidos al offscreen: no lanza y sigue respondiendo', async () => {
  assert.deepEqual(await sw(() => self.__imgdlTest.offscreenSend({ type: 'off:nope' })), errReply('UNKNOWN_MESSAGE'));
  const r = await sw(async () => {
    try {
      return { value: await chrome.runtime.sendMessage({ to: 'nadie', type: 'off:zip-job', jobId: 'x' }) };
    } catch (e) {
      return { error: String(e && e.message) };
    }
  });
  assert.ok(r.value === undefined || /Receiving end/.test(r.error || ''), JSON.stringify(r));
  const st = await status();
  assert.equal(st.ok, true);
  // Trabajo sin ítems: ZIP vacío válido de 22 B.
  const empty = await zipDirect([], { jobId: 'x' });
  assert.deepEqual({ entries: empty.entries, size: empty.size, failures: empty.failures }, { entries: 0, size: 22, failures: [] });
  await revoke(empty.blobUrl);
  assert.equal((await fetchOne(srv.origin + '/img/fin.png?w=30&h=30')).ok, true);
});
