'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const S = require(path.join(__dirname, '..', '..', 'lib', 'strings.js'));

const CONSTANTS = [
  'APP_NAME', 'CHIP_DOWNLOAD', 'CHIP_SELECT', 'CHIP_GROUP', 'BAR_LABEL', 'BAR_CLEAR', 'BAR_EXIT', 'BAR_CANCEL', 'BAR_CONTINUE',
  'ERR_RESTRICTED', 'ERR_403', 'ERR_HTML', 'ERR_TIMEOUT', 'ERR_NETWORK', 'ERR_TAINTED_CANVAS',
  'ERR_CANVAS_EMPTY', 'ERR_BLOB_GONE', 'ERR_SVG', 'ERR_TOO_BIG_ITEM',
  'ERR_ZIP_TOO_MANY', 'ERR_ZIP_TOO_BIG', 'ERR_FRAME', 'ERR_UI_REMOVED', 'ERR_EMPTY_SELECTION', 'ERR_GENERIC', 'ERR_JOB_RUNNING',
  'WARN_ASK_WHERE', 'STATUS_STARTED', 'PROGRESS_ZIP', 'PROGRESS_SAVING',
  'CANCELLED', 'COPY_URL', 'COPIED', 'FAILED_LIST_NAME',
  'ACTION_TITLE_ON', 'ACTION_TITLE_ON_PARTIAL', 'ACTION_TITLE_OFF', 'ACTION_TITLE_RESTRICTED'
];
const FUNCTIONS = [
  'BAR_SELECTED', 'BAR_FILES', 'BAR_ZIP', 'WARN_BIG', 'STATUS_DONE',
  'PROGRESS_FILES', 'PROGRESS_FETCH', 'SUMMARY_ZIP', 'SUMMARY_FILES'
];

test('expone todas las constantes como cadenas no vacías', () => {
  for (const k of CONSTANTS) {
    assert.equal(typeof S[k], 'string', k);
    assert.ok(S[k].length > 0, k);
  }
  assert.equal(typeof S.format, 'function');
  assert.equal(globalThis.ImgDL.strings, S);
});

test('la lista del test cubre todas las claves de strings.js (ninguna queda sin vigilar)', () => {
  const own = Object.keys(S).filter((k) => k !== 'format').sort();
  const listed = CONSTANTS.concat(FUNCTIONS).sort();
  assert.deepEqual(own, listed, 'añade la clave nueva a CONSTANTS o FUNCTIONS');
  for (const k of FUNCTIONS) assert.ok(!CONSTANTS.includes(k), k + ' no puede estar en ambas listas');
});

test('textos exactos de la especificación', () => {
  assert.equal(S.CHIP_DOWNLOAD, 'Descargar imagen');
  assert.equal(S.CHIP_SELECT, 'Seleccionar imagen');
  assert.equal(S.BAR_CLEAR, 'Limpiar');
  assert.equal(S.BAR_EXIT, 'Salir (Esc)');
  assert.equal(S.BAR_CANCEL, 'Cancelar');
  assert.equal(S.BAR_CONTINUE, 'Continuar');
  assert.equal(S.CHIP_GROUP, 'Acciones de la imagen');
  assert.equal(S.BAR_LABEL, 'Imágenes seleccionadas');
  assert.equal(S.ERR_RESTRICTED, 'No disponible en esta página (páginas internas, tienda o visor PDF).');
  assert.equal(S.ERR_403, 'El servidor rechazó la descarga (403, protección anti-hotlink).');
  assert.equal(S.ERR_HTML, 'La URL devolvió HTML en lugar de una imagen.');
  assert.equal(S.ERR_TIMEOUT, 'La descarga tardó demasiado (30 s).');
  assert.equal(S.ERR_NETWORK, 'Error de red al descargar la imagen.');
  assert.equal(S.APP_NAME, 'Descarga de imágenes');
  assert.equal(S.ERR_TAINTED_CANVAS, 'Lienzo protegido: el navegador impide exportarlo.');
  assert.equal(S.ERR_CANVAS_EMPTY, 'El lienzo está vacío.');
  assert.equal(S.ERR_BLOB_GONE, 'La imagen blob: ya no está disponible.');
  assert.equal(S.ERR_SVG, 'No se pudo serializar el SVG.');
  assert.equal(S.ERR_TOO_BIG_ITEM, 'Imagen demasiado grande para transferir (máx. 32 MB).');
  assert.equal(S.ERR_ZIP_TOO_MANY, 'Demasiados archivos para un ZIP (máx. 65 535).');
  assert.equal(S.ERR_ZIP_TOO_BIG, 'El ZIP superaría 4 GB. Divide la selección.');
  assert.equal(S.ERR_FRAME, 'Imagen en un marco inaccesible.');
  assert.equal(S.ERR_UI_REMOVED, 'La página elimina la interfaz continuamente.');
  assert.equal(S.ERR_GENERIC, 'No se pudo descargar la imagen.');
  assert.equal(S.ERR_JOB_RUNNING, 'Ya hay una descarga en marcha en esta pestaña.');
  assert.equal(S.ERR_EMPTY_SELECTION, 'No hay imágenes seleccionadas.');
  assert.equal(S.WARN_ASK_WHERE, 'Si Chrome pregunta dónde guardar cada archivo, desactívalo en chrome://settings/downloads o usa ZIP.');
  assert.equal(S.STATUS_STARTED, 'Descarga iniciada');
  assert.equal(S.PROGRESS_ZIP, 'Creando ZIP…');
  assert.equal(S.PROGRESS_SAVING, 'Guardando ZIP…');
  assert.equal(S.CANCELLED, 'Cancelado');
  assert.equal(S.COPY_URL, 'Copiar URL');
  assert.equal(S.COPIED, 'URL copiada');
  assert.equal(S.FAILED_LIST_NAME, '_fallidas.txt');
  assert.match(S.ACTION_TITLE_ON, /Descarga de imágenes/);
  assert.match(S.ACTION_TITLE_OFF, /Descarga de imágenes/);
  assert.notEqual(S.ACTION_TITLE_ON, S.ACTION_TITLE_OFF);
  assert.match(S.ACTION_TITLE_RESTRICTED, /^No disponible en esta página/);
});

