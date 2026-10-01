'use strict';
// Selección con la extensión real (paso 4): checkbox del chip → selección por
// clave, badges, barra del marco principal (recuento, 'Limpiar'), gather del SW;
// tipos byte en special.html (canvas limpio → PNG, canvas contaminado → toast
// ERR_TAINTED_CANVAS sin seleccionar, svg con <symbol> externo, blob: viva → PNG)
// materializados vía imgdl:materialize; spa.html: la selección sobrevive a la
// recreación de nodos y el nodo nuevo se re-vincula (checkbox marcado). Barra del
// marco principal: doble clic en 'Descargar archivos' → un solo trabajo; progress y
// job-done de otro jobId no la tocan; 'Cancelar' de un trabajo que el SW no conoce la
// deja en reposo con toast; recuento de marco desfasado → EMPTY lo descarta.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');
const S = require('../../lib/strings.js');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let srv;
let env;
let page;

async function open(name) {
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

function rectOf(id) {
  return page.evaluate((id) => {
    const b = document.getElementById(id).getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, id);
}

async function hover(id) {
  await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'center', inline: 'center' }), id);
  const r = await rectOf(id);
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2);
  return r;
}

// Espera chip visible con hoverKey que cumpla `match` (string exacto o predicado).
function waitHover(tabId, match, label) {
  const ok = typeof match === 'function' ? match : (k) => k === match;
  return H.waitFor(async () => {
    const st = await state(tabId);
    return st && st.hoverKey && ok(st.hoverKey) && st.chipRect ? st : null;
  }, 3000, 40, label);
}

// Clic real en la celda [seleccionar] del chip del objetivo.
async function clickSelect(tabId, id, match) {
  await hover(id);
  const st = await waitHover(tabId, match, 'hover #' + id);
  const c = st.chipCells.select;
  await page.mouse.click(c.x + c.w / 2, c.y + c.h / 2);
  return st;
}

function waitCount(tabId, n, label) {
  return H.waitFor(async () => {
    const st = await state(tabId);
    return st && st.selectionCount === n ? st : null;
  }, 3000, 40, label || 'selectionCount ' + n);
}

function gather(tabId) {
  return env.sw.evaluate((id) => self.__imgdlTest.gather(id), tabId);
}

// imgdl:materialize {id} al marco: por el hook del SW si existe, si no directo.
function materialize(tabId, frameId, id) {
  return env.sw.evaluate(async ({ tabId, frameId, id }) => {
    const t = self.__imgdlTest;
    if (t && typeof t.materialize === 'function') return t.materialize(tabId, frameId, id);
    if (self.ImgDL && self.ImgDL.jobs && typeof self.ImgDL.jobs.materializeOne === 'function') return self.ImgDL.jobs.materializeOne(tabId, frameId, id);
    return chrome.tabs.sendMessage(tabId, { type: 'imgdl:materialize', id }, { frameId });
  }, { tabId, frameId, id });
}

function decodeDataUrl(dataUrl) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  assert.ok(m, 'data URL válida: ' + String(dataUrl).slice(0, 40));
  return { mime: m[1], bytes: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])) };
}

const keyOf = (expect) => 'http|' + srv.origin + expect;

// Mensaje del SW al marco principal (como lo harían jobs.js / tabs.js).
function sendTop(tabId, msg) {
  return env.sw.evaluate(({ tabId, msg }) => chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }), { tabId, msg });
}

function lastJobDone() {
  return env.sw.evaluate(() => self.__imgdlTest.lastJobDone());
}

function lastDownloads() {
  return env.sw.evaluate(() => self.__imgdlTest.lastDownloads());
}

// Rect de un botón de la barra (clear|files|zip|cancel|exit|confirm) visible y habilitado.
async function barButton(tabId, name) {
  const st = await H.waitFor(async () => {
    const s = await state(tabId);
    const b = s && s.barState && s.barState.buttons ? s.barState.buttons[name] : null;
    return b && !s.barState.disabled[name] ? s : null;
  }, 5000, 40, 'botón de la barra ' + name);
  return st.barState.buttons[name];
}

