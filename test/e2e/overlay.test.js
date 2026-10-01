'use strict';
// Overlay en aislamiento (sin extensión): Chromium plano + servidor de fixtures,
// módulos inyectados con addScriptTag en el orden de inyección y ImgDL.createOverlay
// manejado desde page.evaluate. Cubre: host/shadow cerrado/top layer, posición del
// chip (clamp), clics aislados de la página, CSS hostil (reset), filter/transform
// (invert), <dialog> modal, guardia del host, toasts, barra, badges y desmontaje.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('./harness.js');
const S = require('../../lib/strings.js');

const ROOT = path.resolve(__dirname, '..', '..');
const FILES = ['lib/strings.js', 'lib/thresholds.js', 'content/overlay.js'].map((f) => path.join(ROOT, f));
const CHIP_W = 66;
const CHIP_H = 34;

let srv;
let browser;
let page;

async function open(name) {
  await page.goto(srv.origin + '/pages/' + name, { waitUntil: 'load' });
  // Listeners de la página registrados ANTES de montar el overlay.
  await page.evaluate(() => {
    window.__pageClicks = 0;
    window.__pageKeys = [];
    document.addEventListener('click', () => { window.__pageClicks++; });
    document.addEventListener('mousedown', () => { window.__pageClicks += 100; });
    document.addEventListener('keydown', (e) => { window.__pageKeys.push(e.key); });
  });
  for (const f of FILES) await page.addScriptTag({ path: f });
}

// Crea el overlay con un AbortController real y callbacks que anotan en window.__calls.
function create(opts = {}) {
  return page.evaluate((o) => {
    window.__calls = [];
    const ac = new AbortController();
    window.__ac = ac;
    const names = ['onDownload', 'onToggleSelect', 'onClear', 'onFiles', 'onZip', 'onExit', 'onCancel', 'onConfirmBig'];
    const callbacks = {};
    for (const n of names) {
      const short = n[2].toLowerCase() + n.slice(3);
      callbacks[n] = (ref) => { window.__calls.push([short, ref && typeof ref === 'object' ? ref.key : null]); };
    }
    window.__ov = ImgDL.createOverlay({ signal: ac.signal, isTopFrame: o.isTopFrame !== false, callbacks });
    return window.__ov.mount();
  }, opts);
}

// showChip sobre el rect actual de un elemento; devuelve la posición esperada y debugRects().
function showChipOn(sel, isSelected = false) {
  return page.evaluate(({ sel, isSelected }) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const ref = { key: 'http|' + el.currentSrc, kind: 'http', url: el.currentSrc, name: el.id + '.png', w: 400, h: 300, id: 1 };
    window.__ov.showChip(r, ref, isSelected);
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    return {
      key: ref.key,
      target: { x: r.x, y: r.y, w: r.width, h: r.height },
      expected: { x: clamp(r.x + r.width - 70, 4, vw - 72), y: clamp(r.y + 4, 4, vh - 36) },
      rects: window.__ov.debugRects()
    };
  }, { sel, isSelected });
}

function rects() {
  return page.evaluate(() => window.__ov.debugRects());
}

function tagAt(x, y) {
  return page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el ? el.tagName : null;
  }, [x, y]);
}

function centre(r) {
  return [r.x + r.w / 2, r.y + r.h / 2];
}

function nextFrame() {
  return page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
}

function assertChip(r, expected) {
  assert.ok(r.chipRect, 'chipRect visible');
  assert.ok(Math.abs(r.chipRect.x - expected.x) <= 0.5, `chip x ${r.chipRect.x} ≈ ${expected.x}`);
  assert.ok(Math.abs(r.chipRect.y - expected.y) <= 0.5, `chip y ${r.chipRect.y} ≈ ${expected.y}`);
  assert.equal(r.chipRect.w, CHIP_W);
  assert.equal(r.chipRect.h, CHIP_H);
  assert.equal(r.chipCells.select.w, 32);
  assert.equal(r.chipCells.select.h, 32);
  assert.equal(r.chipCells.download.w, 32);
  assert.equal(r.chipCells.download.h, 32);
  assert.ok(r.chipCells.download.x > r.chipCells.select.x, 'celda de descarga a la derecha');
}

