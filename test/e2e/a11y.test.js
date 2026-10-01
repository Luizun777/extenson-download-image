'use strict';
// Accesibilidad del overlay (paso 9) con la extensión real sobre basic.html: aria-labels
// en español en todos los controles, barra role=toolbar con el patrón APG (una sola
// parada de Tab, ←/→/Inicio/Fin entre sus botones), región aria-live con el recuento,
// barra alcanzable con Tab desde el final de la página (Enter en 'Limpiar' vacía la
// selección, Esc con el foco en la barra desactiva), chip fuera del orden de Tab sin
// hover y retenido mientras tiene el foco aunque el puntero se vaya, y chip visible y
// clicable con forced-colors + prefers-reduced-motion emulados (la descarga termina).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');
const S = require('../../lib/strings.js');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const g = (n) => '/img/g' + n + '.png?w=400&h=300';

let srv;
let env;
let page;
let tabId;

function state() {
  return H.state(env.sw, tabId);
}

function keyOf(p) {
  return 'http|' + srv.origin + p;
}

function rectOf(id) {
  return page.evaluate((id) => {
    const el = document.getElementById(id);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, id);
}

async function hover(id, key) {
  const r = await rectOf(id);
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2);
  return H.waitFor(async () => {
    const st = await state();
    return st && st.hoverKey === key && st.chipRect && st.chipCells ? st : null;
  }, 4000, 40, 'hover #' + id);
}

async function selectViaChip(id, key) {
  const st = await hover(id, key);
  await H.clickChip(page, st, 'select');
  return st;
}

function waitCount(n, label) {
  return H.waitFor(async () => {
    const st = await state();
    return st && st.selectionCount === n ? st : null;
  }, 4000, 40, label || 'selectionCount ' + n);
}

async function maxDownloadId() {
  const items = await env.sw.evaluate(() => chrome.downloads.search({}));
  return items.reduce((m, it) => Math.max(m, it.id), 0);
}

async function openBasic() {
  await page.goto(srv.origin + '/pages/basic.html', { waitUntil: 'load' });
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  tabId = await H.tabIdOf(env.sw, page);
  assert.equal(await H.activate(env.sw, tabId), true, 'activación');
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

test('aria-labels en español, barra role=toolbar y región aria-live con "2 seleccionadas"', async (t) => {
  await openBasic();
  await selectViaChip('g1', keyOf(g(1)));
  await waitCount(1);
  await selectViaChip('g2', keyOf(g(2)));
  let st = await waitCount(2);
  assert.equal(st.chipLabel, S.CHIP_GROUP, 'chip role=group con aria-label');
  assert.equal(st.barLabel, S.BAR_LABEL, 'barra con aria-label');
  assert.ok(Array.isArray(st.controlLabels) && st.controlLabels.length >= 8, 'controles: ' + JSON.stringify(st.controlLabels));
  assert.ok(st.controlLabels.every((l) => typeof l === 'string' && l.length > 0), 'todos con aria-label: ' + JSON.stringify(st.controlLabels));
  for (const l of [S.CHIP_SELECT, S.CHIP_DOWNLOAD, S.BAR_CLEAR, S.BAR_FILES(2), S.BAR_ZIP(2), S.BAR_CANCEL, S.BAR_EXIT, S.BAR_CONTINUE]) {
    assert.ok(st.controlLabels.includes(l), 'falta la etiqueta ' + l + ' en ' + JSON.stringify(st.controlLabels));
  }
  // Todas las etiquetas salen de ImgDL.strings (ninguna literal).
  const known = new Set([S.CHIP_SELECT, S.CHIP_DOWNLOAD, S.BAR_CLEAR, S.BAR_FILES(2), S.BAR_ZIP(2), S.BAR_CANCEL, S.BAR_EXIT, S.BAR_CONTINUE, S.COPY_URL]);
  for (const l of st.controlLabels) assert.ok(known.has(l), 'etiqueta ajena a strings.js: ' + l);
  // Región aria-live: tras seleccionar 2, anuncia exactamente BAR_SELECTED(2).
  st = await H.waitFor(async () => {
    const s = await state();
    return s && s.liveText === S.BAR_SELECTED(2) ? s : null;
  }, 3000, 40, 'liveText = ' + S.BAR_SELECTED(2));
  assert.equal(st.liveText, S.BAR_SELECTED(2));
  t.diagnostic('controles: ' + JSON.stringify(st.controlLabels) + '; live: ' + JSON.stringify(st.liveText));
  await env.sw.evaluate((id) => self.__imgdlTest.setActive(id, false), tabId);
});

test('teclado: Tab desde el final de la página llega a "Limpiar", Enter vacía la selección y Esc con el foco en la barra desactiva', async (t) => {
  await openBasic();
  await selectViaChip('g1', keyOf(g(1)));
  await waitCount(1);
  await selectViaChip('g2', keyOf(g(2)));
  await waitCount(2);
  // Puntero fuera de toda imagen (chip oculto) y punto de partida de la navegación
  // secuencial al final del documento (clic en el relleno inferior de la página).
  await page.mouse.move(640, 4);
  await H.waitFor(async () => !(await state()).chipRect, 2000, 40, 'chip oculto');
  const bottom = await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); return { y: window.innerHeight - 8 }; });
  await page.mouse.click(8, bottom.y);
  let presses = 0;
  const st = await H.waitFor(async () => {
    const s = await state();
    if (s && s.activeControl === S.BAR_CLEAR) return s;
    if (presses >= 12) return null;
    presses++;
    await page.keyboard.press('Tab');
    return null;
  }, 6000, 30, 'foco en Limpiar con Tab');
  t.diagnostic('Tab hasta Limpiar: ' + presses + ' pulsación(es); control activo ' + JSON.stringify(st.activeControl));
  assert.equal(st.activeControl, S.BAR_CLEAR);
  assert.equal(st.selectionCount, 2);

  await page.keyboard.press('Enter');
  const cleared = await waitCount(0, 'Enter en Limpiar → 0');
  assert.ok(cleared.barRect, 'la barra sigue visible');
  assert.equal(cleared.activeControl, S.BAR_CLEAR, 'el foco sigue en Limpiar');
  assert.deepEqual(await env.sw.evaluate((id) => self.__imgdlTest.gather(id), tabId), []);
  await H.waitFor(async () => (await state()).liveText === S.BAR_SELECTED(0), 3000, 40, 'anuncio 0 seleccionadas');

  await page.keyboard.press('Escape');
  const off = await H.waitFor(async () => {
    const s = await state();
    return s && s.active === false ? s : null;
  }, 4000, 40, 'Esc con el foco en la barra desactiva');
  assert.equal(off.barRect, null);
  assert.equal(await H.badge(env.sw, tabId), '');
  assert.equal(await env.sw.evaluate((id) => self.__imgdlTest.getActive(id), tabId), false);
});

