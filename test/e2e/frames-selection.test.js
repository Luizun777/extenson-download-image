'use strict';
// Selección entre marcos con la extensión real (paso 4): iframe.html (iframe de otro
// origen: chip dentro del iframe, recuento sumado en la barra del marco principal,
// gather con dos frameIds, iframe añadido tarde que recibe controlador vía
// imgdl:frames-changed → ensureFrames, 'Limpiar' que vacía todos los marcos),
// sandbox.html (activar no lanza; se registra qué pasa con el marco sandbox y el
// about:blank), spa.html (la selección sobrevive a la virtualización y el badge
// sigue 'ON' tras pushState; tras reload el badge se vacía) y marcos que se van
// (navegados o eliminados del DOM) cuyo recuento desaparece de la barra.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');
const S = require('../../lib/strings.js');

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

function state(tabId, frameId) {
  return H.state(env.sw, tabId, frameId || 0);
}

function framesOf(tabId) {
  return env.sw.evaluate((id) => self.__imgdlTest.frames(id), tabId);
}

function gather(tabId) {
  return env.sw.evaluate((id) => self.__imgdlTest.gather(id), tabId);
}

function activeTabs() {
  return env.sw.evaluate(() => self.__imgdlTest.activeTabs());
}

// Origen (en coordenadas de la página) del área de contenido de un iframe, tras
// traerlo a la vista (los iframes añadidos quedan por debajo del viewport).
function frameOrigin(selector) {
  return page.evaluate((sel) => {
    const f = document.querySelector(sel);
    f.scrollIntoView({ block: 'center', inline: 'nearest' });
    const b = f.getBoundingClientRect();
    return { x: b.x + f.clientLeft, y: b.y + f.clientTop };
  }, selector);
}

