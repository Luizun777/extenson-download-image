'use strict';
// detect.js en Chromium "a pelo" (sin extensión): se inyectan los módulos con
// addScriptTag en el orden de inyección y se llama a ImgDL.detect.hitTest desde
// page.evaluate sobre el centro de cada [data-expect] de las páginas de fixtures.
// El shadow root cerrado solo se atraviesa con chrome.dom (test de extensión).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startServer } = require('../fixtures/server.js');

const ROOT = path.resolve(__dirname, '..', '..');
// Mismo orden que tabs.CONTENT_FILES hasta detect (overlay/selection/controller no hacen falta).
const MODULES = ['lib/strings.js', 'lib/urls.js', 'lib/thresholds.js', 'lib/names.js', 'content/resolve.js', 'content/detect.js'];

// Páginas con [data-expect] que detect debe resolver en modo standalone.
const PAGES = ['overlay.html', 'pointer-events-none.html', 'spacer.html', 'basic.html', 'lazy.html', 'background.html', 'shadow.html', 'iframe.html', 'special.html', 'detect-edge.html'];
// Tope de nodos leídos (1 getBoundingClientRect cada uno) por el fallback geométrico.
const GEO_SCANNED = 200;
// Objetivos que el modo standalone no puede alcanzar (se prueban aparte).
const STANDALONE_SKIP = new Set(['shadow.html#closed-host']);

let srv;
let browser;
let page;

