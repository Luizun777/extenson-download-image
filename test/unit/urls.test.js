'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const urls = require('../../lib/urls.js');

const {
  parseSrcset, pickLargest, parseImageLayers, extractContentUrl, resolveUrl,
  stripHash, schemeKind, isImageExtPath, unwrapProxyUrl, isTinyDataPlaceholder,
  isLqip, hostOf
} = urls;

const CLOUD_400 = 'https://res.cloudinary.com/d/image/upload/w_400,h_300/a.jpg';
const CLOUD_800 = 'https://res.cloudinary.com/d/image/upload/w_800,h_600/a.jpg';
const GIF_1x1 = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

test('módulo: expone ImgDL.urls y module.exports con la misma API', () => {
  assert.equal(globalThis.ImgDL.urls, urls);
  assert.deepEqual(Object.keys(urls).sort(), [
    'extractContentUrl', 'hostOf', 'isImageExtPath', 'isLqip', 'isTinyDataPlaceholder',
    'parseImageLayers', 'parseSrcset', 'pickLargest', 'resolveUrl', 'schemeKind',
    'stripHash', 'unwrapProxyUrl'
  ]);
});

// --- parseSrcset -----------------------------------------------------------

test('parseSrcset: comas dentro de URLs Cloudinary sobreviven', () => {
  const out = parseSrcset(`${CLOUD_400} 400w, ${CLOUD_800} 800w`);
  assert.deepEqual(out, [
    { url: CLOUD_400, w: 400, x: 1 },
    { url: CLOUD_800, w: 800, x: 1 }
  ]);
});

test('parseSrcset: candidatos data: URI (con comas y "=") se mantienen enteros', () => {
  const out = parseSrcset(`${GIF_1x1} 1x, https://h/a.png 2x`);
  assert.deepEqual(out, [
    { url: GIF_1x1, w: 0, x: 1 },
    { url: 'https://h/a.png', w: 0, x: 2 }
  ]);
});

test('parseSrcset: descriptor ausente = 1x', () => {
  assert.deepEqual(parseSrcset('https://h/a.png'), [{ url: 'https://h/a.png', w: 0, x: 1 }]);
  assert.deepEqual(parseSrcset('a.png, b.png 2x'), [
    { url: 'a.png', w: 0, x: 1 },
    { url: 'b.png', w: 0, x: 2 }
  ]);
});

test('parseSrcset: URL sin espacio antes de la coma absorbe la coma (regla de la spec)', () => {
  // "a.png,b.png 2x" es UN candidato cuya URL es "a.png,b.png"
  assert.deepEqual(parseSrcset('a.png,b.png 2x'), [{ url: 'a.png,b.png', w: 0, x: 2 }]);
});

test('parseSrcset: comas finales y espacios/saltos de línea sobrantes', () => {
  const out = parseSrcset('\n\t a.png   400w ,\r\n  b.png\t800w ,,, \n');
  assert.deepEqual(out, [
    { url: 'a.png', w: 400, x: 1 },
    { url: 'b.png', w: 800, x: 1 }
  ]);
  assert.deepEqual(parseSrcset('a.png,,,'), [{ url: 'a.png', w: 0, x: 1 }]);
  assert.deepEqual(parseSrcset(',,, a.png 1.5x ,'), [{ url: 'a.png', w: 0, x: 1.5 }]);
});

test('parseSrcset: candidatos inválidos se descartan sin romper los demás', () => {
  assert.deepEqual(parseSrcset('a.png 2w 3x, b.png 100w'), [{ url: 'b.png', w: 100, x: 1 }]); // w y x juntos
  assert.deepEqual(parseSrcset('a.png foo, b.png 2x'), [{ url: 'b.png', w: 0, x: 2 }]); // descriptor desconocido
  assert.deepEqual(parseSrcset('a.png 0w, b.png 1w'), [{ url: 'b.png', w: 1, x: 1 }]); // 0w inválido
  assert.deepEqual(parseSrcset('a.png 100w 200w, b.png 2x'), [{ url: 'b.png', w: 0, x: 2 }]); // w duplicado
  assert.deepEqual(parseSrcset('a.png 50h, b.png 100w 50h'), [{ url: 'b.png', w: 100, x: 1 }]); // h sin w
  assert.deepEqual(parseSrcset('a.png -1x, b.png .5x'), [{ url: 'b.png', w: 0, x: 0.5 }]); // densidad negativa
});

