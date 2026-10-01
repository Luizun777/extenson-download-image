'use strict';
// Detección con la extensión real (hover → chip → descarga por clic): cada objetivo
// [data-expect] de las páginas de fixtures produce hoverKey = kind|URL y un chip dentro
// de su esquina superior derecha; píxeles y spacers nunca se ofrecen; el chip se
// mantiene al pasar sobre él, se oculta en el vacío y al hacer scroll (y vuelve);
// el clic en la celda de descarga completa una descarga PNG con el nombre planeado.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');
const names = require('../../lib/names.js');
const urls = require('../../lib/urls.js');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const CHIP_W = 66;
const CHIP_H = 34;
const INSET = 4;

let srv;
let env;
let page;

async function open(name) {
  await page.goto(srv.origin + '/pages/' + name + '.html', { waitUntil: 'load' });
  // Las imágenes deben estar cargadas (natural conocido) antes de medir nada.
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

// Objetivos del DOM claro: {id, expect, kind, key}.
async function targets() {
  const list = await page.evaluate(() => [...document.querySelectorAll('[data-expect]')].map((el) => ({
    id: el.id, expect: el.dataset.expect, kind: el.dataset.expectKind
  })));
  return list.map((t) => Object.assign(t, { key: t.kind + '|' + srv.origin + t.expect }));
}

function rectOf(id) {
  return page.evaluate((id) => {
    const b = document.getElementById(id).getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, id);
}

// Desplaza el objetivo a la vista y mueve el ratón a su centro.
async function hover(id) {
  await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'center', inline: 'center' }), id);
  const r = await rectOf(id);
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2);
  return r;
}

// Espera hoverKey === key con chip visible y devuelve el estado.
function waitHover(tabId, key, label) {
  return H.waitFor(async () => {
    const st = await state(tabId);
    return st && st.hoverKey === key && st.chipRect ? st : null;
  }, 3000, 40, label);
}

// Chip dentro de la imagen, pegado (4 px) a su esquina superior derecha.
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
  const cells = st.chipCells;
  assert.ok(cells && cells.select && cells.download, 'celdas: ' + JSON.stringify(cells));
  assert.ok(cells.download.x > cells.select.x, 'descargar a la derecha de seleccionar');
}

// Cada [data-expect] de la página: hoverKey esperado + chip en su sitio.
async function checkAllTargets(tabId) {
  const list = await targets();
  assert.ok(list.length > 0, 'página sin objetivos');
  for (const t of list) {
    await hover(t.id);
    const st = await waitHover(tabId, t.key, 'hover #' + t.id);
    assert.equal(st.hoverUrl, srv.origin + t.expect, '#' + t.id + ' hoverUrl');
    await assertChipInside(st, t.id);
  }
  return list;
}