test.before(async () => {
  for (const m of MODULES) {
    assert.ok(fs.existsSync(path.join(ROOT, m)), `falta ${m} (¿resolve.js aún no escrito?)`);
  }
  srv = await startServer();
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

async function inject(target) {
  for (const m of MODULES) await target.addScriptTag({ path: path.join(ROOT, m) });
  const ok = await target.evaluate(() => !!(globalThis.ImgDL && ImgDL.detect && ImgDL.resolve && ImgDL.thresholds));
  assert.equal(ok, true, 'módulos cargados');
}

async function open(name) {
  await page.goto(srv.origin + '/pages/' + name, { waitUntil: 'load' });
  // Imágenes creadas por script (blob: en special.html, con src asignado tras
  // un fetch) y lazies: esperar a que todas estén completas y las blob: cargadas.
  await page.waitForFunction(() => {
    const all = Array.from(document.images);
    if (!all.every((i) => i.complete)) return false;
    return all.filter((i) => i.dataset.expectKind === 'blob').every((i) => /^blob:/.test(i.src) && i.naturalWidth > 0);
  }, null, { timeout: 10000 });
  await inject(page);
}

// Centro de un elemento (light DOM) tras scrollIntoView y hitTest en ese punto;
// el resultado se serializa para compararlo en Node.
function hitAt(selector, frame = page) {
  return frame.evaluate((sel) => {
    const serialize = (res, target) => {
      if (res === null || res === undefined) return null;
      if (res.keep) return { keep: true };
      return {
        url: res.ref && res.ref.url !== undefined ? res.ref.url : null,
        kind: res.ref ? res.ref.kind : null,
        key: res.ref ? res.ref.key : null,
        elId: res.el ? res.el.id : null,
        elTag: res.el ? res.el.localName : null,
        sameEl: res.el === target,
        rect: res.rect ? { x: res.rect.x, y: res.rect.y, w: res.rect.w, h: res.rect.h } : null
      };
    };
    const el = document.querySelector(sel);
    if (!el) return { error: 'no existe ' + sel };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const res = ImgDL.detect.hitTest(cx, cy, { isPointerOnUi: () => false, hostEl: null });
    return { cx, cy, res: serialize(res, el), src: el.currentSrc || el.src || null };
  }, selector);
}

function targetsOf(frame = page) {
  return frame.evaluate(() => {
    const list = (sel) => Array.from(document.querySelectorAll(sel)).map((e) => ({
      sel: '#' + e.id,
      id: e.id,
      expect: e.dataset.expect,
      kind: e.dataset.expectKind,
      skip: e.dataset.expectSkip || null,
      host: !!e.shadowRoot || /-host$/.test(e.id),
      src: e.src || null
    }));
    return { targets: list('[data-expect]:not([data-expect-skip])'), skips: list('[data-expect-skip]') };
  });
}

for (const name of PAGES) {
  test(`${name}: cada [data-expect] se resuelve con la URL y el kind esperados`, async () => {
    await open(name);
    const { targets, skips } = await targetsOf();
    assert.ok(targets.length > 0, 'la página tiene objetivos');
    for (const tgt of targets) {
      const label = `${name} ${tgt.sel}`;
      if (STANDALONE_SKIP.has(name + tgt.sel)) continue;
      assert.ok(tgt.id, label + ': el objetivo tiene id');
      const { cx, cy, res, src } = await hitAt(tgt.sel);
      if (tgt.kind === 'frame') {
        assert.equal(res, null, label + ': sobre un iframe el marco superior devuelve null');
        continue;
      }
      assert.ok(res && !res.error && !res.keep, label + ': hay resultado: ' + JSON.stringify(res));
      assert.equal(res.kind, tgt.kind, label + ': kind');
      assert.ok(typeof res.key === 'string' && res.key.startsWith(tgt.kind + '|'), label + ': key con prefijo kind');
      if (tgt.kind === 'http' || tgt.kind === 'data') {
        const expected = tgt.expect === '(src)' ? src : srv.origin + tgt.expect;
        assert.equal(res.url, expected, label + ': url');
      }
      if (tgt.host) {
        assert.notEqual(res.elId, tgt.id, label + ': el elemento devuelto es el de dentro del shadow, no el host');
      } else {
        assert.equal(res.sameEl, true, label + ': el elemento devuelto es el objetivo (' + res.elId + ')');
      }
      assert.ok(res.rect && res.rect.w > 0 && res.rect.h > 0, label + ': rect no vacío');
      assert.ok(cx >= res.rect.x && cx <= res.rect.x + res.rect.w && cy >= res.rect.y && cy <= res.rect.y + res.rect.h, label + ': el rect contiene el punto');
    }
    for (const sk of skips) {
      const label = `${name} ${sk.sel} (skip: ${sk.skip})`;
      const { res } = await hitAt(sk.sel);
      assert.ok(res === null || (res && !res.error && res.sameEl === false), label + ': no se devuelve el elemento descartado: ' + JSON.stringify(res));
    }
  });
}

test('overlay.html: el spacer opacity:0 estirado devuelve la foto de debajo; basic.html: píxel y spacer → null', async () => {
  await open('overlay.html');
  const over = await hitAt('#spacer');
  assert.equal(over.res && over.res.elId, 'photo');
  assert.equal(over.res.url, srv.origin + '/img/photo.png?w=400&h=300');

  await open('spacer.html');
  assert.equal((await hitAt('#spacer')).res.elId, 'photo');
  assert.equal((await hitAt('#pixel-cover')).res.elId, 'photo2');

  await open('basic.html');
  assert.equal((await hitAt('#pixel')).res, null, 'píxel 1x1: nada debajo → null');
  assert.equal((await hitAt('#spacer')).res, null, 'spacer 16x16 estirado: nada debajo → null');
});

test('shadow.html: el host cerrado no se atraviesa sin chrome.dom (standalone → null); shadowRootOf distingue abierto/cerrado', async () => {
  await open('shadow.html');
  const { res } = await hitAt('#closed-host');
  // Documentado: sin chrome.dom.openOrClosedShadowRoot el host es opaco; la
  // extensión lo cubre en el test de nivel extensión.
  assert.ok(res === null || res.elId === 'closed-host', 'standalone: null o el host: ' + JSON.stringify(res));
  const roots = await page.evaluate(() => {
    const d = ImgDL.detect.dom;
    return {
      open: !!d.shadowRootOf(document.getElementById('open-host')),
      closed: d.shadowRootOf(document.getElementById('closed-host')),
      plain: d.shadowRootOf(document.body),
      bogus: d.shadowRootOf(null)
    };
  });
  assert.deepEqual(roots, { open: true, closed: null, plain: null, bogus: null });
});

test('shadow.html: expandStack inserta los elementos del shadow antes del host, sin duplicados, y parentChain cruza límites', async () => {
  await open('shadow.html');
  const r = await page.evaluate(() => {
    const d = ImgDL.detect.dom;
    const host = document.getElementById('nested-host');
    host.scrollIntoView({ block: 'center' });
    const rc = host.getBoundingClientRect();
    const x = rc.left + rc.width / 2;
    const y = rc.top + rc.height / 2;
    const raw = document.elementsFromPoint(x, y);
    const budget = d.newBudget();
    const stack = d.expandStack(raw, x, y, 3, budget);
    const ids = stack.map((e) => e.id || e.localName);
    const img = host.shadowRoot.getElementById('inner-host').shadowRoot.getElementById('nested-img');
    const chain = d.parentChain(img, 6).map((e) => e.id || e.localName);
    const stackHasDupes = new Set(stack).size !== stack.length;
    return { rawIds: raw.map((e) => e.id || e.localName), ids, chain, shadowQueries: budget.shadowQueries, stackHasDupes, len: stack.length };
  });
  assert.equal(r.rawIds[0], 'nested-host', 'el documento solo ve el host');
  assert.equal(r.ids[0], 'nested-img', 'el <img> anidado va primero');
  assert.ok(r.ids.indexOf('inner-host') < r.ids.indexOf('nested-host'), 'host interno antes que el externo');
  assert.equal(r.stackHasDupes, false);
  assert.ok(r.shadowQueries >= 2 && r.shadowQueries <= 3, 'consultas de shadow: ' + r.shadowQueries);
  assert.ok(r.len <= 12);
  assert.deepEqual(r.chain.slice(0, 3), ['nested-img', 'inner-host', 'nested-host']);
});

test('iframe.html: el marco hijo (origen alterno) resuelve sus propias imágenes con su instancia', async () => {
  await open('iframe.html');
  const frame = page.frames().find((f) => f.url().includes('iframe-inner.html'));
  assert.ok(frame, 'hay un frame hijo');
  await frame.waitForLoadState('load');
  await inject(frame);
  const { targets } = await targetsOf(frame);
  assert.equal(targets.length, 3);
  for (const tgt of targets) {
    const { res } = await hitAt(tgt.sel, frame);
    assert.ok(res && !res.error, tgt.sel + ': resultado');
    assert.equal(res.url, srv.altOrigin + tgt.expect, tgt.sel + ': URL relativa al origen del marco');
    assert.equal(res.kind, 'http');
    assert.equal(res.sameEl, true);
  }
});

// Cuenta las llamadas al DOM que acotan el coste de un hitTest. qsa: solo las
// consultas del fallback geométrico (su selector), no las que resolve.js haga.
function instrumentCounts(target = page) {
  return target.evaluate(() => {
    const c = (window.__counts = { efp: 0, gcs: 0, sefp: 0, qsa: 0, gbcr: 0, cv: 0 });
    const efp = document.elementsFromPoint.bind(document);
    document.elementsFromPoint = function (x, y) { c.efp++; return efp(x, y); };
    const gcs = window.getComputedStyle;
    window.getComputedStyle = function (el, p) { c.gcs++; return gcs.call(window, el, p); };
    const sefp = ShadowRoot.prototype.elementsFromPoint;
    ShadowRoot.prototype.elementsFromPoint = function (x, y) { c.sefp++; return sefp.call(this, x, y); };
    const GEO = 'img,svg,canvas,video[poster],video[data-poster]';
    const qsa = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = function (s) { if (s === GEO) c.qsa++; return qsa.call(this, s); };
    const gbcr = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { c.gbcr++; return gbcr.call(this); };
    const cv = Element.prototype.checkVisibility;
    Element.prototype.checkVisibility = function (o) { c.cv++; return cv.call(this, o); };
  });
}
const resetCounts = () => page.evaluate(() => { Object.assign(window.__counts, { efp: 0, gcs: 0, sefp: 0, qsa: 0, gbcr: 0, cv: 0 }); });
const readCounts = () => page.evaluate(() => Object.assign({}, window.__counts));

test('presupuesto en overlay.html: ≤1 elementsFromPoint, ≤6 getComputedStyle, ≤12 rects y checkVisibility por hitTest (más el cupo del fallback)', async () => {
  await open('overlay.html');
  await instrumentCounts();
  const { targets, skips } = await targetsOf();
  for (const tgt of targets.concat(skips)) {
    await resetCounts();
    const { res } = await hitAt(tgt.sel);
    const c = await readCounts();
    // hitAt lee un rect (el del objetivo) antes de llamar a hitTest.
    const rects = c.gbcr - 1;
    const walkOnly = c.qsa === 0;
    assert.ok(c.efp <= 1, `${tgt.sel}: elementsFromPoint ${c.efp} > 1`);
    assert.ok(c.gcs <= 6, `${tgt.sel}: getComputedStyle ${c.gcs} > 6`);
    assert.ok(c.sefp <= 3, `${tgt.sel}: ShadowRoot.elementsFromPoint ${c.sefp} > 3`);
    assert.ok(c.qsa <= 5, `${tgt.sel}: querySelectorAll ${c.qsa} > 5`);
    assert.ok(rects <= 12 + (walkOnly ? 0 : GEO_SCANNED), `${tgt.sel}: getBoundingClientRect ${rects}`);
    assert.ok(c.cv <= 12 + (walkOnly ? 0 : 50), `${tgt.sel}: checkVisibility ${c.cv}`);
    if (tgt.id === 'covered') assert.equal(c.qsa, 0, '#covered se acepta en el recorrido: sin fallback');
    if (tgt.id === 'pen') assert.ok(c.qsa >= 1 && res && res.elId === 'pen', '#pen llega por el fallback geométrico');
  }
});

test('hitTest: centinela KEEP sobre la UI, nunca lanza y fuera del viewport → null', async () => {
  await open('basic.html');
  const r = await page.evaluate(() => {
    const D = ImgDL.detect;
    const g1 = document.getElementById('g1');
    g1.scrollIntoView({ block: 'center' });
    const rc = g1.getBoundingClientRect();
    const x = rc.left + 10;
    const y = rc.top + 10;
    const out = {};
    out.keep = D.hitTest(x, y, { isPointerOnUi: () => true }) === D.KEEP;
    out.keepShape = D.KEEP.keep === true && Object.isFrozen(D.KEEP);
    out.throwingUi = D.hitTest(x, y, { isPointerOnUi: () => { throw new Error('boom'); } });
    // Host falso con fondo propio encima de g1: sin hostEl se devuelve su fondo;
    // con hostEl (o por su nombre imgdl-root) se retira de la pila y gana g1.
    const mkCover = (tag) => {
      const c = document.createElement(tag);
      c.id = 'fake-' + tag;
      Object.assign(c.style, { position: 'fixed', left: rc.left + 'px', top: rc.top + 'px', width: rc.width + 'px', height: rc.height + 'px', zIndex: '10', backgroundImage: 'url(/img/fake.png?w=50&h=50)' });
      document.body.append(c);
      return c;
    };
    const fakeDiv = mkCover('div');
    const idOf = (h) => (h && h.el ? h.el.id : null);
    out.coverNotDropped = idOf(D.hitTest(x, y, { isPointerOnUi: () => false }));
    out.coverDropped = idOf(D.hitTest(x, y, { isPointerOnUi: () => false, hostEl: fakeDiv }));
    fakeDiv.remove();
    const fakeHost = mkCover('imgdl-root');
    out.hostByTagDropped = idOf(D.hitTest(x, y, { isPointerOnUi: () => false }));
    fakeHost.remove();
    const bad = [];
    for (const args of [[NaN, NaN], [1e9, 1e9, {}], [-5, 10], ['a', null, 42], [x, y, { t: { hoverMin: 10000 } }]]) {
      try { bad.push(D.hitTest.apply(null, args)); } catch (e) { bad.push('THREW ' + e.message); }
    }
    out.bad = bad.map((v) => (v === null ? null : typeof v));
    out.throwingUiId = out.throwingUi && out.throwingUi.el ? out.throwingUi.el.id : null;
    delete out.throwingUi;
    return out;
  });
  assert.equal(r.keep, true);
  assert.equal(r.keepShape, true);
  assert.equal(r.throwingUiId, 'g1', 'isPointerOnUi que lanza → se trata como fuera de la UI');
  assert.equal(r.coverNotDropped, 'fake-div', 'sin hostEl gana el fondo de la cubierta');
  assert.equal(r.coverDropped, 'g1', 'hostEl se retira de la pila');
  assert.equal(r.hostByTagDropped, 'g1', '<imgdl-root> se retira por su nombre aunque no llegue en ctx');
  assert.deepEqual(r.bad, [null, null, null, null, null]);
});

test('dom.isRendered: <img> en <details> cerrado (rect no nulo) se omite; al abrirlo se detecta', async () => {
  await open('basic.html');
  const r = await page.evaluate(async () => {
    const D = ImgDL.detect;
    const dt = document.createElement('details');
    dt.id = 'dt';
    dt.innerHTML = '<summary>s</summary><img id="dt-img" src="/img/dt.png?w=300&h=300" width="300" height="300" alt="dt">';
    document.body.prepend(dt);
    const img = dt.querySelector('img');
    await new Promise((res) => { if (img.complete) res(); else { img.onload = res; img.onerror = res; } });
    dt.scrollIntoView({ block: 'center' });
    const rc = img.getBoundingClientRect();
    const closed = {
      rect: { w: rc.width, h: rc.height },
      rendered: D.dom.isRendered(img),
      hit: D.hitTest(rc.left + rc.width / 2, rc.top + rc.height / 2, { isPointerOnUi: () => false })
    };
    closed.hitId = closed.hit && closed.hit.el ? closed.hit.el.id : null;
    delete closed.hit;
    dt.open = true;
    await new Promise((res) => requestAnimationFrame(() => res()));
    const rc2 = img.getBoundingClientRect();
    const hit2 = D.hitTest(rc2.left + rc2.width / 2, rc2.top + rc2.height / 2, { isPointerOnUi: () => false });
    const hidden = document.createElement('img');
    hidden.style.display = 'none';
    document.body.append(hidden);
    const faded = document.getElementById('g1');
    faded.style.opacity = '0';
    const out = { closed, openRendered: D.dom.isRendered(img), openHitId: hit2 && hit2.el ? hit2.el.id : null, displayNone: D.dom.isRendered(hidden), opacity0: D.dom.isRendered(faded), plain: D.dom.isRendered({}) };
    faded.style.opacity = '';
    return out;
  });
  assert.equal(r.closed.rendered, false, 'cerrado: no renderizado');
  assert.notEqual(r.closed.hitId, 'dt-img', 'cerrado: hitTest no lo devuelve (rect ' + JSON.stringify(r.closed.rect) + ')');
  assert.equal(r.openRendered, true);
  assert.equal(r.openHitId, 'dt-img', 'abierto: se detecta');
  assert.equal(r.displayNone, false);
  assert.equal(r.opacity0, true, 'opacity:0 sigue contando como renderizado (spacers)');
  assert.equal(r.plain, true, 'sin checkVisibility → true');
});

test('dom: rectOf/rectContains/inflate, outermostSvg, closestAnchorHref, safeComputedStyle con presupuesto', async () => {
  await open('special.html');
  const r = await page.evaluate(() => {
    const d = ImgDL.detect.dom;
    const svg = document.getElementById('svg');
    const use = svg.querySelector('use');
    const rect = d.rectOf(svg);
    const a = document.createElement('a');
    a.href = '/x/full.jpg';
    const img = document.createElement('img');
    a.append(img);
    document.body.append(a);
    const budget = { styleReads: 5, maxStyleReads: 6 };
    const cs1 = d.safeComputedStyle(svg, null, budget);
    const cs2 = d.safeComputedStyle(svg, '::before', budget);
    return {
      rectKeys: Object.keys(rect).sort(),
      rectOk: rect.w > 0 && rect.h > 0 && rect.right === rect.x + rect.w && rect.bottom === rect.y + rect.h,
      rectOfBogus: d.rectOf(null),
      contains: d.rectContains(rect, rect.x + 1, rect.y + 1, 0),
      containsMargin: d.rectContains(rect, rect.x - 5, rect.y - 5, 8) && !d.rectContains(rect, rect.x - 5, rect.y - 5, 0),
      containsDomRect: d.rectContains(svg.getBoundingClientRect(), rect.x + 1, rect.y + 1, 0),
      inflated: d.inflate({ x: 10, y: 20, w: 30, h: 40 }, 8),
      svgFromUse: d.outermostSvg(use) === svg,
      svgSelf: d.outermostSvg(svg) === svg,
      svgFromDiv: d.outermostSvg(document.body),
      anchor: d.closestAnchorHref(img, 6),
      anchorNone: d.closestAnchorHref(document.getElementById('video'), 6),
      anchorBogus: d.closestAnchorHref(null, 6),
      cs1: !!cs1,
      cs2,
      reads: budget.styleReads,
      modal: d.isModalPresent()
    };
  });
  assert.deepEqual(r.rectKeys, ['bottom', 'h', 'left', 'right', 'top', 'w', 'x', 'y']);
  assert.equal(r.rectOk, true);
  assert.deepEqual(r.rectOfBogus, { x: 0, y: 0, w: 0, h: 0, left: 0, top: 0, right: 0, bottom: 0 });
  assert.equal(r.contains, true);
  assert.equal(r.containsMargin, true);
  assert.equal(r.containsDomRect, true);
  assert.deepEqual(r.inflated, { x: 2, y: 12, w: 46, h: 56, left: 2, top: 12, right: 48, bottom: 68 });
  assert.equal(r.svgFromUse, true);
  assert.equal(r.svgSelf, true);
  assert.equal(r.svgFromDiv, null);
  assert.equal(r.anchor, srv.origin + '/x/full.jpg');
  assert.equal(r.anchorNone, null);
  assert.equal(r.anchorBogus, null);
  assert.equal(r.cs1, true, 'quinta lectura permitida');
  assert.equal(r.cs2, null, 'séptima lectura: presupuesto agotado');
  assert.equal(r.reads, 6);
  assert.equal(r.modal, null);
});

test('dialog.html: isModalPresent devuelve el <dialog> modal mientras está abierto', async () => {
  await open('dialog.html');
  const r = await page.evaluate(() => {
    const d = ImgDL.detect.dom;
    const dlg = document.getElementById('dlg');
    const before = d.isModalPresent();
    dlg.showModal();
    const during = d.isModalPresent();
    dlg.close();
    const after = d.isModalPresent();
    return { before, duringId: during ? during.id : null, after };
  });
  assert.deepEqual(r, { before: null, duringId: 'dlg', after: null });
});

test('detect-edge.html: <svg><image> bajo el puntero → el <image> (http, rect del raster); fuera del raster → svg raíz', async () => {
  await open('detect-edge.html');
  const r = await page.evaluate(() => {
    const D = ImgDL.detect;
    const R = ImgDL.resolve;
    const svg = document.getElementById('svg-a');
    svg.scrollIntoView({ block: 'center' });
    const b = svg.getBoundingClientRect();
    const ctx = { isPointerOnUi: () => false };
    const at = (dx, dy) => D.hitTest(b.left + dx, b.top + dy, ctx);
    const ser = (h) => (h ? {
      el: h.el.id,
      kind: h.ref.kind,
      url: h.ref.url || null,
      w: h.ref.w,
      h: h.ref.h,
      rect: { x: Math.round(h.rect.x - b.left), y: Math.round(h.rect.y - b.top), w: Math.round(h.rect.w), h: Math.round(h.rect.h) }
    } : null);
    const onImage = at(100, 100);
    const direct = R.resolveImageRef(svg, { point: { x: b.left + 100, y: b.top + 100 } });
    return { onImage: ser(onImage), onRect: ser(at(10, 10)), sameKey: !!onImage && onImage.ref.key === direct.key };
  });
  assert.deepEqual(r.onImage, { el: 'svg-img', kind: 'http', url: srv.origin + '/img/svgimg.png?w=120&h=120', w: 120, h: 120, rect: { x: 40, y: 40, w: 120, h: 120 } });
  assert.equal(r.sameKey, true, 'misma clave que resolveImageRef(svg, {point})');
  assert.equal(r.onRect.el, 'svg-a', 'fuera del raster: el <svg> raíz');
  assert.equal(r.onRect.kind, 'svg');
  assert.equal(r.onRect.url, null);
});

test('detect-edge.html: pseudoelementos: content:none → null; content:url gana a background-image; icono 16px → null; ::before absoluto solo bajo su caja y con su rect', async () => {
  await open('detect-edge.html');
  const r = await page.evaluate(() => {
    const D = ImgDL.detect;
    const R = ImgDL.resolve;
    const ctx = { isPointerOnUi: () => false };
    const hit = (id, dx, dy) => {
      const el = document.getElementById(id);
      el.scrollIntoView({ block: 'center' });
      const b = el.getBoundingClientRect();
      const h = D.hitTest(b.left + dx, b.top + dy, ctx);
      return h ? {
        el: h.el.id,
        url: h.ref.url,
        w: h.ref.w,
        h: h.ref.h,
        rect: { x: Math.round(h.rect.x - b.left), y: Math.round(h.rect.y - b.top), w: Math.round(h.rect.w), h: Math.round(h.rect.h) }
      } : null;
    };
    const out = {
      none: hit('pseudo-none', 200, 200),
      noneResolve: R.backgroundRefs(document.getElementById('pseudo-none'), null, { includePseudo: true }).length,
      icon: hit('pseudo-icon', 200, 200),
      iconOnIcon: hit('pseudo-icon', 16, 16),
      absIn: hit('pseudo-abs', 200, 200),
      absOut: hit('pseudo-abs', 20, 20),
      both: hit('pseudo-both', 150, 150),
      bothResolve: R.resolveImageRef(document.getElementById('pseudo-both')).url
    };
    // right/bottom en vez de left/top: el estilo computado resuelve left/top al valor usado (px).
    const st = document.createElement('style');
    st.textContent = '#pseudo-abs::before { left: auto; top: auto; right: 0; bottom: 0; }';
    document.head.append(st);
    out.rbIn = hit('pseudo-abs', 350, 350);
    out.rbOut = hit('pseudo-abs', 200, 200);
    st.remove();
    // Tarjeta sin posicionar: el pseudo absoluto se coloca respecto a otro bloque →
    // posición no exacta: rect del elemento, pero el tamaño de la ref es el del pseudo.
    const card = document.getElementById('pseudo-abs');
    card.style.position = 'static';
    out.staticHit = hit('pseudo-abs', 20, 20);
    card.style.position = '';
    return out;
  });
  const o = srv.origin;
  assert.equal(r.none, null, 'content:none no se genera: no se ofrece su background-image');
  assert.equal(r.noneResolve, 0, 'resolve coincide');
  assert.equal(r.icon, null, 'icono de 16px desde el centro de la tarjeta');
  assert.equal(r.iconOnIcon, null, 'icono de 16px incluso encima: menor que hoverMin');
  assert.deepEqual(r.absIn, { el: 'pseudo-abs', url: o + '/img/pabs.png?w=100&h=100', w: 100, h: 100, rect: { x: 150, y: 150, w: 100, h: 100 } });
  assert.equal(r.absOut, null, 'fuera de la caja del pseudo');
  assert.equal(r.both.url, o + '/img/pboth.png?w=300&h=300', 'content:url() antes que background-image');
  assert.equal(r.both.url, r.bothResolve, 'misma URL que resolve');
  assert.ok(r.rbIn, 'right/bottom: dentro');
  assert.deepEqual(r.rbIn.rect, { x: 300, y: 300, w: 100, h: 100 });
  assert.equal(r.rbOut, null, 'right/bottom: fuera');
  assert.ok(r.staticHit, 'sin posición exacta se sigue ofreciendo');
  assert.equal(r.staticHit.w, 100);
  assert.equal(r.staticHit.h, 100);
  assert.deepEqual(r.staticHit.rect, { x: 0, y: 0, w: 400, h: 400 });
});

test('detect-edge.html: fallback geométrico: 60 miniaturas antes de #pen2 no agotan el cupo; con 2000 <img> sobre espacio vacío se leen ≤ 200 rects', async () => {
  await open('detect-edge.html');
  await instrumentCounts();
  await resetCounts();
  const pen = await hitAt('#pen2');
  const c1 = await readCounts();
  assert.equal(pen.res && pen.res.elId, 'pen2', JSON.stringify(pen.res));
  assert.ok(c1.qsa >= 1, 'llega por el fallback');
  assert.ok(c1.gbcr - 1 <= 100, `rects leídos: ${c1.gbcr - 1}`);
  assert.ok(c1.cv <= 12 + 1, `checkVisibility solo en el recorrido y en el candidato que contiene el punto: ${c1.cv}`);

  const r = await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'many';
    box.style.cssText = 'padding-top:120px;width:600px';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 2000; i++) {
      const im = document.createElement('img');
      im.src = '/img/th.png?w=10&h=10';
      im.width = 10;
      im.height = 10;
      frag.append(im);
    }
    box.append(frag);
    document.body.prepend(box);
    box.scrollIntoView({ block: 'start' });
    const b = box.getBoundingClientRect();
    Object.assign(window.__counts, { gbcr: 0, cv: 0, qsa: 0 });
    const hit = ImgDL.detect.hitTest(b.left + 20, b.top + 50, { isPointerOnUi: () => false });
    const c = Object.assign({}, window.__counts);
    const stack = document.elementsFromPoint(b.left + 20, b.top + 50).map((e) => e.id || e.localName);
    box.remove();
    return { hit: hit ? (hit.el.id || hit.el.localName) : null, c, stack };
  });
  assert.equal(r.hit, null, 'espacio en blanco: ' + JSON.stringify(r.stack));
  assert.ok(r.c.gbcr >= GEO_SCANNED, `el cupo de nodos se recorre entero: ${r.c.gbcr}`);
  assert.ok(r.c.gbcr <= 12 + GEO_SCANNED, `rects leídos ${r.c.gbcr} > ${12 + GEO_SCANNED}`);
  assert.ok(r.c.cv <= 12, `checkVisibility ${r.c.cv} > 12 (ningún nodo contiene el punto)`);
  assert.ok(r.c.qsa <= 5, `querySelectorAll ${r.c.qsa}`);
});

test('dom.closestAnchorHref: sin fragmento, el mismo valor que resolve.closestAnchorHref', async () => {
  await open('basic.html');
  const r = await page.evaluate((o) => {
    const a = document.createElement('a');
    a.href = o + '/full/big.jpg#frag';
    const img = document.createElement('img');
    a.append(img);
    document.body.append(a);
    return { d: ImgDL.detect.dom.closestAnchorHref(img, 6), r: ImgDL.resolve.closestAnchorHref(img, 6), none: ImgDL.detect.dom.closestAnchorHref(document.body, 6) };
  }, srv.origin);
  assert.equal(r.d, srv.origin + '/full/big.jpg');
  assert.equal(r.d, r.r);
  assert.equal(r.none, null);
});
