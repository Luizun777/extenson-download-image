'use strict';
// lib/*.js deben ser puros: ni DOM, ni chrome.*, ni navigator/location; y
// cargarse con require() exponiendo un objeto.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', 'lib');
const FORBIDDEN = /\b(window|document|chrome|navigator|location)\b\s*[.\[]/g;

// Quita comentarios // y /* */ respetando cadenas, plantillas y regex literales.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let lastSig = ''; // último carácter significativo (para distinguir regex de división)
  const regexAllowedBefore = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '']);
  const regexAfterKeyword = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else)\s*$/;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      lastSig = c;
      continue;
    }
    if (c === '/') {
      const tail = out.slice(-40);
      if (regexAllowedBefore.has(lastSig) || regexAfterKeyword.test(tail)) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          const ch = src[j];
          if (ch === '\\') { j += 2; continue; }
          if (ch === '\n') break;
          if (inClass) { if (ch === ']') inClass = false; }
          else if (ch === '[') inClass = true;
          else if (ch === '/') break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        out += src.slice(i, j);
        i = j;
        lastSig = '/';
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out;
}

test('stripComments conserva código y quita comentarios', () => {
  const src = "const a = 'x // no'; // sí\nconst b = /\\/[\"]/g; /* bloque\n window.x */ const c = `t ${1} /* no */`; const d = 4 / 2 / 1;";
  const s = stripComments(src);
  assert.match(s, /const a = 'x \/\/ no';/);
  assert.doesNotMatch(s, /sí/);
  assert.doesNotMatch(s, /window/);
  assert.match(s, /const b = \/\\\/\["\]\/g;/);
  assert.match(s, /const c = `t \$\{1\} \/\* no \*\/`;/);
  assert.match(s, /const d = 4 \/ 2 \/ 1;/);
});

const files = fs.existsSync(LIB) ? fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).sort() : [];

test('lib/ contiene al menos un módulo', () => {
  assert.ok(files.length > 0);
});

for (const f of files) {
  const file = path.join(LIB, f);

  test(`lib/${f}: sin window/document/chrome/navigator/location`, () => {
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, /^'use strict';/, 'empieza con use strict');
    const code = stripComments(src);
    const hits = [];
    let m;
    FORBIDDEN.lastIndex = 0;
    while ((m = FORBIDDEN.exec(code))) {
      const line = code.slice(0, m.index).split('\n').length;
      hits.push(`${m[1]} en línea ${line}`);
    }
    assert.deepEqual(hits, [], `referencias prohibidas en lib/${f}: ${hits.join(', ')}`);
  });

  test(`lib/${f}: require() devuelve un objeto y registra ImgDL.<name>`, () => {
    const before = new Set(Object.keys(globalThis.ImgDL || {}));
    const mod = require(file);
    assert.equal(typeof mod, 'object');
    assert.ok(mod !== null);
    assert.ok(Object.keys(mod).length > 0, 'exporta algo');
    const ns = globalThis.ImgDL;
    assert.ok(ns && typeof ns === 'object', 'globalThis.ImgDL existe');
    const owner = Object.keys(ns).find((k) => ns[k] === mod);
    assert.ok(owner, `module.exports de lib/${f} es el mismo objeto que ImgDL.<name>`);
    assert.ok(before.has(owner) || Object.keys(ns).length > before.size);
  });
}