// Clic real en la celda de descarga del chip del objetivo → descarga completa + PNG.
async function downloadByChip(tabId, t, expectName) {
  await hover(t.id);
  const st = await waitHover(tabId, t.key, 'hover #' + t.id);
  const url = srv.origin + t.expect;
  const before = (await env.sw.evaluate(() => self.__imgdlTest.lastDownloads())).length;
  const c = st.chipCells.download;
  await page.mouse.click(c.x + c.w / 2, c.y + c.h / 2);
  const item = await H.waitForDownload(env.sw, (it) => it.url === url);
  assert.equal(item.state, 'complete', JSON.stringify(item));
  assert.deepEqual(H.readFile(item.filename).subarray(0, 4), PNG_MAGIC, 'bytes PNG de #' + t.id);
  const last = await env.sw.evaluate(() => self.__imgdlTest.lastDownloads());
  assert.equal(last.length, before + 1, 'una sola llamada a downloads.download');
  const folder = names.buildPaths({ folder: 'Imagenes', host: urls.hostOf(page.url()), stamp: 'S' }).single;
  assert.deepEqual(last[last.length - 1], { url, filename: folder + '/' + expectName, conflictAction: 'uniquify', saveAs: false });
  // Aviso STATUS_DONE del SW → toast en este frame.
  await H.waitFor(async () => (await state(tabId)).toasts.some((x) => /^Descargada: /.test(x)), 3000, 50, 'toast Descargada');
  return { item, last: last[last.length - 1] };
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

test('basic.html: las 10 imágenes (incl. #far con scroll) dan hoverKey y chip; #g1 se descarga por clic', async (t) => {
  const tabId = await open('basic');
  const list = await checkAllTargets(tabId);
  assert.ok(list.some((x) => x.id === 'far'), '#far entre los objetivos');
  const g1 = list.find((x) => x.id === 'g1');
  const r = await downloadByChip(tabId, g1, 'g1.png');
  t.diagnostic('descarga por chip: ' + r.last.filename + ' → ' + r.item.filename);
  await deactivate(tabId);
});

test('basic.html: píxel 1x1 y spacer 16x16 estirado nunca se ofrecen', async () => {
  const tabId = await open('basic');
  for (const id of ['pixel', 'spacer']) {
    await hover(id);
    await H.sleep(400); // > chipDelayMs: si fuese a aparecer, ya habría aparecido
    const st = await state(tabId);
    assert.equal(st.hoverKey, null, '#' + id + ' hoverKey');
    assert.equal(st.chipRect, null, '#' + id + ' chip');
  }
  await deactivate(tabId);
});

test('basic.html: el chip se mantiene al pasar sobre él, se oculta en el vacío y con scroll se oculta y vuelve', async (t) => {
  const tabId = await open('basic');
  const list = await targets();
  const g1 = list.find((x) => x.id === 'g1');
  await hover('g1');
  let st = await waitHover(tabId, g1.key, 'hover #g1');

  // 1) Sobre el chip: hoverKey y chip intactos (elementFromPoint ve nuestro host).
  const c = st.chipRect;
  await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2);
  await H.sleep(300);
  st = await state(tabId);
  assert.equal(st.hoverKey, g1.key, 'hoverKey sobre el chip');
  assert.deepEqual(st.chipRect, c, 'chip inmóvil sobre el chip');
  assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y).tagName, [c.x + c.w / 2, c.y + c.h / 2]), 'IMGDL-ROOT');

  // 2) Vacío (cabecera h1): sin objetivo ni chip.
  await page.mouse.move(640, 14);
  await H.waitFor(async () => {
    const s = await state(tabId);
    return s.hoverKey === null && s.chipRect === null;
  }, 2000, 30, 'vacío');

  // 3) Scroll con el puntero sobre #g1: el chip se oculta (scrollHides cuenta cada
  //    ocultación: en headless el scroll de rueda es instantáneo y scroll+scrollend
  //    llegan en el mismo ms, así que el estado oculto no es observable desde fuera)
  //    y vuelve sobre el mismo objetivo en su nueva posición.
  const r = await hover('g1');
  st = await waitHover(tabId, g1.key, 'hover #g1 de nuevo');
  const chipBefore = st.chipRect;
  const hidesBefore = st.scrollHides;
  const DY = 24; // la parte superior de #g1 sigue en el viewport: el chip no se recorta
  await page.mouse.wheel(0, DY);
  const back = await H.waitFor(async () => {
    const s = await state(tabId);
    return s.scrollHides > hidesBefore && s.hoverKey === g1.key && s.chipRect && Math.abs((chipBefore.y - s.chipRect.y) - DY) <= 1.5 ? s : null;
  }, 3000, 30, 'chip oculto por el scroll y de vuelta en la nueva posición');
  const r2 = await rectOf('g1');
  assert.ok(Math.abs((r.y - r2.y) - DY) <= 1.5, 'la página se desplazó ' + DY + ' px: ' + JSON.stringify([r, r2]));
  await assertChipInside(back, 'g1');
  assert.equal(back.dirty, false, 'tras el re-hit-test el rect vuelve a valer');
  t.diagnostic(`scroll: chip ${JSON.stringify(chipBefore)} → ${JSON.stringify(back.chipRect)}; ocultaciones ${hidesBefore} → ${back.scrollHides}; scrollend soportado: ${await page.evaluate(() => 'onscrollend' in window)}`);
  await deactivate(tabId);
});

