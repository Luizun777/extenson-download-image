'use strict';
// content/resolve.js en Chromium "a pelo" (sin extensión): se inyectan los módulos en
// el orden de inyección y se llama a ImgDL.resolve.* sobre las páginas de fixtures y
// sobre HTML inline. No hace falta la extensión: resolve no usa chrome.*.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { startServer } = require('../fixtures/server.js');

const ROOT = path.resolve(__dirname, '..', '..');
// Mismo orden que tabs.CONTENT_FILES hasta content/resolve.js.
const FILES = ['lib/strings.js', 'lib/urls.js', 'lib/thresholds.js', 'lib/names.js', 'content/resolve.js'];
const VIEWPORT = { width: 1280, height: 720 };
const GIF_1X1 = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

let srv;
let browser;
const pages = [];

test.before(async () => {
  srv = await startServer();
  browser = await chromium.launch({ channel: 'chromium', headless: true });
});

test.after(async () => {
  for (const p of pages) await p.close().catch(() => {});
  if (browser) await browser.close();
  if (srv) await srv.close();
});

async function inject(target) {
  for (const f of FILES) await target.addScriptTag({ path: path.join(ROOT, f) });
}

// Espera a que todas las <img> del documento (o marco) hayan terminado (load o error).
function waitImages(target) {
  return target.evaluate(() => Promise.all(Array.from(document.images, (i) => (i.complete ? null : new Promise((r) => {
    i.addEventListener('load', r, { once: true });
    i.addEventListener('error', r, { once: true });
  })))));
}

async function newPage() {
  const page = await browser.newPage({ viewport: VIEWPORT });
  pages.push(page);
  return page;
}

async function open(name) {
  const page = await newPage();
  await page.goto(srv.origin + '/pages/' + name + '.html', { waitUntil: 'load' });
  await waitImages(page);
  await inject(page);
  return page;
}

// HTML inline servido sobre el origen del servidor (setContent conserva la URL del documento).
async function openInline(html) {
  const page = await newPage();
  await page.goto(srv.origin + '/pages/basic.html', { waitUntil: 'load' });
  await page.setContent(html, { waitUntil: 'load' });
  await waitImages(page);
  await inject(page);
  return page;
}

// Resuelve cada selector → {sel, expect, expectKind, ref}.
function resolveAll(target, selectors) {
  return target.evaluate((sels) => sels.map((sel) => {
    const el = document.querySelector(sel);
    return { sel, expect: el.dataset.expect, expectKind: el.dataset.expectKind, ref: ImgDL.resolve.resolveImageRef(el) };
  }), selectors);
}

function assertHttp(r, origin) {
  assert.ok(r.ref, r.sel + ': ref nulo');
  assert.equal(r.ref.kind, r.expectKind, r.sel + ': kind');
  assert.equal(r.ref.url, origin + r.expect, r.sel + ': url');
  assert.equal(r.ref.key, 'http|' + origin + r.expect, r.sel + ': key');
  assert.ok(Number.isInteger(r.ref.id) && r.ref.id > 0, r.sel + ': id');
}

test('basic.html: todas las [data-expect] → http con la URL esperada; pixel y spacer → null', async () => {
  const page = await open('basic');
  const sels = ['#g1', '#g2', '#g3', '#g4', '#g5', '#g6', '#g7', '#g8', '#g9', '#far'];
  const rs = await resolveAll(page, sels);
  for (const r of rs) assertHttp(r, srv.origin);
  const g1 = rs[0].ref;
  assert.deepEqual(Object.keys(g1).sort(), ['alt', 'h', 'id', 'key', 'kind', 'name', 'url', 'w']);
  assert.equal(g1.name, 'g1');
  assert.equal(g1.alt, 'g1');
  assert.equal(g1.w, 400);
  assert.equal(g1.h, 300);
  assert.equal(g1.fullSizeHint, undefined);

  // placeholders: píxel 1x1 y spacer 16x16 (natural <= 16 ya cargado) → null
  const skipped = await page.evaluate(() => ['#pixel', '#spacer'].map((s) => ImgDL.resolve.resolveImageRef(document.querySelector(s))));
  assert.deepEqual(skipped, [null, null]);

  // elementIdOf: estable por elemento, distinto entre elementos, y es el id del ref
  const ids = await page.evaluate(() => {
    const R = ImgDL.resolve;
    const a = document.getElementById('g1');
    const b = document.getElementById('g2');
    return [R.elementIdOf(a), R.elementIdOf(a), R.elementIdOf(b), R.resolveImageRef(a).id, R.elementIdOf(null)];
  });
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
  assert.equal(ids[3], ids[0]);
  assert.equal(ids[4], 0);

  // entradas no válidas → null, sin lanzar
  const bad = await page.evaluate(() => {
    const R = ImgDL.resolve;
    return [R.resolveImageRef(null), R.resolveImageRef(document.createTextNode('x')), R.resolveImageRef(document), R.hasLazyAttr(null)];
  });
  assert.deepEqual(bad, [null, null, null, false]);
});

