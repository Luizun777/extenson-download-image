'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { encodePng, encodeNoisePng, colourFor, readIhdr, SIGNATURE } = require('../fixtures/png.js');

// Recorre los chunks y verifica el CRC de cada uno.
function chunks(buf) {
  assert.deepEqual(buf.subarray(0, 8), SIGNATURE, 'firma PNG');
  const out = [];
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    const crc = buf.readUInt32BE(p + 8 + len);
    assert.equal(crc, zlib.crc32(data, zlib.crc32(buf.subarray(p + 4, p + 8))), 'CRC de ' + type);
    out.push({ type, data });
    p += 12 + len;
  }
  assert.equal(p, buf.length, 'sin bytes sobrantes');
  return out;
}

test('encodePng: firma, IHDR, chunks con CRC y píxeles del color pedido', () => {
  const png = encodePng({ width: 37, height: 11, rgb: [200, 30, 99] });
  const list = chunks(png);
  assert.deepEqual(list.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  assert.deepEqual(readIhdr(png), { width: 37, height: 11, bitDepth: 8, colorType: 2, interlace: 0 });
  const raw = zlib.inflateSync(list[1].data);
  assert.equal(raw.length, 11 * (1 + 37 * 3));
  assert.equal(raw[0], 0, 'filtro 0');
  assert.deepEqual([...raw.subarray(1, 4)], [200, 30, 99], 'primer píxel');
  assert.deepEqual([...raw.subarray(raw.length - 3)], [200, 30, 99], 'último píxel');
});

test('encodePng: por defecto 200x200 y bytes idénticos entre llamadas', () => {
  const a = encodePng();
  const b = encodePng({ width: 200, height: 200, rgb: [0, 0, 0] });
  assert.deepEqual(readIhdr(a), { width: 200, height: 200, bitDepth: 8, colorType: 2, interlace: 0 });
  assert.ok(a.equals(b), 'determinista');
  assert.ok(!encodePng({ rgb: [1, 2, 3] }).equals(a), 'otro color → otros bytes');
});

test('encodePng: rechaza dimensiones inválidas', () => {
  assert.throws(() => encodePng({ width: 0 }), RangeError);
  assert.throws(() => encodePng({ height: 1.5 }), RangeError);
  assert.throws(() => encodePng({ width: -4 }), RangeError);
});

test('colourFor: determinista, en rango y distinto para nombres distintos', () => {
  const a = colourFor('a');
  assert.deepEqual(a, colourFor('a'));
  assert.equal(a.length, 3);
  for (const c of a) assert.ok(Number.isInteger(c) && c >= 0 && c <= 255);
  const seen = new Set(['a', 'b', 'c', 'g1', 'g2', 'ñandú'].map((n) => colourFor(n).join(',')));
  assert.equal(seen.size, 6, 'sin colisiones en el conjunto de prueba');
});

test('encodeNoisePng: IDAT stored de ~1 MB, descomprimible y determinista por semilla', () => {
  const png = encodeNoisePng({ mb: 1, seed: 7 });
  const list = chunks(png);
  assert.deepEqual(list.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  const hdr = readIhdr(png);
  assert.equal(hdr.colorType, 0);
  assert.equal(hdr.bitDepth, 8);
  const idat = list[1].data;
  assert.ok(Math.abs(idat.length - 1048576) < 1048576 * 0.01, 'IDAT ≈ 1 MB: ' + idat.length);
  assert.equal(idat[0], 0x78, 'cabecera zlib');
  assert.equal(((idat[0] << 8) | idat[1]) % 31, 0, 'FCHECK');
  assert.equal(idat[2] & 0x06, 0, 'primer bloque BTYPE=00 (stored)');
  const raw = zlib.inflateSync(idat); // verifica también el Adler-32
  assert.equal(raw.length, hdr.height * (1 + hdr.width));
  for (let y = 0; y < hdr.height; y += 97) assert.equal(raw[y * (1 + hdr.width)], 0, 'filtro 0 en la fila ' + y);
  // incompresible: deflate apenas reduce
  assert.ok(zlib.deflateSync(raw.subarray(0, 65536)).length > 65536 * 0.98, 'ruido incompresible');
  assert.ok(png.equals(encodeNoisePng({ mb: 1, seed: 7 })), 'misma semilla → mismos bytes');
  assert.ok(!png.equals(encodeNoisePng({ mb: 1, seed: 8 })), 'otra semilla → otros bytes');
});

test('encodeNoisePng: tamaños fraccionarios y semilla 0', () => {
  const small = encodeNoisePng({ mb: 0.1, seed: 0 });
  const idat = chunks(small)[1].data;
  assert.ok(Math.abs(idat.length - 104858) < 4096, 'IDAT ≈ 0.1 MB: ' + idat.length);
  assert.doesNotThrow(() => zlib.inflateSync(idat));
  assert.throws(() => encodeNoisePng({ mb: 0 }), RangeError);
});

test('readIhdr: null si no es PNG', () => {
  assert.equal(readIhdr(Buffer.from('hola')), null);
  assert.equal(readIhdr(Buffer.alloc(40)), null);
});