test('basic.html: contenido insertado encima (sin scroll ni resize) mueve la imagen: el objetivo obsoleto se descarta y el chip no queda huérfano', async () => {
  const tabId = await open('basic');
  const list = await targets();
  const g1 = list.find((x) => x.id === 'g1');
  const r = await hover('g1');
  let st = await waitHover(tabId, g1.key, 'hover #g1');
  const chipBefore = st.chipRect;

  // La página antepone un bloque de 320 px (banner, feed que inserta arriba): #g1 baja sin scroll.
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'banner';
    d.style.cssText = 'height:320px;background:#fc0';
    document.body.prepend(d);
  });
  const r2 = await rectOf('g1');
  assert.ok(r2.y - r.y >= 300, 'la imagen bajó: ' + JSON.stringify([r, r2]));
  assert.equal(await page.evaluate(() => scrollY), 0, 'sin scroll');

  // Un movimiento mínimo del puntero (sigue sobre el banner) basta: el rect releído no
  // coincide con el cacheado, se repite el hit-test y el banner no es una imagen.
  const p = [r.x + r.w / 2 + 3, r.y + r.h / 2 + 3];
  assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y).id, p), 'banner');
  await page.mouse.move(p[0], p[1]);
  await H.waitFor(async () => {
    const s = await state(tabId);
    return s.hoverKey === null && s.chipRect === null;
  }, 2000, 30, 'objetivo obsoleto descartado y chip oculto');

  // En su nueva posición #g1 vuelve a ofrecerse con el chip en su esquina.
  await page.mouse.move(r2.x + r2.w / 2, r2.y + r2.h / 2);
  st = await waitHover(tabId, g1.key, 'hover #g1 en la nueva posición');
  await assertChipInside(st, 'g1');
  assert.ok(st.chipRect.y - chipBefore.y >= 300, 'chip en la nueva posición: ' + JSON.stringify([chipBefore, st.chipRect]));
  await deactivate(tabId);
});

test('basic.html: un contenedor con scroll continuo ajeno al objetivo (ticker) no oculta el chip ni cuenta como scroll', async (t) => {
  const tabId = await open('basic');
  const list = await targets();
  const g1 = list.find((x) => x.id === 'g1');
  // Caja fija arriba a la derecha, lejos de #g1, cuyo scrollTop avanza cada 50 ms.
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'ticker';
    box.style.cssText = 'position:fixed;right:10px;top:10px;width:200px;height:100px;overflow:auto;background:#eee';
    const inner = document.createElement('div');
    inner.style.cssText = 'height:4000px';
    box.append(inner);
    document.body.append(box);
    let y = 0;
    window.__tick = setInterval(() => { y = (y + 5) % 3800; box.scrollTop = y; }, 50);
  });
  await hover('g1');
  let st = await waitHover(tabId, g1.key, 'hover #g1 con ticker');
  const hides = st.scrollHides;
  const chip = st.chipRect;
  let samples = 0;
  let withChip = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) {
    const s = await state(tabId);
    samples++;
    if (s.hoverKey === g1.key && s.chipRect) withChip++;
    await H.sleep(40);
  }
  st = await state(tabId);
  await page.evaluate(() => clearInterval(window.__tick));
  assert.ok(samples >= 10, 'muestras: ' + samples);
  assert.equal(withChip, samples, `chip visible en todas las muestras (${withChip}/${samples})`);
  assert.equal(st.scrollHides, hides, 'el scroll ajeno no oculta el chip');
  assert.deepEqual(st.chipRect, chip, 'chip inmóvil');
  t.diagnostic(`ticker: ${withChip}/${samples} muestras con chip; scrollHides ${hides} → ${st.scrollHides}`);
  await deactivate(tabId);
});