test('re-inyección del script en el mismo marco: frameInstanceId e ids de elemento no cambian', async () => {
  const page = await open('basic');
  const before = await page.evaluate(() => {
    const R = ImgDL.resolve;
    return { fid: R.frameInstanceId, id: R.elementIdOf(document.getElementById('g3')), key: R.resolveImageRef(document.getElementById('g3')).key };
  });
  await page.addScriptTag({ path: path.join(ROOT, 'content/resolve.js') });
  const after = await page.evaluate(() => {
    const R = ImgDL.resolve;
    return { fid: R.frameInstanceId, id: R.elementIdOf(document.getElementById('g3')), key: R.resolveImageRef(document.getElementById('g3')).key, fresh: R.elementIdOf(document.getElementById('g4')) };
  });
  assert.equal(after.fid, before.fid);
  assert.equal(after.id, before.id);
  assert.equal(after.key, before.key);
  assert.ok(after.fresh > before.id, 'el contador continúa, no se reinicia');
});

test('lazy.html: data-src, data-srcset (800w), <picture> (source elegido) y srcset con comas CDN', async () => {
  const page = await open('lazy');
  const sels = ['#lazy-src', '#lazy-srcset', '#pic-img', '#cdn'];
  const rs = await resolveAll(page, sels);
  for (const r of rs) assertHttp(r, srv.origin);
  assert.equal(rs[0].ref.name, 'lazy');

  // el <picture> resuelve a su <img>
  const pic = await page.evaluate(() => ImgDL.resolve.resolveImageRef(document.getElementById('pic')));
  assert.equal(pic.url, srv.origin + '/img/pw.png?w=800&h=600');

  const lazyFlags = await page.evaluate((s) => s.map((sel) => ImgDL.resolve.hasLazyAttr(document.querySelector(sel))), sels);
  assert.deepEqual(lazyFlags, [true, true, false, false]);
});

test('background.html: capa url(), image-set 2dppx, ::before content:url y ::after background-image', async () => {
  const page = await open('background');
  const rs = await resolveAll(page, ['#bg', '#before', '#after', '#bg-set']);
  for (const r of rs) assertHttp(r, srv.origin);
  assert.equal(rs[0].ref.w, 600);
  assert.equal(rs[0].ref.h, 400);
  assert.equal(rs[0].ref.name, 'bg');

  const r = await page.evaluate(() => {
    const R = ImgDL.resolve;
    const set = document.getElementById('bg-set');
    const before = document.getElementById('before');
    const cs = getComputedStyle(before);
    return {
      set: R.backgroundRefs(set, getComputedStyle(set)).map((x) => x.url),
      setNullCs: R.backgroundRefs(set, null).map((x) => x.url),
      beforePlain: R.backgroundRefs(before, cs).map((x) => x.url),
      beforePseudo: R.backgroundRefs(before, cs, { includePseudo: true }).map((x) => x.url),
      beforeNoPseudo: R.resolveImageRef(before, { includePseudo: false }),
      afterPseudo: R.backgroundRefs(document.getElementById('after'), null, { includePseudo: true }).map((x) => x.url)
    };
  });
  assert.deepEqual(r.set, [srv.origin + '/img/set.png?w=800&h=600']);
  assert.deepEqual(r.setNullCs, r.set);
  assert.deepEqual(r.beforePlain, []);
  assert.deepEqual(r.beforePseudo, [srv.origin + '/img/before.png?w=300&h=300']);
  assert.equal(r.beforeNoPseudo, null);
  assert.deepEqual(r.afterPseudo, [srv.origin + '/img/after.png?w=200&h=200']);
});