test('las parametrizadas son funciones que devuelven texto con los números', () => {
  for (const k of FUNCTIONS) assert.equal(typeof S[k], 'function', k);
  assert.equal(S.BAR_SELECTED(7), '7 seleccionadas');
  assert.equal(S.BAR_FILES(12), 'Descargar archivos (12)');
  assert.equal(S.BAR_ZIP(3), 'Descargar ZIP (3)');
  assert.equal(S.WARN_BIG(350, 1200), 'Vas a descargar 350 archivos (~1200 MB). ¿Continuar?');
  assert.equal(S.STATUS_DONE('foto.png'), 'Descargada: foto.png');
  assert.equal(S.PROGRESS_FILES(2, 9), 'Descargando 2/9…');
  assert.equal(S.PROGRESS_FETCH(5, 9), 'Obteniendo imágenes 5/9…');
  assert.equal(S.SUMMARY_ZIP(8, 10, 2), 'ZIP listo: 8 de 10 · 2 descargadas aparte');
  assert.equal(S.SUMMARY_FILES(4, 1), 'Descargadas 4 · 1 fallidas');
});

test('format: códigos del protocolo -> texto en español', () => {
  assert.equal(S.format('ERR_403'), S.ERR_403);
  assert.equal(S.format('HTTP_403'), S.ERR_403);
  assert.equal(S.format('HTTP_401'), S.ERR_403);
  assert.equal(S.format('NOT_IMAGE'), S.ERR_HTML);
  assert.equal(S.format('ERR_HTML'), S.ERR_HTML);
  assert.equal(S.format('TIMEOUT'), S.ERR_TIMEOUT);
  assert.equal(S.format('ERR_TIMEOUT'), S.ERR_TIMEOUT);
  assert.equal(S.format('ABORTED'), S.CANCELLED);
  assert.equal(S.format('CANCELLED'), S.CANCELLED);
  assert.equal(S.format('ERR_ZIP_TOO_MANY'), S.ERR_ZIP_TOO_MANY);
  assert.equal(S.format('ERR_ZIP_TOO_BIG'), S.ERR_ZIP_TOO_BIG);
  assert.equal(S.format('ERR_RESTRICTED'), S.ERR_RESTRICTED);
  assert.equal(S.format('ERR_TAINTED_CANVAS'), S.ERR_TAINTED_CANVAS);
  assert.equal(S.format('ERR_GENERIC'), S.ERR_GENERIC);
  assert.equal(S.format('JOB_RUNNING'), S.ERR_JOB_RUNNING);
  // NAME_TOO_LONG (ZipLimitError) está mapeado explícitamente a ERR_GENERIC.
  assert.equal(S.format('NAME_TOO_LONG'), S.ERR_GENERIC);
  assert.equal(S.format('TOO_MANY'), S.ERR_ZIP_TOO_MANY);
  assert.equal(S.format('TOO_BIG'), S.ERR_ZIP_TOO_BIG);
  // Código del offscreen sin texto propio: genérico, nunca 'undefined'.
  assert.equal(S.format('NO_BYTES'), S.ERR_GENERIC);
  // EMPTY (lote sin selección) tiene texto propio, distinto del genérico.
  assert.equal(S.format('EMPTY'), S.ERR_EMPTY_SELECTION);
  assert.notEqual(S.format('EMPTY'), S.ERR_GENERIC);
  // NETWORK tiene texto propio en español.
  const net = S.format('NETWORK');
  assert.equal(typeof net, 'string');
  assert.match(net, /red/i);
  assert.notEqual(net, S.ERR_GENERIC);
});

