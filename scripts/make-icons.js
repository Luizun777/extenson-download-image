'use strict';
// Genera icons/icon{16,32,48,128}.png sin dependencias: fondo azul redondeado,
// flecha de descarga y bandeja en blanco. Supermuestreo 4x para suavizar.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Coordenadas normalizadas 0..1. Devuelve [r,g,b,a] del punto.
function shade(u, v) {
  const BG = [26, 115, 232], FG = [255, 255, 255];
  // Cuadrado redondeado (radio 0.22) centrado.
  const r = 0.22, x = Math.abs(u - 0.5) - (0.5 - r), y = Math.abs(v - 0.5) - (0.5 - r);
  const dx = Math.max(x, 0), dy = Math.max(y, 0);
  if (Math.hypot(dx, dy) > r) return [0, 0, 0, 0];
  // Bandeja: barra horizontal inferior.
  if (v >= 0.74 && v <= 0.82 && u >= 0.22 && u <= 0.78) return [...FG, 255];
  // Flecha: asta vertical.
  if (u >= 0.44 && u <= 0.56 && v >= 0.18 && v <= 0.58) return [...FG, 255];
  // Flecha: punta (triángulo con vértice en v=0.68).
  const tipY = 0.68, baseY = 0.46, half = 0.22;
  if (v >= baseY && v <= tipY) {
    const w = half * (tipY - v) / (tipY - baseY);
    if (Math.abs(u - 0.5) <= w) return [...FG, 255];
  }
  return [...BG, 255];
}

function render(size) {
  const SS = 4, rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const [cr, cg, cb, ca] = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
      r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
    }
    const i = (py * size + px) * 4, n = SS * SS;
    if (a > 0) { rgba[i] = Math.round(r / a); rgba[i + 1] = Math.round(g / a); rgba[i + 2] = Math.round(b / a); }
    rgba[i + 3] = Math.round(a / n);
  }
  return encodePng(size, size, rgba);
}

const out = path.join(__dirname, '..', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  const file = path.join(out, `icon${s}.png`);
  fs.writeFileSync(file, render(s));
  console.log(file, fs.statSync(file).size, 'bytes');
}