test('backgroundRefs: capas en orden de pintado, gradientes omitidos, fondo lazy data-bg(-hidpi)', async () => {
  const o = srv.origin;
  const page = await openInline(`
    <div id="m" style="width:200px;height:200px;background-image:linear-gradient(red,blue),url(${o}/img/top.png?w=100&h=100),url('${o}/img/bottom.png?w=100&h=100')"></div>
    <div id="lz" style="width:200px;height:200px" data-bg="${o}/img/lz.png?w=100&h=100" data-bg-hidpi="${o}/img/lz.png?w=200&h=200"></div>
    <div id="lz1" style="width:200px;height:200px" data-bg="${o}/img/lz1.png?w=100&h=100"></div>
    <div id="none" style="width:200px;height:200px"></div>
  `);
  const r = await page.evaluate(() => {
    const R = ImgDL.resolve;
    const m = document.getElementById('m');
    const none = document.getElementById('none');
    return {
      m: R.backgroundRefs(m, getComputedStyle(m)).map((x) => x.url),
      mHover: R.resolveImageRef(m).url,
      lz: R.resolveImageRef(document.getElementById('lz')).url,
      lz1: R.resolveImageRef(document.getElementById('lz1')).url,
      lzLazy: R.hasLazyAttr(document.getElementById('lz')),
      none: R.resolveImageRef(none),
      noneRefs: R.backgroundRefs(none, null, { includePseudo: true })
    };
  });
  assert.deepEqual(r.m, [o + '/img/top.png?w=100&h=100', o + '/img/bottom.png?w=100&h=100']);
  assert.equal(r.mHover, o + '/img/top.png?w=100&h=100');
  assert.equal(r.lz, o + '/img/lz.png?w=200&h=200');
  assert.equal(r.lz1, o + '/img/lz1.png?w=100&h=100');
  assert.equal(r.lzLazy, true);
  assert.equal(r.none, null);
  assert.deepEqual(r.noneRefs, []);
});

test('special.html: data, blob (clave con elementId), canvas, svg (elemento raíz) y póster de vídeo', async () => {
  const page = await open('special');
  await page.waitForFunction(() => {
    const a = document.getElementById('blob-live');
    const b = document.getElementById('blob-revoked');
    return a.src.startsWith('blob:') && a.complete && a.naturalWidth > 0 && b.dataset.revoked === '1';
  });
  const r = await page.evaluate(() => {
    const R = ImgDL.resolve;
    const by = (id) => document.getElementById(id);
    const refs = {};
    for (const id of ['data', 'data-pixel', 'blob-live', 'blob-revoked', 'canvas2d', 'canvas-tainted', 'svg', 'video']) refs[id] = R.resolveImageRef(by(id));
    return {
      refs,
      fid: R.frameInstanceId,
      ids: { blobLive: R.elementIdOf(by('blob-live')), canvas: R.elementIdOf(by('canvas2d')), svg: R.elementIdOf(by('svg')) },
      dataSrc: by('data').getAttribute('src'),
      blobSrc: by('blob-live').src,
      rectInSvg: R.resolveImageRef(by('svg').querySelector('rect')),
      useInSvg: R.resolveImageRef(by('svg').querySelector('use'))
    };
  });
  assert.equal(typeof r.fid, 'string');
  assert.ok(r.fid.length >= 8, 'frameInstanceId: ' + r.fid);

  const d = r.refs.data;
  assert.equal(d.kind, 'data');
  assert.equal(d.url, r.dataSrc, 'data: URL intacta (sin stripHash ni re-serializar)');
  assert.equal(d.key, 'data|' + r.dataSrc);
  assert.equal(d.name, 'data');
  assert.equal(d.w, 200);
  assert.equal(r.refs['data-pixel'], null, 'data: de 79 B → placeholder');

  const bl = r.refs['blob-live'];
  assert.equal(bl.kind, 'blob');
  assert.equal(bl.url, r.blobSrc);
  assert.equal(bl.id, r.ids.blobLive);
  assert.equal(bl.key, 'blob|' + r.fid + ':' + r.ids.blobLive);
  assert.equal(bl.w, 300);
  assert.equal(bl.alt, 'blob viva');
  const br = r.refs['blob-revoked'];
  assert.equal(br.kind, 'blob');
  assert.notEqual(br.key, bl.key);

  const c = r.refs.canvas2d;
  assert.equal(c.kind, 'canvas');
  assert.equal(c.key, 'canvas|' + r.fid + ':' + r.ids.canvas);
  assert.equal(c.url, undefined);
  assert.equal(c.name, 'canvas2d');
  assert.equal(c.w, 300);
  assert.equal(r.refs['canvas-tainted'].kind, 'canvas');

  const s = r.refs.svg;
  assert.equal(s.kind, 'svg');
  assert.equal(s.key, 'svg|' + r.fid + ':' + r.ids.svg);
  assert.equal(s.url, undefined);
  assert.equal(s.alt, 'logo');
  assert.equal(s.name, 'logo');
  assert.equal(s.w, 200);
  assert.equal(s.h, 200);
  assert.equal(r.rectInSvg.key, s.key, 'un hijo del svg resuelve al <svg> raíz');
  assert.equal(r.useInSvg.key, s.key);

  const v = r.refs.video;
  assert.equal(v.kind, 'http');
  assert.equal(v.url, srv.origin + '/img/poster.png?w=400&h=300');
  assert.equal(v.name, 'poster');
});