test('parseSrcset: paréntesis dentro de descriptores no cortan en la coma interna', () => {
  const out = parseSrcset('a.png 1x, b.png (foo,bar) 2x');
  // "(foo,bar)" es un descriptor desconocido → b se descarta, a sobrevive
  assert.deepEqual(out, [{ url: 'a.png', w: 0, x: 1 }]);
});

test('parseSrcset: entradas vacías o no string → []', () => {
  assert.deepEqual(parseSrcset(''), []);
  assert.deepEqual(parseSrcset('   ,, \n'), []);
  assert.deepEqual(parseSrcset(null), []);
  assert.deepEqual(parseSrcset(undefined), []);
});

// --- pickLargest -----------------------------------------------------------

test('pickLargest: w tiene precedencia sobre x', () => {
  const c = [{ url: 'x3', x: 3 }, { url: 'w100', w: 100 }, { url: 'w800', w: 800 }, { url: 'x9', x: 9 }];
  assert.equal(pickLargest(c).url, 'w800');
});

test('pickLargest: sin w, gana el mayor x y el descriptor ausente cuenta como 1x', () => {
  assert.equal(pickLargest([{ url: 'a' }, { url: 'b', x: 2 }, { url: 'c', x: 1.5 }]).url, 'b');
  assert.equal(pickLargest([{ url: 'a', x: 0.5 }, { url: 'b' }]).url, 'b');
});

test('pickLargest: en empate gana el primero', () => {
  assert.equal(pickLargest([{ url: 'a', w: 800 }, { url: 'b', w: 800 }]).url, 'a');
  assert.equal(pickLargest([{ url: 'a', x: 2 }, { url: 'b', x: 2 }]).url, 'a');
  assert.equal(pickLargest([{ url: 'a' }, { url: 'b' }]).url, 'a');
});

test('pickLargest: devuelve el objeto candidato (conserva campos extra como lazy) y null si vacío', () => {
  const lazy = { url: 'l', w: 0, x: 1, lazy: true };
  assert.equal(pickLargest([lazy]), lazy);
  assert.equal(pickLargest([]), null);
  assert.equal(pickLargest(null), null);
  assert.equal(pickLargest([null, { url: '' }]), null);
});

test('pickLargest: integración con parseSrcset (Cloudinary)', () => {
  assert.equal(pickLargest(parseSrcset(`${CLOUD_400} 400w, ${CLOUD_800} 800w`)).url, CLOUD_800);
});

// --- parseImageLayers ------------------------------------------------------

test('parseImageLayers: url() con comillas dobles, simples y sin comillas', () => {
  assert.deepEqual(parseImageLayers('url("https://h/a.png")'), [{ url: 'https://h/a.png', resolution: 1 }]);
  assert.deepEqual(parseImageLayers("url('https://h/a.png')"), [{ url: 'https://h/a.png', resolution: 1 }]);
  assert.deepEqual(parseImageLayers('url(https://h/a.png)'), [{ url: 'https://h/a.png', resolution: 1 }]);
  assert.deepEqual(parseImageLayers('URL( "https://h/a.png" )'), [{ url: 'https://h/a.png', resolution: 1 }]);
});

test('parseImageLayers: comillas y paréntesis escapados dentro de url()', () => {
  assert.deepEqual(parseImageLayers('url("https://h/a\\"b).png")'), [{ url: 'https://h/a"b).png', resolution: 1 }]);
  assert.deepEqual(parseImageLayers("url('https://h/it\\'s).png')"), [{ url: "https://h/it's).png", resolution: 1 }]);
  assert.deepEqual(parseImageLayers('url(https://h/a\\).png)'), [{ url: 'https://h/a).png', resolution: 1 }]);
  // Escape hexadecimal CSS: \41 = 'A', con espacio terminador opcional
  assert.deepEqual(parseImageLayers('url("https://h/\\41 b.png")'), [{ url: 'https://h/Ab.png', resolution: 1 }]);
});

