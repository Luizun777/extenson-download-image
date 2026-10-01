'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const names = require(path.join(__dirname, '..', '..', 'lib', 'names.js'));
const {
  sanitizeComponent, buildBaseName, extFromUrl, extFromMime, extFromDataUrl, extForRef,
  sniffExt, isImageMime, dedupeNames, stamp, buildPaths, planNames, joinPath
} = names;

const bytes = (...xs) => Uint8Array.from(xs);
const ascii = (s) => Uint8Array.from(Buffer.from(s, 'latin1'));

describe('patrón de módulo', () => {
  test('expone ImgDL.names y module.exports con las mismas funciones', () => {
    assert.equal(globalThis.ImgDL.names, names);
    const expected = ['sanitizeComponent', 'buildBaseName', 'extFromUrl', 'extFromMime', 'extFromDataUrl', 'extForRef',
      'sniffExt', 'isImageMime', 'dedupeNames', 'stamp', 'buildPaths', 'planNames', 'joinPath'];
    assert.deepEqual(Object.keys(names).sort(), expected.sort());
    for (const k of expected) assert.equal(typeof names[k], 'function', k);
  });
});

describe('sanitizeComponent', () => {
  test('nombres reservados de Windows reciben prefijo "_" (también con extensión)', () => {
    assert.equal(sanitizeComponent('NUL.txt'), '_NUL.txt');
    assert.equal(sanitizeComponent('CON'), '_CON');
    assert.equal(sanitizeComponent('con'), '_con');
    assert.equal(sanitizeComponent('prn.jpg'), '_prn.jpg');
    assert.equal(sanitizeComponent('AUX'), '_AUX');
    assert.equal(sanitizeComponent('com1.png'), '_com1.png');
    assert.equal(sanitizeComponent('LPT9'), '_LPT9');
    assert.equal(sanitizeComponent('nul.tar.gz'), '_nul.tar.gz');
    assert.equal(sanitizeComponent('CLOCK$'), '_CLOCK$');
    assert.equal(sanitizeComponent('conin$'), '_conin$');
    assert.equal(sanitizeComponent('CONOUT$'), '_CONOUT$');
    assert.equal(sanitizeComponent('desktop.ini'), '_desktop.ini');
    assert.equal(sanitizeComponent('Thumbs.db'), '_Thumbs.db');
  });

  test('nombres parecidos a reservados no se tocan', () => {
    assert.equal(sanitizeComponent('COM10.jpg'), 'COM10.jpg');
    assert.equal(sanitizeComponent('nulo.png'), 'nulo.png');
    assert.equal(sanitizeComponent('console.png'), 'console.png');
    assert.equal(sanitizeComponent('thumbs.db.png'), 'thumbs.db.png');
  });

  test('extensiones integradas con el shell y CLSID reciben sufijo "_"', () => {
    assert.equal(sanitizeComponent('a.lnk'), 'a.lnk_');
    assert.equal(sanitizeComponent('a.LNK'), 'a.LNK_');
    assert.equal(sanitizeComponent('a.local'), 'a.local_');
    assert.equal(sanitizeComponent('a.scf'), 'a.scf_');
    assert.equal(sanitizeComponent('a.url'), 'a.url_');
    assert.equal(sanitizeComponent('a.{00020D75-0000-0000-C000-000000000046}'), 'a.{00020D75-0000-0000-C000-000000000046}_');
    assert.equal(sanitizeComponent('a.lnk.png'), 'a.lnk.png');
  });

  test('caracteres ilegales " * / : < > ? \\ | y % pasan a "_"', () => {
    assert.equal(sanitizeComponent('foo%20bar'), 'foo_20bar');
    assert.equal(sanitizeComponent('a"b*c/d:e<f>g?h\\i|j'), 'a_b_c_d_e_f_g_h_i_j');
    assert.equal(sanitizeComponent('dir\\sub.png'), 'dir_sub.png');
  });

  test('caracteres de control pasan a "_"; formato/no-caracteres se eliminan (desviación deliberada de la espec.)', () => {
    assert.equal(sanitizeComponent('a\u0000b\u001fc\u007fd'), 'a_b_c_d');
    assert.equal(sanitizeComponent('foo​bar'), 'foobar');
    assert.equal(sanitizeComponent('foo‍‎­bar'), 'foobar');
    assert.equal(sanitizeComponent('﻿foo.png'), 'foo.png');
    assert.equal(sanitizeComponent('a﷐b￾c￿d'), 'abcd');
    assert.equal(sanitizeComponent('a\u{1fffe}b\u{10ffff}c'), 'abc');
  });

  test('espacios en blanco (incluido tab/salto) se colapsan a uno', () => {
    assert.equal(sanitizeComponent('a   b'), 'a b');
    assert.equal(sanitizeComponent('a\t\nb'), 'a b');
    assert.equal(sanitizeComponent('a b'), 'a b');
  });

  test('espacios, puntos y tildes al principio y al final se recortan', () => {
    assert.equal(sanitizeComponent('  foo.jpg. . '), 'foo.jpg');
    assert.equal(sanitizeComponent('foo~'), 'foo');
    assert.equal(sanitizeComponent('~foo'), 'foo');
    assert.equal(sanitizeComponent('...foo...'), 'foo');
    assert.equal(sanitizeComponent(' . ~ foo ~ . '), 'foo');
  });

  test('"~" interior se sustituye (desviación deliberada: nombres cortos 8.3 en Windows)', () => {
    assert.equal(sanitizeComponent('PROGRA~1'), 'PROGRA_1');
    assert.equal(sanitizeComponent('a~b.png'), 'a_b.png');
  });

  test('vacío, nulo o solo puntos -> "imagen"', () => {
    assert.equal(sanitizeComponent(''), 'imagen');
    assert.equal(sanitizeComponent(null), 'imagen');
    assert.equal(sanitizeComponent(undefined), 'imagen');
    assert.equal(sanitizeComponent('...'), 'imagen');
    assert.equal(sanitizeComponent(' \t '), 'imagen');
    assert.equal(sanitizeComponent('.'), 'imagen');
    assert.equal(sanitizeComponent('..'), 'imagen');
  });

  test('normaliza a NFC', () => {
    assert.equal(sanitizeComponent('café.png'), 'café.png');
    assert.equal(sanitizeComponent('ñandú.png'), 'ñandú.png'.normalize('NFC'));
  });

  test('tope de 120 conservando la extensión', () => {
    const long = 'x'.repeat(296) + '.png';
    assert.equal(long.length, 300);
    const out = sanitizeComponent(long);
    assert.equal(out.length, 120);
    assert.ok(out.endsWith('.png'));
    assert.ok(out.startsWith('xxxx'));
    assert.equal(sanitizeComponent('y'.repeat(120)).length, 120);
    assert.equal(sanitizeComponent('y'.repeat(121)).length, 120);
  });

  test('tope personalizado y recorte que no deja espacio ni punto al final del tallo', () => {
    assert.equal(sanitizeComponent('abcdefghij.png', 8), 'abcd.png');
    assert.equal(sanitizeComponent('abc defghij.png', 8), 'abc.png');
    assert.equal(sanitizeComponent('abc.defghij.png', 8), 'abc.png');
  });

  test('tope en bytes UTF-8 para nombres multibyte (NAME_MAX de macOS/Linux)', () => {
    const out = sanitizeComponent('漢'.repeat(120) + '.png');
    assert.ok(out.endsWith('.png'));
    assert.ok(Buffer.byteLength(out, 'utf8') <= 200, String(Buffer.byteLength(out, 'utf8')));
    assert.ok(Array.from(out).length < 120);
  });

  test('no parte pares sustitutos al recortar', () => {
    const out = sanitizeComponent('😀'.repeat(130) + '.png');
    assert.ok(out.endsWith('.png'));
    assert.ok(out.isWellFormed(), 'sin sustitutos sueltos');
    assert.ok(Array.from(out.slice(0, -4)).length <= 116);
    assert.ok(Buffer.byteLength(out, 'utf8') <= 200);
    assert.equal(out.normalize('NFC'), out);
  });

  test('el recorte al tope no deja al descubierto una extensión del shell, un CLSID ni un reservado', () => {
    const SHELL = /\.(lnk|local|scf|url)$|\.\{[^.]*\}$/i;
    const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
    const CLSID = '.{00020D75-0000-0000-C000-000000000046}';
    const inputs = [
      'x'.repeat(116) + '.lnk' + 'y'.repeat(50),
      'x'.repeat(116) + '.url' + 'y'.repeat(50),
      'x'.repeat(106) + '.url' + 'y'.repeat(50),
      'x'.repeat(104) + '.local' + 'y'.repeat(50),
      'a'.repeat(81) + CLSID + 'y'.repeat(50),
      'a'.repeat(71) + CLSID + 'y'.repeat(50),
      'con.' + 'x'.repeat(200),
      'con.{' + '0'.repeat(113) + '}X'
    ];
    for (const max of [120, 110]) {
      for (const s of inputs) {
        const out = sanitizeComponent(s, max);
        assert.ok(out.length <= max, `${max}: ${out.length} (${out.slice(-20)})`);
        assert.ok(!SHELL.test(out), `${max}: termina en "${out.slice(-20)}"`);
        assert.ok(!RESERVED.test(out), `${max}: empieza por "${out.slice(0, 10)}"`);
        assert.equal(sanitizeComponent(out, max), out, `${max}: idempotente`);
      }
    }
    assert.equal(sanitizeComponent('x'.repeat(116) + '.lnk' + 'y'.repeat(50)), 'x'.repeat(115) + '.lnk_');
    assert.match(sanitizeComponent('con.' + 'x'.repeat(200)), /^_con\.x+$/);
  });

  test('fuzz determinista: tope, sin shell/CLSID/reservado e idempotente', () => {
    const SHELL = /\.(lnk|local|scf|url)$|\.\{[^.]*\}$/i;
    const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)(?:\..*)?$/i;
    const parts = ['x', 'x', '.', '{', '}', '-', '0', 'lnk', 'url', 'scf', 'local', 'con', 'nul', ' ', '~', '😀', '漢', '​'];
    let seed = 12345;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let k = 0; k < 2000; k++) {
      let s = '';
      const len = 1 + rnd(260);
      while (s.length < len) s += parts[rnd(parts.length)];
      for (const max of [120, 110]) {
        const out = sanitizeComponent(s, max);
        assert.ok(Array.from(out).length <= max, `${max}: ${JSON.stringify(s)}`);
        assert.ok(Buffer.byteLength(out, 'utf8') <= 201, `${max}: bytes ${JSON.stringify(s)}`);
        assert.ok(!SHELL.test(out), `${max}: shell ${JSON.stringify(s)} -> ${JSON.stringify(out)}`);
        assert.ok(!RESERVED.test(out), `${max}: reservado ${JSON.stringify(s)} -> ${JSON.stringify(out)}`);
        assert.ok(!/^[\s.~]|[\s.~]$/.test(out), `${max}: extremos ${JSON.stringify(out)}`);
        assert.equal(sanitizeComponent(out, max), out, `${max}: idempotente ${JSON.stringify(s)}`);
      }
    }
  });

  test('es idempotente', () => {
    const inputs = ['NUL.txt', 'a.lnk', 'foo%20bar', ' . ~x~ . ', 'x'.repeat(300) + '.png', 'a​b'];
    for (const s of inputs) {
      const once = sanitizeComponent(s);
      assert.equal(sanitizeComponent(once), once, s);
    }
  });
});