test('shadow.html: img en shadow abierto y en shadow anidado; los hosts (divs vacíos) → null', async () => {
  const page = await open('shadow');
  const r = await page.evaluate(() => {
    const R = ImgDL.resolve;
    const open = document.getElementById('open-host').shadowRoot.getElementById('open-img');
    const nested = document.getElementById('nested-host').shadowRoot.getElementById('inner-host').shadowRoot.getElementById('nested-img');
    return {
      open: R.resolveImageRef(open),
      nested: R.resolveImageRef(nested),
      hosts: ['open-host', 'closed-host', 'nested-host'].map((id) => R.resolveImageRef(document.getElementById(id)))
    };
  });
  assert.equal(r.open.kind, 'http');
  assert.equal(r.open.url, srv.origin + '/img/open.png?w=400&h=300');
  assert.equal(r.nested.kind, 'http');
  assert.equal(r.nested.url, srv.origin + '/img/nested.png?w=400&h=300');
  assert.deepEqual(r.hosts, [null, null, null]);
});

test('iframe-inner.html: como página y dentro del iframe de otro origen (base del propio marco)', async () => {
  const page = await open('iframe-inner');
  const rs = await resolveAll(page, ['#in1', '#in2', '#in3']);
  for (const r of rs) assertHttp(r, srv.origin);

  const outer = await newPage();
  await outer.goto(srv.origin + '/pages/iframe.html', { waitUntil: 'load' });
  const handle = await outer.waitForSelector('iframe#cross');
  const frame = await handle.contentFrame();
  await frame.waitForLoadState('load');
  await inject(frame);
  await inject(outer);
  const inner = await frame.evaluate(() => ['#in1', '#in2', '#in3'].map((s) => {
    const el = document.querySelector(s);
    return { expect: el.dataset.expect, url: ImgDL.resolve.resolveImageRef(el).url };
  }));
  for (const r of inner) assert.equal(r.url, srv.altOrigin + r.expect);
  const fids = [await outer.evaluate(() => ImgDL.resolve.frameInstanceId), await frame.evaluate(() => ImgDL.resolve.frameInstanceId)];
  assert.notEqual(fids[0], fids[1], 'frameInstanceId distinto por marco');
  // el <iframe> en sí no se resuelve (lo hace la instancia de su marco)
  assert.equal(await outer.evaluate(() => ImgDL.resolve.resolveImageRef(document.getElementById('cross'))), null);
});