test('format: HTTP_<n> genérico incluye el código y lo demás cae en ERR_GENERIC', () => {
  assert.match(S.format('HTTP_500'), /HTTP 500/);
  assert.match(S.format('HTTP_5xx'), /HTTP 5xx/);
  assert.match(S.format('HTTP_404'), /HTTP 404/);
  assert.equal(S.format('NO_EXISTE'), S.ERR_GENERIC);
  assert.equal(S.format(''), S.ERR_GENERIC);
  assert.equal(S.format(undefined), S.ERR_GENERIC);
  assert.equal(S.format(null), S.ERR_GENERIC);
  assert.equal(S.format(42), S.ERR_GENERIC);
});

test('format: placeholders por objeto y por array', () => {
  assert.equal(S.format('WARN_BIG', { n: 5, mb: 12 }), 'Vas a descargar 5 archivos (~12 MB). ¿Continuar?');
  assert.equal(S.format('WARN_BIG', [5, 12]), 'Vas a descargar 5 archivos (~12 MB). ¿Continuar?');
  assert.equal(S.format('BAR_SELECTED', { n: 2 }), '2 seleccionadas');
  assert.equal(S.format('BAR_SELECTED', { count: 2 }), '2 seleccionadas');
  assert.equal(S.format('BAR_SELECTED', 2), '2 seleccionadas');
  assert.equal(S.format('PROGRESS_FILES', { done: 1, total: 4 }), 'Descargando 1/4…');
  assert.equal(S.format('PROGRESS_FETCH', { d: 3, t: 4 }), 'Obteniendo imágenes 3/4…');
  assert.equal(S.format('SUMMARY_ZIP', { ok: 8, total: 10, fb: 2 }), 'ZIP listo: 8 de 10 · 2 descargadas aparte');
  assert.equal(S.format('SUMMARY_FILES', { ok: 4, failed: 1 }), 'Descargadas 4 · 1 fallidas');
  assert.equal(S.format('STATUS_DONE', { name: 'a.jpg' }), 'Descargada: a.jpg');
});

test('format: parámetros ausentes o parciales nunca interpolan "undefined"', () => {
  const noUndef = (s) => { assert.doesNotMatch(s, /undefined|null/); assert.ok(s.length > 0); return s; };
  assert.equal(noUndef(S.format('WARN_BIG')), 'Vas a descargar ? archivos (~? MB). ¿Continuar?');
  assert.equal(noUndef(S.format('WARN_BIG', null)), 'Vas a descargar ? archivos (~? MB). ¿Continuar?');
  assert.equal(noUndef(S.format('WARN_BIG', { n: 5 })), 'Vas a descargar 5 archivos (~? MB). ¿Continuar?');
  assert.equal(noUndef(S.format('WARN_BIG', { mb: null })), 'Vas a descargar ? archivos (~? MB). ¿Continuar?');
  assert.equal(noUndef(S.format('WARN_BIG', [5])), 'Vas a descargar 5 archivos (~? MB). ¿Continuar?');
  // Escalar para una clave de varios parámetros: ocupa la primera posición.
  assert.equal(noUndef(S.format('PROGRESS_FILES', 3)), 'Descargando 3/?…');
  assert.equal(noUndef(S.format('SUMMARY_ZIP', {})), 'ZIP listo: ? de ? · ? descargadas aparte');
  assert.equal(noUndef(S.format('STATUS_DONE')), 'Descargada: ?');
  // 0 es un valor válido, no un ausente.
  assert.equal(S.format('SUMMARY_FILES', { ok: 0, failed: 0 }), 'Descargadas 0 · 0 fallidas');
});