test.before(async () => {
  srv = await H.startFixtures();
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

test('basic: un solo imgdl-root bajo <html>, shadow cerrado, popover abierto y chip en la esquina superior derecha', async () => {
  await open('basic.html');
  assert.equal(await create(), true);
  const info = await page.evaluate(() => {
    const hosts = document.querySelectorAll('imgdl-root');
    return {
      n: hosts.length,
      parent: hosts[0] && hosts[0].parentElement.tagName,
      shadow: hosts[0] ? hosts[0].shadowRoot : 'none',
      sameHost: window.__ov.host === hosts[0]
    };
  });
  assert.deepEqual(info, { n: 1, parent: 'HTML', shadow: null, sameHost: true });

  const before = await rects();
  assert.equal(before.chipRect, null);
  assert.equal(before.popoverOpen, true);
  assert.equal(before.fallback, false);

  const r = await showChipOn('#g1');
  assertChip(r.rects, r.expected);
  // Dentro de la esquina superior derecha de la imagen.
  assert.ok(r.rects.chipRect.x + CHIP_W <= r.target.x + r.target.w, 'chip dentro por la derecha');
  assert.ok(r.rects.chipRect.y >= r.target.y, 'chip dentro por arriba');
  assert.equal(await tagAt(...centre(r.rects.chipRect)), 'IMGDL-ROOT');
  // Fuera del chip, la capa deja pasar el puntero a la página.
  assert.equal(await tagAt(r.target.x + 20, r.target.y + 150), 'IMG');
});

test('basic: clic real en la celda de descarga -> onDownload(ref) y el listener de clic de la página NO se dispara', async () => {
  const r = await showChipOn('#g2');
  const [dx, dy] = centre(r.rects.chipCells.download);
  await page.mouse.click(dx, dy);
  let calls = await page.evaluate(() => window.__calls);
  assert.deepEqual(calls, [['download', r.key]]);
  assert.equal(await page.evaluate(() => window.__pageClicks), 0);

  const [sx, sy] = centre(r.rects.chipCells.select);
  await page.mouse.click(sx, sy);
  calls = await page.evaluate(() => window.__calls);
  assert.deepEqual(calls, [['download', r.key], ['toggleSelect', r.key]]);
  assert.equal(await page.evaluate(() => window.__pageClicks), 0);
  assert.equal((await rects()).chipChecked, true);

  // showChip con isSelected sincroniza la casilla.
  const r2 = await showChipOn('#g2', false);
  assert.equal(r2.rects.chipChecked, false);
  // El foco no se roba a la página (preventDefault en mousedown).
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY');
});

test('basic: isPointerOnUi, hideChip y clamp al redimensionar (layout)', async () => {
  const r = await showChipOn('#g3');
  const [cx, cy] = centre(r.rects.chipRect);
  const bottom = r.rects.chipRect.y + CHIP_H;
  // Dentro, a 7 px bajo el borde (margen 8), a 30 px bajo el borde, lejos.
  const on = await page.evaluate(([x, y, b]) => [window.__ov.isPointerOnUi(x, y), window.__ov.isPointerOnUi(x, b + 7), window.__ov.isPointerOnUi(x, b + 30), window.__ov.isPointerOnUi(5, 700)], [cx, cy, bottom]);
  assert.deepEqual(on, [true, true, false, false]);

  // Viewport más estrecho: el chip se recoloca al borde derecho (vw - 72).
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.evaluate(() => window.__ov.layout());
  await nextFrame();
  const after = await rects();
  assert.equal(after.chipRect.x, 1000 - 72);
  assert.equal(await tagAt(...centre(after.chipRect)), 'IMGDL-ROOT');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.__ov.markDirty());
  await nextFrame();
  assert.equal((await rects()).chipRect.x, r.expected.x);

  await page.evaluate(() => window.__ov.hideChip());
  const hidden = await rects();
  assert.equal(hidden.chipRect, null);
  assert.equal(hidden.chipCells, null);
  assert.equal(await page.evaluate(([x, y]) => window.__ov.isPointerOnUi(x, y), [cx, cy]), false);
  assert.equal(await tagAt(cx, cy), 'IMG');
});

test('basic: setBadges dibuja anillo sobre el rect, sigue al elemento tras scroll y respeta el tope', async () => {
  const r = await page.evaluate(() => {
    const g2 = document.getElementById('g2');
    const g5 = document.getElementById('g5');
    window.__ov.setBadges([
      { key: 'k2', rect: g2.getBoundingClientRect(), name: 'g2.png', el: g2 },
      { key: 'k5', rect: g5.getBoundingClientRect(), name: 'g5.png' }
    ]);
    return { g2: g2.getBoundingClientRect().toJSON(), g5: g5.getBoundingClientRect().toJSON() };
  });
  await nextFrame();
  let d = await rects();
  assert.deepEqual(d.badges.map((b) => b.key), ['k2', 'k5']);
  assert.deepEqual(d.badges[0].rect, { x: r.g2.x, y: r.g2.y, w: r.g2.width, h: r.g2.height });
  assert.deepEqual(d.badges[1].rect, { x: r.g5.x, y: r.g5.y, w: r.g5.width, h: r.g5.height });
  // Los anillos no interceptan el puntero.
  assert.equal(await tagAt(r.g2.x + 100, r.g2.y + 100), 'IMG');

  await page.evaluate(() => window.scrollBy(0, 100));
  await page.evaluate(() => window.__ov.layout());
  await nextFrame();
  d = await rects();
  assert.equal(d.badges[0].rect.y, r.g2.y - 100, 'con el (conectado) sigue al elemento');
  assert.equal(d.badges[1].rect.y, r.g5.y, 'solo rect: se queda donde estaba');
  await page.evaluate(() => window.scrollTo(0, 0));

  // Tope badgeCap y retirada de los que ya no están.
  const n = await page.evaluate(() => {
    const cap = ImgDL.thresholds.DEFAULTS.badgeCap;
    const many = [];
    for (let i = 0; i < cap + 50; i++) many.push({ key: 'm' + i, rect: { x: 10, y: 10, w: 50, h: 50 }, name: 'm' });
    window.__ov.setBadges(many);
    const total = window.__ov.debugRects().badges.length;
    window.__ov.setBadges([]);
    return { cap, total, after: window.__ov.debugRects().badges.length };
  });
  assert.equal(n.total, n.cap);
  assert.equal(n.after, 0);
});

test('basic: toast aparece en debugRects().toasts, su acción se ejecuta y desaparece tras ms', async () => {
  await page.evaluate(() => {
    window.__acted = 0;
    window.__ov.toast('hola', 'info', 400);
    window.__ov.toast(ImgDL.strings.ERR_HTML, 'error', 0, { actionLabel: ImgDL.strings.COPY_URL, onAction: () => { window.__acted++; } });
  });
  let d = await rects();
  assert.deepEqual(d.toasts, ['hola', S.ERR_HTML]);
  await H.waitFor(async () => !(await rects()).toasts.includes('hola'), 2000, 50, 'toast auto-oculto');
  d = await rects();
  assert.deepEqual(d.toasts, [S.ERR_HTML]);
  // El botón de acción está en la esquina inferior derecha y el clic no llega a la página.
  const btn = await page.evaluate(() => {
    const t = window.__ov.debugRects();
    return t.toasts.length;
  });
  assert.equal(btn, 1);
  const vp = page.viewportSize();
  const found = await page.evaluate(() => {
    // Buscamos el botón por su rect: el toast está anclado abajo a la derecha.
    const r = window.__ov.isPointerOnUi(window.innerWidth - 40, window.innerHeight - 36);
    return r;
  });
  assert.equal(found, true);
  await page.mouse.click(vp.width - 40, vp.height - 36);
  assert.equal(await page.evaluate(() => window.__acted), 1);
  assert.deepEqual((await rects()).toasts, []);
  assert.equal(await page.evaluate(() => window.__pageClicks), 0);
});

test('basic: barra solo en el marco principal, centrada abajo, con textos de strings y botones que llaman a los callbacks', async () => {
  const vp = page.viewportSize();
  const d = await page.evaluate(() => {
    window.__ov.showBar({ count: 2, total: 3, jobRunning: false, progressText: '' });
    return window.__ov.debugRects();
  });
  assert.ok(d.barRect, 'barRect visible');
  assert.ok(Math.abs((d.barRect.x + d.barRect.w / 2) - vp.width / 2) <= 1, 'centrada horizontalmente');
  assert.equal(Math.round(d.barRect.y + d.barRect.h), vp.height - 16, 'a 16 px del borde inferior');
  for (const s of [S.BAR_SELECTED(3), S.BAR_CLEAR, S.BAR_FILES(3), S.BAR_ZIP(3), S.BAR_EXIT]) {
    assert.ok(d.barText.includes(s), 'barra contiene ' + JSON.stringify(s));
  }
  assert.ok(!d.barText.includes(S.BAR_CANCEL), 'sin Cancelar mientras no hay trabajo');

  // Clic real en 'Salir (Esc)' (último botón de la fila) -> onExit; la página no ve el clic.
  await page.evaluate(() => { window.__calls = []; });
  await page.mouse.click(d.barRect.x + d.barRect.w - 40, d.barRect.y + d.barRect.h / 2);
  assert.deepEqual(await page.evaluate(() => window.__calls), [['exit', null]]);
  assert.equal(await page.evaluate(() => window.__pageClicks), 0);

  // Estado de trabajo: Cancelar visible, progreso en la línea role=status, confirmación.
  const d2 = await page.evaluate(() => {
    window.__ov.updateBar({ jobRunning: true });
    window.__ov.setProgress(ImgDL.strings.PROGRESS_FILES(1, 3));
    const a = window.__ov.debugRects().barText;
    window.__ov.updateBar({ jobRunning: false, progressText: '', needsConfirm: { n: 400, mb: 1200 } });
    const b = window.__ov.debugRects().barText;
    return { a, b };
  });
  assert.ok(d2.a.includes(S.BAR_CANCEL));
  assert.ok(d2.a.includes(S.PROGRESS_FILES(1, 3)));
  assert.ok(d2.b.includes(S.WARN_BIG(400, 1200)));
  assert.ok(!d2.b.includes(S.BAR_CANCEL));

  // El clic con ratón no roba el foco (preventDefault en mousedown)...
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY');
  // ...pero Tab entra en la barra (único foco tabulable de basic.html) y el keydown
  // dentro no llega a la página, salvo Escape.
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'IMGDL-ROOT');
  await page.evaluate(() => { window.__pageKeys = []; });
  await page.keyboard.press('a');
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(() => window.__pageKeys), ['Escape']);

  await page.evaluate(() => window.__ov.hideBar());
  assert.equal((await rects()).barRect, null);

  // En un marco secundario no hay barra.
  await page.evaluate(() => window.__ov.unmount());
  assert.equal(await create({ isTopFrame: false }), true);
  const sub = await page.evaluate(() => {
    const ok = window.__ov.showBar({ count: 1, total: 1 });
    return { ok, barRect: window.__ov.debugRects().barRect };
  });
  assert.deepEqual(sub, { ok: false, barRect: null });
});