describe('buildBaseName', () => {
  test('último segmento decodificado sin query/hash y sin extensión de imagen', () => {
    assert.equal(buildBaseName({ url: 'https://cdn.x/img/Foto%20Bonita.JPG?w=1#top', alt: 'x', index: 1 }), 'Foto Bonita');
    assert.equal(buildBaseName({ url: 'https://x/a/foto/' }), 'foto');
    assert.equal(buildBaseName({ url: 'https://x/ab.png?x=1#y' }), 'ab');
    assert.equal(buildBaseName({ url: 'https://x/photo.2024.webp' }), 'photo.2024');
  });

  test('rutas relativas: "/wiki/File:Foo.jpg" -> "File_Foo"', () => {
    assert.equal(buildBaseName({ url: '/wiki/File:Foo.jpg' }), 'File_Foo');
  });

  test('desenvuelve URLs de proxy (param url= con URL absoluta)', () => {
    assert.equal(buildBaseName({ url: 'https://proxy.example/?url=' + encodeURIComponent('https://cdn.example/gato.png') }), 'gato');
  });

  test('bases genéricas o cortas -> alt (60 caracteres) o imagen-NNN', () => {
    assert.equal(buildBaseName({ url: 'https://x/image.png', alt: 'Un gato muy bonito', index: 3 }), 'Un gato muy bonito');
    assert.equal(buildBaseName({ url: 'https://x/thumb.jpg', alt: '', index: 7 }), 'imagen-007');
    assert.equal(buildBaseName({ url: 'https://x/index.jpg', alt: '   ', index: 12 }), 'imagen-012');
    assert.equal(buildBaseName({ url: 'https://x/default.jpg', index: 0 }), 'imagen-000');
    assert.equal(buildBaseName({ url: 'https://x/a', index: 2 }), 'imagen-002');
    assert.equal(buildBaseName({ url: 'https://x/', alt: 'Logo' }), 'Logo');
    assert.equal(buildBaseName({ url: 'https://x/', alt: '' }), 'imagen');
    assert.equal(buildBaseName({}), 'imagen');
    const longAlt = 'palabra '.repeat(20).trim();
    const out = buildBaseName({ url: 'https://x/image.png', alt: longAlt, index: 1 });
    assert.ok(Array.from(out).length <= 60);
    assert.ok(longAlt.startsWith(out));
  });

  test('data: y blob: no aportan base', () => {
    assert.equal(buildBaseName({ url: 'data:image/png;base64,AAAA', alt: '', index: 0 }), 'imagen-000');
    assert.equal(buildBaseName({ url: 'blob:https://x/550e8400-e29b-41d4-a716-446655440000', alt: 'Lienzo', index: 1 }), 'Lienzo');
  });

  test('la base vuelve saneada y con tope', () => {
    assert.equal(buildBaseName({ url: 'https://x/NUL.jpg' }), '_NUL');
    assert.equal(buildBaseName({ url: 'https://x/a%3Cb%3E.png' }), 'a_b_');
    const base = buildBaseName({ url: 'https://x/' + 'z'.repeat(300) + '.png' });
    assert.ok(Array.from(base).length <= 100);
  });
});