function rectIn(frame, id) {
  return frame.evaluate((id) => {
    const b = document.getElementById(id).getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, id);
}

// Mueve el ratón (coordenadas de página) al centro de #id dentro de un marco.
async function hoverIn(frame, iframeSel, id) {
  const o = iframeSel ? await frameOrigin(iframeSel) : { x: 0, y: 0 };
  const r = await rectIn(frame, id);
  const x = o.x + r.x + r.w / 2;
  const y = o.y + r.y + r.h / 2;
  await page.mouse.move(x, y);
  return { x: o.x, y: o.y, px: x, py: y };
}

// Espera chip + hoverKey en el marco. Un iframe de otro origen recién inyectado puede
// tardar unos cientos de ms en recibir los eventos de ratón (enrutado OOPIF): si no
// hay hover, se repite el movimiento (±1 px dentro de la imagen) cada 250 ms.
async function waitHover(tabId, frameId, key, label, pos) {
  let last = Date.now();
  let flip = 0;
  return H.waitFor(async () => {
    const st = await state(tabId, frameId);
    if (st && st.hoverKey === key && st.chipRect && st.chipCells) return st;
    if (pos && Date.now() - last >= 250) {
      last = Date.now();
      flip ^= 1;
      await page.mouse.move(pos.px + flip, pos.py + flip);
    }
    return null;
  }, 3000, 40, label);
}

// Hover con reintento y clic real en la celda [seleccionar] del chip de un marco
// (chipCells en coordenadas del marco).
async function hoverUntil(tabId, frameId, frame, iframeSel, id, key) {
  const o = await hoverIn(frame, iframeSel, id);
  const st = await waitHover(tabId, frameId, key, 'hover #' + id + ' (marco ' + frameId + ')', o);
  return { o, st };
}

async function clickSelectIn(tabId, frameId, frame, iframeSel, id, key) {
  const { o, st } = await hoverUntil(tabId, frameId, frame, iframeSel, id, key);
  const c = st.chipCells.select;
  await page.mouse.click(o.x + c.x + c.w / 2, o.y + c.y + c.h / 2);
  return st;
}

function waitCount(tabId, frameId, n, label) {
  return H.waitFor(async () => {
    const st = await state(tabId, frameId);
    return st && st.selectionCount === n ? st : null;
  }, 3000, 40, label || 'selectionCount ' + n + ' en marco ' + frameId);
}

// Diagnóstico: espera chip + hoverKey en un marco; si no llega, describe lo que hay.
async function describeHover(tabId, frameId) {
  const st = await H.waitFor(async () => {
    const s = await state(tabId, frameId);
    return s && s.hoverKey && s.chipRect ? s : null;
  }, 2000, 40, 'hover marco ' + frameId).catch(() => null);
  if (st) return 'chip visible con hoverKey ' + st.hoverKey;
  const s = await state(tabId, frameId);
  if (!s) return 'sin controlador (executeScript no llega al marco)';
  return 'controlador ' + (s.active ? 'activo' : 'inactivo') + ', hoverKey ' + JSON.stringify(s.hoverKey) + ', chip ' + (s.chipRect ? 'visible' : 'ausente') + ', host montado ' + s.hostMounted;
}

function childFrames(frames, prefix) {
  return frames.filter((f) => f.frameId !== 0 && typeof f.result === 'string' && f.result.startsWith(prefix));
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

test('iframe.html: chip dentro del iframe de otro origen, 2 + 1 → total 3 en la barra, gather con dos frameIds, iframe tardío con controlador y Limpiar en todos los marcos', async (t) => {
  const tabId = await open('iframe');
  const inner = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(srv.altOrigin + '/'));
  assert.ok(inner, 'marco Playwright del iframe en el origen alterno');
  await inner.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));

  const frames = await framesOf(tabId);
  assert.ok(frames.some((f) => f.frameId === 0 && f.result === page.url()), 'marco principal: ' + JSON.stringify(frames));
  const kids = childFrames(frames, srv.altOrigin + '/');
  assert.equal(kids.length, 1, 'un iframe en el origen alterno: ' + JSON.stringify(frames));
  const child = kids[0];
  assert.ok(child.frameId > 0);

  // Controladores activos en ambos marcos; la barra solo existe en el principal.
  let top = await state(tabId, 0);
  let kid = await state(tabId, child.frameId);
  assert.equal(top.active, true);
  assert.equal(top.isTopFrame, true);
  assert.equal(kid.active, true);
  assert.equal(kid.isTopFrame, false);
  assert.equal(kid.barRect, null, 'sin barra en el iframe');

  // Chip dentro del iframe y selección de #in1 y #in2 con clics reales.
  const inKey = (n) => 'http|' + srv.altOrigin + '/img/in' + n + '.png?w=300&h=300';
  const st1 = await clickSelectIn(tabId, child.frameId, inner, '#cross', 'in1', inKey(1));
  assert.ok(st1.chipRect.w > 0 && st1.chipRect.h > 0, 'chip visible en el iframe: ' + JSON.stringify(st1.chipRect));
  kid = await waitCount(tabId, child.frameId, 1);
  assert.equal(kid.chipChecked, true, '#in1 marcada');
  await clickSelectIn(tabId, child.frameId, inner, '#cross', 'in2', inKey(2));
  kid = await waitCount(tabId, child.frameId, 2);
  assert.equal(kid.badgeCount, 2, 'badges en el iframe');
  assert.equal(kid.barRect, null, 'el iframe sigue sin barra');

  // El marco principal recibe imgdl:frame-count: total 2 aún sin selección propia.
  top = await H.waitFor(async () => {
    const s = await state(tabId, 0);
    return s && s.selectionTotal === 2 ? s : null;
  }, 3000, 40, 'frame-count en el principal');
  assert.equal(top.selectionCount, 0);
  assert.deepEqual(top.frameCounts, { [child.frameId]: 2 });
  assert.ok(top.barRect, 'barra visible con selección solo en el iframe');
  assert.equal(top.barState.labels.files, S.BAR_FILES(2));

  // + #top en el marco principal → total 3.
  const topKey = 'http|' + srv.origin + '/img/top.png?w=400&h=300';
  await clickSelectIn(tabId, 0, page.mainFrame(), null, 'top', topKey);
  top = await H.waitFor(async () => {
    const s = await state(tabId, 0);
    return s && s.selectionCount === 1 && s.selectionTotal === 3 ? s : null;
  }, 3000, 40, 'total 3 en el principal');
  assert.equal(top.barState.labels.files, S.BAR_FILES(3));
  assert.equal(top.barState.labels.zip, S.BAR_ZIP(3));
  assert.equal(top.barState.labels.count, S.BAR_SELECTED(3));

  // gather: 3 refs, dos frameIds distintos, URLs del origen de cada marco.
  let items = await gather(tabId);
  assert.equal(items.length, 3, JSON.stringify(items.map((i) => [i.frameId, i.url])));
  assert.deepEqual(items.map((i) => i.key).sort(), [inKey(1), inKey(2), topKey].sort());
  const frameIds = new Set(items.map((i) => i.frameId));
  assert.equal(frameIds.size, 2, 'dos marcos: ' + [...frameIds].join(','));
  assert.ok(frameIds.has(0) && frameIds.has(child.frameId));
  for (const it of items) {
    assert.equal(it.kind, 'http');
    if (it.frameId === child.frameId) {
      assert.ok(it.url.startsWith(srv.altOrigin + '/'), 'URL del iframe en su origen: ' + it.url);
      assert.equal(it.frameUrl, srv.altOrigin + '/pages/iframe-inner.html');
    } else {
      assert.ok(it.url.startsWith(srv.origin + '/'), it.url);
    }
  }

  // #add-iframe: el iframe nuevo recibe controlador (frames-changed → ensureFrames).
  await page.mouse.move(640, 4);
  const t0 = Date.now();
  await page.click('#add-iframe');
  const added = await H.waitFor(async () => {
    const fr = await framesOf(tabId);
    const extra = childFrames(fr, srv.altOrigin + '/').filter((f) => f.frameId !== child.frameId);
    if (!extra.length) return null;
    const s = await state(tabId, extra[0].frameId);
    return s && s.active ? { frameId: extra[0].frameId, st: s } : null;
  }, 4000, 50, 'controlador en el iframe nuevo');
  const elapsed = Date.now() - t0;
  t.diagnostic('iframe nuevo (marco ' + added.frameId + ') activo a los ' + elapsed + ' ms del clic');
  assert.ok(elapsed < 2000, 'controlador en el iframe nuevo dentro de 2 s (' + elapsed + ' ms)');
  assert.equal(added.st.isTopFrame, false);
  assert.equal(added.st.selectionCount, 0);
  const inner2 = page.frames().find((f) => f !== page.mainFrame() && f !== inner && f.url().startsWith(srv.altOrigin + '/'));
  assert.ok(inner2, 'marco Playwright del iframe nuevo');
  await inner2.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  const t1 = Date.now();
  const { st: st3 } = await hoverUntil(tabId, added.frameId, inner2, '#cross-2', 'in3', inKey(3));
  t.diagnostic('chip en el iframe nuevo ' + (Date.now() - t1) + ' ms después del primer movimiento del ratón');
  assert.equal(st3.chipChecked, false, '#in3 del iframe nuevo no está seleccionada');
  // La selección anterior sobrevive a la reinyección (setActive(true) sobre marcos ya activos no reinicia nada).
  items = await gather(tabId);
  assert.equal(items.length, 3, 'la selección sobrevive al ensureFrames');
  top = await state(tabId, 0);
  assert.equal(top.selectionTotal, 3);

  // 'Limpiar' en la barra del principal: todos los marcos a 0.
  await page.mouse.move(640, 4);
  top = await state(tabId, 0);
  const clear = top.barState.buttons.clear;
  assert.ok(clear, 'botón Limpiar');
  await page.mouse.click(clear.x + clear.w / 2, clear.y + clear.h / 2);
  top = await H.waitFor(async () => {
    const s = await state(tabId, 0);
    return s && s.selectionCount === 0 && s.selectionTotal === 0 ? s : null;
  }, 3000, 40, 'Limpiar → total 0');
  assert.deepEqual(top.frameCounts, {});
  kid = await waitCount(tabId, child.frameId, 0, 'Limpiar → iframe a 0');
  assert.equal(kid.badgeCount, 0);
  assert.deepEqual(await gather(tabId), []);
  assert.equal(top.barState.labels.files, S.BAR_FILES(0));
  assert.equal(top.barState.disabled.files, true);

  await deactivate(tabId);
  assert.equal((await state(tabId, child.frameId)).active, false, 'iframe desactivado');
});

