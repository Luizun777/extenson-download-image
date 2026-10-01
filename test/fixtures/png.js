'use strict';
// Generador de PNG determinista para los fixtures (solo node:zlib, sin dependencias).
const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NOISE_WIDTH = 2048; // ancho fijo de las imágenes de ruido (gris 8 bits)
const STORED_MAX = 65535; // bytes máximos por bloque deflate 'stored'
const MAX_DIM = 0x7fffffff;

function assertDim(n, label) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_DIM) {
    throw new RangeError('PNG: ' + label + ' inválido: ' + n);
  }
}

// FNV-1a de 32 bits → [r, g, b]; mismo nombre, mismo color.
function colourFor(name) {
  let h = 0x811c9dc5;
  for (const ch of String(name)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return [h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff];
}

function ihdr(width, height, colorType) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = 8; // profundidad de bits
  d[9] = colorType; // 2 = RGB, 0 = gris
  d[10] = 0; // compresión
  d[11] = 0; // filtro
  d[12] = 0; // sin entrelazado
  return d;
}

// Escribe un chunk (longitud, tipo, datos, CRC del tipo + datos) en `out` y devuelve el offset final.
function writeChunk(out, offset, type, data) {
  out.writeUInt32BE(data.length, offset);
  out.write(type, offset + 4, 4, 'latin1');
  data.copy(out, offset + 8);
  const crc = zlib.crc32(data, zlib.crc32(out.subarray(offset + 4, offset + 8)));
  out.writeUInt32BE(crc, offset + 8 + data.length);
  return offset + 12 + data.length;
}

// Ensambla firma + IHDR + IDAT + IEND con una sola reserva de memoria.
function assemble(ihdrData, idatData) {
  const total = 8 + (12 + 13) + (12 + idatData.length) + 12;
  const out = Buffer.allocUnsafe(total);
  SIGNATURE.copy(out, 0);
  let p = 8;
  p = writeChunk(out, p, 'IHDR', ihdrData);
  p = writeChunk(out, p, 'IDAT', idatData);
  writeChunk(out, p, 'IEND', Buffer.alloc(0));
  return out;
}

// Adler-32 de la carga sin comprimir (zlib no lo expone).
function adler32(buf) {
  let a = 1;
  let b = 0;
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const end = Math.min(i + 5552, n);
    for (; i < end; i++) {
      a += buf[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Flujo zlib con bloques 'stored' (sin compresión), construido a mano.
function storedDeflate(raw) {
  const nBlocks = Math.max(1, Math.ceil(raw.length / STORED_MAX));
  const out = Buffer.allocUnsafe(2 + raw.length + 5 * nBlocks + 4);
  out[0] = 0x78; // CMF: deflate, ventana 32K
  out[1] = 0x01; // FLG: sin diccionario, nivel 0, (0x7801 % 31 === 0)
  let p = 2;
  let q = 0;
  for (let i = 0; i < nBlocks; i++) {
    const len = Math.min(STORED_MAX, raw.length - q);
    out[p++] = i === nBlocks - 1 ? 1 : 0; // BFINAL + BTYPE 00
    out.writeUInt16LE(len, p);
    out.writeUInt16LE(len ^ 0xffff, p + 2);
    p += 4;
    raw.copy(out, p, q, q + len);
    p += len;
    q += len;
  }
  out.writeUInt32BE(adler32(raw), p);
  return out;
}

// PNG RGB de color sólido; mismos argumentos → mismos bytes.
function encodePng({ width = 200, height = 200, rgb = [0, 0, 0] } = {}) {
  assertDim(width, 'ancho');
  assertDim(height, 'alto');
  const [r, g, b] = rgb;
  const row = Buffer.alloc(1 + width * 3); // byte de filtro 0 + píxeles
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r & 0xff;
    row[2 + x * 3] = g & 0xff;
    row[3 + x * 3] = b & 0xff;
  }
  const raw = Buffer.allocUnsafe(row.length * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
  return assemble(ihdr(width, height, 2), zlib.deflateSync(raw, { level: 6 }));
}

// PNG gris cuyo IDAT es ruido xorshift32 en bloques 'stored': incompresible y determinista.
function encodeNoisePng({ mb = 1, seed = 1 } = {}) {
  if (!Number.isFinite(mb) || mb <= 0) throw new RangeError('PNG: mb inválido: ' + mb);
  const rowLen = 1 + NOISE_WIDTH;
  const height = Math.max(1, Math.round((mb * 1048576) / rowLen));
  const raw = Buffer.allocUnsafe(rowLen * height);
  let s = (Number(seed) >>> 0) || 0x9e3779b9; // xorshift no admite estado 0
  for (let i = 0; i < raw.length; i += 4) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    raw[i] = s & 0xff;
    if (i + 1 < raw.length) raw[i + 1] = (s >>> 8) & 0xff;
    if (i + 2 < raw.length) raw[i + 2] = (s >>> 16) & 0xff;
    if (i + 3 < raw.length) raw[i + 3] = (s >>> 24) & 0xff;
  }
  for (let y = 0; y < height; y++) raw[y * rowLen] = 0; // filtro 0 por fila
  return assemble(ihdr(NOISE_WIDTH, height, 0), storedDeflate(raw));
}

// Lee firma + IHDR; null si no es un PNG.
function readIhdr(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) return null;
  if (!buf.subarray(0, 8).equals(SIGNATURE)) return null;
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  };
}

module.exports = { encodePng, encodeNoisePng, colourFor, readIhdr, SIGNATURE };
