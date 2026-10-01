'use strict';
// Valida TODOS los fixtures de test/fixtures/pages en el Chromium de Playwright sobre el servidor real
// (test/fixtures/server.js): cajas, tamaños naturales, hit-testing, marcos y la convención común
// data-expect / data-expect-kind / data-expect-skip que los e2e darán por sentada.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, PAGE_HEADERS } = require('../fixtures/server.js');

const PAGES_DIR = path.join(__dirname, '..', 'fixtures', 'pages');
const CSP = PAGE_HEADERS['csp.html']['Content-Security-Policy'];
const VIEWPORT = { width: 1280, height: 720 };

// ids declarados en el comentario superior '<!-- expect: #id → ... -->'
function expectedIds(name) {
  const html = fs.readFileSync(path.join(PAGES_DIR, name + '.html'), 'utf8');
  return [...html.matchAll(/^\s*(?:<!--\s*)?expect:\s*#([\w-]+)\s*→/gmu)].map((m) => m[1]);
}

let srv;
let browser;
const pages = [];

test.before(async () => {
  srv = await startServer();
  const { chromium } = require('playwright');
  browser = await chromium.launch({ channel: 'chromium', headless: true });
});

test.after(async () => {
  for (const p of pages) await p.close().catch(() => {});
  if (browser) await browser.close();
  // server.js corta conexiones y temporizadores (la /slow.png?ms=5000 de zip.html no retiene el proceso)
  if (srv) await srv.close();
});

async function openPage(name, opts = {}) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  pages.push(page);
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = (msg.location() && msg.location().url) || '';
    // único error tolerado: el 500 deliberado de /fail-once.png en zip.html
    if (/fail-once/.test(url) || /fail-once/.test(msg.text())) return;
    errors.push(msg.text() + ' @ ' + url);
  });
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
  const response = await page.goto(srv.origin + '/pages/' + name + '.html', { waitUntil: opts.waitUntil || 'load' });
  return { page, errors, response };
}

// Todo [data-expect] del DOM claro existe con caja no nula y data-expect-kind, y los ids del comentario están presentes
async function checkTargets(page, ids) {
  const found = await page.evaluate(() => [...document.querySelectorAll('[data-expect]')].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.id, tag: el.tagName, w: r.width, h: r.height, kind: el.dataset.expectKind || '', expect: el.dataset.expect };
  }));
  assert.ok(found.length > 0, 'la página no tiene objetivos data-expect');
  for (const t of found) {
    assert.ok(t.w > 0 && t.h > 0, `#${t.id} (${t.tag}) tiene caja ${t.w}x${t.h}`);
    assert.ok(t.kind, `#${t.id} sin data-expect-kind`);
    assert.equal(t.kind, t.tag === 'IFRAME' ? 'frame' : t.kind, `#${t.id}: un <iframe> es kind "frame"`);
  }
  for (const id of ids) {
    assert.ok(found.some((t) => t.id === id), `#${id} del comentario expect: no está en el DOM con data-expect`);
  }
  return found;
}

// Espera a que las <img data-expect> (salvo las indicadas) hayan terminado y devuelve sus tamaños naturales
async function imgInfo(page, skip = []) {
  await page.waitForFunction((skip) => [...document.querySelectorAll('img[data-expect]')]
    .filter((i) => !skip.includes(i.id)).every((i) => i.complete), skip, { timeout: 8000 });
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll('img[data-expect]')]
    .map((i) => [i.id, { nw: i.naturalWidth, nh: i.naturalHeight, complete: i.complete, src: i.currentSrc || i.src }])));
}

// Espera a que las imágenes con esos ids (p. ej. las marcadas data-expect-skip) hayan terminado
async function waitImgs(page, ids) {
  await page.waitForFunction((ids) => ids.every((id) => {
    const i = document.getElementById(id);
    return i && i.complete;
  }), ids, { timeout: 8000 });
}

