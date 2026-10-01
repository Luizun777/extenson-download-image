'use strict';
// Concurrencia acotada compartida por el offscreen (pool de fetch) y el SW
// (cola de archivos): pool, timeout con AbortSignal, criterio de reintento.
(function (root) {
  const RETRY_DELAY_MS = 1000;

  // Los errores propios llevan code de cadena ('TIMEOUT' | 'ABORTED'): el protocolo y
  // strings.format se apoyan en él. Las DOMException nativas traen code numérico (20/23),
  // así que se normalizan conservando la original en `cause`.
  function makeError(name, message, code, cause) {
    const e = new Error(message);
    e.name = name;
    e.code = code;
    if (cause !== undefined) e.cause = cause;
    return e;
  }

  function cancelError(cause) {
    return makeError('AbortError', 'Operación cancelada', 'ABORTED', cause);
  }

  function timeoutError(ms, cause) {
    return makeError('TimeoutError', `Tiempo de espera agotado (${ms} ms)`, 'TIMEOUT', cause);
  }

  function hasStringCode(err) {
    return !!err && typeof err.code === 'string';
  }

  // Error de aborto: reutiliza signal.reason si ya trae code de cadena
  // (p. ej. ERR_ZIP_TOO_BIG); si no, AbortError 'ABORTED' con la razón como cause.
  function abortError(signal) {
    const reason = signal ? signal.reason : undefined;
    if (hasStringCode(reason)) return reason;
    return cancelError(reason);
  }

  function isAbortLike(err) {
    return !!err && (err.name === 'AbortError' || err.name === 'TimeoutError');
  }

  // sleep(ms, signal): rechaza con AbortError si la señal se aborta antes.
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(abortError(signal)); return; }
      const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms | 0));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // timeoutSignal(ms, parentSignal) -> {signal, timedOut(), cancel()}.
  // Usa AbortSignal.any/timeout si existen; si no, controlador manual.
  function timeoutSignal(ms, parentSignal) {
    const hasAny = typeof AbortSignal !== 'undefined' &&
      typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function';
    if (hasAny) {
      const tSignal = AbortSignal.timeout(ms);
      const signals = parentSignal ? [tSignal, parentSignal] : [tSignal];
      return {
        signal: AbortSignal.any(signals),
        timedOut: () => tSignal.aborted,
        cancel: () => {}
      };
    }
    const ctrl = new AbortController();
    let fired = false;
    const onParent = () => ctrl.abort(abortError(parentSignal));
    const timer = setTimeout(() => {
      fired = true;
      ctrl.abort(timeoutError(ms));
      if (parentSignal) parentSignal.removeEventListener('abort', onParent);
    }, ms);
    if (parentSignal) {
      if (parentSignal.aborted) onParent();
      else parentSignal.addEventListener('abort', onParent, { once: true });
    }
    return {
      signal: ctrl.signal,
      timedOut: () => fired,
      cancel: () => {
        clearTimeout(timer);
        if (parentSignal) parentSignal.removeEventListener('abort', onParent);
      }
    };
  }

  // withTimeout(factory, ms, parentSignal): factory(signal) -> Promise.
  // Rechaza con TimeoutError al vencer ms, o con AbortError si parentSignal se aborta.
  // Sobrecarga: withTimeout(ms, parentSignal) devuelve solo la señal combinada.
  function withTimeout(factory, ms, parentSignal) {
    if (typeof factory === 'number') {
      return timeoutSignal(factory, ms).signal;
    }
    const ts = timeoutSignal(ms, parentSignal);
    return new Promise((resolve, reject) => {
      let p;
      try {
        p = Promise.resolve(factory(ts.signal));
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(
        (v) => { ts.cancel(); resolve(v); },
        (err) => {
          ts.cancel();
          if (ts.timedOut() && (!err || isAbortLike(err))) {
            // Venció el plazo: TimeoutError 'TIMEOUT' aunque la API diera AbortError/DOMException.
            reject(err && err.code === 'TIMEOUT' ? err : timeoutError(ms, err));
          } else if (isAbortLike(err) && !hasStringCode(err)) {
            // Aborto del padre u otra DOMException (code 20/23) -> code de cadena.
            reject(err.name === 'TimeoutError' ? timeoutError(ms, err) : cancelError(err));
          } else {
            reject(err);
          }
        }
      );
    });
  }

  // shouldRetry(err): true en 429/5xx (err.status) y TypeError de red;
  // false en otros 4xx, abortos y timeouts.
  function shouldRetry(err) {
    if (!err) return false;
    if (isAbortLike(err)) return false;
    const status = typeof err.status === 'number' ? err.status
      : (typeof err.status === 'string' && /^\d{3}$/.test(err.status) ? Number(err.status) : null);
    if (status !== null) return status === 429 || (status >= 500 && status <= 599);
    if (err instanceof TypeError || err.name === 'TypeError') return true;
    if (err.code === 'NETWORK') return true;
    return false;
  }

  // retryOnce(fn, delayMs, signal): fn(attempt) una vez más si shouldRetry(err).
  async function retryOnce(fn, delayMs, signal) {
    const delay = typeof delayMs === 'number' ? delayMs : RETRY_DELAY_MS;
    try {
      return await fn(0);
    } catch (err) {
      if (!shouldRetry(err) || (signal && signal.aborted)) throw err;
      await sleep(delay, signal);
      return fn(1);
    }
  }

  // pool(items, limit, worker, {signal, onSettled}) -> Promise<Array<{ok, value}|{ok:false, error}>>
  // Resultados en el orden de entrada; nunca rechaza; al abortar no arranca más
  // trabajo y los pendientes reciben {ok:false, error:AbortError}.
  async function pool(items, limit, worker, opts) {
    const list = Array.from(items || []);
    const n = list.length;
    const o = opts || {};
    const signal = o.signal || null;
    const onSettled = typeof o.onSettled === 'function' ? o.onSettled : null;
    const results = new Array(n);
    let lim = Number.isFinite(limit) ? Math.floor(limit) : n;
    if (lim < 1) lim = 1;
    if (lim > n) lim = Math.max(1, n);

    const settle = (i, r) => {
      results[i] = r;
      if (onSettled) {
        try { onSettled(r, i, list[i]); } catch (_) { /* no rompe el pool */ }
      }
    };

    let next = 0;
    const runner = async () => {
      while (next < n) {
        const i = next++;
        if (signal && signal.aborted) {
          settle(i, { ok: false, error: abortError(signal) });
          continue;
        }
        try {
          const value = await worker(list[i], i, signal);
          settle(i, { ok: true, value });
        } catch (error) {
          settle(i, { ok: false, error });
        }
      }
    };

    const runners = [];
    for (let k = 0; k < lim; k++) runners.push(runner());
    await Promise.all(runners);
    return results;
  }

  const api = { pool, withTimeout, timeoutSignal, shouldRetry, retryOnce, sleep, RETRY_DELAY_MS };

  root.ImgDL = root.ImgDL || {};
  root.ImgDL.asyncPool = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
