'use strict';
// Servidor de fixtures para los tests (node:http, sin dependencias).
// listen(0) sin host → doble pila: http://127.0.0.1:P y http://localhost:P son dos orígenes.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { encodePng, encodeNoisePng, colourFor } = require('./png.js');

const DEFAULT_PAGES_DIR = path.join(__dirname, 'pages');
const DIM_DEFAULT = 200;
const DIM_MAX = 4096;
const NOISE_MB_DEFAULT = 1;
const NOISE_MB_MAX = 64;
const NOISE_CACHE_MAX = 128 * 1048576; // bytes de PNG de ruido cacheados como máximo
const SLOW_MS_MAX = 20000;
const REFERERS_MAX = 8; // valores de Referer conservados por ruta
const HTML_BODY = '<!doctype html><title>no</title>';
const AUTH_COOKIE = /(?:^|;\s*)auth=1(?:;|$)/;
const NAME_RE = /^[\p{L}\p{N} ()._-]+$/u;
const PAGE_RE = /^\/pages\/([\w-]+\.(html|css|js))$/;
const PNG_RE = /^\/(img|nocors|cors|hotlink|cookie)\/([^/]+)\.png$/;
const STATIC_TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
};
// Cabeceras extra por página (csp.html la usa otro test).
const PAGE_HEADERS = {
  'csp.html': {
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src * data: blob:; script-src 'self'",
  },
};

function send(res, status, type, body, extra) {
  const headers = Object.assign({ 'Cache-Control': 'no-store', 'Content-Type': type }, extra);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  headers['Content-Length'] = payload.length;
  res.writeHead(status, headers);
  res.end(payload);
}

function dim(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return DIM_DEFAULT;
  return Math.min(n, DIM_MAX);
}

function createState(pagesDir) {
  return {
    pagesDir,
    counters: new Map(), // pathname decodificado → {hits, withReferer, withCookie}
    referers: new Map(), // pathname decodificado → últimos valores de Referer recibidos (/referers)
    failedOnce: false,
    solid: new Map(), // 'nombre|w|h' → Buffer
    noise: new Map(), // 'mb|seed' → Buffer (FIFO acotado por bytes)
    noiseBytes: 0,
    timers: new Set(),
    port: 0, // puerto real tras listen(): fija los orígenes que acepta /hotlink
  };
}

function solidPng(state, name, w, h) {
  const key = name + '|' + w + '|' + h;
  let buf = state.solid.get(key);
  if (!buf) {
    buf = encodePng({ width: w, height: h, rgb: colourFor(name) });
    state.solid.set(key, buf);
  }
  return buf;
}

function noisePng(state, mb, seed) {
  const key = mb + '|' + seed;
  let buf = state.noise.get(key);
  if (!buf) {
    buf = encodeNoisePng({ mb, seed });
    state.noise.set(key, buf);
    state.noiseBytes += buf.length;
    for (const [k, v] of state.noise) {
      if (state.noiseBytes <= NOISE_CACHE_MAX) break;
      state.noise.delete(k);
      state.noiseBytes -= v.length;
    }
  }
  return buf;
}

function record(state, req, pathname) {
  const c = state.counters.get(pathname) || { hits: 0, withReferer: 0, withCookie: 0 };
  c.hits++;
  if (req.headers.referer) {
    c.withReferer++;
    const list = state.referers.get(pathname) || [];
    list.push(req.headers.referer);
    state.referers.set(pathname, list.slice(-REFERERS_MAX));
  }
  if (req.headers.cookie) c.withCookie++;
  state.counters.set(pathname, c);
}

function servePage(state, res, file) {
  const full = path.join(state.pagesDir, file);
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    const ext = file.slice(file.lastIndexOf('.') + 1);
    send(res, 200, STATIC_TYPES[ext], data, PAGE_HEADERS[file] || {});
  });
}

// Orígenes de la página en el puerto real (127.0.0.1 y localhost son los dos hosts del mismo servidor).
function pageOrigins(state) {
  return ['http://127.0.0.1:' + state.port, 'http://localhost:' + state.port];
}

function servePngRoute(state, req, res, kind, name, query) {
  const w = dim(query.get('w'));
  const h = dim(query.get('h'));
  if (kind === 'hotlink') {
    // Solo un Referer que empiece por el origen de la página (o su alterno): otro puerto local no vale.
    const ref = req.headers.referer;
    if (typeof ref !== 'string' || !pageOrigins(state).some((o) => ref.startsWith(o + '/'))) {
      return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    }
  } else if (kind === 'cookie') {
    const cookie = req.headers.cookie;
    if (typeof cookie !== 'string' || !AUTH_COOKIE.test(cookie)) {
      return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    }
  }
  const extra = kind === 'cors' ? { 'Access-Control-Allow-Origin': '*' } : {};
  send(res, 200, 'image/png', solidPng(state, name, w, h), extra);
}