describe('extFromUrl / extFromMime / extFromDataUrl / extForRef / isImageMime', () => {
  test('extFromUrl: solo ruta, lista blanca, jpeg -> jpg', () => {
    assert.equal(extFromUrl('https://x/a.JPEG?y=1'), 'jpg');
    assert.equal(extFromUrl('/wiki/File:Foo.jpg'), 'jpg');
    assert.equal(extFromUrl('https://x/a'), null);
    assert.equal(extFromUrl('https://x/a.png#frag'), 'png');
    assert.equal(extFromUrl('https://x/a.tiff'), 'tif');
    assert.equal(extFromUrl('https://x/a.jfif'), 'jpg');
    assert.equal(extFromUrl('https://x/a.txt'), null);
    assert.equal(extFromUrl('https://x/a?ext=.png'), null);
    assert.equal(extFromUrl('https://x/dir.png/file'), null);
    assert.equal(extFromUrl('https://x/a.png/'), null); // barra final: coherente con urls.isImageExtPath
    assert.equal(extFromUrl('https://x/a/'), null);
    assert.equal(extFromUrl('a.png/'), null);
    assert.equal(extFromUrl('https://x/a.SVG'), 'svg');
    assert.equal(extFromUrl('https://x/a.webp'), 'webp');
    assert.equal(extFromUrl('https://x/a.avif'), 'avif');
    assert.equal(extFromUrl('https://x/a.heic'), 'heic');
    assert.equal(extFromUrl('https://x/a.jxl'), 'jxl');
    assert.equal(extFromUrl('https://x/a.ico'), 'ico');
    assert.equal(extFromUrl('https://x/a.bmp'), 'bmp');
    assert.equal(extFromUrl('https://x/a.gif'), 'gif');
    assert.equal(extFromUrl(''), null);
    assert.equal(extFromUrl(null), null);
  });

  test('extFromUrl desenvuelve proxies', () => {
    assert.equal(extFromUrl('https://proxy.example/img?url=' + encodeURIComponent('https://cdn.example/x.webp')), 'webp');
  });

  test('extFromMime', () => {
    assert.equal(extFromMime('image/jpeg'), 'jpg');
    assert.equal(extFromMime('IMAGE/PNG; charset=binary'), 'png');
    assert.equal(extFromMime('image/gif'), 'gif');
    assert.equal(extFromMime('image/webp'), 'webp');
    assert.equal(extFromMime('image/avif'), 'avif');
    assert.equal(extFromMime('image/svg+xml'), 'svg');
    assert.equal(extFromMime('image/bmp'), 'bmp');
    assert.equal(extFromMime('image/x-icon'), 'ico');
    assert.equal(extFromMime('image/vnd.microsoft.icon'), 'ico');
    assert.equal(extFromMime('image/tiff'), 'tif');
    assert.equal(extFromMime('image/heic'), 'heic');
    assert.equal(extFromMime('image/jxl'), 'jxl');
    assert.equal(extFromMime('text/html'), null);
    assert.equal(extFromMime(''), null);
    assert.equal(extFromMime(undefined), null);
  });

  test('extFromDataUrl', () => {
    assert.equal(extFromDataUrl('data:image/webp;base64,UklGR'), 'webp');
    assert.equal(extFromDataUrl('data:image/svg+xml,%3Csvg'), 'svg');
    assert.equal(extFromDataUrl('data:text/plain,hi'), null);
    assert.equal(extFromDataUrl('https://x/a.png'), null);
    assert.equal(extFromDataUrl(null), null);
  });

  test('extForRef siempre devuelve una extensión (Chrome nunca añade una que falta)', () => {
    assert.equal(extForRef({ kind: 'http', url: 'https://x/a.png' }), 'png');
    assert.equal(extForRef({ kind: 'http', url: 'https://x/a' }), 'jpg');
    assert.equal(extForRef({ kind: 'data', url: 'data:image/gif;base64,R0lG' }), 'gif');
    assert.equal(extForRef({ kind: 'canvas' }), 'png');
    assert.equal(extForRef({ kind: 'svg' }), 'svg');
    assert.equal(extForRef({ kind: 'blob', url: 'blob:https://x/uuid' }), 'jpg');
    assert.equal(extForRef({ ext: 'webp', url: 'https://x/a.jpg' }), 'webp');
    assert.equal(extForRef({ ext: 'JPEG', url: 'https://x/a.png' }), 'jpg');
    assert.equal(extForRef({ mime: 'image/avif', url: 'https://x/a' }), 'avif');
    assert.equal(extForRef({}), 'jpg');
    assert.equal(extForRef(null), 'jpg');
  });

  test('isImageMime', () => {
    assert.equal(isImageMime('image/png'), true);
    assert.equal(isImageMime('IMAGE/SVG+XML; charset=utf-8'), true);
    assert.equal(isImageMime('text/html'), false);
    assert.equal(isImageMime(''), false);
    assert.equal(isImageMime(undefined), false);
  });
});

