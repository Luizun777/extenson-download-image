'use strict';
// ZIP grande (paso 10, opt-in con E2E_LARGE=1): large.html con 30 PNG de ruido incompresible
// de ~8 MB → un solo .zip STORE de ~240 MB por blob URL del offscreen (downloads-c2 a tamaño
// realista). Comprueba: servidor (/noise.png?mb=8 en < 1 s y bytes idénticos por semilla, incluso
// tras ser expulsado de la caché); convenciones de large.html (queda fuera de fixtures-pages.test.js
// a propósito: 30 × 8 MB no caben en la suite unitaria); refs con w/h reales vía selectExpect
// (estimación de jobs por debajo de zipSoftBytes → runZip sin confirmBig; con una estimación
// forzada → NEEDS_CONFIRM/WARN_BIG); regla DNR de Referer viva solo durante los fetch del
// offscreen y acotada a la extensión + host (downloads-d3); una sola descarga .zip completa,
// tamaño exacto (suma de los 30 fixtures + cabeceras STORE), unzip -t, zipfile.testzip y sha256
// de cada entrada = fixture; fases (fetching/zipping/saving); limpieza tras la descarga (blob URL
// revocada, refcount 0, sin pendientes ni reglas); RSS extra del árbol de Chromium < 2 × ZIP
// (zip-d1: el Blob se comparte, sin segunda copia en el heap); presupuesto de 90 s y offscreen
// cerrado al terminar. Sin la variable, los tests con servidor y navegador se saltan (t.skip);
// solo corre la comprobación estática del fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const H = require('./harness.js');
const S = require('../../lib/strings.js');
const { DEFAULTS } = require('../../lib/thresholds.js');

const ENABLED = process.env.E2E_LARGE === '1';
const SKIP_MSG = 'opt-in: E2E_LARGE=1 npm run test:e2e:large (30 × 8 MB → ZIP de ~240 MB)';
const N = 30;
const MB = 8;
const IMG_W = 300; // caja de cada <img> (atributos width/height: existe antes de cargar)
const IMG_H = 200;
const PATHS = Array.from({ length: N }, (_, i) => '/noise.png?mb=' + MB + '&seed=' + (i + 1));
const LARGE_HTML = path.join(__dirname, '..', 'fixtures', 'pages', 'large.html');
const PAGES_UNIT_TEST = path.join(__dirname, '..', 'unit', 'fixtures-pages.test.js');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const LOCAL_HEADER = 30; // cabecera local STORE (sin extra ni descriptor)
const CENTRAL_HEADER = 46; // entrada del directorio central (sin extra ni comentario)
const EOCD = 22;
const JOB_TIMEOUT_MS = 180000; // cota dura del waitFor; el presupuesto documentado es BUDGET_MS
const BUDGET_MS = 90000; // plan paso 10 / spec paso 8: job-done y test completo en < 90 s
const RSS_SAMPLE_MS = 200; // ~10 muestras en un trabajo de ~2 s
const RULE_SAMPLE_MS = 50; // reglas DNR de sesión durante los fetch del offscreen
const RULE_ID_START = 1000; // referer-rules.js: ids de sesión de la extensión

let srv;
let env;
let page;
let tabId;
const fixtures = new Map(); // ruta → {size, sha256}

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

function offscreenContexts() {
  return sw(() => self.__imgdlTest.offscreenContexts());
}

function offscreenStatus() {
  return sw(() => self.__imgdlTest.offscreenStatus().catch((e) => ({ ok: false, error: String(e) })));
}

function offscreenRefcount() {
  return sw(() => self.__imgdlTest.offscreenRefcount());
}

function pending() {
  return sw(() => self.__imgdlTest.pending());
}

function sessionRules() {
  return sw(() => self.__imgdlTest.sessionRules());
}

function liveRefererRules() {
  return sw(() => self.__imgdlTest.liveRefererRules());
}

function searchDownloads() {
  return sw(() => chrome.downloads.search({}));
}

