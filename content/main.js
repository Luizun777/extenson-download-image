'use strict';
// Último archivo inyectado: crea el controlador del frame una sola vez.
// No alterna nada: el SW difunde setActive(on/off) explícito con executeScript
// para que los frames no se desincronicen. La última expresión es el resultado
// de executeScript({files}) en este frame (boolean).
globalThis.__imgdl ??= globalThis.ImgDL.createController();
globalThis.__imgdl.isActive();