describe('sniffExt', () => {
  test('jpg', () => assert.deepEqual(sniffExt(bytes(0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46)), { mime: 'image/jpeg', ext: 'jpg' }));
  test('png', () => assert.deepEqual(sniffExt(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00)), { mime: 'image/png', ext: 'png' }));
  test('gif87a y gif89a', () => {
    assert.deepEqual(sniffExt(ascii('GIF87a\x01\x00')), { mime: 'image/gif', ext: 'gif' });
    assert.deepEqual(sniffExt(ascii('GIF89a\x01\x00')), { mime: 'image/gif', ext: 'gif' });
  });
  test('webp (RIFF....WEBP)', () => {
    assert.deepEqual(sniffExt(ascii('RIFF\x24\x00\x00\x00WEBPVP8 ')), { mime: 'image/webp', ext: 'webp' });
    assert.equal(sniffExt(ascii('RIFF\x24\x00\x00\x00WAVEfmt ')), null);
  });
  test('avif y heic por marcas ftyp', () => {
    assert.deepEqual(sniffExt(ascii('\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1')), { mime: 'image/avif', ext: 'avif' });
    assert.deepEqual(sniffExt(ascii('\x00\x00\x00\x18ftypavis\x00\x00\x00\x00')), { mime: 'image/avif', ext: 'avif' });
    assert.deepEqual(sniffExt(ascii('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic')), { mime: 'image/heic', ext: 'heic' });
    assert.deepEqual(sniffExt(ascii('\x00\x00\x00\x18ftypheix\x00\x00\x00\x00')), { mime: 'image/heic', ext: 'heic' });
    assert.deepEqual(sniffExt(ascii('\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00')), { mime: 'image/heic', ext: 'heic' });
    // marca mayor genérica con avif entre las compatibles
    assert.deepEqual(sniffExt(ascii('\x00\x00\x00\x1cftypmif1\x00\x00\x00\x00mif1avif')), { mime: 'image/avif', ext: 'avif' });
    assert.equal(sniffExt(ascii('\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00')), null);
  });
  test('bmp', () => assert.deepEqual(sniffExt(ascii('BM\x36\x00\x00\x00')), { mime: 'image/bmp', ext: 'bmp' }));
  test('ico', () => assert.deepEqual(sniffExt(bytes(0x00, 0x00, 0x01, 0x00, 0x01, 0x00)), { mime: 'image/x-icon', ext: 'ico' }));
  test('tif (II*\\0 y MM\\0*)', () => {
    assert.deepEqual(sniffExt(bytes(0x49, 0x49, 0x2A, 0x00, 0x08, 0x00)), { mime: 'image/tiff', ext: 'tif' });
    assert.deepEqual(sniffExt(bytes(0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00)), { mime: 'image/tiff', ext: 'tif' });
  });
  test('jxl (codestream y contenedor)', () => {
    assert.deepEqual(sniffExt(bytes(0xFF, 0x0A, 0x00)), { mime: 'image/jxl', ext: 'jxl' });
    assert.deepEqual(sniffExt(bytes(0x00, 0x00, 0x00, 0x0C, 0x4A, 0x58, 0x4C, 0x20, 0x0D, 0x0A, 0x87, 0x0A)), { mime: 'image/jxl', ext: 'jxl' });
  });
  test('svg: BOM/espacios opcionales y luego <svg o <?xml', () => {
    assert.deepEqual(sniffExt(ascii('<svg xmlns="http://www.w3.org/2000/svg">')), { mime: 'image/svg+xml', ext: 'svg' });
    assert.deepEqual(sniffExt(ascii('\xEF\xBB\xBF\n  <svg>')), { mime: 'image/svg+xml', ext: 'svg' });
    assert.deepEqual(sniffExt(ascii('  \t<?xml version="1.0"?>')), { mime: 'image/svg+xml', ext: 'svg' });
    assert.deepEqual(sniffExt(ascii('<SVG>')), { mime: 'image/svg+xml', ext: 'svg' });
    assert.deepEqual(sniffExt(ascii('<!DOCTYPE svg PUBLIC')), { mime: 'image/svg+xml', ext: 'svg' });
    assert.equal(sniffExt(ascii('<svgx>')), null);
  });
  test('html -> {mime:"text/html"} sin extensión', () => {
    assert.deepEqual(sniffExt(ascii('<!DOCTYPE html><html>')), { mime: 'text/html' });
    assert.deepEqual(sniffExt(ascii('<!doctype HTML>')), { mime: 'text/html' });
    assert.deepEqual(sniffExt(ascii('\xEF\xBB\xBF <html lang="es">')), { mime: 'text/html' });
    assert.deepEqual(sniffExt(ascii('<HTML>')), { mime: 'text/html' });
    assert.deepEqual(sniffExt(ascii('<!DOCTYPE html>').subarray(0, 16)), { mime: 'text/html' });
  });
  test('mif1 + avif compatible: con 16 bytes no hay marcas compatibles (heic); con 64 ve el avif', () => {
    const mif1avif = ascii('\x00\x00\x00\x1cftypmif1\x00\x00\x00\x00mif1avif');
    assert.deepEqual(sniffExt(mif1avif.subarray(0, 16)), { mime: 'image/heic', ext: 'heic' });
    assert.deepEqual(sniffExt(mif1avif.subarray(0, 64)), { mime: 'image/avif', ext: 'avif' });
    const avif = ascii('\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1');
    assert.deepEqual(sniffExt(avif.subarray(0, 16)), { mime: 'image/avif', ext: 'avif' });
  });
  test('html: etiquetas iniciales del sniffer de Chromium, con 16 y con 64 bytes', () => {
    const htmls = ['<!-- x --><!DOCTYPE html>', '<head><title>x</title>', '<body>', '<BODY class="a">', '<title>x</title>',
      '<script>', '<div>', '<p>', '<br/>', '<font>', '<table>', '<a href="x">', '<style>', '<b>', '<h1>', '<iframe>',
      '\n\t<!-- a -->'];
    for (const s of htmls) {
      assert.deepEqual(sniffExt(ascii(s).subarray(0, 16)), { mime: 'text/html' }, s + ' (16)');
      assert.deepEqual(sniffExt(ascii(s).subarray(0, 64)), { mime: 'text/html' }, s + ' (64)');
    }
    for (const s of ['<bx>', '<header>', '<svgx>', '<pre>', '<!-x']) assert.equal(sniffExt(ascii(s)), null, s);
    assert.deepEqual(sniffExt(ascii('<!DOCTYPE svg PUBLIC').subarray(0, 16)), { mime: 'image/svg+xml', ext: 'svg' });
  });
  test('html tras espacios: 16 bytes de espacios no bastan, 64 sí', () => {
    const s = ascii(' '.repeat(20) + '<!DOCTYPE html>');
    assert.equal(sniffExt(s.subarray(0, 16)), null);
    assert.deepEqual(sniffExt(s.subarray(0, 64)), { mime: 'text/html' });
  });
  test('desconocido o demasiado corto -> null; acepta Buffer/ArrayBuffer', () => {
    assert.equal(sniffExt(bytes()), null);
    assert.equal(sniffExt(bytes(0xFF)), null);
    assert.equal(sniffExt(ascii('hola mundo')), null);
    assert.equal(sniffExt(ascii('{"json":true}')), null);
    assert.deepEqual(sniffExt(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), { mime: 'image/png', ext: 'png' });
    assert.deepEqual(sniffExt(bytes(0xFF, 0xD8, 0xFF).buffer), { mime: 'image/jpeg', ext: 'jpg' });
    assert.equal(sniffExt(null), null);
  });
});