test('fullSizeHint: <a href> con extensión de imagen (<= 6 niveles, cruzando shadow DOM); /wiki/File:X.jpg se acepta', async () => {
  const o = srv.origin;
  const img = (id) => `<img id="${id}" src="${o}/img/t.png?w=300&h=300" width="300" height="300" alt="${id}">`;
  const wrap = (n, inner) => {
    let s = inner;
    for (let i = 0; i < n; i++) s = `<div>${s}</div>`;
    return s;
  };
  const page = await openInline(`
    <a href="${o}/full/big.jpg">${img('a')}</a>
    <a href="${o}/wiki/File:Foo.jpg">${img('b')}</a>
    <a href="${o}/gallery/1">${img('c')}</a>
    <a href="${o}/img/t.png?w=300&h=300">${img('d')}</a>
    <a href="${o}/full/deep6.png">${wrap(5, img('e'))}</a>
    <a href="${o}/full/deep7.png">${wrap(6, img('f'))}</a>
    <a href="${o}/full/bg.webp"><div id="g" style="width:200px;height:200px;background-image:url(${o}/img/t.png?w=300&h=300)"></div></a>
    <a href="${o}/full/shadow.jpg"><div id="h"></div></a>
    <a href="${o}/full/canvas.png"><canvas id="i" width="100" height="100"></canvas></a>
    <a href="${o}/full/hash.jpg#frag">${img('j')}</a>
    <a href="javascript:void(0)">${img('k')}</a>
    <a href="${o}/full/big.JPEG?x=1">${img('l')}</a>
  `);
  const r = await page.evaluate((origin) => {
    const R = ImgDL.resolve;
    const hint = (id) => (R.resolveImageRef(document.getElementById(id)) || {}).fullSizeHint;
    const out = {};
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'i', 'j', 'k', 'l']) out[id] = hint(id);
    const root = document.getElementById('h').attachShadow({ mode: 'open' });
    const im = document.createElement('img');
    im.src = origin + '/img/t.png?w=300&h=300';
    im.width = 300;
    im.height = 300;
    root.append(im);
    out.h = hint('h') === undefined ? R.resolveImageRef(im).fullSizeHint : 'host-resolvio';
    out.anchorSelf = R.closestAnchorHref(document.querySelector('a'), 6);
    return out;
  }, o);
  assert.equal(r.a, o + '/full/big.jpg');
  assert.equal(r.b, o + '/wiki/File:Foo.jpg', 'parece imagen por extensión; la guarda MIME lo descarta después');
  assert.equal(r.c, undefined, 'sin extensión de imagen');
  assert.equal(r.d, undefined, 'misma URL que la imagen');
  assert.equal(r.e, o + '/full/deep6.png', '6 niveles: se acepta');
  assert.equal(r.f, undefined, '7 niveles: fuera del alcance');
  assert.equal(r.g, o + '/full/bg.webp', 'fondo CSS dentro de un enlace');
  assert.equal(r.h, o + '/full/shadow.jpg', 'cruza el límite del shadow root');
  assert.equal(r.i, o + '/full/canvas.png', 'tipo byte también lleva la pista');
  assert.equal(r.j, o + '/full/hash.jpg', 'sin fragmento');
  assert.equal(r.k, undefined, 'javascript: no vale');
  assert.equal(r.l, o + '/full/big.JPEG?x=1', 'extensión sin distinguir mayúsculas; la query no estorba');
  assert.equal(r.anchorSelf, o + '/full/big.jpg', 'el propio elemento cuenta como nivel 0');
});

test('hasLazyAttr: true con cualquier atributo lazy no vacío; false sin ellos o vacíos', async () => {
  const page = await openInline(`
    <img id="l1" data-src="/x.png"> <img id="l2" data-srcset="/x.png 1x"> <img id="l3" data-lazy-src="/x.png">
    <img id="l4" data-lazy-srcset="/x.png 1x"> <img id="l5" data-original="/x.png"> <img id="l6" data-url="/x.png">
    <div id="l7" data-bg="/x.png"></div> <div id="l8" data-bg-hidpi="/x.png"></div>
    <img id="n1" alt="plain"> <img id="n2" data-src=""> <img id="n3" data-src="   "> <img id="n4" data-sizes="auto" loading="lazy"> <div id="n5"></div>
  `);
  const r = await page.evaluate(() => {
    const f = (id) => ImgDL.resolve.hasLazyAttr(document.getElementById(id));
    return {
      yes: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'].map(f),
      no: ['n1', 'n2', 'n3', 'n4', 'n5'].map(f)
    };
  });
  assert.deepEqual(r.yes, [true, true, true, true, true, true, true, true]);
  assert.deepEqual(r.no, [false, false, false, false, false]);
});