function waitTop(tabId, pred, label) {
  return H.waitFor(async () => {
    const s = await state(tabId);
    return s && pred(s) ? s : null;
  }, 5000, 40, label);
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

test('basic.html: tres por checkbox → 3 badges y barra; una menos → 2; Limpiar → 0; gather devuelve las refs', async () => {
  const tabId = await open('basic');
  const g = (n) => '/img/g' + n + '.png?w=400&h=300';

  for (let i = 1; i <= 3; i++) {
    await clickSelect(tabId, 'g' + i, keyOf(g(i)));
    const st = await waitCount(tabId, i);
    assert.equal(st.chipChecked, true, '#g' + i + ' checkbox marcado tras seleccionar');
  }
  let st = await state(tabId);
  assert.equal(st.selectionCount, 3);
  assert.equal(st.selectionTotal, 3);
  assert.equal(st.badgeCount, 3, 'badges: ' + JSON.stringify(st.badges));
  assert.deepEqual(st.badges.sort(), [keyOf(g(1)), keyOf(g(2)), keyOf(g(3))]);
  assert.ok(st.barRect, 'barra visible');
  assert.equal(st.barState.visible, true);
  assert.equal(st.barState.labels.files, S.BAR_FILES(3));
  assert.equal(st.barState.labels.zip, S.BAR_ZIP(3));
  assert.equal(st.barState.labels.count, S.BAR_SELECTED(3));
  assert.ok(st.barState.text.includes('Descargar archivos (3)') && st.barState.text.includes('Descargar ZIP (3)'), st.barState.text);
  assert.equal(st.barState.buttons.cancel, null, 'Cancelar oculto sin trabajo');
  assert.equal(st.barState.buttons.confirm, null, 'Continuar oculto sin confirmación');
  assert.deepEqual(st.barState.disabled, { clear: false, files: false, zip: false, cancel: false, exit: false, confirm: false });

  // gather del SW: las tres refs (http) con sus claves.
  const items = await gather(tabId);
  assert.deepEqual(items.map((it) => it.key).sort(), [keyOf(g(1)), keyOf(g(2)), keyOf(g(3))]);
  for (const it of items) {
    assert.equal(it.kind, 'http');
    assert.equal(it.frameId, 0);
    assert.equal(typeof it.id, 'number');
    assert.ok(/^g[123]/.test(it.name), it.name);
  }

  // Volver a hacer clic en #g2 → desmarcada → 2.
  await clickSelect(tabId, 'g2', keyOf(g(2)));
  st = await waitCount(tabId, 2);
  assert.equal(st.chipChecked, false, '#g2 desmarcada');
  assert.equal(st.badgeCount, 2);
  assert.equal(st.barState.labels.files, S.BAR_FILES(2));

  // 'Limpiar' (clic real en el botón de la barra) → 0 y barra con 0.
  const clear = st.barState.buttons.clear;
  assert.ok(clear, 'botón Limpiar');
  assert.equal(st.barState.labels.clear, S.BAR_CLEAR);
  await page.mouse.click(clear.x + clear.w / 2, clear.y + clear.h / 2);
  st = await waitCount(tabId, 0, 'Limpiar → 0');
  assert.equal(st.badgeCount, 0);
  assert.equal(st.selectionTotal, 0);
  assert.ok(st.barRect, 'la barra sigue visible tras Limpiar');
  assert.equal(st.barState.labels.count, S.BAR_SELECTED(0));
  assert.equal(st.barState.labels.files, S.BAR_FILES(0));
  assert.equal(st.barState.disabled.files, true, 'sin selección no se puede descargar');
  assert.deepEqual(await gather(tabId), []);

  await deactivate(tabId);
  const off = await state(tabId);
  assert.equal(off.selectionCount, 0);
  assert.equal(off.barRect, null);
});

test('special.html: canvas → PNG, canvas contaminado → toast y no se selecciona, svg con <symbol>, blob: viva → PNG', async () => {
  const tabId = await open('special');
  await page.waitForFunction(() => {
    const live = document.getElementById('blob-live');
    const t = document.getElementById('canvas-tainted');
    return live.complete && live.naturalWidth > 0 && t.dataset.tainted === '1';
  });

  // canvas limpio.
  await clickSelect(tabId, 'canvas2d', (k) => k.startsWith('canvas|'));
  let st = await waitCount(tabId, 1);
  assert.equal(st.chipChecked, true);
  let items = await gather(tabId);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'canvas');
  assert.ok(!('dataUrl' in items[0]) && !('blob' in items[0]), 'collectSelection solo refs');
  let r = await materialize(tabId, 0, items[0].id);
  assert.equal(r.id, items[0].id);
  assert.ok(typeof r.dataUrl === 'string' && r.dataUrl.startsWith('data:image/png;base64,'), JSON.stringify(r).slice(0, 120));
  assert.equal(r.mime, 'image/png');
  assert.equal(r.ext, 'png');
  let d = decodeDataUrl(r.dataUrl);
  assert.deepEqual(d.bytes.subarray(0, 4), PNG_MAGIC, 'PNG del canvas');
  assert.ok(d.bytes.length > 100, 'PNG no vacío');

  // canvas contaminado: toast ERR_TAINTED_CANVAS y sigue 1 seleccionada.
  await clickSelect(tabId, 'canvas-tainted', (k) => k.startsWith('canvas|'));
  await H.waitFor(async () => (await state(tabId)).toasts.includes(S.ERR_TAINTED_CANVAS), 3000, 50, 'toast lienzo protegido');
  st = await H.waitFor(async () => {
    const s = await state(tabId);
    return s.selectionCount === 1 && s.chipChecked === false ? s : null;
  }, 3000, 40, 'contaminado no seleccionado');
  assert.equal(st.badgeCount, 1);
  items = await gather(tabId);
  assert.equal(items.length, 1, 'solo el canvas limpio');

  // svg inline con <use href="#sym"> definido fuera: la exportación incluye el <symbol>.
  await clickSelect(tabId, 'svg', (k) => k.startsWith('svg|'));
  await waitCount(tabId, 2);
  items = await gather(tabId);
  const svg = items.find((it) => it.kind === 'svg');
  assert.ok(svg, 'ref svg en gather');
  r = await materialize(tabId, 0, svg.id);
  assert.ok(typeof r.dataUrl === 'string' && r.dataUrl.startsWith('data:image/svg+xml'), JSON.stringify(r).slice(0, 120));
  assert.equal(r.ext, 'svg');
  d = decodeDataUrl(r.dataUrl);
  const xml = d.bytes.toString('utf8');
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), xml.slice(0, 60));
  assert.ok(xml.includes('<symbol'), 'symbol inlinado');
  assert.ok(xml.includes('id="sym"'), 'id del symbol');
  assert.ok(/<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(xml), 'xmlns');
  assert.ok(xml.includes('href="#sym"'), 'el <use> sigue apuntando al symbol');

  // blob: viva → bytes PNG.
  await clickSelect(tabId, 'blob-live', (k) => k.startsWith('blob|'));
  await waitCount(tabId, 3);
  items = await gather(tabId);
  const blob = items.find((it) => it.kind === 'blob');
  assert.ok(blob && /^blob:/.test(blob.url), 'ref blob con url blob:');
  r = await materialize(tabId, 0, blob.id);
  assert.ok(typeof r.dataUrl === 'string' && r.dataUrl.startsWith('data:image/png;base64,'), JSON.stringify(r).slice(0, 120));
  assert.equal(r.ext, 'png');
  d = decodeDataUrl(r.dataUrl);
  assert.deepEqual(d.bytes.subarray(0, 4), PNG_MAGIC, 'PNG de la blob:');

  // Un id desconocido o una ref http no se materializan.
  r = await materialize(tabId, 0, 999999);
  assert.equal(r.id, 999999);
  assert.equal(typeof r.code, 'string');
  assert.equal(r.text, S.ERR_GENERIC);

  await deactivate(tabId);
});

