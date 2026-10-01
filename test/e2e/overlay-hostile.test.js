'use strict';
// Overlay en páginas hostiles con la extensión real: CSP estricta (chip estilado,
// sin violaciones), reset global con !important, html{filter}+body{transform} con
// scroll de 3000 px, <dialog> modal (host dentro del diálogo, chip clicable, vuelta
// a <html>), host eliminado por la página (guardia) y HTML servido como .jpg
// (descarga descartada + toast ERR_HTML con "Copiar URL").
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');
const S = require('../../lib/strings.js');
const names = require('../../lib/names.js');
const urls = require('../../lib/urls.js');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const CHIP_W = 66;
const CHIP_H = 34;
const INSET = 4;

let srv;
let env;
let page;
let consoleLog; // mensajes de consola de la página actual

async function open(name) {
  consoleLog = [];
  await page.goto(srv.origin + '/pages/' + name + '.html', { waitUntil: 'load' });
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  const tabId = await H.tabIdOf(env.sw, page);
  assert.equal(await H.activate(env.sw, tabId), true, 'activación en ' + name);
  return tabId;
}

function deactivate(tabId) {
  return env.sw.evaluate((id) => self.__imgdlTest.setActive(id, false), tabId);
}

function state(tabId) {
  return H.state(env.sw, tabId);
}

function hostCount() {
  return page.evaluate(() => document.querySelectorAll('imgdl-root').length);
}

function keyFor(expect) {
  return 'http|' + srv.origin + expect;
}

function rectOf(id) {
  return page.evaluate((id) => {
    const b = document.getElementById(id).getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, id);
}

async function hover(id, scroll = true) {
  if (scroll) await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'center', inline: 'center' }), id);
  const r = await rectOf(id);
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2);
  return r;
}

function waitHover(tabId, key, label) {
  return H.waitFor(async () => {
    const st = await state(tabId);
    return st && st.hoverKey === key && st.chipRect ? st : null;
  }, 3000, 40, label);
}

async function assertChipInside(st, id) {
  const r = await rectOf(id);
  const c = st.chipRect;
  const msg = `#${id}: chip ${JSON.stringify(c)} vs rect ${JSON.stringify(r)}`;
  assert.ok(c, msg);
  assert.equal(Math.round(c.w), CHIP_W, msg);
  assert.equal(Math.round(c.h), CHIP_H, msg);
  assert.ok(c.x >= r.x - 1 && c.x + c.w <= r.x + r.w + 1, 'dentro en X: ' + msg);
  assert.ok(c.y >= r.y - 1 && c.y + c.h <= r.y + r.h + 1, 'dentro en Y: ' + msg);
  assert.ok(Math.abs((r.x + r.w) - (c.x + c.w) - INSET) <= 1.5, 'pegado al borde derecho: ' + msg);
  assert.ok(Math.abs(c.y - r.y - INSET) <= 1.5, 'pegado al borde superior: ' + msg);
}

// El elemento del documento bajo el centro del chip es nuestro host (shadow cerrado).
async function assertHostAtChip(st) {
  const c = st.chipRect;
  const tag = await page.evaluate(([x, y]) => (document.elementFromPoint(x, y) || {}).tagName, [c.x + c.w / 2, c.y + c.h / 2]);
  assert.equal(tag, 'IMGDL-ROOT');
}

async function clickDownload(st) {
  const c = st.chipCells.download;
  await page.mouse.click(c.x + c.w / 2, c.y + c.h / 2);
}

function folder() {
  return names.buildPaths({ folder: 'Imagenes', host: urls.hostOf(page.url()), stamp: 'S' }).single;
}