describe('dedupeNames', () => {
  test('añade " (2)", " (3)" sin distinguir mayúsculas', () => {
    assert.deepEqual(dedupeNames(['a.jpg', 'a.jpg', 'a.jpg']), ['a.jpg', 'a (2).jpg', 'a (3).jpg']);
    assert.deepEqual(dedupeNames(['A.PNG', 'a.png']), ['A.PNG', 'a (2).png']);
    assert.deepEqual(dedupeNames(['a.jpg', 'A.JPG', 'a.jpg']), ['a.jpg', 'A (2).JPG', 'a (3).jpg']);
  });
  test('salta sufijos ya ocupados y respeta nombres sin extensión', () => {
    assert.deepEqual(dedupeNames(['a.jpg', 'a.jpg', 'a (2).jpg']), ['a.jpg', 'a (2).jpg', 'a (3).jpg']);
    assert.deepEqual(dedupeNames(['a.jpg', 'a (2).jpg', 'a.jpg']), ['a.jpg', 'a (2).jpg', 'a (3).jpg']);
    assert.deepEqual(dedupeNames(['x', 'x']), ['x', 'x (2)']);
    assert.deepEqual(dedupeNames(['photo.tar.gz', 'photo.tar.gz']), ['photo.tar.gz', 'photo.tar (2).gz']);
  });
  test('no muta la entrada y acepta vacío', () => {
    const input = ['a.png', 'a.png'];
    const out = dedupeNames(input);
    assert.deepEqual(input, ['a.png', 'a.png']);
    assert.notEqual(out, input);
    assert.deepEqual(dedupeNames([]), []);
    assert.deepEqual(dedupeNames(undefined), []);
  });
  test('NFC/NFD y mayúsculas no ASCII cuentan como el mismo nombre', () => {
    assert.deepEqual(dedupeNames(['café.png', 'café.png']), ['café.png', 'café (2).png']);
    assert.deepEqual(dedupeNames(['ÑANDÚ.png', 'ñandú.png']), ['ÑANDÚ.png', 'ñandú (2).png']);
  });
});