test('basic.html: sobre un toast FUERA del rect de la imagen el objetivo se conserva (KEEP vía isPointerOnUi) y en el vacío contiguo se limpia', async () => {
  const tabId = await open('basic');
  const list = await targets();
  const far = list.find((x) => x.id === 'far');
  // downloadByChip deja el toast "Descargada: far.png" abajo a la derecha, sobre el relleno
  // vacío (con #far centrado en el viewport su rect queda arriba a la izquierda).
  await downloadByChip(tabId, far, 'far.png');
  const r = await rectOf('far');
  const vp = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
  const onToast = [vp.w - 16 - 20, vp.h - 16 - 15];
  assert.ok(onToast[0] > r.x + r.w + 8 && onToast[1] > r.y + r.h + 8, 'el toast queda fuera del rect de #far (+8): ' + JSON.stringify({ r, onToast }));
  assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y).tagName, onToast), 'IMGDL-ROOT', 'toast bajo el puntero');
  const before = await state(tabId);
  assert.equal(before.hoverKey, far.key);
  assert.ok(before.chipRect);

  await page.mouse.move(onToast[0], onToast[1]);
  await H.sleep(300);
  let st = await state(tabId);
  assert.equal(st.hoverKey, far.key, 'hoverKey conservado sobre el toast');
  assert.deepEqual(st.chipRect, before.chipRect, 'chip conservado sobre el toast');

  // Vacío (relleno) 70 px por encima del toast: fuera de la UI y sin imagen -> se limpia.
  const empty = [onToast[0], onToast[1] - 70];
  assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y).className, empty), 'filler');
  await page.mouse.move(empty[0], empty[1]);
  await H.waitFor(async () => {
    const s = await state(tabId);
    return s.hoverKey === null && s.chipRect === null;
  }, 2000, 30, 'vacío junto al toast');
  await deactivate(tabId);
});

test('overlay.html: imagen bajo overlay transparente, pointer-events:none bajo overlay y spacer opacity:0 encima', async () => {
  const tabId = await open('overlay');
  const list = await checkAllTargets(tabId);
  assert.deepEqual(list.map((x) => x.id).sort(), ['covered', 'pen', 'photo']);
  await deactivate(tabId);
});

test('pointer-events-none.html: imagen grande con pointer-events:none (fallback geométrico)', async () => {
  const tabId = await open('pointer-events-none');
  const list = await checkAllTargets(tabId);
  assert.deepEqual(list.map((x) => x.id), ['pen']);
  await deactivate(tabId);
});

test('spacer.html: fotos bajo spacer 16x16 y bajo gif data: 1x1 estirados', async () => {
  const tabId = await open('spacer');
  const list = await checkAllTargets(tabId);
  assert.deepEqual(list.map((x) => x.id).sort(), ['photo', 'photo2']);
  await deactivate(tabId);
});

test('lazy.html: data-src, data-srcset 800w, <picture> webp y srcset con comas de CDN; #lazy-srcset se descarga', async () => {
  const tabId = await open('lazy');
  const list = await checkAllTargets(tabId);
  assert.deepEqual(list.map((x) => x.id).sort(), ['cdn', 'lazy-src', 'lazy-srcset', 'pic-img']);
  await downloadByChip(tabId, list.find((x) => x.id === 'lazy-srcset'), 'ls.png');
  await deactivate(tabId);
});

test('background.html: url(), image-set 2x, ::before content:url() y ::after background; #bg se descarga', async () => {
  const tabId = await open('background');
  const list = await checkAllTargets(tabId);
  assert.deepEqual(list.map((x) => x.id).sort(), ['after', 'before', 'bg', 'bg-set']);
  await downloadByChip(tabId, list.find((x) => x.id === 'bg'), 'bg.png');
  await deactivate(tabId);
});

test('shadow.html: shadow abierto, CERRADO (chrome.dom) y anidado; la imagen del shadow cerrado se descarga', async () => {
  const tabId = await open('shadow');
  const list = await checkAllTargets(tabId);
  assert.deepEqual(list.map((x) => x.id).sort(), ['closed-host', 'nested-host', 'open-host']);
  await downloadByChip(tabId, list.find((x) => x.id === 'closed-host'), 'closed.png');
  await deactivate(tabId);
});

test('desactivar limpia el hover: hoverKey y chip nulos', async () => {
  const tabId = await open('basic');
  const list = await targets();
  await hover('g2');
  await waitHover(tabId, list.find((x) => x.id === 'g2').key, 'hover #g2');
  await deactivate(tabId);
  const st = await state(tabId);
  assert.equal(st.active, false);
  assert.equal(st.hoverKey, null);
  assert.equal(st.chipRect, null);
  assert.equal(await page.evaluate(() => document.querySelector('imgdl-root')), null);
});