test('parseImageLayers: la URL puede contener comas y paréntesis (Cloudinary, serializada)', () => {
  assert.deepEqual(parseImageLayers(`url("${CLOUD_800}")`), [{ url: CLOUD_800, resolution: 1 }]);
  assert.deepEqual(parseImageLayers('url("https://h/a,b(c).png"), url("https://h/d.png")'), [
    { url: 'https://h/a,b(c).png', resolution: 1 },
    { url: 'https://h/d.png', resolution: 1 }
  ]);
});

test('parseImageLayers: varias capas en orden de pintado (índice 0 = arriba) y gradientes omitidos', () => {
  const v = 'linear-gradient(rgba(0,0,0,.5), rgba(0,0,0,.5)), url("https://h/top.png"), radial-gradient(circle, red, blue), url("https://h/bottom.png")';
  assert.deepEqual(parseImageLayers(v), [
    { url: 'https://h/top.png', resolution: 1 },
    { url: 'https://h/bottom.png', resolution: 1 }
  ]);
});

test('parseImageLayers: none, cross-fade y valores vacíos', () => {
  assert.deepEqual(parseImageLayers('none'), []);
  assert.deepEqual(parseImageLayers('none, url("https://h/a.png")'), [{ url: 'https://h/a.png', resolution: 1 }]);
  assert.deepEqual(parseImageLayers('cross-fade(url("https://h/a.png"), url("https://h/b.png"), 50%)'), []);
  assert.deepEqual(parseImageLayers(''), []);
  assert.deepEqual(parseImageLayers(null), []);
  assert.deepEqual(parseImageLayers('url("")'), []);
});

test('parseImageLayers: image-set elige la mayor resolución (x, dppx, dpi/96)', () => {
  assert.deepEqual(parseImageLayers('image-set(url("https://h/1x.png") 1x, url("https://h/2x.png") 2x)'),
    [{ url: 'https://h/2x.png', resolution: 2 }]);
  assert.deepEqual(parseImageLayers('image-set(url("https://h/a.png") 1dppx, url("https://h/b.png") 1.5dppx)'),
    [{ url: 'https://h/b.png', resolution: 1.5 }]);
  assert.deepEqual(parseImageLayers('image-set(url("https://h/a.png") 96dpi, url("https://h/b.png") 192dpi)'),
    [{ url: 'https://h/b.png', resolution: 2 }]);
  // Cadenas sin url() y type(): también válidos; empate → primero
  assert.deepEqual(parseImageLayers('image-set("https://h/a.avif" type("image/avif") 2x, "https://h/b.png" 2x)'),
    [{ url: 'https://h/a.avif', resolution: 2 }]);
  // Sin descriptor = 1x
  assert.deepEqual(parseImageLayers('image-set(url("https://h/a.png"), url("https://h/b.png") 2x)'),
    [{ url: 'https://h/b.png', resolution: 2 }]);
});

test('parseImageLayers: -webkit-image-set y mezcla con otras capas', () => {
  const v = '-webkit-image-set(url("https://h/s.png") 1x, url("https://h/l.png") 2x), url("https://h/base.png")';
  assert.deepEqual(parseImageLayers(v), [
    { url: 'https://h/l.png', resolution: 2 },
    { url: 'https://h/base.png', resolution: 1 }
  ]);
});

test('parseImageLayers: un "2x" dentro de la URL no se confunde con el descriptor', () => {
  assert.deepEqual(parseImageLayers('image-set(url("https://h/img 2x.png") 1x, url("https://h/b.png") 1.5x)'),
    [{ url: 'https://h/b.png', resolution: 1.5 }]);
});

// --- extractContentUrl -----------------------------------------------------

