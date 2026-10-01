'use strict';
// Textos de la interfaz en español y mapa código de error -> mensaje.
// Única fuente de verdad: toasts del content script, avisos del SW y tests
// comparan contra estas cadenas.
(function (root) {
  const APP_NAME = 'Descarga de imágenes';

  // Textos fijos.
  const T = {
    APP_NAME,
    CHIP_DOWNLOAD: 'Descargar imagen',
    CHIP_SELECT: 'Seleccionar imagen',
    CHIP_GROUP: 'Acciones de la imagen', // aria-label del chip (role=group)
    BAR_LABEL: 'Imágenes seleccionadas', // aria-label de la barra (role=toolbar)
    BAR_CLEAR: 'Limpiar',
    BAR_EXIT: 'Salir (Esc)',
    BAR_CANCEL: 'Cancelar',
    BAR_CONTINUE: 'Continuar',
    ERR_RESTRICTED: 'No disponible en esta página (páginas internas, tienda o visor PDF).',
    ERR_403: 'El servidor rechazó la descarga (403, protección anti-hotlink).',
    ERR_HTML: 'La URL devolvió HTML en lugar de una imagen.',
    ERR_TIMEOUT: 'La descarga tardó demasiado (30 s).',
    ERR_NETWORK: 'Error de red al descargar la imagen.',
    ERR_TAINTED_CANVAS: 'Lienzo protegido: el navegador impide exportarlo.',
    ERR_CANVAS_EMPTY: 'El lienzo está vacío.',
    ERR_BLOB_GONE: 'La imagen blob: ya no está disponible.',
    ERR_SVG: 'No se pudo serializar el SVG.',
    ERR_TOO_BIG_ITEM: 'Imagen demasiado grande para transferir (máx. 32 MB).',
    ERR_ZIP_TOO_MANY: 'Demasiados archivos para un ZIP (máx. 65 535).',
    ERR_ZIP_TOO_BIG: 'El ZIP superaría 4 GB. Divide la selección.',
    ERR_FRAME: 'Imagen en un marco inaccesible.',
    ERR_UI_REMOVED: 'La página elimina la interfaz continuamente.',
    ERR_EMPTY_SELECTION: 'No hay imágenes seleccionadas.',
    ERR_GENERIC: 'No se pudo descargar la imagen.',
    ERR_JOB_RUNNING: 'Ya hay una descarga en marcha en esta pestaña.',
    WARN_ASK_WHERE: 'Si Chrome pregunta dónde guardar cada archivo, desactívalo en chrome://settings/downloads o usa ZIP.',
    STATUS_STARTED: 'Descarga iniciada',
    PROGRESS_ZIP: 'Creando ZIP…',
    PROGRESS_SAVING: 'Guardando ZIP…',
    CANCELLED: 'Cancelado',
    COPY_URL: 'Copiar URL',
    COPIED: 'URL copiada',
    FAILED_LIST_NAME: '_fallidas.txt', // entrada del ZIP con las imágenes que fallaron
    // Títulos del icono de la barra de herramientas.
    ACTION_TITLE_OFF: APP_NAME + ' (Alt+Shift+D): activar en esta pestaña',
    ACTION_TITLE_ON: APP_NAME + ' (Alt+Shift+D): activa en esta pestaña · clic para desactivar',
    ACTION_TITLE_ON_PARTIAL: APP_NAME + ' (Alt+Shift+D): activa solo en el marco principal · clic para desactivar',
    ACTION_TITLE_RESTRICTED: 'No disponible en esta página (páginas internas, tienda o visor PDF).'
  };

  // Textos con parámetros (posicionales).
  const F = {
    BAR_SELECTED: (n) => `${n} seleccionadas`,
    BAR_FILES: (n) => `Descargar archivos (${n})`,
    BAR_ZIP: (n) => `Descargar ZIP (${n})`,
    WARN_BIG: (n, mb) => `Vas a descargar ${n} archivos (~${mb} MB). ¿Continuar?`,
    STATUS_DONE: (name) => `Descargada: ${name}`,
    PROGRESS_FILES: (done, total) => `Descargando ${done}/${total}…`,
    PROGRESS_FETCH: (done, total) => `Obteniendo imágenes ${done}/${total}…`,
    SUMMARY_ZIP: (ok, total, fb) => `ZIP listo: ${ok} de ${total} · ${fb} descargadas aparte`,
    SUMMARY_FILES: (ok, failed) => `Descargadas ${ok} · ${failed} fallidas`
  };

  // Nombres de parámetro aceptados por format() para cada función (con alias).
  const PARAMS = {
    BAR_SELECTED: [['n', 'count']],
    BAR_FILES: [['n', 'count']],
    BAR_ZIP: [['n', 'count']],
    WARN_BIG: [['n', 'count'], ['mb', 'megabytes']],
    STATUS_DONE: [['name', 'filename']],
    PROGRESS_FILES: [['done', 'd'], ['total', 't']],
    PROGRESS_FETCH: [['done', 'd'], ['total', 't']],
    SUMMARY_ZIP: [['ok'], ['total'], ['fb', 'fallback', 'failed']],
    SUMMARY_FILES: [['ok'], ['failed']]
  };

  // Códigos de error/estado del protocolo -> clave de texto.
  const CODE_MAP = {
    HTTP_401: 'ERR_403',
    HTTP_403: 'ERR_403',
    FORBIDDEN: 'ERR_403',
    SERVER_FORBIDDEN: 'ERR_403',
    SERVER_UNAUTHORIZED: 'ERR_403',
    NOT_IMAGE: 'ERR_HTML',
    HTML: 'ERR_HTML',
    TIMEOUT: 'ERR_TIMEOUT',
    NETWORK: 'ERR_NETWORK',
    NETWORK_FAILED: 'ERR_NETWORK',
    NETWORK_TIMEOUT: 'ERR_TIMEOUT',
    ABORTED: 'CANCELLED',
    CANCELLED: 'CANCELLED',
    USER_CANCELED: 'CANCELLED',
    RESTRICTED: 'ERR_RESTRICTED',
    EMPTY: 'ERR_EMPTY_SELECTION', // lote sin selección (recuento de marcos desfasado)
    TOO_MANY: 'ERR_ZIP_TOO_MANY',
    TOO_BIG: 'ERR_ZIP_TOO_BIG',
    NO_BYTES: 'ERR_GENERIC', // offscreen: tipo byte cuyos bytes nunca llegaron
    JOB_RUNNING: 'ERR_JOB_RUNNING',
    NAME_TOO_LONG: 'ERR_GENERIC' // ZipLimitError inalcanzable hoy (names.js recorta a 120); sin texto propio
  };

  // Marcador visible para parámetros ausentes: nunca 'undefined' en la interfaz.
  const MISSING = '?';

  function pickArgs(key, params) {
    const names = PARAMS[key] || [];
    let args;
    if (Array.isArray(params)) args = params.slice();
    else if (params === null || params === undefined) args = [];
    else if (typeof params !== 'object') args = [params];
    else {
      args = names.map((aliases) => {
        for (const a of aliases) {
          if (params[a] !== undefined) return params[a];
        }
        return undefined;
      });
    }
    const n = Math.max(args.length, names.length);
    for (let i = 0; i < n; i++) {
      if (args[i] === undefined || args[i] === null) args[i] = MISSING;
    }
    return args;
  }

  // format(code, params) -> texto en español; nunca lanza, nunca devuelve vacío.
  function format(code, params) {
    const c = typeof code === 'string' ? code.trim() : '';
    let key = null;
    if (c) {
      if (Object.prototype.hasOwnProperty.call(T, c) || Object.prototype.hasOwnProperty.call(F, c)) key = c;
      else if (CODE_MAP[c]) key = CODE_MAP[c];
      else if (Object.prototype.hasOwnProperty.call(T, 'ERR_' + c)) key = 'ERR_' + c;
      else if (Object.prototype.hasOwnProperty.call(F, 'ERR_' + c)) key = 'ERR_' + c;
    }
    if (key && F[key]) {
      try { return String(F[key](...pickArgs(key, params))); } catch (_) { return T.ERR_GENERIC; }
    }
    if (key && T[key]) return T[key];
    // HTTP_<n> genérico (5xx, 404, 'HTTP_5xx'…).
    const m = /^HTTP_(\d{3}|\dxx)$/i.exec(c);
    if (m) return `El servidor respondió con un error (HTTP ${m[1]}).`;
    return T.ERR_GENERIC;
  }

  const api = Object.assign({}, T, F, { format });

  root.ImgDL = root.ImgDL || {};
  root.ImgDL.strings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