function handle(state, req, res) {
  const url = new URL(req.url, 'http://fixtures.invalid');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'text/plain; charset=utf-8', 'bad request');
  }
  if (pathname === '/favicon.ico') { // Chromium lo pide en cada página: ni cuenta ni ensucia la consola
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (pathname !== '/count' && pathname !== '/referers' && pathname !== '/reset') record(state, req, pathname);

  let m;
  if ((m = PAGE_RE.exec(pathname))) return servePage(state, res, m[1]);

  if ((m = PNG_RE.exec(pathname))) {
    if (!NAME_RE.test(m[2])) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    return servePngRoute(state, req, res, m[1], m[2], url.searchParams);
  }

  if (pathname === '/noise.png') {
    const mbRaw = parseFloat(url.searchParams.get('mb'));
    const mb = Number.isFinite(mbRaw) && mbRaw > 0 ? Math.min(mbRaw, NOISE_MB_MAX) : NOISE_MB_DEFAULT;
    const seedRaw = parseInt(url.searchParams.get('seed'), 10);
    const seed = Number.isFinite(seedRaw) ? seedRaw : 1;
    return send(res, 200, 'image/png', noisePng(state, mb, seed));
  }

  if (pathname === '/html-as-jpg.jpg') {
    return send(res, 200, 'text/html; charset=utf-8', HTML_BODY);
  }

  if (pathname === '/slow.png') {
    const msRaw = parseInt(url.searchParams.get('ms'), 10);
    const ms = Number.isFinite(msRaw) && msRaw > 0 ? Math.min(msRaw, SLOW_MS_MAX) : 0;
    const t = setTimeout(() => {
      state.timers.delete(t);
      if (!res.writableEnded && !res.destroyed) send(res, 200, 'image/png', solidPng(state, 'slow', DIM_DEFAULT, DIM_DEFAULT));
    }, ms);
    state.timers.add(t);
    res.on('close', () => {
      clearTimeout(t);
      state.timers.delete(t);
    });
    return undefined;
  }

  if (pathname === '/fail-once.png') {
    if (!state.failedOnce) {
      state.failedOnce = true;
      return send(res, 500, 'text/plain; charset=utf-8', 'fail');
    }
    return send(res, 200, 'image/png', solidPng(state, 'fail-once', DIM_DEFAULT, DIM_DEFAULT));
  }

  if (pathname === '/count') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(Object.fromEntries(state.counters)));
  }

  // Valores exactos de Referer por ruta (los últimos 8): {path: [referer, ...]}.
  if (pathname === '/referers') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(Object.fromEntries(state.referers)));
  }

  if (pathname === '/reset') {
    state.counters.clear();
    state.referers.clear();
    state.failedOnce = false;
    return send(res, 200, 'text/plain; charset=utf-8', 'ok');
  }

  return send(res, 404, 'text/plain; charset=utf-8', 'not found');
}

function startServer({ pagesDir = DEFAULT_PAGES_DIR } = {}) {
  const state = createState(pagesDir);
  const server = http.createServer((req, res) => handle(state, req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.off('error', reject);
      const port = server.address().port;
      state.port = port;
      resolve({
        server,
        port,
        origin: 'http://127.0.0.1:' + port,
        altOrigin: 'http://localhost:' + port,
        hits: () => structuredClone(Object.fromEntries(state.counters)),
        referers: () => structuredClone(Object.fromEntries(state.referers)),
        reset: () => {
          state.counters.clear();
          state.referers.clear();
          state.failedOnce = false;
        },
        png: (name, w = DIM_DEFAULT, h = DIM_DEFAULT) => solidPng(state, String(name), dim(w), dim(h)),
        close: () =>
          new Promise((done) => {
            for (const t of state.timers) clearTimeout(t);
            state.timers.clear();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = { startServer, PAGE_HEADERS, DEFAULT_PAGES_DIR };

// Ejecución directa: imprime los dos orígenes y queda a la espera.
if (require.main === module) {
  startServer().then((s) => {
    console.log(s.origin);
    console.log(s.altOrigin);
    const stop = () => s.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