async function downloadByChip(tabId, id, expect, expectName) {
  await hover(id);
  const st = await waitHover(tabId, keyFor(expect), 'hover #' + id);
  await assertChipInside(st, id);
  const url = srv.origin + expect;
  await clickDownload(st);
  const item = await H.waitForDownload(env.sw, (it) => it.url === url);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  assert.deepEqual(H.readFile(item.filename).subarray(0, 4), PNG_MAGIC, 'bytes PNG de #' + id);
  const last = await env.sw.evaluate(() => self.__imgdlTest.lastDownloads());
  assert.deepEqual(last[last.length - 1], { url, filename: folder() + '/' + expectName, conflictAction: 'uniquify', saveAs: false });
  return item;
}

test.before(async () => {
  srv = await H.startFixtures();
  env = await H.launch();
  page = await env.context.newPage();
  page.on('console', (m) => { if (consoleLog) consoleLog.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => { if (consoleLog) consoleLog.push('pageerror: ' + e.message); });
});

test.after(async () => {
  if (env) await env.close();
  if (srv) await srv.close();
});

test('csp.html: chip presente y estilado bajo CSP estricta, host bajo el chip, sin violaciones en consola; descarga directa', async (t) => {
  const tabId = await open('csp');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.cspJs), 'ok', 'csp.js se ejecutó');
  for (const [id, expect] of [['c1', '/img/c1.png?w=300&h=300'], ['c2', '/img/c2.png?w=320&h=240']]) {
    await hover(id);
    const st = await waitHover(tabId, keyFor(expect), 'hover #' + id);
    await assertChipInside(st, id);
    await assertHostAtChip(st);
    assert.equal(st.popoverOpen, true, 'popover abierto (top layer)');
  }
  await downloadByChip(tabId, 'c1', '/img/c1.png?w=300&h=300', 'c1.png');
  await H.waitFor(async () => (await state(tabId)).toasts.some((x) => /^Descargada: /.test(x)), 3000, 50, 'toast Descargada bajo CSP');
  await H.sleep(200);
  const csp = consoleLog.filter((m) => /Content Security Policy|CSP violation/i.test(m));
  assert.deepEqual(csp, [], 'sin violaciones de CSP');
  t.diagnostic(`consola (${consoleLog.length}): ${JSON.stringify(consoleLog.slice(0, 5))}`);
  await deactivate(tabId);
});

test('reset.html: * {all:unset !important}, [popover] e imgdl-root ocultos: el chip sigue en su sitio', async () => {
  const tabId = await open('reset');
  for (const [id, expect] of [['r1', '/img/r1.png?w=300&h=300'], ['r2', '/img/r2.png?w=300&h=300']]) {
    await hover(id);
    const st = await waitHover(tabId, keyFor(expect), 'hover #' + id);
    await assertChipInside(st, id);
    await assertHostAtChip(st);
    assert.equal(st.hostMounted, true);
  }
  const hostBox = await page.evaluate(() => {
    const h = document.querySelector('imgdl-root');
    const cs = getComputedStyle(h);
    return { display: cs.display, position: cs.position };
  });
  assert.deepEqual(hostBox, { display: 'block', position: 'fixed' }, 'el host gana al reset de la página');
  await deactivate(tabId);
});

test('invert.html: html{filter} + body{transform} y scroll de ~3000 px: chipRect correcto (top layer)', async (t) => {
  const tabId = await open('invert');
  for (const [id, expect] of [['i1', '/img/i1.png?w=300&h=300'], ['i2', '/img/i2.png?w=300&h=300']]) {
    await hover(id);
    const st = await waitHover(tabId, keyFor(expect), 'hover #' + id);
    await assertChipInside(st, id);
    await assertHostAtChip(st);
  }
  const sy = await page.evaluate(() => scrollY);
  assert.ok(sy > 2500, 'scroll real: ' + sy);
  t.diagnostic('scrollY = ' + sy);
  await deactivate(tabId);
});

