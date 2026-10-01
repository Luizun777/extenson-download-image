'use strict';
// Tests de lib/zip-store.js: CRC32, fecha DOS, archivo validado con unzip -t y python zipfile, topes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const zipStore = require('../../lib/zip-store.js');
const { crc32, dosDateTime, buildStoreZip, ZipLimitError, LIMITS } = zipStore;

const TMP = path.join(__dirname, '..', '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const PNG_SIG = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
function fakePng(len) {
  return Buffer.concat([Buffer.from(PNG_SIG), crypto.randomBytes(len)]);
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
async function writeZip(name, entries, opts) {
  const zip = await buildStoreZip(entries, opts);
  assert.equal(zip.type, 'application/zip');
  const file = path.join(TMP, name);
  fs.writeFileSync(file, Buffer.from(await zip.arrayBuffer()));
  return { zip, file };
}
function unzipTest(file) {
  const r = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
// Lee el ZIP con python zipfile y devuelve testzip() + infolist() como JSON.
const PY = `
import sys, json, zipfile, hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
    out = {'testzip': z.testzip(), 'entries': []}
    for i in z.infolist():
        out['entries'].append({
            'name': i.filename,
            'file_size': i.file_size,
            'compress_size': i.compress_size,
            'compress_type': i.compress_type,
            'utf8': bool(i.flag_bits & 0x800),
            'date_time': list(i.date_time),
            'crc': i.CRC,
            'sha256': hashlib.sha256(z.read(i)).hexdigest(),
        })
print(json.dumps(out))
`;
function pyZipfile(file) {
  const r = spawnSync('python3', ['-c', PY, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `python3 falló: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('exporta el API esperado y registra ImgDL.zipStore', () => {
  assert.equal(globalThis.ImgDL.zipStore, zipStore);
  assert.deepEqual(Object.keys(zipStore).sort(), ['LIMITS', 'ZipLimitError', 'buildStoreZip', 'crc32', 'dosDateTime']);
  assert.deepEqual(Object.keys(crc32).sort(), ['finish', 'init', 'ofBytes', 'update']);
  assert.equal(LIMITS.MAX_ENTRIES, 65535);
  assert.equal(LIMITS.MAX_SIZE, 0xFFFFFFFF);
});

test('crc32: vector "123456789" === 0xCBF43926 y por trozos == entero', () => {
  assert.equal(crc32.ofBytes('123456789'), 0xCBF43926);
  assert.equal(crc32.ofBytes(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(crc32.ofBytes(new Uint8Array(0)), 0);
  assert.equal(crc32.init(), 0xFFFFFFFF);
  const data = crypto.randomBytes(10007);
  let state = crc32.init();
  let i = 0;
  while (i < data.length) {
    const n = 1 + Math.floor(Math.random() * 500);
    state = crc32.update(state, data.subarray(i, i + n));
    i += n;
  }
  assert.equal(crc32.finish(state), crc32.ofBytes(data));
});

test('crc32: coincide con node:zlib.crc32 sobre datos aleatorios', () => {
  for (const len of [0, 1, 7, 255, 256, 4096, 70000]) {
    const data = crypto.randomBytes(len);
    assert.equal(crc32.ofBytes(data), zlib.crc32(data) >>> 0, `len=${len}`);
  }
});

test('dosDateTime: fecha fija y recorte de año 1980..2107', () => {
  // Hora local: los componentes son los mismos en cualquier zona horaria.
  const d = new Date(2024, 4, 17, 13, 45, 31); // 2024-05-17 13:45:31
  const r = dosDateTime(d.getTime());
  assert.equal(r.time, (13 << 11) | (45 << 5) | 15); // segundos/2
  assert.equal(r.date, ((2024 - 1980) << 9) | (5 << 5) | 17);
  assert.equal(r.time, 0x6DAF);
  assert.equal(r.date, 0x58B1);
  assert.deepEqual(dosDateTime(new Date(1970, 0, 1).getTime()), { time: 0, date: (1 << 5) | 1 });
  assert.deepEqual(dosDateTime(new Date(2200, 5, 1).getTime()), {
    time: (23 << 11) | (59 << 5) | 29,
    date: (127 << 9) | (12 << 5) | 31
  });
  // Sin argumento o NaN: ahora, dentro de rango
  for (const v of [undefined, NaN]) {
    const now = dosDateTime(v);
    assert.ok(now.date >= ((2020 - 1980) << 9), 'año >= 2020');
  }
});

test('buildStoreZip: archivo válido para unzip -t y python zipfile', async () => {
  const when = new Date(2024, 4, 17, 13, 45, 30).getTime();
  const inputs = [
    { name: 'a.png', bytes: fakePng(1000) },
    { name: 'ñandú 1.png', bytes: fakePng(777) },
    { name: 'sub/b.png', bytes: fakePng(3 * 65536 + 123) }, // varios trozos del stream
    { name: 'vacio.bin', bytes: Buffer.alloc(0) },
    { name: 'dir\\c.png', bytes: fakePng(10) },  // '\' → '/'
    { name: '/raiz.png', bytes: fakePng(10) }    // sin '/' inicial
  ];
  const expectedNames = ['a.png', 'ñandú 1.png', 'sub/b.png', 'vacio.bin', 'dir/c.png', 'raiz.png'];
  const entries = inputs.map((e) => ({ name: e.name, blob: new Blob([e.bytes]), lastModified: when }));
  const progress = [];
  const { zip, file } = await writeZip('store.zip', entries, { onProgress: (p) => progress.push({ ...p }) });

  // Tamaño exacto: cabeceras locales + datos + directorio central + EOCD
  const enc = new TextEncoder();
  let expectedSize = 22;
  for (let i = 0; i < inputs.length; i++) {
    const nameLen = enc.encode(expectedNames[i]).length;
    expectedSize += 30 + nameLen + inputs[i].bytes.length + 46 + nameLen;
  }
  assert.equal(zip.size, expectedSize);

  // Cabecera local 0: firma, versión 20, flags 0x0800, método 0
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.equal(buf.readUInt16LE(4), 20);
  assert.equal(buf.readUInt16LE(6), 0x0800);
  assert.equal(buf.readUInt16LE(8), 0);
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50);
  assert.equal(buf.readUInt16LE(buf.length - 22 + 10), inputs.length);

  // (1) unzip -t
  const u = unzipTest(file);
  assert.equal(u.status, 0, u.out);
  assert.match(u.out, /No errors detected/);

  // (2) python zipfile
  const py = pyZipfile(file);
  assert.equal(py.testzip, null);
  assert.deepEqual(py.entries.map((e) => e.name), expectedNames);
  py.entries.forEach((e, i) => {
    assert.equal(e.file_size, inputs[i].bytes.length, e.name);
    assert.equal(e.compress_size, inputs[i].bytes.length, e.name);
    assert.equal(e.compress_type, 0, e.name);
    assert.equal(e.utf8, true, e.name);
    assert.equal(e.crc, crc32.ofBytes(inputs[i].bytes), e.name);
    assert.equal(e.sha256, sha256(inputs[i].bytes), e.name);
    assert.deepEqual(e.date_time, [2024, 5, 17, 13, 45, 30], e.name);
  });

  // (7) onProgress: una llamada por entrada con totales acumulados
  assert.equal(progress.length, inputs.length);
  let acc = 0;
  progress.forEach((p, i) => {
    acc += inputs[i].bytes.length;
    assert.deepEqual(p, { done: i + 1, total: inputs.length, bytes: acc });
  });
});

test('buildStoreZip: archivo vacío = 22 bytes y lo aceptan unzip/zipfile', async () => {
  const { zip, file } = await writeZip('empty.zip', []);
  assert.equal(zip.size, 22);
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x06054b50);
  const u = unzipTest(file);
  if (u.status === 0) {
    assert.match(u.out, /No errors detected/);
  } else {
    // Info-ZIP avisa "zipfile is empty" con código 1: validamos con python en su lugar.
    assert.match(u.out, /empty/i);
  }
  const py = pyZipfile(file);
  assert.equal(py.testzip, null);
  assert.deepEqual(py.entries, []);
});

test('buildStoreZip: TOO_MANY con 65 536 entradas antes de hacer trabajo', async () => {
  const t0 = Date.now();
  const entries = new Array(65536).fill({ name: 'x', blob: new Blob([]) });
  await assert.rejects(buildStoreZip(entries), (e) => {
    assert.ok(e instanceof ZipLimitError);
    assert.equal(e.code, 'TOO_MANY');
    assert.equal(e.name, 'ZipLimitError');
    return true;
  });
  assert.ok(Date.now() - t0 < 1000, 'validación inmediata');
});

// Blob real (vacío) con `size` declarado a mano: buildStoreZip exige instanceof Blob.
// Con readable=false, stream() lanza para demostrar que el tope se comprueba
// ANTES de leer los bytes.
function fakeBlob(size, readable) {
  const b = new Blob([]);
  Object.defineProperty(b, 'size', { value: size });
  if (!readable) {
    Object.defineProperty(b, 'stream', { value() { throw new Error('stream() no debería llamarse'); } });
  }
  return b;
}

test('buildStoreZip: TOO_BIG con tamaño 0xFFFFFFFF sin leer el stream', async () => {
  await assert.rejects(buildStoreZip([{ name: 'big.bin', blob: fakeBlob(0xFFFFFFFF, false) }]), (e) => {
    assert.ok(e instanceof ZipLimitError);
    assert.equal(e.code, 'TOO_BIG');
    return true;
  });
});

test('buildStoreZip: TOO_BIG cuando el offset acumulado alcanza 0xFFFFFFFF', async () => {
  const entries = [
    { name: 'a', blob: fakeBlob(0x80000000, true) },  // pasa: 2 GiB
    { name: 'b', blob: fakeBlob(0x80000000, false) }  // offset resultante >= 4 GiB − 1
  ];
  await assert.rejects(buildStoreZip(entries), (e) => e instanceof ZipLimitError && e.code === 'TOO_BIG');
});

test('buildStoreZip: nombre de más de 65 535 bytes → NAME_TOO_LONG', async () => {
  const entries = [{ name: 'x'.repeat(65536), blob: new Blob([]) }];
  await assert.rejects(buildStoreZip(entries), (e) => e instanceof ZipLimitError && e.code === 'NAME_TOO_LONG');
  const ok = await buildStoreZip([{ name: 'y'.repeat(65535), blob: new Blob([]) }]);
  assert.equal(ok.size, 22 + 30 + 65535 + 46 + 65535);
});

test('buildStoreZip: entrada sin Blob válido → TypeError', async () => {
  await assert.rejects(buildStoreZip([{ name: 'x' }]), TypeError);
  await assert.rejects(buildStoreZip('no'), TypeError);
});

test('buildStoreZip: objeto que imita a Blob (size + stream) → TypeError, no ZIP corrupto', async () => {
  const impostor = { size: 5, stream() { return new ReadableStream({ start(c) { c.close(); } }); } };
  await assert.rejects(buildStoreZip([{ name: 'f.bin', blob: impostor }]), TypeError);
  // Un Blob real con size sobrescrito sí pasa la validación de tipo.
  const ok = await buildStoreZip([{ name: 'f.bin', blob: fakeBlob(0, true) }]);
  assert.equal(ok.size, 22 + 30 + 5 + 46 + 5);
});

test('buildStoreZip: nombre ausente, vacío, no cadena o solo "/" → TypeError', async () => {
  const blob = new Blob([]);
  await assert.rejects(buildStoreZip([{ blob }]), /no tiene nombre/);
  await assert.rejects(buildStoreZip([{ name: '', blob }]), /no tiene nombre/);
  await assert.rejects(buildStoreZip([{ name: 7, blob }]), /no tiene nombre/);
  await assert.rejects(buildStoreZip([{ name: '///', blob }]), /no tiene nombre/);
  await assert.rejects(buildStoreZip([null]), TypeError);
  await assert.rejects(buildStoreZip(['x']), TypeError);
});

test('buildStoreZip: onProgress que lanza no rompe el ZIP', async () => {
  let calls = 0;
  const zip = await buildStoreZip(
    [{ name: 'a', blob: new Blob([new Uint8Array(3)]) }, { name: 'b', blob: new Blob([new Uint8Array(2)]) }],
    { onProgress: () => { calls++; throw new Error('ui rota'); } }
  );
  assert.equal(calls, 2, 'se sigue llamando tras lanzar');
  assert.equal(zip.size, 22 + (30 + 1 + 3 + 46 + 1) + (30 + 1 + 2 + 46 + 1));
});