describe('stamp', () => {
  test('formato YYYYMMDD-HHmm en hora local', () => {
    assert.equal(stamp(new Date(2026, 8, 30, 7, 5, 59)), '20260930-0705');
    assert.equal(stamp(new Date(2024, 0, 1, 0, 0)), '20240101-0000');
    assert.equal(stamp(new Date(2024, 11, 31, 23, 59)), '20241231-2359');
  });
  test('acepta milisegundos y usa ahora por defecto', () => {
    const d = new Date(2026, 1, 3, 14, 30);
    assert.equal(stamp(d.getTime()), '20260203-1430');
    assert.match(stamp(), /^\d{8}-\d{4}$/);
    assert.match(stamp(new Date('invalid')), /^\d{8}-\d{4}$/);
  });
});

describe('buildPaths', () => {
  test('sanea el host (sin www., ":" -> "_") y compone single/batch/zip', () => {
    assert.deepEqual(buildPaths({ folder: 'Imagenes', host: 'www.Example.com:8080', stamp: '20260930-0705' }), {
      single: 'Imagenes/Example.com_8080',
      batch: 'Imagenes/Example.com_8080_20260930-0705',
      zip: 'Imagenes/Example.com_8080_20260930-0705.zip'
    });
  });
  test('host vacío o solo www. -> "pagina"; carpeta por defecto "Imagenes"', () => {
    const p = buildPaths({ host: '', stamp: '20260101-0000' });
    assert.equal(p.single, 'Imagenes/pagina');
    assert.equal(buildPaths({ host: 'www.', stamp: 'S' }).single, 'Imagenes/pagina');
    assert.equal(buildPaths({ stamp: 'S' }).zip, 'Imagenes/pagina_S.zip');
    assert.equal(buildPaths({ folder: '', host: 'a.b', stamp: 'S' }).single, 'Imagenes/a.b');
  });
  test('sello: Date -> stamp(date); ausente -> ahora', () => {
    assert.equal(buildPaths({ host: 'x.y', stamp: new Date(2026, 8, 30, 7, 5) }).batch, 'Imagenes/x.y_20260930-0705');
    assert.match(buildPaths({ host: 'x.y' }).zip, /^Imagenes\/x\.y_\d{8}-\d{4}\.zip$/);
  });
  test('acepta una URL completa como host y sanea la carpeta', () => {
    assert.equal(buildPaths({ host: 'https://www.foo.com:8443/x?y', stamp: 'S' }).single, 'Imagenes/foo.com_8443');
    assert.equal(buildPaths({ folder: 'Mis:fotos', host: 'a.b', stamp: 'S' }).single, 'Mis_fotos/a.b');
    assert.equal(buildPaths({ folder: 'Imagenes/sub', host: 'a.b', stamp: 'S' }).single, 'Imagenes/sub/a.b');
  });
  test('coincide con urls.hostOf: el puerto se conserva y ":" pasa a "_"', () => {
    const urls = require(path.join(__dirname, '..', '..', 'lib', 'urls.js'));
    assert.equal(buildPaths({ host: urls.hostOf('http://localhost:3000/p'), stamp: 'S' }).single, 'Imagenes/localhost_3000');
    assert.equal(buildPaths({ host: 'http://localhost:3000/p', stamp: 'S' }).single, 'Imagenes/localhost_3000');
    assert.equal(buildPaths({ host: urls.hostOf('http://127.0.0.1:8080/x'), stamp: 'S' }).single, 'Imagenes/127.0.0.1_8080');
    assert.equal(buildPaths({ host: urls.hostOf('https://www.example.com/x'), stamp: 'S' }).single, 'Imagenes/example.com');
  });
  test('nunca contiene "\\"', () => {
    const p = buildPaths({ folder: 'A\\B', host: 'h\\x', stamp: 'S' });
    for (const v of Object.values(p)) assert.ok(!v.includes('\\'), v);
  });
});