test('dialog.html: con el modal abierto el host vive en el <dialog>, el chip es clicable y descarga; al cerrar vuelve a <html>', async () => {
  const tabId = await open('dialog');
  // Fuera del diálogo, antes de abrirlo.
  await hover('outside');
  let st = await waitHover(tabId, keyFor('/img/d2.png?w=300&h=300'), 'hover #outside');
  assert.equal(st.hostParent, 'HTML');

  await page.click('#open');
  await page.waitForFunction(() => document.getElementById('dlg').matches(':modal'));
  await H.waitFor(async () => (await state(tabId)).hostParent === 'DIALOG', 2000, 30, 'host dentro del diálogo');

  await hover('in-dialog', false);
  st = await waitHover(tabId, keyFor('/img/d1.png?w=300&h=300'), 'hover #in-dialog');
  await assertChipInside(st, 'in-dialog');
  await assertHostAtChip(st);
  assert.equal(st.hostParent, 'DIALOG');
  await clickDownload(st);
  const url = srv.origin + '/img/d1.png?w=300&h=300';
  const item = await H.waitForDownload(env.sw, (it) => it.url === url);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  assert.deepEqual(H.readFile(item.filename).subarray(0, 4), PNG_MAGIC);
  const last = await env.sw.evaluate(() => self.__imgdlTest.lastDownloads());
  assert.equal(last[last.length - 1].filename, folder() + '/d1.png');
  assert.equal(await page.evaluate(() => document.getElementById('dlg').open), true, 'el clic en el chip no cerró el diálogo');

  await page.click('#close');
  await H.waitFor(async () => (await state(tabId)).hostParent === 'HTML', 2000, 30, 'host de vuelta bajo <html>');
  assert.equal(await hostCount(), 1);
  await hover('outside');
  st = await waitHover(tabId, keyFor('/img/d2.png?w=300&h=300'), 'hover #outside tras cerrar');
  await assertChipInside(st, 'outside');
  await deactivate(tabId);
});

test('la página elimina imgdl-root: la guardia lo repone en < 1 s y el hover sigue funcionando', async () => {
  const tabId = await open('basic');
  assert.equal(await hostCount(), 1);
  const t0 = Date.now();
  await page.evaluate(() => document.querySelector('imgdl-root').remove());
  await H.waitFor(async () => (await hostCount()) === 1, 1000, 20, 'host repuesto');
  const st0 = await state(tabId);
  assert.equal(st0.hostMounted, true);
  assert.equal(st0.popoverOpen, true, 'popover reabierto tras reponer el host');
  assert.ok(Date.now() - t0 < 1000);

  await hover('g1');
  const st = await waitHover(tabId, keyFor('/img/g1.png?w=400&h=300'), 'hover tras reponer');
  await assertChipInside(st, 'g1');
  await assertHostAtChip(st);
  await deactivate(tabId);
});

test('HTML servido como .jpg: el clic en el chip no deja archivo (descartado) y aparece un toast con "HTML"', async (t) => {
  const tabId = await open('basic');
  await page.evaluate(() => new Promise((resolve) => {
    const img = document.createElement('img');
    img.id = 'htmljpg';
    // Caja CSS explícita: una imagen rota con alt se pinta como texto en línea
    // (44x17) e ignora width/height como atributos; con CSS conserva los 300x300.
    img.style.cssText = 'display:block;width:300px;height:300px';
    img.alt = 'html';
    img.addEventListener('load', () => resolve('load'));
    img.addEventListener('error', () => resolve('error'));
    img.src = '/html-as-jpg.jpg';
    document.body.prepend(img);
  }));
  await hover('htmljpg');
  const url = srv.origin + '/html-as-jpg.jpg';
  const st = await waitHover(tabId, 'http|' + url, 'hover #htmljpg');
  await assertChipInside(st, 'htmljpg');
  await clickDownload(st);

  const n = await H.waitFor(async () => {
    const list = await env.sw.evaluate(() => self.__imgdlTest.lastNotify());
    return list.find((e) => e.msg.code === 'NOT_IMAGE' && e.msg.url === url);
  }, 10000, 100, 'aviso NOT_IMAGE');
  assert.equal(n.msg.text, S.ERR_HTML);
  assert.equal(n.msg.action, 'copy-url');
  assert.equal(n.delivered, true, 'el controlador recibió imgdl:notify');

  const toasts = await H.waitFor(async () => {
    const s = await state(tabId);
    return s.toasts.some((x) => /HTML/.test(x)) ? s.toasts : null;
  }, 3000, 50, 'toast HTML');
  assert.ok(toasts.includes(S.ERR_HTML), JSON.stringify(toasts));

  const items = await env.sw.evaluate((u) => chrome.downloads.search({ url: u }), url);
  assert.deepEqual(items, [], 'descarga borrada (erase)');
  const disc = (await env.sw.evaluate(() => self.__imgdlTest.lastDiscarded())).find((d) => d.url === url || d.mime === 'text/html');
  assert.ok(disc, 'registro de descartada');
  t.diagnostic('descartada: ' + JSON.stringify(disc) + '; toasts: ' + JSON.stringify(toasts));
  await deactivate(tabId);
});