test('basic: unmount retira todo (host, popover, temporizadores) y un segundo mount funciona; abort del signal desmonta', async () => {
  await page.evaluate(() => window.__ov.unmount());
  assert.equal(await page.evaluate(() => document.querySelectorAll('imgdl-root').length), 0);
  assert.equal(await page.evaluate(() => window.__ov.host), null);
  assert.equal(await page.evaluate(() => window.__ov.debugRects().chipRect), null);
  // Idempotente.
  await page.evaluate(() => window.__ov.unmount());

  assert.equal(await page.evaluate(() => window.__ov.mount()), true);
  assert.equal(await page.evaluate(() => document.querySelectorAll('imgdl-root').length), 1);
  const r = await showChipOn('#g4');
  assertChip(r.rects, r.expected);
  assert.equal(await tagAt(...centre(r.rects.chipRect)), 'IMGDL-ROOT');
  // mount repetido no duplica el host.
  assert.equal(await page.evaluate(() => window.__ov.mount()), true);
  assert.equal(await page.evaluate(() => document.querySelectorAll('imgdl-root').length), 1);

  await page.evaluate(() => window.__ac.abort());
  assert.equal(await page.evaluate(() => document.querySelectorAll('imgdl-root').length), 0);
  assert.equal(await page.evaluate(() => window.__ov.debugRects().chipRect), null);
});