describe('planNames', () => {
  test('20 "image.jpg" idénticas -> nombres únicos sin distinguir mayúsculas', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ key: 'http|' + i, kind: 'http', url: 'https://x/image.jpg', name: 'image', index: i }));
    const out = planNames(items);
    assert.equal(out.length, 20);
    assert.equal(out[0].fileName, 'image.jpg');
    assert.equal(out[1].fileName, 'image (2).jpg');
    assert.equal(out[19].fileName, 'image (20).jpg');
    assert.equal(new Set(out.map((o) => o.fileName.toLowerCase())).size, 20);
    for (const o of out) assert.match(o.fileName, /^image( \(\d+\))?\.jpg$/);
    // copia: conserva campos y no muta la entrada
    assert.equal(out[0].key, 'http|0');
    assert.equal(items[0].fileName, undefined);
    assert.notEqual(out[0], items[0]);
  });
  test('mayúsculas distintas chocan igualmente', () => {
    const out = planNames([{ name: 'Foto', url: 'https://x/Foto.png' }, { name: 'foto', url: 'https://x/foto.png' }]);
    assert.deepEqual(out.map((o) => o.fileName), ['Foto.png', 'foto (2).png']);
  });
  test('sin nombre usa buildBaseName con el índice; ext de ext/mime/url/kind', () => {
    const out = planNames([
      { url: 'https://x/thumb.jpg' },
      { url: 'https://x/thumb.jpg', alt: 'Perro' },
      { kind: 'canvas', name: 'lienzo' },
      { kind: 'svg', name: 'logo' },
      { url: 'https://x/a.jpg', name: 'a', ext: 'webp' },
      { url: 'https://x/a', name: 'b', mime: 'image/avif' },
      { url: 'https://x/NUL.png', name: 'NUL' },
      { url: 'https://x/x.png', name: 'x.png' }
    ]);
    assert.deepEqual(out.map((o) => o.fileName), [
      'imagen-000.jpg', 'Perro.jpg', 'lienzo.png', 'logo.svg', 'a.webp', 'b.avif', '_NUL.png', 'x.png'
    ]);
  });
  test('quita la extensión propia del nombre aunque sea un alias (jpeg, tiff, jfif, JPG)', () => {
    const out = planNames([
      { name: 'photo.jpeg', url: 'https://x/photo.jpeg' },
      { name: 'a.tiff', url: 'https://x/a.tiff' },
      { name: 'b.jfif', url: 'https://x/b.jfif' },
      { name: 'c.JPG', url: 'https://x/c.JPG' },
      { name: 'photo.2024', url: 'https://x/photo.2024.webp' },
      { name: 'd.jpg', url: 'https://x/d.jpg', ext: 'webp' }
    ]);
    assert.deepEqual(out.map((o) => o.fileName), ['photo.jpg', 'a.tif', 'b.jpg', 'c.jpg', 'photo.2024.webp', 'd.jpg.webp']);
  });
  test('nombres largos quedan bajo 120 incluso con sufijo de deduplicación', () => {
    const items = Array.from({ length: 12 }, () => ({ name: 'n'.repeat(200), url: 'https://x/a.png' }));
    const out = planNames(items);
    for (const o of out) {
      assert.ok(o.fileName.length <= 120, String(o.fileName.length));
      assert.ok(o.fileName.endsWith('.png'));
    }
    assert.equal(new Set(out.map((o) => o.fileName.toLowerCase())).size, 12);
  });
  test('vacío e ítems nulos', () => {
    assert.deepEqual(planNames([]), []);
    assert.deepEqual(planNames(undefined), []);
    assert.equal(planNames([null])[0].fileName, 'imagen-000.jpg');
  });
});

describe('joinPath', () => {
  test('une con "/" y limpia barras sobrantes y vacíos', () => {
    assert.equal(joinPath('Imagenes', 'host', 'a.png'), 'Imagenes/host/a.png');
    assert.equal(joinPath('Imagenes/', '/host/', '', null, undefined, 'a.png'), 'Imagenes/host/a.png');
    assert.equal(joinPath('a//b', 'c'), 'a/b/c');
    assert.equal(joinPath(), '');
    assert.equal(joinPath('solo'), 'solo');
  });
});