test('extractContentUrl: url(), alt text, image-set y valores sin imagen', () => {
  assert.equal(extractContentUrl('url("https://h/i.png")'), 'https://h/i.png');
  assert.equal(extractContentUrl('url("https://h/i.png") / "icono"'), 'https://h/i.png');
  assert.equal(extractContentUrl('"→" url(https://h/i.png)'), 'https://h/i.png');
  // cadenas: su texto no es una imagen aunque contenga url(...)
  assert.equal(extractContentUrl('"url(https://h/i.png)"'), null);
  assert.equal(extractContentUrl('\'url("https://h/i.png")\''), null);
  assert.equal(extractContentUrl('"image-set(url(https://h/a.png) 1x)"'), null);
  assert.equal(extractContentUrl('"url(https://h/i.png)" url(https://h/j.png)'), 'https://h/j.png');
  assert.equal(extractContentUrl('"it\'s" url(https://h/i.png)'), 'https://h/i.png');
  assert.equal(extractContentUrl('"a\\"b" url(https://h/i.png)'), 'https://h/i.png');
  assert.equal(extractContentUrl('xurl(https://h/i.png)'), null);
  assert.equal(extractContentUrl('-webkit-image-set(url("https://h/a.png") 1x, url("https://h/b.png") 2x)'), 'https://h/b.png');
  assert.equal(extractContentUrl('attr(data-x) url( https://h/i.png )'), 'https://h/i.png');
  assert.equal(extractContentUrl('image-set(url("https://h/a.png") 1x, url("https://h/b.png") 2x)'), 'https://h/b.png');
  assert.equal(extractContentUrl('none'), null);
  assert.equal(extractContentUrl('normal'), null);
  assert.equal(extractContentUrl('"texto"'), null);
  assert.equal(extractContentUrl('counter(item) ". "'), null);
  assert.equal(extractContentUrl(''), null);
  assert.equal(extractContentUrl(undefined), null);
});

// --- resolveUrl / stripHash / schemeKind ----------------------------------

test('resolveUrl: relativas contra base, absolutas, data: y blob:', () => {
  assert.equal(resolveUrl('img/a.png', 'https://h/dir/page.html'), 'https://h/dir/img/a.png');
  assert.equal(resolveUrl('/a.png', 'https://h/dir/page.html'), 'https://h/a.png');
  assert.equal(resolveUrl('//cdn/a.png', 'https://h/'), 'https://cdn/a.png');
  assert.equal(resolveUrl('  https://h/a.png  ', 'https://h/'), 'https://h/a.png');
  assert.equal(resolveUrl('https://h/a.png'), 'https://h/a.png');
  assert.equal(resolveUrl(GIF_1x1, 'https://h/'), GIF_1x1);
  assert.equal(resolveUrl('blob:https://h/uuid-1', 'https://h/'), 'blob:https://h/uuid-1');
});

test('resolveUrl: null para esquemas rechazados, vacíos y no parseables', () => {
  assert.equal(resolveUrl('javascript:alert(1)', 'https://h/'), null);
  assert.equal(resolveUrl('about:blank', 'https://h/'), null);
  assert.equal(resolveUrl('file:///etc/passwd', 'https://h/'), null);
  assert.equal(resolveUrl('', 'https://h/'), null);
  assert.equal(resolveUrl('   ', 'https://h/'), null);
  assert.equal(resolveUrl('a.png'), null); // relativa sin base
  assert.equal(resolveUrl('https://h/a.png', 'no es una base'), null);
  assert.equal(resolveUrl(null, 'https://h/'), null);
  assert.equal(resolveUrl(42, 'https://h/'), null);
});

test('stripHash', () => {
  assert.equal(stripHash('https://h/a.png#frag'), 'https://h/a.png');
  assert.equal(stripHash('https://h/a.png?x=1#a#b'), 'https://h/a.png?x=1');
  assert.equal(stripHash('https://h/a.png'), 'https://h/a.png');
  assert.equal(stripHash(null), null);
});