test('canvas: el clic en el chip falla de forma síncrona (sin URL hasta el paso 4) y el usuario ve UN solo toast', async (t) => {
  const tabId = await open('basic');
  await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.id = 'cv';
    c.width = 300;
    c.height = 300;
    c.style.cssText = 'display:block;width:300px;height:300px;background:#8cf';
    document.body.prepend(c);
  });
  await hover('cv');
  const st = await H.waitFor(async () => {
    const s = await state(tabId);
    return s && /^canvas\|/.test(s.hoverKey || '') && s.chipRect ? s : null;
  }, 3000, 40, 'hover #cv');
  await assertChipInside(st, 'cv');
  await clickDownload(st);
  await H.waitFor(async () => (await state(tabId)).toasts.length > 0, 5000, 50, 'toast de error');
  await H.sleep(700); // margen para que llegue el segundo canal (imgdl:notify o respuesta al mensaje)
  const toasts = (await state(tabId)).toasts;
  assert.equal(toasts.length, 1, 'un solo toast: ' + JSON.stringify(toasts));
  assert.ok(typeof toasts[0] === 'string' && toasts[0].length > 0, 'texto no vacío');
  const notes = (await env.sw.evaluate(() => self.__imgdlTest.lastNotify())).slice(-2).map((e) => ({ code: e.msg.code, delivered: e.delivered }));
  t.diagnostic('toasts: ' + JSON.stringify(toasts) + '; últimos avisos: ' + JSON.stringify(notes));
  await deactivate(tabId);
});

test('documento SVG abierto directamente (image/svg+xml): toggle devuelve false sin error de página, sin host y el badge no queda en ON', async (t) => {
  consoleLog = [];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#4a4"/></svg>';
  await page.route('**/doc.svg', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }));
  try {
    await page.goto(srv.origin + '/doc.svg', { waitUntil: 'load' });
    assert.equal(await page.evaluate(() => document.contentType), 'image/svg+xml');
    assert.equal(await page.evaluate(() => document instanceof HTMLDocument), false);
    const tabId = await H.tabIdOf(env.sw, page);
    assert.equal(await H.activate(env.sw, tabId), false, 'toggle');
    await H.sleep(300);
    assert.equal(await page.evaluate(() => document.querySelectorAll('imgdl-root').length), 0, 'sin host');
    const st = await state(tabId);
    assert.ok(st === null || (st.active === false && st.hostMounted === false), JSON.stringify(st));
    const badge = await H.badge(env.sw, tabId);
    assert.notEqual(badge, 'ON');
    assert.deepEqual(consoleLog.filter((m) => /^pageerror/.test(m)), [], 'sin errores de página');
    // Un segundo toggle tampoco lanza ni monta nada.
    assert.equal(await H.activate(env.sw, tabId), false);
    assert.equal(await page.evaluate(() => document.querySelectorAll('imgdl-root').length), 0);
    t.diagnostic('badge tras toggle en documento SVG: ' + JSON.stringify(badge) + '; consola: ' + JSON.stringify(consoleLog.slice(0, 3)));
  } finally {
    await page.unroute('**/doc.svg');
  }
});