// Tab hasta que el control activo sea `label` (máximo `max` pulsaciones); devuelve la
// secuencia de controles activos vistos.
async function tabUntil(label, max) {
  const seq = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const s = await state();
    seq.push(s.activeControl);
    if (s.activeControl === label) return { st: s, seq };
  }
  return { st: await state(), seq };
}

test('toolbar (APG): sin hover el chip no está en el orden de Tab; la barra es una sola parada y ←/→/Inicio/Fin recorren sus botones', async (t) => {
  await openBasic();
  await selectViaChip('g1', keyOf(g(1)));
  await waitCount(1);
  await selectViaChip('g2', keyOf(g(2)));
  await waitCount(2);
  await page.mouse.move(640, 4);
  await H.waitFor(async () => !(await state()).chipRect, 2000, 40, 'chip oculto');
  const bottom = await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); return { y: window.innerHeight - 8 }; });
  await page.mouse.click(8, bottom.y);
  const { st, seq } = await tabUntil(S.BAR_CLEAR, 12);
  assert.equal(st.activeControl, S.BAR_CLEAR, 'Tab llega a Limpiar: ' + JSON.stringify(seq));
  // El chip (oculto sin hover) no apareció en la secuencia.
  assert.ok(!seq.includes(S.CHIP_SELECT) && !seq.includes(S.CHIP_DOWNLOAD), 'chip fuera del orden de Tab: ' + JSON.stringify(seq));
  assert.equal(st.barRole, 'toolbar');
  assert.deepEqual(st.barTabStops, [S.BAR_CLEAR], 'una sola parada de Tab (tabindex itinerante)');
  // Flechas entre los botones operativos (Cancelar y Continuar están ocultos).
  const press = async (key) => { await page.keyboard.press(key); return (await state()).activeControl; };
  assert.equal(await press('ArrowRight'), S.BAR_FILES(2));
  assert.equal(await press('ArrowRight'), S.BAR_ZIP(2));
  assert.equal(await press('ArrowRight'), S.BAR_EXIT);
  assert.equal(await press('ArrowRight'), S.BAR_CLEAR, 'da la vuelta');
  assert.equal(await press('ArrowLeft'), S.BAR_EXIT, 'da la vuelta hacia atrás');
  assert.equal(await press('Home'), S.BAR_CLEAR);
  assert.equal(await press('End'), S.BAR_EXIT);
  assert.deepEqual((await state()).barTabStops, [S.BAR_EXIT], 'la parada sigue al foco');
  // Tab desde dentro sale de la barra (no recorre el resto de botones).
  await page.keyboard.press('Tab');
  const out = await state();
  assert.ok(![S.BAR_CLEAR, S.BAR_FILES(2), S.BAR_ZIP(2), S.BAR_EXIT].includes(out.activeControl), 'Tab sale de la barra: ' + JSON.stringify(out.activeControl));
  assert.equal(out.selectionCount, 2, 'las flechas no activan nada');
  t.diagnostic('secuencia hasta Limpiar: ' + JSON.stringify(seq) + '; tras Tab: ' + JSON.stringify(out.activeControl));
  await env.sw.evaluate((id) => self.__imgdlTest.setActive(id, false), tabId);
});