test('spa.html: la selección sobrevive a la recreación de nodos y el nodo nuevo se re-vincula', async () => {
  const tabId = await open('spa');
  const key = keyOf('/img/v0.png?w=300&h=200');
  await clickSelect(tabId, 'v0', key);
  let st = await waitCount(tabId, 1);
  assert.equal(st.badgeCount, 1);

  // Fuera de la ventana virtual (~100 filas): #v0 desaparece del DOM.
  await page.mouse.move(640, 14);
  await page.evaluate(() => window.scrollTo(0, 100 * 220));
  await page.waitForFunction(() => !document.getElementById('v0'));
  await H.waitFor(async () => {
    const s = await state(tabId);
    return s.selectionCount === 1 && s.badges.length === 0 ? s : null;
  }, 3000, 40, 'sin badge visible fuera de vista');
  assert.deepEqual((await gather(tabId)).map((it) => it.key), [key], 'sigue seleccionada por clave');

  // De vuelta: nodo recreado (otra identidad); al pasar el ratón el checkbox está marcado.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => !!document.getElementById('v0'));
  await hover('v0');
  st = await waitHover(tabId, key, 'hover #v0 recreado');
  assert.equal(st.selectionCount, 1);
  assert.equal(st.chipChecked, true, 'checkbox marcado en el nodo recreado (rebind)');
  st = await H.waitFor(async () => {
    const s = await state(tabId);
    return s.badges.length === 1 ? s : null;
  }, 3000, 40, 'badge sobre el nodo nuevo');
  assert.equal(st.badgeCount, 1);

  // Desmarcar en el nodo nuevo → 0.
  await clickSelect(tabId, 'v0', key);
  st = await waitCount(tabId, 0);
  assert.equal(st.chipChecked, false);
  await deactivate(tabId);
});

