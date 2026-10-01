'use strict';
// Ayudas de Playwright (API de librería) para node --test: Chromium headless con la
// extensión cargada, acceso al service worker y a los hooks __imgdlTest.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const EXT_DIR = path.resolve(__dirname, '..', '..');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Espera (sondeo) a que fn() devuelva un valor truthy; lanza al agotar el tiempo.
async function waitFor(fn, timeoutMs = 5000, intervalMs = 50, label = 'waitFor') {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() >= deadline) throw new Error(`${label}: tiempo agotado (${timeoutMs} ms); último valor: ${JSON.stringify(last)}`);
    await sleep(intervalMs);
  }
}

function rmQuiet(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (_) {
      // Chrome puede soltar ficheros con retraso.
    }
  }
}

// Lanza Chromium headless con la extensión descomprimida. Playwright añade
// --disable-extensions por defecto: hay que ignorarlo explícitamente.
async function launch(opts = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdl-profile-'));
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdl-downloads-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--disable-extensions-except=' + EXT_DIR, '--load-extension=' + EXT_DIR],
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    viewport: { width: 1280, height: 720 },
    ...opts
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  async function close() {
    try { await context.close(); } catch (_) { /* ya cerrado */ }
    rmQuiet(userDataDir);
    rmQuiet(downloadsDir);
  }
  return { context, sw, extId, userDataDir, downloadsDir, close };
}

// tabId de una página: por URL exacta y, si hay varias pestañas con la misma URL
// o la URL no es visible para la extensión (chrome://…), por índice de pestaña
// (el orden de context.pages() coincide con el orden de creación de pestañas).
async function tabIdOf(sw, page) {
  const url = page.url();
  const index = page.context().pages().indexOf(page);
  const id = await sw.evaluate(async ({ url, index }) => {
    const all = await chrome.tabs.query({});
    const byUrl = all.filter((t) => t.url === url);
    if (byUrl.length === 1) return byUrl[0].id;
    const byIndex = (byUrl.length ? byUrl : all).find((t) => t.index === index);
    if (byIndex) return byIndex.id;
    return byUrl.length ? byUrl[0].id : null;
  }, { url, index });
  if (typeof id !== 'number') throw new Error('tabIdOf: no se encontró la pestaña de ' + url);
  return id;
}

function activate(sw, tabId) {
  return sw.evaluate((id) => self.__imgdlTest.toggle(id), tabId);
}

function badge(sw, tabId) {
  return sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
}

function title(sw, tabId) {
  return sw.evaluate((id) => chrome.action.getTitle({ tabId: id }), tabId);
}

// debugState() del controlador en un frame; null si no hay controlador o no se puede inyectar.
function state(sw, tabId, frameId = 0) {
  return sw.evaluate(async ({ tabId, frameId }) => {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: () => (globalThis.__imgdl ? globalThis.__imgdl.debugState() : null)
      });
      return r && r[0] && r[0].result !== undefined ? r[0].result : null;
    } catch (_) {
      return null;
    }
  }, { tabId, frameId });
}

// Clic real (ratón) sobre una celda del chip: [seleccionar 32][descargar 32].
async function clickChip(page, st, which = 'download') {
  const r = st && st.chipRect;
  if (!r) throw new Error('clickChip: sin chipRect en debugState');
  const w = r.width !== undefined ? r.width : r.w;
  const h = r.height !== undefined ? r.height : r.h;
  const cell = which === 'select' ? 0 : 1;
  const x = r.x + (w / 2) * (cell + 0.5);
  const y = r.y + h / 2;
  await page.mouse.click(x, y);
}

// Sondea chrome.downloads.search hasta que un ítem complete|interrupted cumpla predicate.
async function waitForDownload(sw, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let items = [];
  while (Date.now() < deadline) {
    items = await sw.evaluate(() => chrome.downloads.search({}));
    const hit = items.find((it) => (it.state === 'complete' || it.state === 'interrupted') && (!predicate || predicate(it)));
    if (hit) return hit;
    await sleep(100);
  }
  throw new Error('waitForDownload: tiempo agotado; ítems: ' + JSON.stringify(items));
}

function readFile(p) {
  return fs.readFileSync(p);
}

// Listado + verificación de integridad de un ZIP con las herramientas del sistema.
// Nombres con zipfile de Python (exactos en UTF-8: unzip -l en macOS escapa 'ñandú.png'
// como '+?and+?.png'); si no hay python3, se cae al listado de unzip -l. Devuelve
// además {name, size, head (4 primeros bytes), utf8 (bit 11)} por entrada en `entries`.
function listZip(zipPath) {
  const list = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  const test = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
  let names = list
    .split('\n')
    .slice(3, -3)
    .map((l) => l.replace(/^\s*\d+\s+\S+\s+\S+\s+/, '').trim())
    .filter(Boolean);
  let pyOk = null;
  let entries = null;
  try {
    const out = JSON.parse(execFileSync('python3', ['-c', [
      'import zipfile, sys, json',
      'z = zipfile.ZipFile(sys.argv[1])',
      'out = {"test": z.testzip(), "entries": []}',
      'for i in z.infolist():',
      '    d = z.read(i.filename)',
      '    text = d.decode("utf-8", "replace") if i.filename.lower().endswith((".txt", ".svg")) else None',
      '    out["entries"].append({"name": i.filename, "size": i.file_size, "utf8": bool(i.flag_bits & 0x800), "head": list(d[:4]), "text": text})',
      'print(json.dumps(out, ensure_ascii=False))'
    ].join('\n'), zipPath], { encoding: 'utf8' }));
    pyOk = out.test === null;
    entries = out.entries;
    names = entries.map((e) => e.name);
  } catch (_) {
    pyOk = null; // python3 no disponible: nombres de unzip -l
  }
  return { names, entries, ok: /No errors detected/.test(test), pyOk, raw: list };
}

function startFixtures() {
  return require('../fixtures/server.js').startServer();
}

module.exports = {
  launch,
  tabIdOf,
  activate,
  badge,
  title,
  state,
  clickChip,
  waitForDownload,
  readFile,
  listZip,
  startFixtures,
  waitFor,
  sleep,
  EXT_DIR
};
