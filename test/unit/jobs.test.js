'use strict';
// Funciones puras de background/jobs.js (sin chrome): dedupe entre marcos, estimación
// de bytes y tope blando NEEDS_CONFIRM, cambio de extensión.
const test = require('node:test');
const assert = require('node:assert/strict');
const jobs = require('../../background/jobs.js');
const { DEFAULTS } = require('../../lib/thresholds.js');
const S = require('../../lib/strings.js');

function frame(frameId, items, frameUrl) {
  return { frameId, result: { frameUrl: frameUrl || 'http://x/' + frameId, items } };
}

test('flattenSelection: claves http/data gana la primera (marco 0 primero aunque llegue después)', () => {
  const a = { key: 'http|http://x/a.png', kind: 'http', url: 'http://x/a.png', name: 'a', id: 1 };
  const b = { key: 'http|http://x/b.png', kind: 'http', url: 'http://x/b.png', name: 'b', id: 2 };
  const out = jobs.flattenSelection([frame(7, [a, b]), frame(0, [Object.assign({}, a, { id: 9 })])]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((i) => [i.frameId, i.id]), [[0, 9], [7, 2]]);
  assert.equal(out[0].frameUrl, 'http://x/0');
});

test('flattenSelection: claves byte son únicas por marco; resultados nulos o sin items se ignoran', () => {
  const c = { key: 'canvas|abc:1', kind: 'canvas', name: 'lienzo', id: 1 };
  const out = jobs.flattenSelection([frame(0, [c]), frame(3, [c]), { frameId: 4, result: null }, { frameId: 5 }, null]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((i) => i.frameId), [0, 3]);
});

test('estimateBytes: w*h*0.5 solo con tamaño conocido', () => {
  assert.equal(jobs.estimateBytes([{ w: 100, h: 100 }, { w: 0, h: 10 }, {}, { w: '20', h: '10' }]), 5000 + 100);
  assert.equal(jobs.estimateBytes([]), 0);
});

test('needsConfirm: null por debajo de los topes y con confirmBig; NEEDS_CONFIRM por archivos o bytes', () => {
  const small = Array.from({ length: 10 }, (_, i) => ({ key: 'k' + i, w: 100, h: 100 }));
  assert.equal(jobs.needsConfirm(small, false), null);
  const many = Array.from({ length: DEFAULTS.zipSoftFiles + 1 }, (_, i) => ({ key: 'k' + i, w: 10, h: 10 }));
  const r = jobs.needsConfirm(many, false);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NEEDS_CONFIRM');
  assert.equal(r.total, DEFAULTS.zipSoftFiles + 1);
  assert.equal(typeof r.estimatedBytes, 'number');
  assert.equal(r.text, S.WARN_BIG(r.total, Math.round(r.estimatedBytes / (1024 * 1024))));
  assert.equal(jobs.needsConfirm(many, true), null);
  const side = Math.ceil(Math.sqrt(DEFAULTS.zipSoftBytes / 0.5)) + 1;
  const big = jobs.needsConfirm([{ key: 'g', w: side, h: side }], false);
  assert.equal(big && big.code, 'NEEDS_CONFIRM');
  assert.equal(big.total, 1);
});

test('withExt: cambia la extensión conservando la base; misma extensión intacta', () => {
  assert.equal(jobs.withExt('foto.jpg', 'png'), 'foto.png');
  assert.equal(jobs.withExt('foto (2).jpg', 'PNG'), 'foto (2).png');
  assert.equal(jobs.withExt('foto.png', 'png'), 'foto.png');
  assert.equal(jobs.withExt('sin-ext', 'svg'), 'sin-ext.svg');
  assert.equal(jobs.withExt('foto.jpg', ''), 'foto.jpg');
});
