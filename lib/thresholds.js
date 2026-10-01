'use strict';
// Umbrales de la extensión y decisión pura de elegibilidad de una imagen.
// classifyFacts recibe "hechos" ya medidos (sin DOM) para poder testearse en Node.
(function (root) {
  const KiB = 1024;
  const MiB = 1024 * KiB;
  const GiB = 1024 * MiB;

  const DEFAULTS = Object.freeze({
    hoverMin: 40,              // lado mínimo (px) para ofrecer el chip
    svgMin: 48,                // lado mínimo de un <svg> raíz
    pixelMax: 2,               // píxel de seguimiento: natural o rect <= 2
    spacerNaturalMax: 16,      // spacer: natural <= 16 ...
    spacerRenderedMin: 64,     // ... estirado a >= 64 en algún eje
    placeholderDataMax: 1024,  // data: URL <= 1 KiB = placeholder
    lqipRatio: 0.25,           // natural < 25 % del rect*DPR con atributo lazy
    maxStack: 12,              // entradas máximas de elementsFromPoint expandido
    maxShadowDepth: 3,
    maxStyleReads: 6,          // presupuesto de getComputedStyle por hit-test
    geoAncestors: 5,           // fallback geométrico: ancestros a explorar
    geoCandidates: 50,         // ... y candidatos máximos
    chipDelayMs: 150,
    rectMargin: 8,
    badgeCap: 300,
    fetchConcurrency: 4,
    fetchTimeoutMs: 30000,
    filesConcurrency: 4,
    zipSoftFiles: 300,         // pedir confirmación por encima
    zipSoftBytes: 1 * GiB,
    zipHardBytes: 4 * GiB - 64 * MiB,
    zipMaxEntries: 65535,
    maxItemBytes: 32 * MiB,    // tope del transporte base64 por ítem
    preferFullSizeLink: true,
    folder: 'Imagenes',
    frameDebounceMs: 500,
    progressThrottleMs: 250,
    offscreenIdleMs: 10000
  });

  // Modo 'select': natural mínimo y rect mínimo (si natural desconocido).
  const SELECT_NATURAL_MIN = 100;
  const SELECT_RECT_MIN = 64;

  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }

  // facts = {tag, rect:{w,h}, natural:{w,h}|null, complete, isSvgRoot, hasLazyAttr}
  // hasLazyAttr: el elemento lleva data-src/data-srcset/...: su src es un placeholder,
  // así que el tamaño natural no describe la imagen real y solo se juzga el rect.
  // mode = 'hover' | 'select'
  // -> {accept, reason:'ok'|'pixel'|'spacer'|'small'|'svg-small'}
  function classifyFacts(facts, mode, t) {
    const f = facts || {};
    // Un objeto parcial se fusiona con DEFAULTS: una clave ausente no desactiva su regla.
    const th = t && t !== DEFAULTS ? Object.assign({}, DEFAULTS, t) : DEFAULTS;
    const m = mode === 'select' ? 'select' : 'hover';
    const rw = num(f.rect && f.rect.w);
    const rh = num(f.rect && f.rect.h);
    const tag = typeof f.tag === 'string' ? f.tag.toLowerCase() : '';
    const isSvgRoot = !!f.isSvgRoot || tag === 'svg';

    // Natural solo cuenta si la imagen está cargada y tiene tamaño intrínseco.
    let nat = null;
    if (!f.hasLazyAttr && f.complete !== false && f.natural && typeof f.natural === 'object') {
      const nw = num(f.natural.w);
      const nh = num(f.natural.h);
      if (nw > 0 && nh > 0) nat = { w: nw, h: nh };
    }

    const done = (reason) => ({ accept: reason === 'ok', reason });

    // 1) Píxel de seguimiento.
    if (rw <= th.pixelMax || rh <= th.pixelMax) return done('pixel');
    if (nat && (nat.w <= th.pixelMax || nat.h <= th.pixelMax)) return done('pixel');

    // 2) Spacer: diminuto estirado.
    if (nat && nat.w <= th.spacerNaturalMax && nat.h <= th.spacerNaturalMax &&
        (rw >= th.spacerRenderedMin || rh >= th.spacerRenderedMin)) {
      return done('spacer');
    }

    // 3) SVG raíz: umbral propio.
    if (isSvgRoot) {
      if (rw < th.svgMin || rh < th.svgMin) return done('svg-small');
      return done('ok');
    }

    // 4) Tamaño mínimo.
    if (m === 'select') {
      const selNat = th.selectNaturalMin || SELECT_NATURAL_MIN;
      const selRect = th.selectRectMin || SELECT_RECT_MIN;
      const big = nat
        ? (nat.w >= selNat && nat.h >= selNat)
        : (rw >= selRect && rh >= selRect);
      return done(big ? 'ok' : 'small');
    }
    if (rw < th.hoverMin || rh < th.hoverMin) return done('small');
    return done('ok');
  }

  const api = { DEFAULTS, classifyFacts };

  root.ImgDL = root.ImgDL || {};
  root.ImgDL.thresholds = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