test('guardia del host: la página elimina imgdl-root -> se vuelve a añadir en < 1 s y el chip sigue clicable', async () => {
  await open('basic.html');
  assert.equal(await create(), true);
  const r = await showChipOn('#g1');
  // El MutationObserver corre en el siguiente microtask: el recuento 0 se comprueba en el mismo evaluate.
  const gone = await page.evaluate(() => {
    document.querySelector('imgdl-root').remove();
    return document.querySelectorAll('imgdl-root').length;
  });
  assert.equal(gone, 0);
  const t0 = Date.now();
  await H.waitFor(() => page.evaluate(() => document.querySelectorAll('imgdl-root').length === 1), 1000, 20, 'host re-añadido');
  assert.ok(Date.now() - t0 < 1000);
  await nextFrame();
  const d = await rects();
  assert.equal(d.popoverOpen, true);
  assert.equal(d.hostParent, 'HTML');
  assertChip(d, r.expected);
  assert.equal(await tagAt(...centre(d.chipRect)), 'IMGDL-ROOT');
  await page.mouse.click(...centre(d.chipCells.download));
  assert.deepEqual(await page.evaluate(() => window.__calls), [['download', r.key]]);
  await page.evaluate(() => window.__ov.unmount());
});

test('guardia del host: página que lo elimina sin parar -> tras guardMax re-añadidos se rinde y avisa con ERR_UI_REMOVED', async () => {
  await open('basic.html');
  const res = await page.evaluate(() => new Promise((resolve) => {
    // Umbrales cortos para el test (producción: 500 ms, 20 por 60 s).
    window.__ov = ImgDL.createOverlay({ isTopFrame: true, callbacks: {}, t: { guardThrottleMs: 10, guardMax: 3 } });
    window.__ov.mount();
    let removals = 0;
    const hostile = new MutationObserver(() => {
      const h = document.querySelector('imgdl-root');
      if (h && removals < 20) { removals++; h.remove(); }
    });
    hostile.observe(document.documentElement, { childList: true });
    removals++;
    document.querySelector('imgdl-root').remove();
    setTimeout(() => {
      hostile.disconnect();
      resolve({ removals, hosts: document.querySelectorAll('imgdl-root').length, toasts: window.__ov.debugRects().toasts });
    }, 400);
  }));
  // 1 eliminación inicial + 3 re-añadidos eliminados; después el overlay deja de insistir.
  assert.equal(res.removals, 4);
  assert.equal(res.hosts, 0);
  assert.deepEqual(res.toasts, [S.ERR_UI_REMOVED]);
  await page.evaluate(() => window.__ov.unmount());
});