function runZip(opts) {
  const pageInfo = { url: page.url(), title: 'Fixture: ZIP grande' };
  return sw(({ tabId, page, opts }) => self.__imgdlTest.runZip(tabId, page, opts), { tabId, page: pageInfo, opts: opts || {} });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Descarga un fixture y devuelve {size, sha256, ms, head}; no retiene los bytes.
async function fetchFixture(p) {
  const t0 = Date.now();
  const r = await fetch(srv.origin + p);
  const buf = Buffer.from(await r.arrayBuffer());
  const ms = Date.now() - t0;
  assert.equal(r.status, 200, p);
  assert.equal(r.headers.get('content-type'), 'image/png', p);
  assert.deepEqual(buf.subarray(0, 4), PNG_MAGIC, p);
  return { size: buf.length, sha256: sha256(buf), ms };
}

// --- RSS del árbol de procesos de Chromium (ps, macOS/Linux); opcional: null si no se puede --------

function browserPid() {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1048576 });
  for (const line of out.split('\n')) {
    if (!line.includes(env.userDataDir) || /--type=/.test(line)) continue;
    const pid = parseInt(line.trim(), 10);
    if (Number.isFinite(pid)) return pid;
  }
  return null;
}

function rssTreeKB(rootPid) {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', maxBuffer: 64 * 1048576 });
  const children = new Map();
  const rss = new Map();
  for (const line of out.split('\n')) {
    const m = line.trim().split(/\s+/);
    if (m.length < 3) continue;
    const pid = +m[0];
    const ppid = +m[1];
    rss.set(pid, +m[2]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  let kb = 0;
  let procs = 0;
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    if (!rss.has(p)) continue;
    kb += rss.get(p);
    procs++;
    for (const c of children.get(p) || []) stack.push(c);
  }
  return { kb, procs };
}

// Muestrea el RSS del árbol cada RSS_SAMPLE_MS; stop() devuelve base y pico (o null si ps falló).
// La base incluye large.html ya cargada (~250 MB de PNG): lo que se juzga es el extra del trabajo.
function startRssSampler() {
  let pid = null;
  try { pid = browserPid(); } catch (_) { pid = null; }
  if (!pid) return { stop: () => null };
  let peak = { kb: 0, procs: 0 };
  let samples = 0;
  const sample = () => {
    try {
      const r = rssTreeKB(pid);
      samples++;
      if (r.kb > peak.kb) peak = r;
    } catch (_) { /* ps no disponible: se ignora la muestra */ }
  };
  sample();
  const base = peak;
  const timer = setInterval(sample, RSS_SAMPLE_MS);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      sample();
      return { pid, baseMiB: base.kb / 1024, peakMiB: peak.kb / 1024, procs: peak.procs, samples };
    }
  };
}

// Muestrea las reglas DNR de sesión (y los ids vivos del SW) cada RULE_SAMPLE_MS mientras dura el
// trabajo; stop() devuelve la primera muestra no vacía de cada una (o null) y cuántas se tomaron.
function startRuleSampler() {
  let first = null;
  let liveFirst = null;
  let samples = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const [rules, live] = await Promise.all([sessionRules(), liveRefererRules()]);
        samples++;
        if (!first && rules.length) first = rules;
        if (!liveFirst && live.length) liveFirst = live;
      } catch (_) { /* SW ocupado: se ignora la muestra */ }
      await H.sleep(RULE_SAMPLE_MS);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return { first, liveFirst, samples };
    }
  };
}

// Listado + CRC + sha256 de cada entrada con zipfile de Python (lectura en trozos de 1 MiB).
function inspectZip(zipPath) {
  const out = execFileSync('python3', ['-c', [
    'import zipfile, sys, json, hashlib',
    'z = zipfile.ZipFile(sys.argv[1])',
    'out = {"test": z.testzip(), "entries": []}',
    'for i in z.infolist():',
    '    h = hashlib.sha256()',
    '    with z.open(i) as f:',
    '        for chunk in iter(lambda: f.read(1 << 20), b""):',
    '            h.update(chunk)',
    '    out["entries"].append({"name": i.filename, "size": i.file_size, "compress": i.compress_type, "utf8": bool(i.flag_bits & 0x800), "sha256": h.hexdigest()})',
    'print(json.dumps(out, ensure_ascii=False))'
  ].join('\n'), zipPath], { encoding: 'utf8', maxBuffer: 16 * 1048576 });
  return JSON.parse(out);
}

test.before(async () => {
  if (!ENABLED) return;
  srv = await H.startFixtures();
});

test.after(async () => {
  if (env) await env.close();
  if (srv) await srv.close();
});