test('<img>/<video>/<input>: densidades 2x, imagen rota conserva su src, LQIP con data-src, pósteres y esquemas no válidos', async () => {
  const o = srv.origin;
  const page = await openInline(`
    <img id="dens" src="${o}/img/d.png?w=100&h=100" srcset="${o}/img/d.png?w=100&h=100 1x, ${o}/img/d.png?w=200&h=200 2x" width="100" height="100">
    <img id="broken" src="${o}/nope/missing.png" width="100" height="100" alt="rota">
    <img id="lqip" src="${o}/img/lq.png?w=20&h=20" data-src="${o}/img/lq.png?w=400&h=400" width="400" height="400">
    <img id="stretch" src="${o}/img/lq2.png?w=20&h=20" width="400" height="400" alt="sin lazy">
    <img id="gifph" src="${GIF_1X1}" width="100" height="100" alt="solo placeholder">
    <img id="generic" src="${o}/img/image.png?w=50&h=50" width="100" height="100" alt="Mi Foto">
    <input id="inp" type="image" src="${o}/img/btn.png?w=100&h=100" width="100" height="100">
    <video id="v1" data-poster="${o}/img/dp.png?w=100&h=100" width="100" height="100"></video>
    <video id="v2" width="100" height="100"></video>
    <video id="v3" poster="${GIF_1X1}" data-poster="${o}/img/dp3.png?w=100&h=100" width="100" height="100"></video>
    <video id="v4" poster="${o}/img/p4.png?w=100&h=100" data-poster="${o}/img/dp4.png?w=100&h=100" width="100" height="100"></video>
    <img id="jsurl" src="javascript:void(0)" width="100" height="100">
  `);
  const r = await page.evaluate(() => {
    const R = ImgDL.resolve;
    const out = {};
    for (const id of ['dens', 'broken', 'lqip', 'stretch', 'gifph', 'generic', 'inp', 'v1', 'v2', 'v3', 'v4', 'jsurl']) out[id] = R.resolveImageRef(document.getElementById(id));
    out.brokenFacts = { complete: document.getElementById('broken').complete, nw: document.getElementById('broken').naturalWidth };
    return out;
  });
  assert.equal(r.dens.url, o + '/img/d.png?w=200&h=200', 'mayor densidad');
  assert.deepEqual(r.brokenFacts, { complete: true, nw: 0 });
  assert.equal(r.broken.url, o + '/nope/missing.png', 'rota (natural 0) no es placeholder: el error llega al descargar');
  assert.equal(r.lqip.url, o + '/img/lq.png?w=400&h=400', 'LQIP: gana el candidato lazy');
  assert.equal(r.stretch.url, o + '/img/lq2.png?w=20&h=20', 'natural 20 > 16 sin atributo lazy: no es placeholder');
  assert.equal(r.gifph, null, 'gif 1x1 sin alternativa → null');
  assert.equal(r.generic.name, 'Mi Foto', 'base genérica (image) → alt');
  assert.equal(r.inp.url, o + '/img/btn.png?w=100&h=100');
  assert.equal(r.v1.url, o + '/img/dp.png?w=100&h=100', 'data-poster');
  assert.equal(r.v2, null, 'vídeo sin póster');
  assert.equal(r.v3.url, o + '/img/dp3.png?w=100&h=100', 'poster placeholder → data-poster');
  assert.equal(r.v4.url, o + '/img/p4.png?w=100&h=100', 'poster real gana a data-poster');
  assert.equal(r.jsurl, null);
});

