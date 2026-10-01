'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { DEFAULTS, classifyFacts } = require(path.join(__dirname, '..', '..', 'lib', 'thresholds.js'));

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

test('DEFAULTS exactos', () => {
  assert.deepEqual(DEFAULTS, {
    hoverMin: 40, svgMin: 48, pixelMax: 2, spacerNaturalMax: 16, spacerRenderedMin: 64,
    placeholderDataMax: 1024, lqipRatio: 0.25, maxStack: 12, maxShadowDepth: 3, maxStyleReads: 6,
    geoAncestors: 5, geoCandidates: 50, chipDelayMs: 150, rectMargin: 8, badgeCap: 300,
    fetchConcurrency: 4, fetchTimeoutMs: 30000, filesConcurrency: 4, zipSoftFiles: 300,
    zipSoftBytes: GiB, zipHardBytes: 4 * GiB - 64 * MiB, zipMaxEntries: 65535,
    maxItemBytes: 32 * MiB, preferFullSizeLink: true, folder: 'Imagenes',
    frameDebounceMs: 500, progressThrottleMs: 250, offscreenIdleMs: 10000
  });
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.equal(globalThis.ImgDL.thresholds.classifyFacts, classifyFacts);
});

const img = (rect, natural, extra) => Object.assign(
  { tag: 'img', rect: { w: rect[0], h: rect[1] }, natural: natural ? { w: natural[0], h: natural[1] } : null, complete: natural !== null, isSvgRoot: false },
  extra || {}
);

test('tabla de decisión en modo hover', () => {
  const rows = [
    // [descripción, facts, reason]
    ['imagen normal', img([300, 200], [1200, 800]), 'ok'],
    ['justo en el mínimo 40x40', img([40, 40], [40, 40]), 'ok'],
    ['píxel de seguimiento natural 1x1 estirado', img([300, 300], [1, 1]), 'pixel'],
    ['natural 2 de alto', img([100, 100], [500, 2]), 'pixel'],
    ['rect 1x1 aunque natural grande', img([1, 1], [800, 600]), 'pixel'],
    ['rect 0x0 (display:none)', img([0, 0], [800, 600]), 'pixel'],
    ['spacer 16x16 estirado a 64 de ancho', img([64, 10], [16, 16]), 'spacer'],
    ['spacer 8x8 estirado en alto', img([30, 400], [8, 8]), 'spacer'],
    ['icono 16x16 renderizado 16x16 no es spacer sino small', img([16, 16], [16, 16]), 'small'],
    ['natural 17x17 estirado a 100 no es spacer (y supera hoverMin)', img([100, 100], [17, 17]), 'ok'],
    ['pequeña 39x100', img([39, 100], [39, 100]), 'small'],
    ['pequeña 100x39', img([100, 39], [400, 156]), 'small'],
    ['no cargada (complete=false): se juzga por rect, ok', img([200, 200], null, { complete: false, natural: { w: 0, h: 0 } }), 'ok'],
    ['no cargada: se juzga por rect, small', img([30, 30], null, { complete: false }), 'small'],
    ['natural null con rect grande', img([120, 120], null), 'ok'],
    ['natural 0x0 (rota) con complete=true: solo rect', img([120, 120], [0, 0], { complete: true }), 'ok'],
    ['svg raíz 48x48', { tag: 'svg', rect: { w: 48, h: 48 }, natural: null, complete: true, isSvgRoot: true }, 'ok'],
    ['svg raíz 47x100', { tag: 'svg', rect: { w: 47, h: 100 }, natural: null, complete: true, isSvgRoot: true }, 'svg-small'],
    ['svg raíz 100x47 (tag en mayúsculas sin isSvgRoot)', { tag: 'SVG', rect: { w: 100, h: 47 }, natural: null, complete: true }, 'svg-small'],
    ['svg raíz 2x2 es pixel', { tag: 'svg', rect: { w: 2, h: 2 }, natural: null, complete: true, isSvgRoot: true }, 'pixel'],
    ['canvas 40x40', { tag: 'canvas', rect: { w: 40, h: 40 }, natural: null, complete: true }, 'ok'],
    ['canvas 39x40', { tag: 'canvas', rect: { w: 39, h: 40 }, natural: null, complete: true }, 'small'],
    ['facts vacíos', {}, 'pixel'],
    ['rect con NaN', { tag: 'img', rect: { w: NaN, h: 100 }, natural: null }, 'pixel']
  ];
  for (const [desc, facts, reason] of rows) {
    const r = classifyFacts(facts, 'hover');
    assert.deepEqual(r, { accept: reason === 'ok', reason }, desc);
  }
});