test('basic.html: doble clic en Descargar archivos (3) lanza un solo trabajo: 1 job-done y 3 descargas, barra en reposo y selección vacía', async () => {
  const tabId = await open('basic');
  const g = (n) => '/img/g' + n + '.png?w=400&h=300';
  for (let i = 1; i <= 3; i++) {
    await clickSelect(tabId, 'g' + i, keyOf(g(i)));
    await waitCount(tabId, i);
  }
  await page.mouse.move(640, 4);
  const files = await barButton(tabId, 'files');
  const before = (await lastJobDone()).length;
  const dlBefore = (await lastDownloads()).length;

  // Dos clics seguidos: el segundo llega con la petición en vuelo o el trabajo ya en marcha.
  await page.mouse.click(files.x + files.w / 2, files.y + files.h / 2);
  await page.mouse.click(files.x + files.w / 2, files.y + files.h / 2);
  await page.mouse.move(640, 4);
  const log = await H.waitFor(async () => {
    const l = await lastJobDone();
    return l.length > before ? l : null;
  }, 20000, 50, 'job-done del lote');
  await H.sleep(1500); // margen para un hipotético segundo trabajo
  const after = await lastJobDone();
  const ids = after.slice(before).map((j) => j.jobId);
  assert.equal(after.length - before, 1, 'un solo job-done: ' + JSON.stringify(ids));
  const done = log[log.length - 1];
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.done, 3);
  assert.equal(done.failed, 0);
  const dls = (await lastDownloads()).slice(dlBefore);
  assert.equal(dls.length, 3, 'tres descargas, no seis: ' + JSON.stringify(dls.map((d) => d.filename)));
  assert.equal(new Set(dls.map((d) => d.filename)).size, 3, 'nombres distintos');

  const st = await waitTop(tabId, (s) => !s.jobRunning && !s.barState.requesting && s.selectionCount === 0, 'barra en reposo tras el lote');
  assert.equal(st.jobId, null);
  assert.equal(st.barState.buttons.cancel, null, 'Cancelar oculto');
  assert.equal(st.barState.disabled.clear, false);
  assert.equal(st.barState.labels.files, S.BAR_FILES(0));
  await deactivate(tabId);
});