test('schemeKind: acepta http(s)/data/blob, rechaza el resto', () => {
  assert.equal(schemeKind('https://h/a.png'), 'http');
  assert.equal(schemeKind('http://h/a.png'), 'http');
  assert.equal(schemeKind('HTTPS://H/a.png'), 'http');
  assert.equal(schemeKind('  https://h/a.png'), 'http');
  assert.equal(schemeKind(GIF_1x1), 'data');
  assert.equal(schemeKind('blob:https://h/uuid'), 'blob');
  assert.equal(schemeKind('javascript:alert(1)'), null);
  assert.equal(schemeKind('JavaScript:void(0)'), null);
  assert.equal(schemeKind('about:blank'), null);
  assert.equal(schemeKind('chrome://version'), null);
  assert.equal(schemeKind('chrome-extension://abc/x.png'), null);
  assert.equal(schemeKind('file:///tmp/a.png'), null);
  assert.equal(schemeKind('ftp://h/a.png'), null);
  assert.equal(schemeKind('/relativa.png'), null);
  assert.equal(schemeKind('a.png'), null);
  assert.equal(schemeKind(''), null);
  assert.equal(schemeKind(null), null);
});

// --- isImageExtPath --------------------------------------------------------

test('isImageExtPath: anclado al final del pathname', () => {
  assert.equal(isImageExtPath('/wiki/File:Foo.jpg'), true);
  assert.equal(isImageExtPath('/a.png/whatever'), false);
  assert.equal(isImageExtPath('/x.jpg?x=1'), false); // query no es parte del pathname
  assert.equal(isImageExtPath(new URL('https://h/x.jpg?x=1#f').pathname), true);
  for (const ext of ['avif', 'bmp', 'gif', 'ico', 'jfif', 'jpg', 'jpeg', 'png', 'svg', 'tif', 'tiff', 'webp', 'heic', 'jxl']) {
    assert.equal(isImageExtPath(`/dir/img.${ext}`), true, ext);
    assert.equal(isImageExtPath(`/dir/img.${ext.toUpperCase()}`), true, ext.toUpperCase());
  }
  assert.equal(isImageExtPath('/a.html'), false);
  assert.equal(isImageExtPath('/a.png/'), false);
  assert.equal(isImageExtPath('/png'), false);
  assert.equal(isImageExtPath('/a.jpgx'), false);
  assert.equal(isImageExtPath(''), false);
  assert.equal(isImageExtPath(null), false);
});

// --- unwrapProxyUrl --------------------------------------------------------

test('unwrapProxyUrl: /_next/image?url= y ?src=', () => {
  assert.equal(unwrapProxyUrl('https://site/_next/image?url=https%3A%2F%2Fcdn%2Fa.jpg&w=640&q=75'), 'https://cdn/a.jpg');
  assert.equal(unwrapProxyUrl('https://site/proxy?src=https%3A%2F%2Fcdn%2Fb.png'), 'https://cdn/b.png');
  assert.equal(unwrapProxyUrl('https://site/p?u=http://cdn/c.gif&x=1'), 'http://cdn/c.gif');
  for (const k of ['img', 'image', 'i', 'file']) {
    assert.equal(unwrapProxyUrl(`https://site/p?${k}=https%3A%2F%2Fcdn%2Fd.webp`), 'https://cdn/d.webp', k);
  }
});

test('unwrapProxyUrl: devuelve la entrada cuando no hay URL http(s) absoluta interna', () => {
  assert.equal(unwrapProxyUrl('https://site/_next/image?url=%2Fimages%2Fa.jpg&w=640'), 'https://site/_next/image?url=%2Fimages%2Fa.jpg&w=640');
  assert.equal(unwrapProxyUrl('https://site/p?url=javascript%3Aalert(1)'), 'https://site/p?url=javascript%3Aalert(1)');
  assert.equal(unwrapProxyUrl('https://site/p?url=data%3Aimage%2Fpng%3Bbase64%2CAAAA'), 'https://site/p?url=data%3Aimage%2Fpng%3Bbase64%2CAAAA');
  assert.equal(unwrapProxyUrl('https://cdn/a.jpg'), 'https://cdn/a.jpg');
  assert.equal(unwrapProxyUrl('https://cdn/a.jpg?w=100'), 'https://cdn/a.jpg?w=100');
  assert.equal(unwrapProxyUrl(GIF_1x1), GIF_1x1);
  assert.equal(unwrapProxyUrl('blob:https://h/uuid'), 'blob:https://h/uuid');
  assert.equal(unwrapProxyUrl('no es url'), 'no es url');
  assert.equal(unwrapProxyUrl(null), null);
});

