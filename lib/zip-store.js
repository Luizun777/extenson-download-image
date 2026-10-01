'use strict';
// lib/zip-store.js — escritor ZIP STORE (sin compresión), puro.
// Corre en content scripts, service worker, offscreen y Node (require).
// Formato: cabecera local 30 B + nombre + Blob; directorio central 46 B + nombre; EOCD 22 B.
(function (root) {
  const LIMITS = Object.freeze({
    MAX_ENTRIES: 65535,          // n > esto → TOO_MANY
    MAX_SIZE: 0xFFFFFFFF,        // tamaño u offset >= esto → TOO_BIG (sin ZIP64)
    MAX_NAME_BYTES: 65535,       // bytes UTF-8 del nombre > esto → NAME_TOO_LONG
    SAFE_TOTAL_BYTES: 0xFC000000 // 4 GiB − 64 MiB: tope sugerido de contenido para quien llama
  });

  const LH_SIG = 0x04034b50;
  const CD_SIG = 0x02014b50;
  const EOCD_SIG = 0x06054b50;
  const VERSION = 20;   // 2.0: cualquier lector lo abre
  const FLAGS = 0x0800; // bit 11: nombres en UTF-8
  const METHOD = 0;     // STORE

  class ZipLimitError extends Error {
    constructor(code, detail) {
      super(detail ? `ZIP ${code}: ${detail}` : `ZIP ${code}`);
      this.name = 'ZipLimitError';
      this.code = code;
    }
  }

  // ---- CRC32 (poly 0xEDB88320), tabla perezosa de 256 entradas ----
  let table = null;
  function getTable() {
    if (table) return table;
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('crc32: se esperaba Uint8Array, ArrayBuffer o string');
  }

  const crc32 = {
    init() { return 0xFFFFFFFF; },
    update(state, data) {
      const bytes = toBytes(data);
      const t = getTable();
      let c = state;
      for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
      return c >>> 0;
    },
    finish(state) { return (state ^ 0xFFFFFFFF) >>> 0; },
    ofBytes(data) { return crc32.finish(crc32.update(crc32.init(), data)); }
  };

  // ---- Fecha/hora DOS (hora local, resolución 2 s, año 1980..2107) ----
  function dosDateTime(ms) {
    const d = new Date(typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now());
    const y = d.getFullYear();
    if (y < 1980) return { time: 0, date: (0 << 9) | (1 << 5) | 1 };               // 1980-01-01 00:00:00
    if (y > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 }; // 2107-12-31 23:59:58
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  function normalizeName(name) {
    return String(name).replace(/\\/g, '/').replace(/^\/+/, '');
  }

  // CRC en streaming: el heap solo retiene un trozo a la vez.
  async function crcOfBlob(blob) {
    let state = crc32.init();
    if (blob.size === 0) return crc32.finish(state);
    const stream = blob.stream();
    if (typeof stream[Symbol.asyncIterator] === 'function') {
      for await (const chunk of stream) state = crc32.update(state, chunk);
    } else {
      // Chromium < 124 no itera ReadableStream con for-await
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        state = crc32.update(state, value);
      }
    }
    return crc32.finish(state);
  }

  function pickLastModified(entry, blob) {
    if (typeof entry.lastModified === 'number') return entry.lastModified;
    if (typeof blob.lastModified === 'number') return blob.lastModified;
    return Date.now();
  }

  // entries: [{name, blob, lastModified?}]; opts: {onProgress?({done, total, bytes})}
  async function buildStoreZip(entries, opts) {
    if (!Array.isArray(entries)) throw new TypeError('buildStoreZip: entries debe ser un array');
    const total = entries.length;
    if (total > LIMITS.MAX_ENTRIES) {
      throw new ZipLimitError('TOO_MANY', `${total} entradas > ${LIMITS.MAX_ENTRIES}`);
    }
    const onProgress = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    let bytes = 0;

    for (let i = 0; i < total; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== 'object') {
        throw new TypeError(`buildStoreZip: la entrada ${i} no es un objeto`);
      }
      const name = typeof entry.name === 'string' ? normalizeName(entry.name) : '';
      if (!name) throw new TypeError(`buildStoreZip: la entrada ${i} no tiene nombre`);
      const blob = entry.blob;
      // Un objeto que no es Blob se serializaría como '[object Object]' y el tamaño
      // declarado en la cabecera no coincidiría: exige Blob real cuando el global existe.
      const isBlob = typeof Blob !== 'undefined'
        ? blob instanceof Blob
        : (!!blob && typeof blob.size === 'number' && typeof blob.stream === 'function');
      if (!isBlob) throw new TypeError(`buildStoreZip: la entrada ${i} no tiene un Blob válido`);
      const nameBytes = enc.encode(name);
      if (nameBytes.length > LIMITS.MAX_NAME_BYTES) {
        throw new ZipLimitError('NAME_TOO_LONG', `${nameBytes.length} bytes > ${LIMITS.MAX_NAME_BYTES}`);
      }
      const size = blob.size;
      if (size >= LIMITS.MAX_SIZE) throw new ZipLimitError('TOO_BIG', `entrada de ${size} bytes`);
      const next = offset + 30 + nameBytes.length + size;
      if (next >= LIMITS.MAX_SIZE) throw new ZipLimitError('TOO_BIG', `offset ${next} bytes`);

      const crc = await crcOfBlob(blob);
      const { time, date } = dosDateTime(pickLastModified(entry, blob));

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, LH_SIG, true);
      lh.setUint16(4, VERSION, true);
      lh.setUint16(6, FLAGS, true);
      lh.setUint16(8, METHOD, true);
      lh.setUint16(10, time, true);
      lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), nameBytes, blob); // el Blob va tal cual: Chromium no lo copia

      central.push({ nameBytes, time, date, crc, size, offset });
      offset = next;
      bytes += size;
      if (onProgress) {
        try { onProgress({ done: i + 1, total, bytes }); } catch (_) { /* no rompe el ZIP */ }
      }
    }

    // Directorio central en un solo buffer
    let cdSize = 0;
    for (const c of central) cdSize += 46 + c.nameBytes.length;
    const cdOffset = offset;
    if (cdOffset + cdSize >= LIMITS.MAX_SIZE) throw new ZipLimitError('TOO_BIG', 'directorio central');
    const cd = new Uint8Array(cdSize);
    const cdv = new DataView(cd.buffer);
    let p = 0;
    for (const c of central) {
      cdv.setUint32(p, CD_SIG, true);
      cdv.setUint16(p + 4, VERSION, true);  // version made by
      cdv.setUint16(p + 6, VERSION, true);  // version needed
      cdv.setUint16(p + 8, FLAGS, true);
      cdv.setUint16(p + 10, METHOD, true);
      cdv.setUint16(p + 12, c.time, true);
      cdv.setUint16(p + 14, c.date, true);
      cdv.setUint32(p + 16, c.crc, true);
      cdv.setUint32(p + 20, c.size, true);
      cdv.setUint32(p + 24, c.size, true);
      cdv.setUint16(p + 28, c.nameBytes.length, true);
      cdv.setUint16(p + 30, 0, true); // extra
      cdv.setUint16(p + 32, 0, true); // comentario
      cdv.setUint16(p + 34, 0, true); // disco
      cdv.setUint16(p + 36, 0, true); // atributos internos
      cdv.setUint32(p + 38, 0, true); // atributos externos
      cdv.setUint32(p + 42, c.offset, true);
      cd.set(c.nameBytes, p + 46);
      p += 46 + c.nameBytes.length;
    }

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, EOCD_SIG, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, total, true);
    eocd.setUint16(10, total, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, cdOffset, true);
    eocd.setUint16(20, 0, true);

    parts.push(cd, new Uint8Array(eocd.buffer));
    return new Blob(parts, { type: 'application/zip' });
  }

  const api = { crc32, dosDateTime, buildStoreZip, ZipLimitError, LIMITS };
  root.ImgDL = root.ImgDL || {};
  root.ImgDL.zipStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