test('basic.html: progress/job-done de otro jobId no tocan la barra; Cancelar de un trabajo que el SW no conoce la deja en reposo con toast y conserva la selección', async () => {
  const tabId = await open('basic');
  const key = keyOf('/img/g1.png?w=400&h=300');
  await clickSelect(tabId, 'g1', key);
  await waitCount(tabId, 1);
  await page.mouse.move(640, 4);

  // Trabajo A (simulado): la barra lo adopta.
  await sendTop(tabId, { type: 'imgdl:progress', jobId: 'job-A', phase: 'files', done: 1, total: 3 });
  let st = await waitTop(tabId, (s) => s.jobRunning && s.jobId === 'job-A', 'barra con job-A');
  assert.equal(st.progressText, S.PROGRESS_FILES(1, 3));
  assert.ok(st.barState.buttons.cancel, 'Cancelar visible');
  assert.equal(st.barState.disabled.files, true);
  assert.equal(st.barState.disabled.clear, true);

  // Trabajo B (ajeno): ni su progreso ni su job-done cambian nada.
  await sendTop(tabId, { type: 'imgdl:progress', jobId: 'job-B', phase: 'files', done: 2, total: 9 });
  await sendTop(tabId, { type: 'imgdl:job-done', jobId: 'job-B', ok: true, done: 9, failed: 0, failures: [], text: S.SUMMARY_FILES(9, 0) });
  await H.sleep(300);
  st = await state(tabId);
  assert.equal(st.jobRunning, true, 'sigue en marcha');
  assert.equal(st.jobId, 'job-A');
  assert.equal(st.progressText, S.PROGRESS_FILES(1, 3), 'progreso de A intacto');
  assert.equal(st.selectionCount, 1, 'el job-done ajeno no limpia la selección');
  assert.ok(!st.toasts.includes(S.SUMMARY_FILES(9, 0)), 'sin toast del trabajo ajeno: ' + JSON.stringify(st.toasts));

  // Cancelar: el SW responde {ok:false} (no conoce job-A) → barra en reposo + toast.
  const cancel = st.barState.buttons.cancel;
  await page.mouse.click(cancel.x + cancel.w / 2, cancel.y + cancel.h / 2);
  await page.mouse.move(640, 4);
  st = await waitTop(tabId, (s) => !s.jobRunning && s.toasts.includes(S.ERR_GENERIC), 'Cancelar → reposo con toast');
  assert.equal(st.jobId, null);
  assert.equal(st.progressText, '');
  assert.equal(st.barState.buttons.cancel, null, 'Cancelar oculto');
  assert.equal(st.barState.disabled.files, false, 'descargar habilitado');
  assert.equal(st.barState.disabled.clear, false, 'Limpiar habilitado');
  assert.equal(st.selectionCount, 1, 'la selección se conserva');
  assert.equal(st.barState.labels.files, S.BAR_FILES(1));

  // Tras el reposo, el job-done tardío de A ya no resucita nada raro: se adopta y limpia.
  await sendTop(tabId, { type: 'imgdl:job-done', jobId: 'job-A', ok: true, done: 3, failed: 0, failures: [], text: S.SUMMARY_FILES(3, 0) });
  st = await waitTop(tabId, (s) => s.selectionCount === 0 && !s.jobRunning, 'job-done tardío → selección vacía');
  await deactivate(tabId);
});

test('basic.html: recuento de un marco desfasado → el SW responde EMPTY: toast propio, recuento a 0 y botones deshabilitados', async () => {
  const tabId = await open('basic');
  // Un marco (77) que ya no existe dejó su recuento en el principal.
  await sendTop(tabId, { type: 'imgdl:frame-count', frameId: 77, count: 2 });
  let st = await waitTop(tabId, (s) => s.selectionTotal === 2 && s.barRect, 'barra con recuento ajeno');
  assert.deepEqual(st.frameCounts, { 77: 2 });
  assert.equal(st.barState.labels.files, S.BAR_FILES(2));
  assert.equal(st.barState.disabled.files, false);
  assert.deepEqual(await gather(tabId), [], 'gather vacío: el recuento miente');

  const files = await barButton(tabId, 'files');
  await page.mouse.click(files.x + files.w / 2, files.y + files.h / 2);
  await page.mouse.move(640, 4);
  st = await waitTop(tabId, (s) => s.toasts.includes(S.ERR_EMPTY_SELECTION), 'toast de selección vacía');
  assert.ok(!st.toasts.includes(S.ERR_GENERIC), 'no el genérico: ' + JSON.stringify(st.toasts));
  assert.deepEqual(st.frameCounts, {}, 'recuento desfasado descartado');
  assert.equal(st.selectionTotal, 0);
  assert.equal(st.jobRunning, false);
  assert.equal(st.barState.requesting, false);
  assert.equal(st.barState.labels.files, S.BAR_FILES(0));
  assert.equal(st.barState.disabled.files, true, 'sin selección no se puede descargar');
  assert.equal(st.barState.disabled.zip, true);
  await deactivate(tabId);
});