test('modo select: natural >= 100x100, o rect >= 64x64 si natural desconocido', () => {
  assert.deepEqual(classifyFacts(img([50, 50], [100, 100]), 'select'), { accept: true, reason: 'ok' });
  assert.deepEqual(classifyFacts(img([50, 50], [99, 100]), 'select'), { accept: false, reason: 'small' });
  assert.deepEqual(classifyFacts(img([300, 300], [80, 80]), 'select'), { accept: false, reason: 'small' });
  assert.deepEqual(classifyFacts(img([64, 64], null), 'select'), { accept: true, reason: 'ok' });
  assert.deepEqual(classifyFacts(img([63, 64], null), 'select'), { accept: false, reason: 'small' });
  assert.deepEqual(classifyFacts(img([200, 200], null, { complete: false, natural: { w: 0, h: 0 } }), 'select'), { accept: true, reason: 'ok' });
  // pixel/spacer/svg siguen aplicando en select.
  assert.equal(classifyFacts(img([300, 300], [1, 1]), 'select').reason, 'pixel');
  assert.equal(classifyFacts(img([64, 10], [16, 16]), 'select').reason, 'spacer');
  assert.equal(classifyFacts({ tag: 'svg', rect: { w: 47, h: 47 }, isSvgRoot: true }, 'select').reason, 'svg-small');
  // modo desconocido => hover.
  assert.equal(classifyFacts(img([50, 50], [80, 80]), 'otro').reason, 'ok');
});

test('umbrales personalizados', () => {
  const t = Object.assign({}, DEFAULTS, { hoverMin: 100, svgMin: 10, pixelMax: 5, spacerNaturalMax: 32, spacerRenderedMin: 200 });
  assert.equal(classifyFacts(img([99, 200], [99, 200]), 'hover', t).reason, 'small');
  assert.equal(classifyFacts(img([200, 200], [5, 200]), 'hover', t).reason, 'pixel');
  assert.equal(classifyFacts(img([200, 20], [32, 32]), 'hover', t).reason, 'spacer');
  assert.equal(classifyFacts(img([199, 20], [32, 32]), 'hover', t).reason, 'small');
  assert.equal(classifyFacts({ tag: 'svg', rect: { w: 10, h: 10 }, isSvgRoot: true }, 'hover', t).reason, 'ok');
});

test('umbrales parciales se fusionan con DEFAULTS: las reglas sin clave siguen activas', () => {
  const t = { hoverMin: 100 }; // solo hoverMin; pixelMax/spacer*/svgMin deben salir de DEFAULTS
  assert.equal(classifyFacts(img([300, 300], [1, 1]), 'hover', t).reason, 'pixel');
  assert.equal(classifyFacts(img([1, 1], [800, 600]), 'hover', t).reason, 'pixel');
  assert.equal(classifyFacts(img([64, 10], [16, 16]), 'hover', t).reason, 'spacer');
  assert.equal(classifyFacts({ tag: 'svg', rect: { w: 47, h: 100 }, isSvgRoot: true }, 'hover', t).reason, 'svg-small');
  // La clave presente sí se aplica.
  assert.equal(classifyFacts(img([99, 200], [99, 200]), 'hover', t).reason, 'small');
  assert.equal(classifyFacts(img([100, 200], [100, 200]), 'hover', t).reason, 'ok');
  // t vacío o DEFAULTS congelado se comportan igual que sin t; DEFAULTS no se muta.
  assert.deepEqual(classifyFacts(img([10, 10], [10, 10]), 'hover', {}), classifyFacts(img([10, 10], [10, 10]), 'hover'));
  assert.deepEqual(classifyFacts(img([10, 10], [10, 10]), 'hover', DEFAULTS), { accept: false, reason: 'small' });
  assert.equal(DEFAULTS.hoverMin, 40);
});

test('hasLazyAttr: placeholder 1x1 con data-src se juzga solo por el rect', () => {
  const lazy = { tag: 'img', rect: { w: 400, h: 300 }, natural: { w: 1, h: 1 }, complete: true, hasLazyAttr: true };
  assert.deepEqual(classifyFacts(lazy, 'hover'), { accept: true, reason: 'ok' });
  const spacerLazy = { tag: 'img', rect: { w: 300, h: 300 }, natural: { w: 16, h: 16 }, complete: true, hasLazyAttr: true };
  assert.deepEqual(classifyFacts(spacerLazy, 'hover'), { accept: true, reason: 'ok' });
  // Sin atributo lazy, las mismas medidas siguen siendo píxel / spacer.
  assert.equal(classifyFacts({ ...lazy, hasLazyAttr: false }, 'hover').reason, 'pixel');
  assert.equal(classifyFacts({ ...spacerLazy, hasLazyAttr: false }, 'hover').reason, 'spacer');
  // El rect diminuto sigue siendo píxel aunque haya atributo lazy.
  assert.equal(classifyFacts({ tag: 'img', rect: { w: 1, h: 1 }, natural: null, hasLazyAttr: true }, 'hover').reason, 'pixel');
});