test('guardia del host: la página MUEVE imgdl-root a <body> (sigue conectado, popover cerrado) -> vuelve bajo <html> con el popover abierto en un frame', async () => {
  await open('basic.html');
  assert.equal(await create(), true);
  const r = await showChipOn('#g1');
  assert.equal(r.rects.popoverOpen, true);
  // Mover = quitar + insertar: un popover abierto se cierra al salir del DOM aunque el
  // host siga conectado; la guardia también repara este caso.
  const moved = await page.evaluate(() => {
    const h = document.querySelector('imgdl-root');
    document.body.append(h);
    return { parent: h.parentElement.tagName, connected: h.isConnected };
  });
  assert.deepEqual(moved, { parent: 'BODY', connected: true });
  await nextFrame();
  const d = await rects();
  assert.equal(d.popoverOpen, true, 'popover reabierto');
  assert.equal(d.hostParent, 'HTML', 'host de vuelta bajo <html>');
  assert.equal(await page.evaluate(() => document.querySelectorAll('imgdl-root').length), 1);
  assertChip(d, r.expected);
  assert.equal(await tagAt(...centre(d.chipRect)), 'IMGDL-ROOT');
  await page.mouse.click(...centre(d.chipCells.download));
  assert.deepEqual(await page.evaluate(() => window.__calls), [['download', r.key]]);
  await page.evaluate(() => window.__ov.unmount());
});