test('<svg> inline: <image href|xlink:href> bajo el punto → http; fuera → svg raíz; hijos y svg anidados → la raíz', async () => {
  const o = srv.origin;
  const page = await openInline(`
    <svg id="s" width="200" height="200" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" style="display:block" aria-label="escena">
      <rect id="r" width="200" height="200" fill="#ccc"/>
      <image id="im1" href="${o}/img/sv1.png?w=100&h=100" x="0" y="0" width="100" height="100"/>
      <image id="im2" xlink:href="${o}/img/sv2.png?w=100&h=100" x="100" y="100" width="100" height="100"/>
      <svg id="inner" x="0" y="100" width="100" height="100"><circle id="c" cx="50" cy="50" r="40"/></svg>
    </svg>
    <svg id="small" width="20" height="20" style="display:block"><rect width="20" height="20"/></svg>
  `);
  const r = await page.evaluate(() => {
    const R = ImgDL.resolve;
    const s = document.getElementById('s');
    const b = s.getBoundingClientRect();
    const at = (dx, dy) => ({ x: b.left + dx, y: b.top + dy });
    return {
      root: R.resolveImageRef(s),
      p1: R.resolveImageRef(s, { point: at(50, 50) }),
      p2: R.resolveImageRef(s, { point: at(150, 150) }),
      p3: R.resolveImageRef(s, { point: at(150, 50) }),
      im1: R.resolveImageRef(document.getElementById('im1')),
      circle: R.resolveImageRef(document.getElementById('c')),
      innerSvg: R.resolveImageRef(document.getElementById('inner')),
      rectWithPoint: R.resolveImageRef(document.getElementById('r'), { point: at(50, 50) }),
      outer: R.outermostSvg(document.getElementById('c')) === s,
      outerOfHtml: R.outermostSvg(document.body),
      small: R.resolveImageRef(document.getElementById('small')),
      // detect pasa el punto como opts.point; opts.x/opts.y también vale
      p1xy: R.resolveImageRef(s, { x: b.left + 50, y: b.top + 50 }),
      imageAt: (R.svgImageAt(s, at(50, 50)) || {}).id || null,
      imageAtNone: R.svgImageAt(s, at(150, 50)),
      imageAtBogus: [R.svgImageAt(null, at(50, 50)), R.svgImageAt(s, null), R.svgImageAt(s, { x: 'a', y: 1 })]
    };
  });
  assert.deepEqual(r.p1xy, r.p1, 'opts.x/opts.y equivale a opts.point');
  assert.equal(r.imageAt, 'im1');
  assert.equal(r.imageAtNone, null);
  assert.deepEqual(r.imageAtBogus, [null, null, null]);
  assert.equal(r.root.kind, 'svg');
  assert.equal(r.root.w, 200);
  assert.equal(r.root.alt, 'escena');
  assert.equal(r.p1.kind, 'http');
  assert.equal(r.p1.url, o + '/img/sv1.png?w=100&h=100');
  assert.equal(r.p1.w, 100, 'rect del <image>');
  assert.equal(r.p2.kind, 'http');
  assert.equal(r.p2.url, o + '/img/sv2.png?w=100&h=100', 'xlink:href');
  assert.equal(r.p3.kind, 'svg');
  assert.equal(r.p3.key, r.root.key);
  assert.equal(r.im1.url, o + '/img/sv1.png?w=100&h=100', 'el propio <image> sin punto');
  assert.equal(r.circle.key, r.root.key);
  assert.equal(r.innerSvg.key, r.root.key, 'svg anidado → raíz');
  assert.equal(r.rectWithPoint.url, o + '/img/sv1.png?w=100&h=100', 'desde un hijo, el <image> bajo el punto gana');
  assert.equal(r.outer, true);
  assert.equal(r.outerOfHtml, null);
  assert.equal(r.small.kind, 'svg', 'resolve no filtra por tamaño (eso es de detect/thresholds)');
});

test('data-url (atributo débil): cuenta si parece imagen o el src es placeholder; una ficha HTML junto a un src real se ignora', async () => {
  const o = srv.origin;
  const page = await openInline(`
    <img id="w1" src="${o}/img/real.png?w=300&h=300" data-url="${o}/product/123" width="300" height="300" alt="w1">
    <img id="w2" src="${GIF_1X1}" data-url="/product/123" width="300" height="300" alt="w2">
    <img id="w3" src="${o}/img/real.png?w=300&h=300" data-url="/full/big.jpg" width="300" height="300" alt="w3">
    <img id="w4" src="${o}/img/sp.png?w=16&h=16" data-url="/product/456" width="300" height="300" alt="w4">
    <img id="w5" data-url="data:image/png;base64,AAAA" width="100" height="100" alt="w5">
    <div id="w6" data-url="/product/123" style="width:200px;height:200px"></div>
    <img id="w7" src="${o}/img/real.png?w=300&h=300" data-url="javascript:void(0)" width="300" height="300" alt="w7">
  `);
  const r = await page.evaluate(() => {
    const R = ImgDL.resolve;
    const out = {};
    for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']) {
      const el = document.getElementById(id);
      const ref = R.resolveImageRef(el);
      out[id] = { lazy: R.hasLazyAttr(el), url: ref ? ref.url : null };
    }
    return out;
  });
  assert.deepEqual(r.w1, { lazy: false, url: o + '/img/real.png?w=300&h=300' }, 'ficha HTML: se ignora, gana el src y no se pierde el filtro por tamaño natural');
  assert.deepEqual(r.w2, { lazy: true, url: o + '/product/123' }, 'src placeholder: el data-url es la única pista');
  assert.deepEqual(r.w3, { lazy: true, url: o + '/full/big.jpg' }, 'extensión de imagen: cuenta');
  assert.deepEqual(r.w4, { lazy: true, url: o + '/product/456' }, 'src natural <= 16 (spacer): cuenta');
  assert.deepEqual(r.w5, { lazy: true, url: 'data:image/png;base64,AAAA' }, 'data: cuenta');
  assert.deepEqual(r.w6, { lazy: false, url: null }, 'en un <div> solo contaría con extensión de imagen');
  assert.deepEqual(r.w7, { lazy: false, url: o + '/img/real.png?w=300&h=300' }, 'esquema no válido: se ignora');
});