test('unwrapProxyUrl: prioridad de parámetros y proxies anidados', () => {
  assert.equal(unwrapProxyUrl('https://site/p?src=https%3A%2F%2Fcdn%2Fsrc.png&url=https%3A%2F%2Fcdn%2Furl.png'), 'https://cdn/url.png');
  const inner = 'https://a/_next/image?url=https%3A%2F%2Fcdn%2Ffinal.jpg&w=1';
  assert.equal(unwrapProxyUrl(`https://b/proxy?url=${encodeURIComponent(inner)}`), 'https://cdn/final.jpg');
});

// --- isTinyDataPlaceholder / isLqip ---------------------------------------

test('isTinyDataPlaceholder: data: cortas sí, largas o http no', () => {
  assert.equal(isTinyDataPlaceholder(GIF_1x1), true);
  assert.equal(isTinyDataPlaceholder("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%200%200'%3E%3C/svg%3E"), true);
  assert.equal(isTinyDataPlaceholder('data:image/png;base64,' + 'A'.repeat(2048)), false);
  assert.equal(isTinyDataPlaceholder('data:image/png;base64,' + 'A'.repeat(2048), 4096), true);
  assert.equal(isTinyDataPlaceholder('data:image/gif;base64,R0lG', 10), false);
  assert.equal(isTinyDataPlaceholder('https://h/a.png'), false);
  assert.equal(isTinyDataPlaceholder(''), false);
  assert.equal(isTinyDataPlaceholder(null), false);
});

test('isLqip: natural < ratio × rect × dpr solo con atributo lazy e imagen cargada', () => {
  const base = { complete: true, naturalWidth: 40, rectWidth: 400, dpr: 1, hasLazyAttr: true };
  assert.equal(isLqip(base), true); // 40 < 100
  assert.equal(isLqip({ ...base, naturalWidth: 100 }), false); // 100 < 100 es falso
  assert.equal(isLqip({ ...base, naturalWidth: 150, dpr: 2 }), true); // 150 < 200
  assert.equal(isLqip({ ...base, naturalWidth: 150 }), false);
  assert.equal(isLqip({ ...base, hasLazyAttr: false }), false);
  assert.equal(isLqip({ ...base, complete: false }), false);
  assert.equal(isLqip({ ...base, rectWidth: 0 }), false);
  assert.equal(isLqip({ ...base, naturalWidth: 150 }, 0.5), true); // ratio configurable
  assert.equal(isLqip(null), false);
});

// --- hostOf ----------------------------------------------------------------

test('hostOf: sin www., con puerto (como URL.host), blob: usa el origen interno, inválidas → ""', () => {
  assert.equal(hostOf('https://www.example.com/a/b.png'), 'example.com');
  assert.equal(hostOf('https://WWW.Example.com/'), 'example.com');
  assert.equal(hostOf('http://localhost:3000/a.png'), 'localhost:3000');
  assert.equal(hostOf('http://127.0.0.1:8080/a.png'), '127.0.0.1:8080');
  assert.equal(hostOf('https://www.example.com:443/'), 'example.com'); // puerto por defecto: URL.host lo omite
  assert.equal(hostOf('https://cdn.wwwsite.com/'), 'cdn.wwwsite.com');
  assert.equal(hostOf('blob:https://www.example.com/uuid'), 'example.com');
  assert.equal(hostOf(GIF_1x1), '');
  assert.equal(hostOf('no es url'), '');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(null), '');
});