test('basic: con la barra visible los toasts se elevan por encima de ella en el siguiente frame (escritura diferida al rAF) y bajan al ocultarla', async () => {
  await open('basic.html');
  assert.equal(await create(), true);
  // isPointerOnUi usa el rect real de la caja de toasts: sonda en la posición baja
  // (sin barra) y en la elevada (16 + altura de barra + 12 por encima).
  const probe = () => page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const d = window.__ov.debugRects();
    const barH = d.barRect ? d.barRect.h : 0;
    return {
      barH,
      low: window.__ov.isPointerOnUi(vw - 40, vh - 36),
      lifted: barH > 0 ? window.__ov.isPointerOnUi(vw - 40, vh - 36 - barH - 12) : null
    };
  });
  await page.evaluate(() => { window.__ov.toast('t1', 'info', 0); });
  let p = await probe();
  assert.equal(p.low, true, 'toast abajo sin barra');

  // showBar escribe la barra y difiere la elevación: en el mismo turno el toast sigue abajo...
  const sync = await page.evaluate(() => {
    window.__ov.showBar({ count: 1, total: 1 });
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    return window.__ov.isPointerOnUi(vw - 40, vh - 36);
  });
  assert.equal(sync, true, 'sin elevación síncrona (se difiere al rAF)');
  // ...y en el siguiente frame queda por encima de la barra.
  await nextFrame();
  p = await probe();
  assert.ok(p.barH > 0, 'barra visible');
  assert.equal(p.lifted, true, 'toast elevado por encima de la barra');
  assert.equal(p.low, false, 'ya no está en la posición baja');

  await page.evaluate(() => window.__ov.hideBar());
  await nextFrame();
  p = await probe();
  assert.equal(p.barH, 0);
  assert.equal(p.low, true, 'toast de vuelta abajo');
  await page.evaluate(() => window.__ov.unmount());
});

test('reset.html: con * {all:unset !important}, [popover] e imgdl-root ocultos, el chip sigue en su sitio y es alcanzable', async () => {
  await open('reset.html');
  assert.equal(await create(), true);
  for (const sel of ['#r1', '#r2']) {
    const r = await showChipOn(sel);
    assertChip(r.rects, r.expected);
    assert.equal(r.rects.popoverOpen, true);
    assert.equal(await tagAt(...centre(r.rects.chipRect)), 'IMGDL-ROOT');
  }
  const r = await showChipOn('#r1');
  await page.mouse.click(...centre(r.rects.chipCells.download));
  assert.deepEqual(await page.evaluate(() => window.__calls), [['download', r.key]]);
  assert.equal(await page.evaluate(() => window.__pageClicks), 0);
  await page.evaluate(() => window.__ov.unmount());
});