test('sandbox.html: activar no lanza; comportamiento del marco sandbox y del about:blank (registrado)', async (t) => {
  await page.goto(srv.origin + '/pages/sandbox.html', { waitUntil: 'load' });
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  const tabId = await H.tabIdOf(env.sw, page);
  let on = null;
  let err = null;
  try {
    on = await H.activate(env.sw, tabId);
  } catch (e) {
    err = e;
  }
  assert.equal(err, null, 'toggle no lanza: ' + (err && err.message));
  assert.equal(on, true, 'la pestaña se activa');
  assert.equal(await env.sw.evaluate((id) => self.__imgdlTest.getActive(id), tabId), true);
  const badge = await H.badge(env.sw, tabId);
  assert.ok(badge !== '', 'badge no vacío: ' + JSON.stringify(badge));

  // Marco principal: controlador activo y chip sobre #top.
  const top = await state(tabId, 0);
  assert.equal(top && top.active, true);
  await hoverUntil(tabId, 0, page.mainFrame(), null, 'top', 'http|' + srv.origin + '/img/top-sb.png?w=400&h=300');
  await page.mouse.move(640, 4);

  // Diagnóstico por marco: qué devuelve scripting y si hay controlador.
  const frames = await framesOf(tabId);
  const report = [];
  for (const f of frames) {
    const st = f.frameId === 0 ? top : await state(tabId, f.frameId);
    report.push({ frameId: f.frameId, url: f.result, controller: !!st, active: st ? st.active : null });
  }
  // about:blank: el padre escribió #blank-img; ¿aparece el chip?
  const blankPw = page.frames().find((f) => f.url() === 'about:blank');
  const blankSw = frames.find((f) => f.result === 'about:blank');
  let blankHover = 'sin marco about:blank';
  if (blankPw && blankSw) {
    try {
      await hoverIn(blankPw, '#blank', 'blank-img');
      blankHover = await describeHover(tabId, blankSw.frameId);
    } catch (e) {
      blankHover = 'error: ' + e.message;
    }
    await page.mouse.move(640, 4);
  }
  // sandbox (origen opaco): ¿scripting lo ve / lo inyecta?
  const sbPw = page.frames().find((f) => f !== page.mainFrame() && /iframe-inner\.html$/.test(f.url()));
  const sbSw = frames.filter((f) => f.frameId !== 0 && /iframe-inner\.html$/.test(String(f.result)));
  let sbHover = 'scripting no lista el marco sandbox';
  if (sbPw && sbSw.length) {
    try {
      await hoverIn(sbPw, '#sandboxed', 'in1');
      sbHover = await describeHover(tabId, sbSw[0].frameId);
    } catch (e) {
      sbHover = 'error: ' + e.message;
    }
    await page.mouse.move(640, 4);
  }
  t.diagnostic('sandbox.html: badge ' + JSON.stringify(badge) + '; marcos ' + JSON.stringify(report) + '; about:blank → ' + blankHover + '; sandbox → ' + sbHover);
  assert.deepEqual(await gather(tabId), [], 'sin selección');
  await deactivate(tabId);
});

