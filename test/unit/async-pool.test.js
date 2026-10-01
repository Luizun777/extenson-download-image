'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const AP = require(path.join(__dirname, '..', '..', 'lib', 'async-pool.js'));
const { pool, withTimeout, shouldRetry, retryOnce, sleep } = AP;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('exports', () => {
  for (const k of ['pool', 'withTimeout', 'shouldRetry', 'sleep', 'retryOnce']) assert.equal(typeof AP[k], 'function', k);
  assert.equal(globalThis.ImgDL.asyncPool, AP);
});

test('pool: resultados en orden de entrada y concurrencia máxima = limit', async () => {
  const items = [30, 5, 20, 1, 15, 8, 2, 12, 3, 7];
  let running = 0;
  let maxRunning = 0;
  const settled = [];
  const res = await pool(items, 3, async (ms, i) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await wait(ms);
    running--;
    return `${i}:${ms}`;
  }, { onSettled: (r, i) => settled.push(i) });
  assert.equal(res.length, items.length);
  res.forEach((r, i) => assert.deepEqual(r, { ok: true, value: `${i}:${items[i]}` }));
  assert.equal(maxRunning, 3);
  assert.deepEqual([...settled].sort((a, b) => a - b), items.map((_, i) => i));
  assert.notDeepEqual(settled, items.map((_, i) => i), 'onSettled sigue el orden de finalización');
});

test('pool: nunca rechaza; errores (incluidos síncronos) -> {ok:false, error}', async () => {
  const boom = new Error('boom');
  const res = await pool([1, 2, 3], 2, (x) => {
    if (x === 2) throw boom;
    if (x === 3) return Promise.reject(new Error('async'));
    return x;
  });
  assert.deepEqual(res[0], { ok: true, value: 1 });
  assert.equal(res[1].ok, false);
  assert.equal(res[1].error, boom);
  assert.equal(res[2].ok, false);
  assert.equal(res[2].error.message, 'async');
});

test('pool: lista vacía, limit inválido y onSettled que lanza', async () => {
  assert.deepEqual(await pool([], 4, async () => 1), []);
  const r1 = await pool([1, 2], 0, async (x) => x, { onSettled: () => { throw new Error('ignorado'); } });
  assert.deepEqual(r1, [{ ok: true, value: 1 }, { ok: true, value: 2 }]);
  const r2 = await pool(new Set([5]), Infinity, async (x) => x);
  assert.deepEqual(r2, [{ ok: true, value: 5 }]);
});

test('pool: abort deja de arrancar trabajo; pendientes reciben AbortError', async () => {
  const ac = new AbortController();
  const started = [];
  const res = await pool([1, 2, 3, 4, 5, 6], 2, async (x, i, signal) => {
    started.push(x);
    assert.equal(signal, ac.signal);
    await wait(10);
    if (x === 1) ac.abort(); // el primero en acabar aborta; el 2 ya corre y termina
    return x;
  }, { signal: ac.signal });
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(res[0], { ok: true, value: 1 });
  assert.deepEqual(res[1], { ok: true, value: 2 });
  for (let i = 2; i < 6; i++) {
    assert.equal(res[i].ok, false, `item ${i}`);
    assert.equal(res[i].error.name, 'AbortError', `item ${i}`);
    // code de cadena: el protocolo y strings.format lo necesitan (la DOMException nativa trae 20).
    assert.equal(res[i].error.code, 'ABORTED', `item ${i}`);
    assert.ok(res[i].error.cause instanceof DOMException, `item ${i}: conserva la DOMException en cause`);
  }
});

test('pool: señal ya abortada -> todo AbortError sin llamar al worker', async () => {
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  const res = await pool([1, 2], 2, async () => { calls++; }, { signal: ac.signal });
  assert.equal(calls, 0);
  assert.equal(res.length, 2);
  assert.ok(res.every((r) => r.ok === false && r.error.name === 'AbortError' && r.error.code === 'ABORTED'));
});

test('pool: abort con reason que ya trae code de cadena se propaga tal cual', async () => {
  const ac = new AbortController();
  const zipErr = new Error('zip'); zipErr.code = 'TOO_BIG';
  ac.abort(zipErr);
  const res = await pool([1, 2], 2, async (x) => x, { signal: ac.signal });
  assert.ok(res.every((r) => r.ok === false && r.error === zipErr && r.error.code === 'TOO_BIG'));
});

test('withTimeout: resuelve antes del plazo', async () => {
  const v = await withTimeout(async (signal) => {
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    return 'ok';
  }, 1000);
  assert.equal(v, 'ok');
});

test('withTimeout: TimeoutError al vencer el plazo y la señal se aborta', async () => {
  // Ruta nativa (AbortSignal.any): el factory rechaza con signal.reason, una DOMException
  // con code numérico 23; withTimeout debe normalizar a code 'TIMEOUT'.
  assert.equal(typeof AbortSignal.any, 'function', 'este test cubre la ruta nativa');
  let sig;
  const t0 = Date.now();
  await assert.rejects(
    withTimeout((signal) => {
      sig = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    }, 30),
    (e) => {
      assert.equal(e.name, 'TimeoutError');
      assert.equal(e.code, 'TIMEOUT');
      assert.ok(e.cause instanceof DOMException, 'conserva la DOMException original en cause');
      assert.equal(e.cause.code, 23);
      return true;
    }
  );
  assert.ok(Date.now() - t0 >= 25);
  assert.equal(sig.aborted, true);
});