test('pseudoRefs: content:none/normal → []; content:url() antes que background-image; pcs opcional, limit y rect', async () => {
  const o = srv.origin;
  const page = await openInline(`
    <style>
      #pn::before { content: none; background-image: url(${o}/img/ghost.png?w=50&h=50); }
      #pb::before { content: url(${o}/img/a.png?w=100&h=100); background-image: url(${o}/img/b.png?w=100&h=100); display: block; }
      #pa::after { content: ""; display: block; width: 100px; height: 100px; background-image: url(${o}/img/c.png?w=100&h=100), url(${o}/img/d.png?w=100&h=100); }
    </style>
    <div id="pn" style="width:200px;height:200px"></div>
    <div id="pb" style="width:200px;height:200px"></div>
    <div id="pa" style="width:200px;height:200px"></div>
  `);
  const r = await page.evaluate(() => {
    const R = ImgDL.resolve;
    const by = (id) => document.getElementById(id);
    const urlsOf = (refs) => refs.map((x) => x.url);
    return {
      none: urlsOf(R.pseudoRefs(by('pn'), '::before', null)),
      noneViaBg: urlsOf(R.backgroundRefs(by('pn'), null, { includePseudo: true })),
      noneHover: R.resolveImageRef(by('pn')),
      both: urlsOf(R.pseudoRefs(by('pb'), '::before', null)),
      bothPcs: urlsOf(R.pseudoRefs(by('pb'), '::before', getComputedStyle(by('pb'), '::before'))),
      bothViaBg: urlsOf(R.backgroundRefs(by('pb'), null, { includePseudo: true })),
      after: urlsOf(R.pseudoRefs(by('pa'), '::after', null)),
      afterLimit: urlsOf(R.pseudoRefs(by('pa'), '::after', null, { limit: 1 })),
      afterBefore: urlsOf(R.pseudoRefs(by('pa'), '::before', null)),
      afterRect: R.pseudoRefs(by('pa'), '::after', null, { rect: { x: 0, y: 0, w: 100, h: 100 } }).map((x) => [x.w, x.h]),
      bogus: [R.pseudoRefs(null, '::before'), R.pseudoRefs(document.createTextNode('x'), '::before')]
    };
  });
  assert.deepEqual(r.none, [], 'content:none → no se genera');
  assert.deepEqual(r.noneViaBg, []);
  assert.equal(r.noneHover, null);
  assert.deepEqual(r.both, [o + '/img/a.png?w=100&h=100'], 'content:url() gana');
  assert.deepEqual(r.bothPcs, r.both, 'con pcs ya leído, lo mismo');
  assert.deepEqual(r.bothViaBg, r.both, 'backgroundRefs delega en la misma regla');
  assert.deepEqual(r.after, [o + '/img/c.png?w=100&h=100', o + '/img/d.png?w=100&h=100'], 'capas en orden de pintado');
  assert.deepEqual(r.afterLimit, [o + '/img/c.png?w=100&h=100']);
  assert.deepEqual(r.afterBefore, [], 'content:normal → no se genera');
  assert.deepEqual(r.afterRect, [[100, 100], [100, 100]], 'opts.rect fija w/h');
  assert.deepEqual(r.bogus, [[], []]);
});
