'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startServer, PAGE_HEADERS } = require('../fixtures/server.js');
const { readIhdr } = require('../fixtures/png.js');

const SERVER_FILE = path.join(__dirname, '..', 'fixtures', 'server.js');
const PAGES_DIR = path.join(__dirname, '..', 'fixtures', 'pages');
const MY_PAGES = [
  'basic', 'overlay', 'pointer-events-none', 'spacer', 'lazy',
  'background', 'shadow', 'iframe', 'iframe-inner', 'sandbox',
];

let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(async () => {
  await srv.close();
});

async function get(url, init) {
  const res = await fetch(url, init);
  const body = Buffer.from(await res.arrayBuffer());
  return { res, body };
}

test('origen y origen alterno: mismo puerto, dos hosts, ambos responden', async () => {
  assert.match(srv.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(srv.altOrigin, 'http://localhost:' + srv.port);
  for (const o of [srv.origin, srv.altOrigin]) {
    const { res } = await get(o + '/img/dual.png');
    assert.equal(res.status, 200, o);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('/pages: estáticas con tipo correcto, 404 para desconocidas y sin traversal', async () => {
  for (const name of MY_PAGES) {
    const { res, body } = await get(srv.origin + '/pages/' + name + '.html');
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = body.toString('utf8');
    assert.match(html, /<!-- expect: #[\w-]+ → /, name + ': documenta objetivos');
    assert.match(html, /data-expect="/, name + ': marca objetivos');
    assert.doesNotMatch(html, /src="https?:\/\//, name + ': sin recursos externos');
  }
  assert.equal((await get(srv.origin + '/pages/nope.html')).res.status, 404);
  assert.equal((await get(srv.origin + '/pages/../server.js')).res.status, 404);
  assert.equal((await get(srv.origin + '/pages/..%2Fserver.js')).res.status, 404);
  // csp.html lo escribe otro paquete: con el archivo → 200 + CSP; sin él → 404 sin cabecera.
  const cspExists = fs.existsSync(path.join(__dirname, '..', 'fixtures', 'pages', 'csp.html'));
  const csp = await fetch(srv.origin + '/pages/csp.html');
  assert.equal(csp.status, cspExists ? 200 : 404);
  assert.equal(csp.headers.get('content-security-policy'), cspExists ? PAGE_HEADERS['csp.html']['Content-Security-Policy'] : null);
});

test('convención única en todas las páginas: data-expect ↔ data-expect-kind, skips con data-expect-skip', () => {
  const files = fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith('.html')).sort();
  assert.ok(files.length >= 19, 'hay ' + files.length + ' páginas');
  const count = (html, re) => (html.match(re) || []).length;
  for (const f of files) {
    const html = fs.readFileSync(path.join(PAGES_DIR, f), 'utf8');
    // cada data-expect (en marcado o puesto por script) lleva su data-expect-kind
    assert.equal(count(html, /data-expect="/g), count(html, /data-expect-kind="/g), f + ': data-expect sin data-expect-kind');
    assert.equal(count(html, /dataset\.expect = /g), count(html, /dataset\.expectKind = /g), f + ': dataset.expect sin dataset.expectKind');
    assert.doesNotMatch(html, /data-skip\b|dataset\.skip\b/, f + ': los descartes se marcan con data-expect-skip');
    // los <iframe> son objetivos de kind "frame", no "http"
    for (const tag of html.match(/<iframe[^>]*data-expect="[^>]*>/g) || []) {
      assert.match(tag, /data-expect-kind="frame"/, f + ': ' + tag);
    }
    // (que cada "expect: #id" del comentario exista en el DOM lo comprueba fixtures-pages.test.js en Chromium)
  }
});

test('/pages/csp.html recibe la cabecera CSP cuando el archivo existe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdl-pages-'));
  fs.writeFileSync(path.join(dir, 'csp.html'), '<!doctype html><title>csp</title>');
  const s = await startServer({ pagesDir: dir });
  try {
    const res = await fetch(s.origin + '/pages/csp.html');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-security-policy'), PAGE_HEADERS['csp.html']['Content-Security-Policy']);
    assert.equal(
      res.headers.get('content-security-policy'),
      "default-src 'self'; style-src 'self'; img-src * data: blob:; script-src 'self'"
    );
    const plain = await fetch(s.origin + '/img/x.png');
    assert.equal(plain.headers.get('content-security-policy'), null);
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/img: PNG determinista, tamaño por query, tope 4096, sin ACAO', async () => {
  const a1 = await get(srv.origin + '/img/a.png');
  assert.equal(a1.res.status, 200);
  assert.equal(a1.res.headers.get('content-type'), 'image/png');
  assert.equal(a1.res.headers.get('access-control-allow-origin'), null);
  assert.equal(a1.res.headers.get('content-length'), String(a1.body.length));
  assert.deepEqual(readIhdr(a1.body), { width: 200, height: 200, bitDepth: 8, colorType: 2, interlace: 0 });
  const a2 = await get(srv.origin + '/img/a.png');
  assert.ok(a1.body.equals(a2.body), 'mismos bytes');
  assert.ok(a1.body.equals(srv.png('a')), 'png() devuelve los mismos bytes');
  const b = await get(srv.origin + '/img/b.png');
  assert.ok(!a1.body.equals(b.body), 'otro nombre → otro color');
  const sized = await get(srv.origin + '/img/a.png?w=400&h=300');
  assert.deepEqual([readIhdr(sized.body).width, readIhdr(sized.body).height], [400, 300]);
  const capped = await get(srv.origin + '/img/a.png?w=99999&h=0');
  assert.deepEqual([readIhdr(capped.body).width, readIhdr(capped.body).height], [4096, 200]);
  const unicode = await get(srv.origin + '/img/' + encodeURIComponent('ñandú 1') + '.png');
  assert.equal(unicode.res.status, 200);
  assert.equal((await get(srv.origin + '/img/a.jpg')).res.status, 404);
  assert.equal((await get(srv.origin + '/img/a%2Fb.png')).res.status, 404);
});

test('/cors y /nocors', async () => {
  const cors = await get(srv.origin + '/cors/a.png?w=10&h=10');
  assert.equal(cors.res.status, 200);
  assert.equal(cors.res.headers.get('access-control-allow-origin'), '*');
  assert.equal(cors.res.headers.get('content-type'), 'image/png');
  const nocors = await get(srv.origin + '/nocors/a.png?w=10&h=10');
  assert.equal(nocors.res.status, 200);
  assert.equal(nocors.res.headers.get('access-control-allow-origin'), null);
  assert.ok(cors.body.equals(nocors.body), 'mismo nombre y tamaño → mismos bytes en todas las rutas');
});

test('/noise.png: ~N MB, determinista por semilla, tope 64', async () => {
  const n1 = await get(srv.origin + '/noise.png?mb=1&seed=3');
  assert.equal(n1.res.headers.get('content-type'), 'image/png');
  assert.ok(Math.abs(n1.body.length - 1048576) < 1048576 * 0.01, 'tamaño ' + n1.body.length);
  const n2 = await get(srv.origin + '/noise.png?mb=1&seed=3');
  assert.ok(n1.body.equals(n2.body));
  const n3 = await get(srv.origin + '/noise.png?mb=1&seed=4');
  assert.ok(!n1.body.equals(n3.body));
  const def = await get(srv.origin + '/noise.png');
  assert.ok(Math.abs(def.body.length - 1048576) < 1048576 * 0.01, 'por defecto 1 MB');
  const half = await get(srv.origin + '/noise.png?mb=0.5');
  assert.ok(Math.abs(half.body.length - 524288) < 524288 * 0.02, 'mb fraccionario');
});

test('/hotlink: 403 salvo Referer que empiece por el origen de la página (puerto real)', async () => {
  const none = await get(srv.origin + '/hotlink/h.png');
  assert.equal(none.res.status, 403);
  assert.equal(none.res.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(none.body.toString(), 'forbidden');
  const ok1 = await get(srv.origin + '/hotlink/h.png', { headers: { Referer: srv.origin + '/pages/hotlink.html' } });
  assert.equal(ok1.res.status, 200);
  assert.equal(ok1.res.headers.get('content-type'), 'image/png');
  const ok2 = await get(srv.altOrigin + '/hotlink/h.png', { headers: { Referer: srv.origin + '/pages/hotlink.html' } });
  assert.equal(ok2.res.status, 200, 'imagen del origen alterno con Referer del origen de la página');
  const ok3 = await get(srv.origin + '/hotlink/h.png', { headers: { Referer: srv.altOrigin + '/' } });
  assert.equal(ok3.res.status, 200, 'el origen alterno también es "la página"');
  // ni otro sitio, ni otro puerto local, ni un prefijo numérico del puerto, ni https
  const bad = [
    'http://evil.example/',
    'http://localhost:1/',
    'http://127.0.0.1:' + (srv.port + 1) + '/',
    srv.origin + '0/',
    srv.origin.replace('http:', 'https:') + '/',
  ];
  for (const ref of bad) {
    const r = await get(srv.origin + '/hotlink/h.png', { headers: { Referer: ref } });
    assert.equal(r.res.status, 403, 'Referer ' + ref + ' debe dar 403');
  }
});

test('/cookie: 403 sin auth=1', async () => {
  assert.equal((await get(srv.origin + '/cookie/c.png')).res.status, 403);
  assert.equal((await get(srv.origin + '/cookie/c.png', { headers: { Cookie: 'foo=bar' } })).res.status, 403);
  const ok = await get(srv.origin + '/cookie/c.png', { headers: { Cookie: 'foo=bar; auth=1' } });
  assert.equal(ok.res.status, 200);
  assert.equal(ok.res.headers.get('content-type'), 'image/png');
});

test('/html-as-jpg.jpg devuelve HTML con 200', async () => {
  const { res, body } = await get(srv.origin + '/html-as-jpg.jpg');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(body.toString(), '<!doctype html><title>no</title>');
});

test('/slow.png espera los ms pedidos', async () => {
  const t0 = Date.now();
  const { res, body } = await get(srv.origin + '/slow.png?ms=300');
  assert.ok(Date.now() - t0 >= 280, 'esperó ' + (Date.now() - t0) + ' ms');
  assert.equal(res.status, 200);
  assert.ok(readIhdr(body));
});

test('close(): corta las conexiones abiertas y cancela el temporizador de /slow.png sin esperar', async () => {
  const s = await startServer();
  const pending = fetch(s.origin + '/slow.png?ms=5000').then((r) => 'status:' + r.status, (e) => 'rejected:' + e.name);
  // esperar a que el servidor haya registrado la petición (su temporizador ya está en marcha)
  for (let i = 0; i < 100 && !s.hits()['/slow.png']; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.hits()['/slow.png'].hits, 1);
  const t0 = Date.now();
  await s.close();
  const took = Date.now() - t0;
  assert.ok(took < 1000, 'close() tardó ' + took + ' ms: debe cortar la conexión, no esperar los 5 s');
  assert.match(await pending, /^rejected:/, 'la petición pendiente debe fallar, no completarse tras close()');
  const after = await fetch(s.origin + '/img/x.png').then((r) => r.status, (e) => 'rejected:' + e.name);
  assert.match(String(after), /^rejected:/, 'tras close() el puerto ya no escucha');
});

test('/fail-once: 500 la primera vez, 200 después, reinicia con /reset', async () => {
  await get(srv.origin + '/reset');
  const first = await get(srv.origin + '/fail-once.png');
  assert.equal(first.res.status, 500);
  const second = await get(srv.origin + '/fail-once.png');
  assert.equal(second.res.status, 200);
  assert.ok(readIhdr(second.body));
  assert.equal((await get(srv.origin + '/fail-once.png')).res.status, 200);
  const r = await get(srv.origin + '/reset');
  assert.equal(r.body.toString(), 'ok');
  assert.equal((await get(srv.origin + '/fail-once.png')).res.status, 500);
  srv.reset();
  assert.equal((await get(srv.origin + '/fail-once.png')).res.status, 500, 'reset() también reinicia');
});

test('/count y /reset: contadores por ruta con Referer y Cookie', async () => {
  await get(srv.origin + '/reset');
  await get(srv.origin + '/img/z.png?w=10&h=10');
  await get(srv.origin + '/img/z.png?w=20&h=20', { headers: { Referer: srv.origin + '/pages/basic.html' } });
  await get(srv.origin + '/img/z.png', { headers: { Cookie: 'auth=1' } });
  await get(srv.origin + '/cookie/k.png');
  const { res, body } = await get(srv.origin + '/count');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  const json = JSON.parse(body.toString());
  assert.deepEqual(json['/img/z.png'], { hits: 3, withReferer: 1, withCookie: 1 }, 'query ignorada en la clave');
  assert.deepEqual(json['/cookie/k.png'], { hits: 1, withReferer: 0, withCookie: 0 }, 'los 403 también cuentan');
  assert.equal(json['/count'], undefined, '/count no se cuenta');
  assert.deepEqual(srv.hits(), json, 'hits() coincide con /count');
  await get(srv.origin + '/reset');
  assert.deepEqual(srv.hits(), {});
  assert.equal((await get(srv.origin + '/count')).body.toString(), '{}');
});

test('ruta desconocida → 404; /favicon.ico → 204 sin contar', async () => {
  const { res, body } = await get(srv.origin + '/nada');
  assert.equal(res.status, 404);
  assert.equal(body.toString(), 'not found');
  assert.equal((await get(srv.origin + '/')).res.status, 404);
  await get(srv.origin + '/reset');
  assert.equal((await get(srv.origin + '/favicon.ico')).res.status, 204);
  assert.equal(srv.hits()['/favicon.ico'], undefined);
});

test('ejecución directa: imprime los dos orígenes y sigue en pie', async () => {
  const child = spawn(process.execPath, [SERVER_FILE], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  const lines = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sin salida en 5 s')), 5000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const ls = out.split('\n').filter(Boolean);
      if (ls.length >= 2) {
        clearTimeout(timer);
        resolve(ls);
      }
    });
    child.on('exit', (code) => reject(new Error('salió antes de tiempo: ' + code)));
  });
  try {
    assert.match(lines[0], /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(lines[1], 'http://localhost:' + lines[0].split(':')[2]);
    const res = await fetch(lines[0] + '/img/direct.png?w=8&h=8');
    assert.equal(res.status, 200);
  } finally {
    child.kill('SIGTERM');
  }
});