test('chip con el foco: Tab tras el hover entra en el chip, que no desaparece al irse el puntero; al salir el foco se oculta', async (t) => {
  await openBasic();
  const key3 = keyOf(g(3));
  let st = await hover('g3', key3);
  // Punto de partida de la navegación secuencial: la propia imagen (clic fuera del chip).
  await page.mouse.click(st.chipRect.x - 60, st.chipRect.y + 60);
  st = await hover('g3', key3);
  let reached = null;
  for (let i = 0; i < 12 && !reached; i++) {
    await page.keyboard.press('Tab');
    const s = await state();
    if (s.activeControl === S.CHIP_SELECT || s.activeControl === S.CHIP_DOWNLOAD) reached = s;
  }
  assert.ok(reached, 'Tab entra en el chip mientras hay hover');
  assert.equal(reached.activeControl, S.CHIP_SELECT, 'primera celda: seleccionar');
  // El puntero se va: el chip y el objetivo se conservan mientras el foco siga dentro.
  await page.mouse.move(640, 4);
  await H.sleep(400);
  const held = await state();
  assert.ok(held.chipRect, 'chip retenido con el foco dentro');
  assert.equal(held.hoverKey, key3, 'objetivo retenido');
  assert.equal(held.activeControl, S.CHIP_SELECT, 'el foco sigue en el chip');
  // Sigue operativo: Espacio selecciona la imagen retenida.
  await page.keyboard.press('Space');
  const sel = await waitCount(1, 'Espacio en el chip retenido selecciona');
  assert.equal(sel.chipChecked, true);
  assert.deepEqual(sel.badges, [key3]);
  // Tab: a la celda de descarga (sigue dentro) y otro Tab sale del chip → se oculta.
  await page.keyboard.press('Tab');
  assert.equal((await state()).activeControl, S.CHIP_DOWNLOAD);
  assert.ok((await state()).chipRect, 'sigue visible dentro del chip');
  await page.keyboard.press('Tab');
  const gone = await H.waitFor(async () => {
    const s = await state();
    return s && !s.chipRect && s.hoverKey === null ? s : null;
  }, 3000, 40, 'chip oculto al salir el foco');
  assert.ok(gone.activeControl !== S.CHIP_SELECT && gone.activeControl !== S.CHIP_DOWNLOAD, 'el foco ya no está en el chip: ' + JSON.stringify(gone.activeControl));
  assert.equal(gone.selectionCount, 1, 'la selección se conserva');
  t.diagnostic('control tras salir del chip: ' + JSON.stringify(gone.activeControl));
  await env.sw.evaluate((id) => self.__imgdlTest.setActive(id, false), tabId);
});

test('forced-colors + prefers-reduced-motion: el chip sigue visible y clicable (la descarga termina)', async (t) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  try {
    await openBasic();
    const media = await page.evaluate(() => ({
      forced: matchMedia('(forced-colors: active)').matches,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches
    }));
    assert.deepEqual(media, { forced: true, reduced: true }, 'emulación activa en la página');
    const since = await maxDownloadId();
    const st = await hover('g3', keyOf(g(3)));
    assert.ok(st.chipRect.w > 0 && st.chipRect.h > 0, 'chip visible: ' + JSON.stringify(st.chipRect));
    await H.clickChip(page, st, 'download');
    await page.mouse.move(640, 4);
    const item = await H.waitForDownload(env.sw, (it) => it.id > since);
    assert.equal(item.state, 'complete', JSON.stringify(item));
    assert.deepEqual(H.readFile(item.filename).subarray(0, 4), PNG_MAGIC);
    const last = (await env.sw.evaluate(() => self.__imgdlTest.lastDownloads())).pop();
    assert.equal(last.url, srv.origin + g(3));
    t.diagnostic('descarga en forced-colors: ' + last.filename);
    // Seleccionar con el chip en alto contraste también funciona (checkbox nativo).
    await selectViaChip('g4', keyOf(g(4)));
    const sel = await waitCount(1);
    assert.equal(sel.chipChecked, true);
    assert.equal(sel.badgeCount, 1);
    await env.sw.evaluate((id) => self.__imgdlTest.setActive(id, false), tabId);
  } finally {
    await page.emulateMedia({ forcedColors: null, reducedMotion: null });
  }
});
