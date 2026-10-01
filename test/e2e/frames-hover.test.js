'use strict';
// Chip colgado entre marcos: un iframe de otro origen no recibe pointerout/pointerleave
// cuando el puntero sale hacia el padre (Chromium bajo CDP), así que el padre, al
// reanudar sus pointermove tras un hueco, avisa (imgdl:hover-frame vía SW) a los demás
// marcos y estos ocultan el chip. También la vuelta: el padre pierde su chip al entrar
// en el iframe. El aviso nunca pasa por postMessage: un handler 'message' estricto de
// la página no recibe nada ni lanza.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

let srv;
let env;
let page;

function framesOf(tabId) {
  return env.sw.evaluate(async (id) => {
    const r = await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, func: () => location.href });
    return r.map((x) => ({ frameId: x.frameId, url: x.result }));
  }, tabId);
}

function state(tabId, frameId) {
  return H.state(env.sw, tabId, frameId);
}

// Hover con reintento (±1 px) hasta ver el chip en el marco frameId.
async function hoverUntil(tabId, frameId, px, py, key) {
  await page.mouse.move(px, py);
  let flip = 0;
  return H.waitFor(async () => {
    const st = await state(tabId, frameId);
    if (st && st.hoverKey === key && st.chipRect) return st;
    flip ^= 1;
    await page.mouse.move(px + flip, py + flip);
    return null;
  }, 5000, 60, 'chip en el marco ' + frameId);
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

test('iframe.html: el chip del iframe se oculta al salir el puntero hacia el padre; y el del padre al entrar en el iframe', async (t) => {
  await page.goto(srv.origin + '/pages/iframe.html', { waitUntil: 'load' });
  const inner = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(srv.altOrigin + '/'));
  assert.ok(inner, 'marco del iframe');
  await inner.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  const tabId = await H.tabIdOf(env.sw, page);
  assert.equal(await H.activate(env.sw, tabId), true);
  const child = (await framesOf(tabId)).find((f) => f.frameId !== 0 && f.url.startsWith(srv.altOrigin + '/'));
  assert.ok(child, 'frameId del iframe');

  const o = await page.evaluate(() => { const b = document.querySelector('#cross').getBoundingClientRect(); return { x: b.x, y: b.y }; });
  const rIn = await inner.evaluate(() => { const b = document.getElementById('in1').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const rTop = await page.evaluate(() => { const b = document.getElementById('top').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const inKey = 'http|' + srv.altOrigin + '/img/in1.png?w=300&h=300';
  const topKey = 'http|' + srv.origin + '/img/top.png?w=400&h=300';

  // 1) Chip en el iframe; el puntero se queda quieto más que el hueco (100 ms).
  let kid = await hoverUntil(tabId, child.frameId, o.x + rIn.x + rIn.w / 2, o.y + rIn.y + rIn.h / 2, inKey);
  assert.ok(kid.chipRect, 'chip en el iframe');
  await H.sleep(300);

  // 2) Salir al padre (sobre #top): el padre reanuda sus pointermove y avisa; el iframe oculta el chip.
  const t0 = Date.now();
  await page.mouse.move(rTop.x + rTop.w / 2, rTop.y + rTop.h / 2, { steps: 6 });
  kid = await H.waitFor(async () => {
    const s = await state(tabId, child.frameId);
    return s && !s.chipRect && s.hoverKey === null ? s : null;
  }, 3000, 40, 'chip del iframe oculto tras salir');
  t.diagnostic('chip del iframe oculto ' + (Date.now() - t0) + ' ms después de salir; mensajes recibidos por el iframe: ' + kid.hoverMsgs.received);
  assert.ok(kid.hoverMsgs.received >= 1, 'el iframe recibió el aviso del padre');
  const top = await H.waitFor(async () => {
    const s = await state(tabId, 0);
    return s && s.hoverKey === topKey && s.chipRect ? s : null;
  }, 3000, 40, 'chip del padre sobre #top');
  assert.ok(top.hoverMsgs.sent >= 1, 'el padre avisó a sus iframes');

  // 3) De vuelta al iframe: el padre pierde su chip y el iframe vuelve a mostrarlo.
  await H.sleep(300);
  kid = await hoverUntil(tabId, child.frameId, o.x + rIn.x + rIn.w / 2, o.y + rIn.y + rIn.h / 2, inKey);
  assert.ok(kid.chipRect, 'chip de nuevo en el iframe');
  const topAfter = await H.waitFor(async () => {
    const s = await state(tabId, 0);
    return s && !s.chipRect && s.hoverKey === null ? s : null;
  }, 3000, 40, 'chip del padre oculto al entrar en el iframe');
  assert.equal(topAfter.hoverKey, null);
  await env.sw.evaluate((id) => self.__imgdlTest.setActive(id, false), tabId);
});

test('aislamiento: el aviso entre marcos no llega a los handlers "message" de la página (ni errores ni mensajes)', async (t) => {
  const pageErrors = [];
  const onErr = (e) => pageErrors.push(String(e.message).slice(0, 160));
  page.on('pageerror', onErr);
  try {
    await page.goto(srv.origin + '/pages/iframe.html', { waitUntil: 'load' });
    const inner = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(srv.altOrigin + '/'));
    assert.ok(inner, 'marco del iframe');
    await inner.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
    // Handler estricto típico de un widget: JSON.parse(e.data) sin try/catch, en ambos marcos.
    const strict = () => {
      window.__msgs = [];
      window.addEventListener('message', (e) => { window.__msgs.push(e.data); JSON.parse(e.data); });
    };
    await page.evaluate(strict);
    await inner.evaluate(strict);
    const tabId = await H.tabIdOf(env.sw, page);
    assert.equal(await H.activate(env.sw, tabId), true);
    const child = (await framesOf(tabId)).find((f) => f.frameId !== 0 && f.url.startsWith(srv.altOrigin + '/'));
    assert.ok(child, 'frameId del iframe');
    const fr = await page.evaluate(() => { const b = document.querySelector('#cross').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    // Puntero: marco principal, pausa > 100 ms, iframe, pausa… (cada reanudación avisa).
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(20 + i, 20 + i);
      await H.sleep(150);
      await page.mouse.move(fr.x + fr.w / 2 + i, fr.y + fr.h / 2 + i);
      await H.sleep(150);
    }
    await H.sleep(300);
    const top = await state(tabId, 0);
    const kid = await state(tabId, child.frameId);
    assert.ok(top.hoverMsgs.sent >= 1, 'el padre avisó: ' + JSON.stringify(top.hoverMsgs));
    assert.ok(kid.hoverMsgs.received >= 1 && kid.hoverMsgs.sent >= 1, 'el iframe avisó y recibió: ' + JSON.stringify(kid.hoverMsgs));
    assert.deepEqual(await page.evaluate(() => window.__msgs), [], 'la página principal no recibió ningún message');
    assert.deepEqual(await inner.evaluate(() => window.__msgs), [], 'el iframe no recibió ningún message');
    assert.deepEqual(pageErrors, [], 'sin errores no capturados en la página');
    t.diagnostic('avisos: padre ' + JSON.stringify(top.hoverMsgs) + ', iframe ' + JSON.stringify(kid.hoverMsgs) + '; message en la página: 0');
    await env.sw.evaluate((id) => self.__imgdlTest.setActive(id, false), tabId);
  } finally {
    page.off('pageerror', onErr);
  }
});