// Estática (sin servidor ni navegador, corre siempre): large.html sigue la convención data-expect /
// data-expect-kind y declara su cabecera en la forma colapsada "expect (no parseado)", que expectedIds()
// de fixtures-pages.test.js no reconoce a propósito: esa suite no abre esta página (30 × 8 MB).
test('large.html: 30 <img> n1..n30 de 300×200 eager con data-expect/kind, cabecera "expect (no parseado)" y fuera de fixtures-pages.test.js', () => {
  const html = fs.readFileSync(LARGE_HTML, 'utf8');
  const tags = html.match(/<img\b[^>]*>/g) || [];
  assert.equal(tags.length, N, N + ' <img>');
  const attr = (tag, name) => {
    const m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag);
    return m ? m[1] : null;
  };
  tags.forEach((tag, i) => {
    const want = {
      id: 'n' + (i + 1),
      src: PATHS[i],
      'data-expect': PATHS[i],
      'data-expect-kind': 'http',
      width: String(IMG_W),
      height: String(IMG_H),
      loading: 'eager'
    };
    for (const [k, v] of Object.entries(want)) assert.equal(attr(tag, k), v, k + ' de ' + tag);
    assert.equal(attr(tag, 'data-expect-skip'), null, 'sin data-expect-skip: ' + tag);
  });
  const m = /expect \(no parseado\): #n1\.\.#n(\d+) → \/noise\.png\?mb=(\d+)&seed=N\b/u.exec(html);
  assert.ok(m, 'cabecera "expect (no parseado): #n1..#n30 → /noise.png?mb=8&seed=N"');
  assert.deepEqual([+m[1], +m[2]], [N, MB], 'la cabecera declara N y MB del test');
  // Misma expresión que expectedIds() en fixtures-pages.test.js: no debe reconocer ninguna línea.
  const parsed = [...html.matchAll(/^\s*(?:<!--\s*)?expect:\s*#([\w-]+)\s*→/gmu)].map((x) => x[1]);
  assert.deepEqual(parsed, [], 'ninguna línea con la forma "expect: #id →" que parsea expectedIds()');
  const unit = fs.readFileSync(PAGES_UNIT_TEST, 'utf8');
  assert.ok(!/large\.html|'large'/.test(unit), 'fixtures-pages.test.js no abre large.html (queda fuera a propósito)');
});

test('servidor: /noise.png?mb=8 responde en < 1 s, es PNG de ~8 MB y sus bytes son idénticos por semilla (también tras salir de la caché)', async (t) => {
  if (!ENABLED) return t.skip(SKIP_MSG);
  // Primera petición en frío (genera el PNG) y segunda inmediata (caché): mismos bytes.
  const first = await fetchFixture(PATHS[0]);
  assert.ok(first.ms < 1000, 'primera respuesta de /noise.png?mb=8 en ' + first.ms + ' ms');
  assert.ok(first.size > MB * 1000000 && first.size < MB * 1048576 + 65536, 'tamaño ~8 MB: ' + first.size);
  const again = await fetchFixture(PATHS[0]);
  assert.equal(again.sha256, first.sha256, 'bytes idénticos entre dos peticiones con la misma semilla');
  assert.equal(again.size, first.size);
  fixtures.set(PATHS[0], first);

  // Las 30: tamaños y sha256 (la caché del servidor es de 128 MB: las primeras semillas se expulsan).
  const t0 = Date.now();
  let slowest = first.ms;
  for (const p of PATHS.slice(1)) {
    const f = await fetchFixture(p);
    slowest = Math.max(slowest, f.ms);
    fixtures.set(p, f);
  }
  const hashes = new Set([...fixtures.values()].map((f) => f.sha256));
  assert.equal(hashes.size, N, 'las 30 semillas dan 30 PNG distintos');
  // seed=1 ya fue expulsada de la caché FIFO (30 × 8.4 MB > 128 MB): se regenera con los mismos bytes.
  const regenerated = await fetchFixture(PATHS[0]);
  assert.equal(regenerated.sha256, first.sha256, 'seed=1 regenerada tras la expulsión: mismos bytes');
  const sum = [...fixtures.values()].reduce((n, f) => n + f.size, 0);
  t.diagnostic('fixtures: ' + N + ' PNG, suma ' + sum + ' B (' + (sum / 1048576).toFixed(1) + ' MiB), ' +
    'primera respuesta ' + first.ms + ' ms, más lenta ' + slowest + ' ms, las 30 en ' + (Date.now() - t0 + first.ms) + ' ms');
});

test('ZIP de 30 × 8 MB: w/h reales sin NEEDS_CONFIRM, regla DNR de Referer solo durante los fetch, un solo .zip completo por blob URL, tamaño exacto, unzip -t, zipfile + sha256 por entrada, fases, limpieza, RSS < 2 × ZIP, < 90 s y offscreen cerrado', async (t) => {
  if (!ENABLED) return t.skip(SKIP_MSG);
  const testStart = Date.now();
  assert.equal(fixtures.size, N, 'el test del servidor dejó los 30 fixtures medidos');
  const sumBytes = [...fixtures.values()].reduce((n, f) => n + f.size, 0);

  env = await H.launch();
  page = await env.context.newPage();
  // ~250 MB de imágenes: no se espera a 'load'.
  await page.goto(srv.origin + '/pages/large.html', { waitUntil: 'domcontentloaded' });
  // Convenciones del fixture en el DOM (fuera de fixtures-pages.test.js): caja 300×200 por width/height
  // antes de cargar, kind http e ids n1..n30 con la ruta esperada.
  const dom = await page.evaluate(() => [...document.querySelectorAll('[data-expect]')].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.id, tag: el.tagName, w: r.width, h: r.height, kind: el.dataset.expectKind, expect: el.dataset.expect };
  }));
  assert.deepEqual(dom, PATHS.map((p, i) => ({ id: 'n' + (i + 1), tag: 'IMG', w: IMG_W, h: IMG_H, kind: 'http', expect: p })));
  tabId = await H.tabIdOf(env.sw, page);
  assert.equal(await H.activate(env.sw, tabId), true, 'activación');
  await H.waitFor(async () => { const s = await state(); return s && s.barState ? s : null; }, 10000, 100, 'controlador inyectado');

  const n = await sw(({ tabId, paths }) => self.__imgdlTest.selectExpect(tabId, paths), { tabId, paths: PATHS });
  assert.equal(n, N, 'selectExpect en el marco principal');
  const items = await H.waitFor(async () => {
    const g = await gather();
    return g.length === N ? g : null;
  }, 10000, 100, '30 seleccionadas');
  assert.deepEqual(items.map((i) => i.url).sort(), PATHS.map((p) => srv.origin + p).sort());
  assert.ok(items.every((i) => i.kind === 'http'), JSON.stringify(items.map((i) => i.kind)));
  // w/h reales: el hook pasa el rect en la forma {x,y,w,h} de resolve.rectOf (un DOMRect daba NaN, que
  // executeScript descartaba, y jobs.estimateBytes sumaba 0). Estimación = 30 × 300×200 × 0.5 B ≈ 0.9 MB.
  assert.deepEqual(items.map((i) => [i.w, i.h]), PATHS.map(() => [IMG_W, IMG_H]), 'w/h de cada ref');
  const est = await sw(({ items, n, w, h }) => {
    const J = self.ImgDL.jobs;
    const forced = items.map((i) => Object.assign({}, i, { w: 10000, h: 10000 }));
    return {
      bytes: J.estimateBytes(items),
      same: J.estimateBytes(Array.from({ length: n }, () => ({ w, h }))),
      confirm: J.needsConfirm(items, false),
      forcedBytes: J.estimateBytes(forced),
      forced: J.needsConfirm(forced, false),
      forcedBig: J.needsConfirm(forced, true)
    };
  }, { items, n: N, w: IMG_W, h: IMG_H });
  assert.ok(est.bytes > 0 && est.bytes < DEFAULTS.zipSoftBytes, 'estimación ' + est.bytes + ' B, por debajo de zipSoftBytes');
  assert.equal(est.bytes, est.same, 'estimación = la de 30 refs de 300×200');
  assert.equal(est.confirm, null, 'sin NEEDS_CONFIRM: 30 ≤ zipSoftFiles y ~0.9 MB ≤ zipSoftBytes');
  // Con una estimación forzada por encima de zipSoftBytes (30 × 10000² × 0.5 B ≈ 1.4 GiB) sí pide
  // confirmación con WARN_BIG; confirmBig la salta.
  assert.ok(est.forcedBytes > DEFAULTS.zipSoftBytes, 'estimación forzada ' + est.forcedBytes);
  assert.deepEqual(est.forced, {
    ok: false, code: 'NEEDS_CONFIRM', total: N, estimatedBytes: est.forcedBytes,
    text: S.WARN_BIG(N, Math.round(est.forcedBytes / (1024 * 1024)))
  });
  assert.equal(est.forcedBig, null, 'confirmBig salta el tope blando');

  const beforeDone = (await lastJobDone()).length;
  const dlBefore = (await lastDownloads()).length;
  assert.deepEqual(await searchDownloads(), [], 'estantería vacía antes del trabajo');
  const gated = await sw(() => self.__imgdlTest.refererRules());
  assert.deepEqual(await sessionRules(), [], 'sin reglas DNR de sesión antes del trabajo');
  assert.deepEqual(await liveRefererRules(), []);

  const rssSampler = startRssSampler();
  const ruleSampler = startRuleSampler();
  const t0 = Date.now();
  // Sin confirmBig: la estimación real (30 archivos, ~0.9 MB) queda bajo el tope blando.
  const r = await runZip({});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.total, N);
  const done = await H.waitFor(async () => (await lastJobDone()).find((j) => j.jobId === r.jobId), JOB_TIMEOUT_MS, 250, 'job-done ' + r.jobId);
  const rules = await ruleSampler.stop();
  const wallMs = done.at - t0;
  assert.equal(done.ok, true, JSON.stringify(Object.assign({}, done, { failures: done.failures })));
  assert.equal(done.kind, 'zip');
  assert.equal(done.done, N);
  assert.equal(done.failed, 0);
  assert.deepEqual(done.failures, []);
  assert.equal(done.text, S.SUMMARY_ZIP(N, N, 0));
  assert.equal((await lastJobDone()).length, beforeDone + 1, 'un solo job-done');

  // Regla DNR de Referer (paso 11, downloads-d3): vista durante los fetch del offscreen, acotada a la
  // extensión (initiatorDomains), al host del servidor (requestDomains) y a xmlhttprequest, con el
  // Referer de la página; retirada al llegar off:zip-ready, antes del job-done.
  if (gated) {
    assert.ok(rules.first, 'alguna de las ' + rules.samples + ' muestras vio la regla de sesión durante el trabajo');
    assert.equal(rules.first.length, 1, JSON.stringify(rules.first));
    const rule = rules.first[0];
    assert.ok(Number.isInteger(rule.id) && rule.id >= RULE_ID_START, 'id de sesión ≥ ' + RULE_ID_START + ': ' + rule.id);
    assert.deepEqual(rule.condition.initiatorDomains, [env.extId], 'solo fetch iniciados por la propia extensión');
    assert.deepEqual(rule.condition.requestDomains, [new URL(srv.origin).hostname], 'solo el host del servidor');
    assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest']);
    assert.equal(rule.action.type, 'modifyHeaders');
    assert.deepEqual(rule.action.requestHeaders, [{ header: 'Referer', operation: 'set', value: page.url() }]);
    assert.deepEqual(rules.liveFirst, [rule.id], 'liveRefererRules() lleva el mismo id');
    t.diagnostic('regla DNR ' + rule.id + ' vista en ' + rules.samples + ' muestras: ' + JSON.stringify(rule.condition));
  } else {
    t.diagnostic('declarativeNetRequest no disponible: compuerta del Referer cerrada, sin regla que comprobar');
  }
  assert.deepEqual(await sessionRules(), [], 'ninguna regla DNR de sesión tras el job-done');
  assert.deepEqual(await liveRefererRules(), []);

  // Exactamente una descarga: la URL blob del offscreen, completa.
  const item = await H.waitForDownload(env.sw, (it) => it.filename === done.zipFilename, 60000);
  const rss = rssSampler.stop();
  assert.equal(item.state, 'complete', JSON.stringify(item));
  assert.match(item.url, /^blob:chrome-extension:\/\//);
  assert.equal(item.mime, 'application/zip', JSON.stringify(item));
  // El nombre .zip va en las opciones de download(); en disco Playwright guarda la descarga con un GUID.
  const opts = (await lastDownloads()).slice(dlBefore);
  assert.equal(opts.length, 1, 'una sola llamada a download(): ' + JSON.stringify(opts.map((o) => o.filename)));
  assert.match(opts[0].url, /^blob:chrome-extension:\/\//);
  assert.match(opts[0].filename, /\.zip$/, opts[0].filename);
  const all = await searchDownloads();
  const blobs = all.filter((it) => /^blob:/.test(it.url));
  assert.equal(blobs.length, 1, 'una sola descarga blob en la estantería: ' + JSON.stringify(all.map((it) => [it.url, it.filename, it.state])));
  assert.equal(blobs[0].id, item.id);
  assert.equal(all.length, 1, 'ninguna otra descarga');
  assert.equal(all[0].state, 'complete');

  // Limpieza tras completar la descarga (downloads-c2 / zip-c1): la URL blob vivió hasta 'complete' y
  // ahora se revoca; el offscreen sigue abierto (el cierre ocioso llega offscreenIdleMs después) pero sin
  // trabajos, fetch ni blobs; el refcount vuelve a 0 y no quedan descargas pendientes.
  assert.equal(await offscreenContexts(), 1, 'offscreen aún abierto justo tras la descarga');
  const clean = await H.waitFor(async () => {
    const st = await offscreenStatus();
    const refcount = await offscreenRefcount();
    return st && st.ok && st.blobUrls === 0 && refcount === 0 ? { st, refcount } : null;
  }, 5000, 100, 'blob URL del ZIP revocada y refcount 0');
  assert.deepEqual(clean.st, { ok: true, jobs: 0, stashed: 0, fetches: 0, blobUrls: 0 }, 'offscreen sin trabajos, fetch ni blob URLs');
  assert.equal(clean.refcount, 0);
  assert.deepEqual(await pending(), {}, 'sin descargas pendientes');

  // Tamaño exacto del STORE: suma de los 30 fixtures + 30 × (30 + 46) + nombres × 2 + 22.
  const size = fs.statSync(item.filename).size;
  assert.equal(size, item.fileSize, 'fileSize de chrome.downloads');
  assert.ok(size > N * MB * 1000000, 'más de ' + N * MB + ' MB: ' + size);
  const z = inspectZip(item.filename);
  assert.equal(z.test, null, 'zipfile.testzip() → None');
  assert.equal(z.entries.length, N, JSON.stringify(z.entries.map((e) => [e.name, e.size])));
  const nameBytes = z.entries.reduce((n, e) => n + Buffer.byteLength(e.name, 'utf8'), 0);
  const expected = sumBytes + N * (LOCAL_HEADER + CENTRAL_HEADER) + nameBytes * 2 + EOCD;
  assert.equal(size, expected, 'tamaño STORE exacto (suma ' + sumBytes + ' + cabeceras)');

  // Cada entrada es un fixture intacto (sha256 y tamaño), STORE, nombre único .png.
  const names = z.entries.map((e) => e.name);
  assert.equal(new Set(names).size, N, 'nombres únicos: ' + names.join(', '));
  assert.ok(names.every((x) => /\.png$/.test(x)), names.join(', '));
  assert.ok(z.entries.every((e) => e.compress === 0), 'todas las entradas STORE');
  const want = new Map([...fixtures.values()].map((f) => [f.sha256, f.size]));
  for (const e of z.entries) {
    assert.ok(want.has(e.sha256), 'sha256 de ' + e.name + ' no coincide con ningún fixture');
    assert.equal(e.size, want.get(e.sha256), 'tamaño de ' + e.name);
    want.delete(e.sha256);
  }
  assert.equal(want.size, 0, 'los 30 fixtures están en el ZIP');
  const listing = H.listZip(item.filename);
  assert.equal(listing.ok, true, 'unzip -t: No errors detected');
  assert.equal(listing.names.length, N, listing.names.join(', '));

  // Fases del progreso (al menos fetching y saving) y tiempos.
  const prog = (await lastProgress()).filter((p) => p.jobId === r.jobId);
  const phases = [...new Set(prog.map((p) => p.phase))];
  assert.ok(phases.includes('fetching'), 'fase fetching: ' + phases.join(','));
  assert.ok(phases.includes('saving'), 'fase saving: ' + phases.join(','));
  // El progreso se acota a progressThrottleMs: el último 'fetching' puede no decir 30/30; 'saving' sí
  // (y lleva en bytes el tamaño del ZIP).
  const lastFetch = prog.filter((p) => p.phase === 'fetching').pop();
  assert.ok(lastFetch.done <= N && lastFetch.failed === 0 && lastFetch.total === N, JSON.stringify(lastFetch));
  const saving = prog.filter((p) => p.phase === 'saving').pop();
  assert.equal(saving.done, N, JSON.stringify(saving));
  assert.equal(saving.failed, 0);
  assert.equal(saving.total, N);
  assert.equal(saving.bytes, size, 'bytes del aviso saving = tamaño del ZIP');
  const span = (ph) => {
    const xs = prog.filter((p) => p.phase === ph);
    return xs.length ? { first: xs[0].at, last: xs[xs.length - 1].at, n: xs.length } : null;
  };
  const f = span('fetching');
  const zp = span('zipping');
  const sv = span('saving');
  const fetchMs = f.last - t0;
  const zipMs = zp ? zp.last - f.last : 0;
  const saveMs = done.at - (zp ? zp.last : f.last);
  const dlMs = Date.now() - done.at;
  t.diagnostic('ZIP: ' + item.filename + ' = ' + size + ' B (' + (size / 1048576).toFixed(1) + ' MiB) con ' + N + ' entradas: ' + names.slice(0, 3).join(', ') + ' … ' + names[N - 1]);
  t.diagnostic('fases: ' + phases.join(' → ') + ' | fetching ' + fetchMs + ' ms (' + f.n + ' avisos) · zipping ' + zipMs + ' ms (' +
    (zp ? zp.n : 0) + ' avisos) · saving→job-done ' + saveMs + ' ms (' + (sv ? sv.n : 0) + ' avisos) · job-done→descarga completa ≤ ' + dlMs + ' ms | total hasta job-done ' + wallMs + ' ms');
  // Presupuesto documentado (plan paso 10 / spec paso 8), aparte de la cota dura del waitFor.
  assert.ok(wallMs < BUDGET_MS, 'job-done en < ' + BUDGET_MS + ' ms: ' + wallMs + ' ms');
  // zip-d1: el ZIP se arma con los Blob como partes (sin segunda copia en el heap): el RSS extra del
  // árbol durante el trabajo queda por debajo de 2 × el tamaño del ZIP (lo medido: +100…300 MiB).
  const nodeRss = process.memoryUsage().rss / 1048576;
  const extraMiB = rss ? rss.peakMiB - rss.baseMiB : null;
  t.diagnostic('RSS: node ' + nodeRss.toFixed(0) + ' MiB; Chromium (árbol, pid ' + (rss ? rss.pid : '?') + ') ' +
    (rss ? 'base ' + rss.baseMiB.toFixed(0) + ' MiB → pico ' + rss.peakMiB.toFixed(0) + ' MiB (+' + extraMiB.toFixed(0) + ' MiB) en ' +
      rss.procs + ' procesos (' + rss.samples + ' muestras)' : 'no medido'));
  if (rss) {
    assert.ok(rss.samples >= 3, 'muestras de RSS: ' + rss.samples);
    assert.ok(extraMiB < 2 * size / 1048576, 'RSS extra < 2 × tamaño del ZIP (zip-d1): +' + extraMiB.toFixed(0) + ' MiB');
  } else {
    t.diagnostic('ps no disponible: RSS no medido');
  }

  // Tras ok: selección limpiada, sin trabajos y offscreen cerrado por inactividad.
  await H.waitFor(async () => (await gather()).length === 0, 5000, 100, 'selección limpiada');
  assert.deepEqual(await sw(() => self.__imgdlTest.jobs()), {});
  const tClose = Date.now();
  await H.waitFor(async () => (await offscreenContexts()) === 0, DEFAULTS.offscreenIdleMs + 5000, 250, 'offscreen cerrado tras el ZIP');
  t.diagnostic('offscreen cerrado ' + (Date.now() - tClose) + ' ms después (umbral offscreenIdleMs ' + DEFAULTS.offscreenIdleMs + ' ms)');
  const totalMs = Date.now() - testStart;
  t.diagnostic('test completo en ' + totalMs + ' ms');
  assert.ok(totalMs < BUDGET_MS, 'test completo en < ' + BUDGET_MS + ' ms: ' + totalMs + ' ms');
});