test('withTimeout: AbortError de la señal padre', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(
    withTimeout((signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))), 1000, ac.signal),
    (e) => {
      assert.equal(e.name, 'AbortError');
      assert.equal(e.code, 'ABORTED');
      assert.ok(e.cause instanceof DOMException);
      assert.equal(e.cause.code, 20);
      return true;
    }
  );
});

test('withTimeout: razón del padre con code de cadena se propaga sin envolver', async () => {
  const ac = new AbortController();
  const zipErr = new Error('zip'); zipErr.code = 'TOO_BIG';
  const p = withTimeout((signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))), 1000, ac.signal);
  ac.abort(zipErr);
  await assert.rejects(p, (e) => e === zipErr);
});

test('withTimeout: factory que ignora la razón -> se normaliza a TimeoutError', async () => {
  await assert.rejects(
    withTimeout((signal) => new Promise((_, reject) => signal.addEventListener('abort', () => {
      const e = new Error('x'); e.name = 'AbortError'; reject(e);
    })), 20),
    (e) => e.name === 'TimeoutError' && e.code === 'TIMEOUT'
  );
});

test('withTimeout: sobrecarga (ms, parent) devuelve una señal combinada', async () => {
  const ac = new AbortController();
  const s = withTimeout(1000, ac.signal);
  assert.ok(s instanceof AbortSignal);
  assert.equal(s.aborted, false);
  ac.abort();
  assert.equal(s.aborted, true);
  const s2 = withTimeout(10);
  await wait(30);
  assert.equal(s2.aborted, true);
});

test('withTimeout: fallback manual sin AbortSignal.any', async () => {
  const origAny = AbortSignal.any;
  AbortSignal.any = undefined;
  try {
    const v = await withTimeout(async () => 'rapido', 100);
    assert.equal(v, 'rapido');
    await assert.rejects(
      withTimeout((signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))), 20),
      (e) => e.name === 'TimeoutError' && e.code === 'TIMEOUT'
    );
    const ac = new AbortController();
    const p = withTimeout((signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))), 1000, ac.signal);
    ac.abort();
    await assert.rejects(p, (e) => e.name === 'AbortError' && e.code === 'ABORTED');
    // Señal padre ya abortada.
    const ac2 = new AbortController();
    ac2.abort();
    await assert.rejects(
      withTimeout((signal) => Promise.reject(signal.reason), 1000, ac2.signal),
      (e) => e.name === 'AbortError' && e.code === 'ABORTED'
    );
  } finally {
    AbortSignal.any = origAny;
  }
});

test('shouldRetry: 429/5xx y TypeError de red sí; otros 4xx, abort y timeout no', () => {
  assert.equal(shouldRetry({ status: 429 }), true);
  assert.equal(shouldRetry({ status: 500 }), true);
  assert.equal(shouldRetry({ status: 503 }), true);
  assert.equal(shouldRetry({ status: 599 }), true);
  assert.equal(shouldRetry({ status: '502' }), true);
  assert.equal(shouldRetry(new TypeError('fetch failed')), true);
  assert.equal(shouldRetry({ name: 'TypeError' }), true);
  assert.equal(shouldRetry({ code: 'NETWORK' }), true);
  assert.equal(shouldRetry({ status: 400 }), false);
  assert.equal(shouldRetry({ status: 401 }), false);
  assert.equal(shouldRetry({ status: 403 }), false);
  assert.equal(shouldRetry({ status: 404 }), false);
  assert.equal(shouldRetry({ status: 200 }), false);
  assert.equal(shouldRetry({ status: 600 }), false);
  assert.equal(shouldRetry({ name: 'AbortError' }), false);
  assert.equal(shouldRetry({ name: 'TimeoutError' }), false);
  const abortTE = new TypeError('abort'); abortTE.name = 'AbortError';
  assert.equal(shouldRetry(abortTE), false);
  assert.equal(shouldRetry(new Error('x')), false);
  assert.equal(shouldRetry(null), false);
  assert.equal(shouldRetry(undefined), false);
});

test('retryOnce: 503 y luego 200', async () => {
  let calls = 0;
  const attempts = [];
  const res = await retryOnce(async (attempt) => {
    attempts.push(attempt);
    calls++;
    if (calls === 1) { const e = new Error('503'); e.status = 503; throw e; }
    return { status: 200 };
  }, 5);
  assert.deepEqual(res, { status: 200 });
  assert.equal(calls, 2);
  assert.deepEqual(attempts, [0, 1]);
});

test('retryOnce: 404 no reintenta; dos fallos reintentables lanzan el segundo', async () => {
  let calls = 0;
  await assert.rejects(retryOnce(async () => { calls++; const e = new Error('404'); e.status = 404; throw e; }, 5), /404/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(retryOnce(async () => { calls++; const e = new Error('fail' + calls); e.status = 500; throw e; }, 5), /fail2/);
  assert.equal(calls, 2);
});

test('retryOnce: por defecto espera 1000 ms y respeta la señal', async () => {
  assert.equal(AP.RETRY_DELAY_MS, 1000);
  const ac = new AbortController();
  let calls = 0;
  const p = retryOnce(async () => { calls++; throw new TypeError('net'); }, 1000, ac.signal);
  await wait(5);
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.equal(calls, 1);
});

test('sleep: resuelve tras ms y rechaza al abortar', async () => {
  const t0 = Date.now();
  await sleep(20);
  assert.ok(Date.now() - t0 >= 15);
  const ac = new AbortController();
  const p = sleep(1000, ac.signal);
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  ac.abort();
  await assert.rejects(sleep(10, ac.signal), (e) => e.name === 'AbortError');
});