// Marco cuya URL cumple el predicado (los marcos tardan en aparecer en page.frames())
async function frameByUrl(page, pred, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    const f = page.frames().find((fr) => pred(fr.url()));
    if (f) return f;
    if (Date.now() - t0 > timeout) throw new Error('no apareció el marco; marcos: ' + page.frames().map((fr) => fr.url()).join(', '));
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Espera a que el servidor haya recibido al menos un hit en cada ruta
async function waitForHits(paths, timeout = 5000) {
  const t0 = Date.now();
  for (;;) {
    const h = srv.hits();
    if (paths.every((p) => h[p] && h[p].hits >= 1)) return h;
    if (Date.now() - t0 > timeout) throw new Error('faltan hits: ' + paths.filter((p) => !h[p]).join(', '));
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Id del elemento más alto en el centro de #id y pila completa (ids o etiquetas)
const HIT_TEST = `(id) => {
  const r = document.getElementById(id).getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  return { top: document.elementFromPoint(x, y).id, stack: document.elementsFromPoint(x, y).map((e) => e.id || e.tagName.toLowerCase()) };
}`;

// ---------- lote 1: detección (basic, overlay, pointer-events-none, spacer, lazy, background, shadow) ----------

test('basic.html: cuadrícula 3x3, píxel y spacer con data-expect-skip, tercera fila parcial y #far bajo el pliegue', { timeout: 15000 }, async () => {
  const { page, errors } = await openPage('basic');
  const found = await checkTargets(page, expectedIds('basic'));
  assert.equal(found.length, 10);
  assert.ok(found.every((t) => t.kind === 'http'));
  const info = await imgInfo(page);
  for (const id of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'far']) assert.equal(info[id].nw, 400, id);
  await waitImgs(page, ['pixel', 'spacer']);
  const st = await page.evaluate(() => {
    const rect = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
    const skip = (id) => {
      const i = document.getElementById(id);
      const r = i.getBoundingClientRect();
      return { nw: i.naturalWidth, w: r.width, h: r.height, skip: i.dataset.expectSkip, expect: i.hasAttribute('data-expect') };
    };
    return { g1: rect('g1'), g7: rect('g7'), far: rect('far'), scrollY: window.scrollY, innerHeight: window.innerHeight, pixel: skip('pixel'), spacer: skip('spacer') };
  });
  assert.equal(st.innerHeight, 720);
  assert.equal(st.scrollY, 0);
  assert.ok(st.g1.top >= 0 && st.g1.bottom <= 720, 'primera fila entera en el viewport');
  // tercera fila: parcialmente visible; la esquina superior derecha (donde va el chip) queda dentro sin scroll
  assert.ok(st.g7.top + 4 < 720 && st.g7.bottom > 720, `#g7 top=${st.g7.top} bottom=${st.g7.bottom}`);
  assert.ok(st.far.top > 720, '#far debe exigir scroll, top=' + st.far.top);
  assert.deepEqual(st.pixel, { nw: 1, w: 1, h: 1, skip: 'pixel', expect: false });
  assert.deepEqual(st.spacer, { nw: 16, w: 300, h: 300, skip: 'spacer', expect: false });
  assert.deepEqual(errors, []);
});

test('overlay.html: capas transparentes encima; el hit-test devuelve la capa, nunca la imagen', { timeout: 15000 }, async () => {
  const { page, errors } = await openPage('overlay');
  await checkTargets(page, expectedIds('overlay'));
  const info = await imgInfo(page);
  assert.equal(info.covered.nw, 400);
  assert.equal(info.pen.nw, 400);
  assert.equal(info.photo.nw, 400);
  await waitImgs(page, ['spacer']);
  const st = await page.evaluate(`(() => {
    const hit = ${HIT_TEST};
    const spacer = document.getElementById('spacer');
    const r = spacer.getBoundingClientRect();
    return {
      covered: hit('covered'), pen: hit('pen'), photo: hit('photo'),
      penPointer: getComputedStyle(document.getElementById('pen')).pointerEvents,
      spacer: { nw: spacer.naturalWidth, w: r.width, h: r.height, opacity: getComputedStyle(spacer).opacity, skip: spacer.dataset.expectSkip, expect: spacer.hasAttribute('data-expect') },
    };
  })()`);
  assert.equal(st.covered.top, 'cover-a');
  assert.ok(st.covered.stack.indexOf('cover-a') < st.covered.stack.indexOf('covered'), 'la imagen está debajo en la pila: ' + st.covered.stack);
  assert.equal(st.pen.top, 'cover-b');
  assert.equal(st.penPointer, 'none');
  assert.ok(!st.pen.stack.includes('pen'), 'pointer-events:none la excluye del hit-test: ' + st.pen.stack);
  assert.equal(st.photo.top, 'spacer', 'el spacer opacity:0 sí recibe el hit-test');
  assert.ok(st.photo.stack.includes('photo'));
  assert.deepEqual(st.spacer, { nw: 16, w: 400, h: 300, opacity: '0', skip: 'spacer', expect: false });
  assert.deepEqual(errors, []);
});

test('pointer-events-none.html: imagen grande sin nada encima que el hit-test salta', { timeout: 15000 }, async () => {
  const { page, errors } = await openPage('pointer-events-none');
  await checkTargets(page, expectedIds('pointer-events-none'));
  const info = await imgInfo(page);
  assert.equal(info.pen.nw, 800);
  const st = await page.evaluate(`(() => {
    const hit = ${HIT_TEST};
    const r = document.getElementById('pen').getBoundingClientRect();
    return { hit: hit('pen'), pointer: getComputedStyle(document.getElementById('pen')).pointerEvents, w: r.width, h: r.height };
  })()`);
  assert.equal(st.pointer, 'none');
  assert.deepEqual([st.w, st.h], [800, 600]);
  assert.equal(st.hit.top, 'wrap', 'el hit-test cae en el contenedor: hace falta el fallback geométrico');
  assert.ok(!st.hit.stack.includes('pen'));
  assert.deepEqual(errors, []);
});

test('spacer.html: spacer 16x16 y gif 1x1 estirados encima de las fotos', { timeout: 15000 }, async () => {
  const { page, errors } = await openPage('spacer');
  await checkTargets(page, expectedIds('spacer'));
  const info = await imgInfo(page);
  assert.equal(info.photo.nw, 500);
  assert.equal(info.photo2.nw, 500);
  await waitImgs(page, ['spacer', 'pixel-cover']);
  const st = await page.evaluate(`(() => {
    const hit = ${HIT_TEST};
    const skip = (id) => {
      const i = document.getElementById(id);
      const r = i.getBoundingClientRect();
      return { nw: i.naturalWidth, w: r.width, h: r.height, skip: i.dataset.expectSkip, expect: i.hasAttribute('data-expect'), data: i.src.startsWith('data:image/gif') };
    };
    return { photo: hit('photo').top, photo2: hit('photo2').top, spacer: skip('spacer'), pixel: skip('pixel-cover') };
  })()`);
  assert.equal(st.photo, 'spacer');
  assert.equal(st.photo2, 'pixel-cover');
  assert.deepEqual(st.spacer, { nw: 16, w: 500, h: 375, skip: 'spacer', expect: false, data: false });
  assert.deepEqual(st.pixel, { nw: 1, w: 500, h: 375, skip: 'pixel', expect: false, data: true });
  assert.deepEqual(errors, []);
});

test('lazy.html: placeholders 1x1 con data-src/data-srcset, <picture> y srcset con comas', { timeout: 15000 }, async () => {
  const { page, errors } = await openPage('lazy');
  await checkTargets(page, expectedIds('lazy'));
  const info = await imgInfo(page);
  // el placeholder cargado es el gif 1x1: natural 1x1 (contrato documentado en la cabecera de lazy.html)
  assert.equal(info['lazy-src'].nw, 1);
  assert.ok(info['lazy-src'].src.startsWith('data:image/gif'));
  assert.equal(info['lazy-srcset'].nw, 1);
  assert.ok(info['lazy-srcset'].src.startsWith('data:image/gif'));
  // con 1280 px de viewport, DPR 1 y sin sizes (100vw) el navegador elige el candidato 800w (el mayor);
  // naturalWidth sale corregido por densidad: 800 / (800/1280) = 1280 (por eso se comprueba la URL, no el natural)
  assert.equal(info['pic-img'].src, srv.origin + '/img/pw.png?w=800&h=600', 'debe elegir el <source type=image/webp>');
  assert.equal(info['pic-img'].nw, 1280);
  assert.equal(info.cdn.src, srv.origin + '/img/c.png?w=800&h=600&t=w_800,h_600');
  assert.equal(info.cdn.nw, 1280);
  const st = await page.evaluate(() => {
    const ls = document.getElementById('lazy-src');
    const lss = document.getElementById('lazy-srcset');
    const r = ls.getBoundingClientRect();
    return { dataSrc: ls.dataset.src, dataSrcset: lss.dataset.srcset, w: r.width, h: r.height, expect: ls.dataset.expect, expect2: lss.dataset.expect };
  });
  assert.equal(st.dataSrc, '/img/lazy.png?w=800&h=600');
  assert.equal(st.dataSrc, st.expect);
  assert.match(st.dataSrcset, /\/img\/ls\.png\?w=800&h=600 800w/);
  assert.equal(st.expect2, '/img/ls.png?w=800&h=600');
  assert.deepEqual([st.w, st.h], [400, 300], 'se juzga por el rect, no por el natural 1x1');
  assert.deepEqual(errors, []);
});

test('background.html: url(), image-set, ::before content:url() y ::after background-image', { timeout: 15000 }, async () => {
  const { page, errors } = await openPage('background');
  const found = await checkTargets(page, expectedIds('background'));
  assert.equal(found.length, 4);
  assert.ok(found.every((t) => t.tag === 'DIV' && t.kind === 'http'));
  const st = await page.evaluate(() => {
    const cs = (id, pseudo) => getComputedStyle(document.getElementById(id), pseudo);
    const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.width, r.height]; };
    return {
      bg: cs('bg').backgroundImage, bgBox: box('bg'),
      set: cs('bg-set').backgroundImage, setBox: box('bg-set'),
      before: cs('before', '::before').content, beforeBox: box('before'),
      after: cs('after', '::after').backgroundImage, afterBox: box('after'),
      imgs: document.querySelectorAll('img').length,
    };
  });
  assert.equal(st.bg, `url("${srv.origin}/img/bg.png?w=600&h=400")`);
  assert.deepEqual(st.bgBox, [600, 400]);
  assert.match(st.set, /^image-set\(/);
  // el estilo computado serializa 1x/2x como 1dppx/2dppx
  assert.ok(st.set.includes('/img/set.png?w=400&h=300") 1dppx') && st.set.includes('/img/set.png?w=800&h=600") 2dppx'), st.set);
  assert.deepEqual(st.setBox, [200, 150]);
  assert.equal(st.before, `url("${srv.origin}/img/before.png?w=300&h=300")`);
  assert.deepEqual(st.beforeBox, [300, 300]);
  assert.equal(st.after, `url("${srv.origin}/img/after.png?w=200&h=200")`);
  assert.deepEqual(st.afterBox, [200, 200]);
  assert.equal(st.imgs, 0, 'no hay <img>: todo es CSS');
  await waitForHits(['/img/bg.png', '/img/set.png', '/img/before.png', '/img/after.png']);
  assert.deepEqual(errors, []);
});

test('shadow.html: img en shadow abierto, anidado y cerrado (no atravesable)', { timeout: 15000 }, async () => {
  const { page, errors } = await openPage('shadow');
  const found = await checkTargets(page, expectedIds('shadow'));
  assert.deepEqual(found.map((t) => t.id).sort(), ['closed-host', 'nested-host', 'open-host']);
  await page.waitForFunction(() => {
    const open = document.getElementById('open-host').shadowRoot.getElementById('open-img');
    const nested = document.getElementById('nested-host').shadowRoot.getElementById('inner-host').shadowRoot.getElementById('nested-img');
    return open.complete && nested.complete;
  }, null, { timeout: 8000 });
  const st = await page.evaluate(`(() => {
    const hit = ${HIT_TEST};
    const open = document.getElementById('open-host').shadowRoot.getElementById('open-img');
    const nested = document.getElementById('nested-host').shadowRoot.getElementById('inner-host').shadowRoot.getElementById('nested-img');
    const closed = document.getElementById('closed-host');
    return {
      open: { nw: open.naturalWidth, kind: open.dataset.expectKind, expect: open.dataset.expect },
      nested: { nw: nested.naturalWidth, kind: nested.dataset.expectKind, expect: nested.dataset.expect },
      closedRoot: closed.shadowRoot, closedChildren: closed.childElementCount,
      hits: { open: hit('open-host').top, closed: hit('closed-host').top, nested: hit('nested-host').top },
      lightImgs: document.querySelectorAll('img').length,
    };
  })()`);
  assert.deepEqual(st.open, { nw: 400, kind: 'http', expect: '/img/open.png?w=400&h=300' });
  assert.deepEqual(st.nested, { nw: 400, kind: 'http', expect: '/img/nested.png?w=400&h=300' });
  assert.equal(st.closedRoot, null, 'shadowRoot cerrado no es accesible desde fuera');
  assert.equal(st.closedChildren, 0, 'el host cerrado no tiene hijos en el DOM claro');
  // elementFromPoint desde el documento retarget al host: los selectores no llegan a la img
  assert.deepEqual(st.hits, { open: 'open-host', closed: 'closed-host', nested: 'nested-host' });
  assert.equal(st.lightImgs, 0);
  const hits = await waitForHits(['/img/open.png', '/img/nested.png', '/img/closed.png']);
  assert.equal(hits['/img/closed.png'].hits, 1, 'la img del shadow cerrado sí se cargó');
  assert.deepEqual(errors, []);
});

// ---------- lote 1: marcos (iframe, iframe-inner, sandbox) ----------

test('iframe-inner.html: 3 imágenes relativas al origen del propio marco', { timeout: 15000 }, async () => {
  const { page, errors } = await openPage('iframe-inner');
  await checkTargets(page, expectedIds('iframe-inner'));
  const info = await imgInfo(page);
  assert.deepEqual([info.in1.nw, info.in2.nw, info.in3.nw], [300, 300, 300]);
  assert.deepEqual(errors, []);
});

test('iframe.html: iframe del origen alterno con 3 imágenes y botón que añade otro', { timeout: 20000 }, async () => {
  const { page, errors } = await openPage('iframe');
  const found = await checkTargets(page, expectedIds('iframe'));
  assert.deepEqual(found.map((t) => [t.id, t.tag, t.kind]).sort(), [['cross', 'IFRAME', 'frame'], ['top', 'IMG', 'http']]);
  const info = await imgInfo(page);
  assert.equal(info.top.nw, 400);
  const innerUrl = srv.altOrigin + '/pages/iframe-inner.html';
  const isInner = (u) => u === innerUrl;
  const f1 = await frameByUrl(page, isInner);
  await f1.waitForFunction(() => ['in1', 'in2', 'in3'].every((id) => document.getElementById(id).complete), null, { timeout: 8000 });
  const inner = await f1.evaluate(() => ({
    origin: location.origin,
    nws: ['in1', 'in2', 'in3'].map((id) => document.getElementById(id).naturalWidth),
    kinds: [...document.querySelectorAll('[data-expect]')].map((e) => e.dataset.expectKind),
  }));
  assert.equal(inner.origin, srv.altOrigin, 'el marco vive en el origen alterno');
  assert.deepEqual(inner.nws, [300, 300, 300]);
  assert.deepEqual(inner.kinds, ['http', 'http', 'http']);
  const cross = await page.evaluate(() => {
    const f = document.getElementById('cross');
    return { expect: f.dataset.expect, kind: f.dataset.expectKind, doc: f.contentDocument, frames: document.querySelectorAll('iframe').length };
  });
  assert.deepEqual(cross, { expect: 'iframe-inner', kind: 'frame', doc: null, frames: 1 });
  // el botón añade #cross-2 en el origen alterno; aparece como tercer marco de la página
  await page.click('#add-iframe');
  await page.waitForFunction(() => document.getElementById('cross-2') && document.getElementById('cross-2').dataset.expectKind === 'frame', null, { timeout: 5000 });
  const t0 = Date.now();
  while (page.frames().filter((f) => isInner(f.url())).length < 2) {
    assert.ok(Date.now() - t0 < 8000, 'el segundo marco no apareció');
    await new Promise((r) => setTimeout(r, 50));
  }
  const f2 = page.frames().filter((f) => isInner(f.url())).find((f) => f !== f1);
  await f2.waitForFunction(() => ['in1', 'in2', 'in3'].every((id) => document.getElementById(id).complete), null, { timeout: 8000 });
  assert.deepEqual(await f2.evaluate(() => ['in1', 'in2', 'in3'].map((id) => document.getElementById(id).naturalWidth)), [300, 300, 300]);
  assert.equal(page.frames().length, 3, 'principal + 2 marcos');
  assert.deepEqual(errors, []);
});

test('sandbox.html: iframe sandbox (origen opaco) y about:blank escrito por el padre', { timeout: 20000 }, async () => {
  const { page, errors } = await openPage('sandbox');
  const found = await checkTargets(page, expectedIds('sandbox'));
  assert.deepEqual(found.map((t) => [t.id, t.tag, t.kind]).sort(), [['blank', 'IFRAME', 'frame'], ['sandboxed', 'IFRAME', 'frame'], ['top', 'IMG', 'http']]);
  const info = await imgInfo(page);
  assert.equal(info.top.nw, 400);
  // about:blank es del mismo origen: el padre lo lee directamente
  await page.waitForFunction(() => {
    const d = document.getElementById('blank').contentDocument;
    const i = d && d.getElementById('blank-img');
    return !!(i && i.complete);
  }, null, { timeout: 8000 });
  const st = await page.evaluate(() => {
    const blank = document.getElementById('blank');
    const img = blank.contentDocument.getElementById('blank-img');
    const sb = document.getElementById('sandboxed');
    return {
      blank: { nw: img.naturalWidth, kind: img.dataset.expectKind, expect: img.dataset.expect, src: img.src, url: blank.contentWindow.location.href, origin: blank.contentWindow.origin },
      sandboxed: { doc: sb.contentDocument, sandbox: sb.getAttribute('sandbox') },
    };
  });
  // about:blank hereda el origen del padre (self.origin), aunque su location.origin sea "null"
  assert.deepEqual(st.blank, { nw: 300, kind: 'http', expect: '/img/blank.png?w=300&h=300', src: srv.origin + '/img/blank.png?w=300&h=300', url: 'about:blank', origin: srv.origin });
  assert.equal(st.sandboxed.sandbox, '', 'sandbox sin tokens');
  assert.equal(st.sandboxed.doc, null, 'origen opaco: el padre no puede leer el marco sandbox');
  const sbf = await frameByUrl(page, (u) => u === srv.origin + '/pages/iframe-inner.html');
  await sbf.waitForFunction(() => ['in1', 'in2', 'in3'].every((id) => document.getElementById(id).complete), null, { timeout: 8000 });
  const inner = await sbf.evaluate(() => ({
    origin: self.origin, // origen del documento (opaco); location.origin daría el de la URL
    locOrigin: location.origin,
    nws: ['in1', 'in2', 'in3'].map((id) => document.getElementById(id).naturalWidth),
  }));
  assert.equal(inner.origin, 'null', 'sandbox sin allow-same-origin → origen opaco');
  assert.equal(inner.locOrigin, srv.origin, 'location.origin sigue siendo el de la URL (quirk documentado)');
  assert.deepEqual(inner.nws, [300, 300, 300], 'las imágenes relativas sí cargan dentro del sandbox');
  assert.deepEqual(errors, []);
});

// ---------- lote 2: hostiles, especiales, red (csp, reset, invert, dialog, special, hotlink, cookie, zip, spa) ----------

test('csp.html: nada en línea, script y CSS externos funcionan, sin violaciones', { timeout: 15000 }, async () => {
  const { page, errors, response } = await openPage('csp');
  assert.equal(response.headers()['content-security-policy'], CSP);
  // sin comentarios HTML: el comentario superior menciona <script> y <style> como texto
  const html = fs.readFileSync(path.join(PAGES_DIR, 'csp.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'csp.html no debe tener <script> en línea');
  assert.ok(!/<style[\s>]/i.test(html) && !/\son\w+=/i.test(html), 'csp.html no debe tener <style> ni on*= en línea');
  await checkTargets(page, expectedIds('csp'));
  const info = await imgInfo(page);
  assert.equal(info.c1.nw, 300);
  assert.equal(info.c2.nw, 320);
  const st = await page.evaluate(() => ({
    js: document.documentElement.dataset.cspJs,
    bg: getComputedStyle(document.body).backgroundColor
  }));
  assert.equal(st.js, 'ok', 'csp.js no se ejecutó');
  assert.equal(st.bg, 'rgb(240, 244, 248)', 'csp.css no se aplicó');
  assert.deepEqual(errors, []);
});

test('reset.html: reset global hostil y 2 imágenes visibles', { timeout: 15000 }, async () => {
  const { page, errors } = await openPage('reset');
  await checkTargets(page, expectedIds('reset'));
  const info = await imgInfo(page);
  assert.equal(info.r1.nw, 300);
  assert.equal(info.r2.nw, 300);
  const css = await page.evaluate(() => [...document.styleSheets[0].cssRules].map((r) => r.cssText).join('\n'));
  assert.match(css, /\* \{ all: unset !important; \}/);
  assert.match(css, /imgdl-root \{ display: none !important; \}/);
  assert.match(css, /\[popover\] \{ display: none !important; \}/);
  assert.deepEqual(errors, []);
});

test('invert.html: filter en html, transform en body e imágenes muy abajo', { timeout: 15000 }, async () => {
  const { page, errors } = await openPage('invert');
  await checkTargets(page, expectedIds('invert'));
  const info = await imgInfo(page);
  assert.equal(info.i1.nw, 300);
  assert.equal(info.i2.nw, 300);
  const st = await page.evaluate(() => ({
    filter: getComputedStyle(document.documentElement).filter,
    transform: getComputedStyle(document.body).transform,
    top: document.getElementById('i1').getBoundingClientRect().top,
    scrollY: window.scrollY
  }));
  assert.match(st.filter, /invert/);
  assert.notEqual(st.transform, 'none');
  assert.equal(st.scrollY, 0);
  assert.ok(st.top > 2500, `#i1 debería estar lejos del pliegue, top=${st.top}`);
  assert.deepEqual(errors, []);
});

test('dialog.html: la imagen del diálogo solo tiene caja con el modal abierto', { timeout: 15000 }, async () => {
  const { page, errors } = await openPage('dialog');
  const before = await page.evaluate(() => {
    const r = document.getElementById('in-dialog').getBoundingClientRect();
    return { w: r.width, open: document.getElementById('dlg').open };
  });
  assert.equal(before.open, false);
  assert.equal(before.w, 0, 'con el diálogo cerrado la imagen no debe tener caja');
  await page.click('#open');
  const modal = await page.evaluate(() => {
    const d = document.getElementById('dlg');
    return { open: d.open, isModal: d.matches(':modal') };
  });
  assert.deepEqual(modal, { open: true, isModal: true });
  await checkTargets(page, expectedIds('dialog'));
  const info = await imgInfo(page);
  assert.equal(info['in-dialog'].nw, 300);
  assert.equal(info.outside.nw, 300);
  await page.click('#close');
  assert.equal(await page.evaluate(() => document.getElementById('dlg').open), false);
  assert.deepEqual(errors, []);
});

test('special.html: data, blob viva/revocada, canvas limpio/contaminado, svg con <use>, póster', { timeout: 15000 }, async () => {
  const { page, errors } = await openPage('special');
  await page.waitForFunction(() => {
    const live = document.getElementById('blob-live');
    const rev = document.getElementById('blob-revoked');
    return live.naturalWidth > 0 && rev.naturalWidth > 0 && rev.dataset.revoked === '1' &&
      document.getElementById('canvas-tainted').dataset.tainted;
  }, null, { timeout: 8000 });
  await checkTargets(page, expectedIds('special'));
  const info = await imgInfo(page);
  assert.equal(info.data.nw, 32);
  assert.ok(info.data.src.length > 1024, 'el data: debe superar placeholderDataMax (1 KB)');
  assert.ok(info['blob-live'].src.startsWith('blob:'));
  assert.ok(info['blob-revoked'].src.startsWith('blob:'));
  assert.equal(info['blob-live'].nw, 300);
  assert.equal(info['blob-revoked'].nw, 300);
  assert.deepEqual(errors, []);
  const errorsBefore = errors.length;
  const st = await page.evaluate(async () => {
    const pixel = document.getElementById('data-pixel');
    const live = await fetch(document.getElementById('blob-live').src).then((r) => r.ok).catch(() => false);
    const revoked = await fetch(document.getElementById('blob-revoked').src).then((r) => r.ok).catch(() => false);
    let clean = null;
    let taintedErr = null;
    try { clean = document.getElementById('canvas2d').toDataURL('image/png').slice(0, 15); } catch (e) { clean = 'ERR ' + e.name; }
    try { document.getElementById('canvas-tainted').toDataURL('image/png'); } catch (e) { taintedErr = e.name; }
    const use = document.querySelector('#svg use');
    const ub = use.getBoundingClientRect();
    return {
      pixelNw: pixel.naturalWidth, pixelLen: pixel.src.length, pixelSkip: pixel.dataset.expectSkip, pixelHasExpect: pixel.hasAttribute('data-expect'),
      pixelOldAttr: pixel.hasAttribute('data-skip'),
      live, revoked, clean, taintedErr, tainted: document.getElementById('canvas-tainted').dataset.tainted,
      useW: ub.width, symOutside: !document.getElementById('svg').contains(document.getElementById('sym')),
      starFill: getComputedStyle(document.querySelector('#svg use')).fill,
      poster: document.getElementById('video').getAttribute('poster')
    };
  });
  assert.equal(st.pixelNw, 2);
  assert.ok(st.pixelLen < 1024);
  assert.equal(st.pixelSkip, 'pixel', 'misma convención que el lote 1: data-expect-skip');
  assert.equal(st.pixelOldAttr, false, 'data-skip ya no se usa');
  assert.equal(st.pixelHasExpect, false);
  assert.equal(st.live, true, 'la blob: viva debe poder leerse con fetch');
  assert.equal(st.revoked, false, 'la blob: revocada no debe poder leerse con fetch');
  assert.equal(st.clean, 'data:image/png;');
  assert.equal(st.tainted, '1', 'la imagen del origen alterno no cargó');
  assert.equal(st.taintedErr, 'SecurityError', 'el canvas debería estar contaminado');
  assert.ok(st.useW > 0, 'el <use href="#sym"> no se renderiza');
  assert.equal(st.symOutside, true, 'el <symbol> debe vivir fuera del <svg> objetivo');
  assert.equal(st.poster, '/img/poster.png?w=400&h=300');
  // el único error nuevo admisible es el del sondeo fetch() a la blob: revocada
  assert.deepEqual(errors.slice(errorsBefore).filter((e) => !/ERR_FILE_NOT_FOUND @ blob:/.test(e)), []);
});

test('hotlink.html: imagen del origen alterno que exige Referer', { timeout: 15000 }, async () => {
  srv.reset();
  const { page, errors } = await openPage('hotlink');
  await checkTargets(page, expectedIds('hotlink'));
  const info = await imgInfo(page);
  assert.ok(info.h.src.startsWith(srv.altOrigin + '/hotlink/h.png'), info.h.src);
  assert.equal(info.h.nw, 300, 'el navegador debe enviar Referer y obtener 200');
  // server.js solo da 200 si el Referer empieza por el origen de la página: el 200 de arriba lo demuestra
  const hit = srv.hits()['/hotlink/h.png'];
  assert.ok(hit && hit.hits >= 1 && hit.withReferer === hit.hits, 'todos los hits llevaron Referer: ' + JSON.stringify(hit));
  assert.deepEqual(errors, []);
});

test('cookie.html: la cookie auth=1 se fija antes de cargar la imagen (mismo origen, desviación documentada)', { timeout: 15000 }, async () => {
  srv.reset();
  const { page, errors } = await openPage('cookie');
  await checkTargets(page, expectedIds('cookie'));
  const info = await imgInfo(page);
  const hit = srv.hits()['/cookie/c.png'];
  assert.equal(info.c.nw, 300, 'la imagen con cookie no cargó; hit=' + JSON.stringify(hit));
  assert.ok(info.c.src.startsWith(srv.origin + '/cookie/'), 'mismo origen que la página: ' + info.c.src);
  assert.match(await page.evaluate(() => document.cookie), /auth=1/);
  assert.ok(hit && hit.hits >= 1 && hit.withCookie >= 1, 'el servidor debe haber recibido la cookie: ' + JSON.stringify(hit));
  assert.deepEqual(errors, []);
});

test('zip.html: 6 imágenes + lenta + 400 pequeñas bajo <details>', { timeout: 20000 }, async () => {
  srv.reset(); // /fail-once.png vuelve a fallar la primera vez
  const { page, errors } = await openPage('zip', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('fail-once').naturalWidth > 0, null, { timeout: 8000 });
  await checkTargets(page, expectedIds('zip'));
  const info = await imgInfo(page, ['slow']);
  assert.equal(info.z1.nw, 300);
  assert.equal(info.z2.nw, 300);
  assert.equal(info.a1.nw, 300);
  assert.equal(info.a2.nw, 301);
  assert.equal(info.nandu.nw, 300, 'el servidor debe decodificar %C3%B1and%C3%BA');
  assert.equal(info['fail-once'].nw, 200, '/fail-once.png no admite ?w=: tamaño por defecto del servidor (200)');
  assert.equal(info['html-as-jpg'].nw, 0, 'html-as-jpg debe quedar rota');
  assert.equal(info['html-as-jpg'].complete, true);
  assert.equal(info.slow.complete, false, 'la lenta aún no debería haber cargado');
  const st = await page.evaluate(() => {
    const many = document.getElementById('many');
    const imgs = many.querySelectorAll('img.many');
    // Chrome conserva la caja (content-visibility:hidden) con <details> cerrado: lo fiable es checkVisibility()
    const closedVisible = imgs[0].checkVisibility();
    many.open = true;
    const openVisible = imgs[0].checkVisibility();
    const openBox = imgs[0].getBoundingClientRect();
    return {
      retried: document.getElementById('fail-once').dataset.retried,
      count: imgs.length,
      noExpect: [...imgs].every((i) => !i.hasAttribute('data-expect')),
      closedVisible, openVisible, openW: openBox.width, openH: openBox.height,
      nanduSrc: document.getElementById('nandu').src
    };
  });
  assert.equal(st.retried, '1');
  assert.equal(st.count, 400);
  assert.equal(st.noExpect, true);
  assert.equal(st.closedVisible, false, 'cerrado: no visible');
  assert.equal(st.openVisible, true, 'abierto: visible');
  assert.deepEqual([st.openW, st.openH], [120, 120]);
  assert.match(st.nanduSrc, /%C3%B1and%C3%BA\.png/);
  const hits = srv.hits();
  assert.equal(hits['/fail-once.png'].hits, 2, '500 + reintento');
  assert.ok(hits['/img/ñandú.png'], 'la clave de /count es la ruta decodificada');
  assert.equal(hits['/slow.png'].hits, 1, 'la lenta está pendiente en el servidor (close() la cancelará)');
  assert.deepEqual(errors, []);
});

test('spa.html: lista virtualizada que recrea nodos y pushState sin recarga', { timeout: 15000 }, async () => {
  const { page, errors } = await openPage('spa');
  const loadedAt = await page.evaluate(() => window.__spaLoadedAt);
  await checkTargets(page, ['v0']);
  const first = await page.evaluate(() => ({
    count: document.querySelectorAll('#list img').length,
    v0: !!document.getElementById('v0'),
    height: document.getElementById('list').offsetHeight
  }));
  assert.ok(first.count >= 10 && first.count <= 22, `solo ~20 ítems en el DOM, hay ${first.count}`);
  assert.equal(first.v0, true);
  assert.equal(first.height, 200 * 220);
  await page.evaluate(() => window.scrollTo(0, 100 * 220));
  await page.waitForFunction(() => document.getElementById('v100') && !document.getElementById('v0'), null, { timeout: 5000 });
  const mid = await page.evaluate(() => {
    const r = document.getElementById('v100').getBoundingClientRect();
    return { w: r.width, h: r.height, count: document.querySelectorAll('#list img').length };
  });
  assert.deepEqual([mid.w, mid.h], [300, 200]);
  assert.ok(mid.count <= 22);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => !!document.getElementById('v0'), null, { timeout: 5000 });
  await page.click('#nav2');
  await page.waitForFunction(() => !!document.getElementById('v200'), null, { timeout: 5000 });
  await checkTargets(page, ['v200']);
  const v2 = await page.evaluate(() => ({ search: location.search, scrollY: window.scrollY, loadedAt: window.__spaLoadedAt, v0: !!document.getElementById('v0') }));
  assert.equal(v2.search, '?view=2');
  assert.equal(v2.scrollY, 0);
  assert.equal(v2.loadedAt, loadedAt, 'pushState no debe recargar');
  assert.equal(v2.v0, false);
  await page.click('#nav1');
  await page.waitForFunction(() => !!document.getElementById('v0') && location.search === '?view=1', null, { timeout: 5000 });
  await page.goBack();
  await page.waitForFunction(() => !!document.getElementById('v200') && location.search === '?view=2', null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__spaLoadedAt), loadedAt, 'popstate no debe recargar');
  assert.deepEqual(errors, []);
});