test('spa.html: la selección sobrevive a la virtualización, badge ON tras pushState y vacío tras reload', async (t) => {
  const tabId = await open('spa');
  const key = 'http|' + srv.origin + '/img/v0.png?w=300&h=200';
  await clickSelectIn(tabId, 0, page.mainFrame(), null, 'v0', key);
  let st = await waitCount(tabId, 0, 1);
  assert.equal(st.badgeCount, 1);
  assert.equal(await H.badge(env.sw, tabId), 'ON');

  // ~100 filas más abajo: #v0 ya no está en el DOM, pero sigue seleccionada por clave.
  await page.mouse.move(640, 4);
  await page.evaluate(() => window.scrollTo(0, 100 * 220));
  await page.waitForFunction(() => !document.getElementById('v0'));
  st = await H.waitFor(async () => {
    const s = await state(tabId, 0);
    return s && s.selectionCount === 1 && s.badges.length === 0 ? s : null;
  }, 3000, 40, 'selección sin badge visible');
  assert.deepEqual((await gather(tabId)).map((i) => i.key), [key]);

  // pushState (vista 2): mismo documento → el controlador sigue, el badge vuelve a ON y la selección se conserva.
  const loadedAt = await page.evaluate(() => window.__spaLoadedAt);
  await page.click('#nav2');
  await page.waitForFunction(() => /vista 2/.test(document.getElementById('status').textContent));
  assert.equal(await page.evaluate(() => window.__spaLoadedAt), loadedAt, 'sin recarga');
  assert.match(page.url(), /\?view=2$/);
  await H.waitFor(async () => (await H.badge(env.sw, tabId)) === 'ON', 2000, 40, 'badge ON tras pushState');
  st = await state(tabId, 0);
  assert.equal(st.active, true);
  assert.equal(st.selectionCount, 1);
  assert.deepEqual((await gather(tabId)).map((i) => i.key), [key], 'selección conservada tras pushState');
  // #v200 (vista 2) también se puede seleccionar.
  const key200 = 'http|' + srv.origin + '/img/v200.png?w=300&h=200';
  await clickSelectIn(tabId, 0, page.mainFrame(), null, 'v200', key200);
  st = await waitCount(tabId, 0, 2);
  assert.deepEqual((await gather(tabId)).map((i) => i.key).sort(), [key, key200].sort());
  t.diagnostic('spa: badge tras pushState ' + JSON.stringify(await H.badge(env.sw, tabId)) + '; selección ' + st.selectionCount);

  // reload: documento nuevo → sin controlador, badge vacío y fuera de activeTabs.
  await page.reload({ waitUntil: 'load' });
  await H.waitFor(async () => (await H.badge(env.sw, tabId)) === '', 3000, 50, 'badge vacío tras reload');
  const after = await state(tabId, 0);
  assert.ok(after === null || after.active === false, 'sin controlador activo tras reload: ' + JSON.stringify(after && after.active));
  await H.waitFor(async () => !(await activeTabs()).includes(tabId), 2000, 50, 'activeTabs tras reload');
  assert.equal(await env.sw.evaluate((id) => self.__imgdlTest.getActive(id), tabId), false);
});