test('invert.html: html{filter} + body{transform}; tras scroll el chip queda dentro del viewport y es alcanzable', async () => {
  await open('invert.html');
  assert.equal(await create(), true);
  for (const sel of ['#i1', '#i2']) {
    await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), sel);
    assert.ok((await page.evaluate(() => window.scrollY)) > 2000, 'página desplazada');
    const r = await showChipOn(sel);
    assertChip(r.rects, r.expected);
    const vp = page.viewportSize();
    assert.ok(r.rects.chipRect.x >= 0 && r.rects.chipRect.x + CHIP_W <= vp.width, 'dentro en x');
    assert.ok(r.rects.chipRect.y >= 0 && r.rects.chipRect.y + CHIP_H <= vp.height, 'dentro en y');
    assert.equal(await tagAt(...centre(r.rects.chipRect)), 'IMGDL-ROOT');
  }
  const r = await showChipOn('#i2');
  await page.mouse.click(...centre(r.rects.chipCells.download));
  assert.deepEqual(await page.evaluate(() => window.__calls), [['download', r.key]]);
  await page.evaluate(() => window.__ov.unmount());
});

test('dialog.html: con showModal() el host se re-parenta dentro del diálogo, el chip es clicable y vuelve a <html> al cerrar', async () => {
  await open('dialog.html');
  await page.click('#open');
  assert.equal(await page.evaluate(() => document.querySelector(':modal') && document.querySelector(':modal').id), 'dlg');
  assert.equal(await create(), true);
  const parent = await page.evaluate(() => window.__ov.host.parentElement.id);
  assert.equal(parent, 'dlg');

  const r = await showChipOn('#in-dialog');
  assertChip(r.rects, r.expected);
  assert.equal(await tagAt(...centre(r.rects.chipRect)), 'IMGDL-ROOT');
  await page.evaluate(() => { window.__pageClicks = 0; }); // el clic en #open fue un clic de página legítimo
  await page.mouse.click(...centre(r.rects.chipCells.download));
  assert.deepEqual(await page.evaluate(() => window.__calls), [['download', r.key]]);
  assert.equal(await page.evaluate(() => window.__pageClicks), 0);

  // La página elimina el host desde DENTRO del diálogo: la guardia observa el propio
  // <dialog> (no solo <html> y el padre del diálogo) y lo repone dentro en < 1 s.
  const gone = await page.evaluate(() => {
    document.querySelector('imgdl-root').remove();
    return document.querySelectorAll('imgdl-root').length;
  });
  assert.equal(gone, 0);
  const t0 = Date.now();
  await H.waitFor(() => page.evaluate(() => document.querySelectorAll('imgdl-root').length === 1), 1000, 20, 'host repuesto dentro del diálogo');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(await page.evaluate(() => window.__ov.host.parentElement.id), 'dlg');
  await nextFrame();
  const d0 = await rects();
  assert.equal(d0.popoverOpen, true, 'popover reabierto dentro del diálogo');
  assert.equal(d0.hostParent, 'DIALOG');
  const r1 = await showChipOn('#in-dialog');
  assertChip(r1.rects, r1.expected);
  assert.equal(await tagAt(...centre(r1.rects.chipRect)), 'IMGDL-ROOT');

  await page.click('#close');
  await H.waitFor(() => page.evaluate(() => window.__ov.host.parentElement === document.documentElement), 2000, 20, 'host de vuelta bajo <html>');
  assert.equal(await page.evaluate(() => document.querySelector(':modal')), null);
  const d = await rects();
  assert.equal(d.popoverOpen, true);
  assert.equal(d.hostParent, 'HTML');
  assert.equal(await page.evaluate(() => document.querySelectorAll('imgdl-root').length), 1);

  // Reabrir con el overlay ya montado: el observador de [open] lo mueve dentro.
  await page.click('#open');
  await H.waitFor(() => page.evaluate(() => window.__ov.host.parentElement.id === 'dlg'), 2000, 20, 'host dentro del diálogo');
  const r2 = await showChipOn('#in-dialog');
  assert.equal(await tagAt(...centre(r2.rects.chipRect)), 'IMGDL-ROOT');
  await page.click('#close');
  await H.waitFor(() => page.evaluate(() => window.__ov.host.parentElement === document.documentElement), 2000, 20, 'host de vuelta bajo <html> (2)');
  await page.evaluate(() => window.__ov.unmount());
});