test('iframe.html: el marco que navega a about:blank o se elimina del DOM deja de contar en la barra y gather queda vacío', async () => {
  const tabId = await open('iframe');
  const inner = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(srv.altOrigin + '/'));
  assert.ok(inner, 'marco Playwright del iframe en el origen alterno');
  await inner.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  const child = childFrames(await framesOf(tabId), srv.altOrigin + '/')[0];
  assert.ok(child && child.frameId > 0, 'iframe en el origen alterno');
  const inKey = (n) => 'http|' + srv.altOrigin + '/img/in' + n + '.png?w=300&h=300';

  // 2 en el iframe → total 2 en el principal.
  await clickSelectIn(tabId, child.frameId, inner, '#cross', 'in1', inKey(1));
  await waitCount(tabId, child.frameId, 1);
  await clickSelectIn(tabId, child.frameId, inner, '#cross', 'in2', inKey(2));
  await waitCount(tabId, child.frameId, 2);
  let top = await H.waitFor(async () => {
    const s = await state(tabId, 0);
    return s && s.selectionTotal === 2 ? s : null;
  }, 3000, 40, 'frame-count 2 en el principal');
  assert.deepEqual(top.frameCounts, { [child.frameId]: 2 });
  assert.equal(top.barState.labels.files, S.BAR_FILES(2));
  await page.mouse.move(640, 4);

  // El iframe navega: pagehide → selection-changed 0 → el principal lo descuenta.
  await page.evaluate(() => { document.getElementById('cross').src = 'about:blank'; });
  top = await H.waitFor(async () => {
    const s = await state(tabId, 0);
    return s && s.selectionTotal === 0 ? s : null;
  }, 3000, 40, 'marco navegado → total 0');
  assert.deepEqual(top.frameCounts, {});
  assert.equal(top.selectionCount, 0);
  assert.equal(top.barState.labels.files, S.BAR_FILES(0));
  assert.equal(top.barState.disabled.files, true, 'sin selección no se puede descargar');
  assert.deepEqual(await gather(tabId), []);

  // Iframe nuevo (#cross-2) con 1 seleccionada → total 1; al eliminarlo del DOM → 0.
  await page.click('#add-iframe');
  const added = await H.waitFor(async () => {
    const fr = await framesOf(tabId);
    const extra = childFrames(fr, srv.altOrigin + '/').filter((f) => f.frameId !== child.frameId);
    if (!extra.length) return null;
    const s = await state(tabId, extra[0].frameId);
    return s && s.active ? { frameId: extra[0].frameId } : null;
  }, 4000, 50, 'controlador en el iframe nuevo');
  const inner2 = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(srv.altOrigin + '/'));
  assert.ok(inner2, 'marco Playwright del iframe nuevo');
  await inner2.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await clickSelectIn(tabId, added.frameId, inner2, '#cross-2', 'in3', inKey(3));
  await waitCount(tabId, added.frameId, 1);
  top = await H.waitFor(async () => {
    const s = await state(tabId, 0);
    return s && s.selectionTotal === 1 ? s : null;
  }, 3000, 40, 'frame-count 1 del iframe nuevo');
  assert.deepEqual(top.frameCounts, { [added.frameId]: 1 });
  assert.equal((await gather(tabId)).length, 1);
  await page.mouse.move(640, 4);

  await page.evaluate(() => document.getElementById('cross-2').remove());
  top = await H.waitFor(async () => {
    const s = await state(tabId, 0);
    return s && s.selectionTotal === 0 ? s : null;
  }, 3000, 40, 'marco eliminado → total 0');
  assert.deepEqual(top.frameCounts, {});
  assert.equal(top.barState.labels.files, S.BAR_FILES(0));
  assert.deepEqual(await gather(tabId), []);
  await deactivate(tabId);
});
