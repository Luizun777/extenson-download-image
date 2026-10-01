'use strict';
// background/referer-rules.js con un chrome simulado: forma de la regla, referer por
// página (≤ 2 KB o solo origen), hosts distintos, ids desde storage.session a partir de
// 1000 (serializados), add/remove/clearAll contra updateSessionRules y comportamiento
// inerte sin chrome.declarativeNetRequest.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

// chrome simulado mínimo: storage.session en memoria y DNR de sesión con registro de llamadas.
function makeChrome(opts) {
  const o = opts || {};
  const session = {};
  const rules = new Map();
  const calls = [];
  const chrome = {
    runtime: { id: EXT_ID },
    tabs: { TAB_ID_NONE: -1 },
    storage: {
      session: {
        async get(key) { return { [key]: session[key] }; },
        async set(obj) { Object.assign(session, obj); }
      }
    }
  };
  if (o.dnr !== false) {
    chrome.declarativeNetRequest = {
      async updateSessionRules(arg) {
        calls.push(arg);
        if (o.reject) throw new Error('rechazada');
        for (const id of arg.removeRuleIds || []) rules.delete(id);
        for (const r of arg.addRules || []) rules.set(r.id, r);
      },
      async getSessionRules() { return Array.from(rules.values()); }
    };
  }
  return { chrome, session, rules, calls };
}

function load(mock) {
  delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'background', 'referer-rules.js'))];
  if (mock) globalThis.chrome = mock.chrome; else delete globalThis.chrome;
  return require(path.join(__dirname, '..', '..', 'background', 'referer-rules.js'));
}

test.afterEach(() => { delete globalThis.chrome; });

test('buildRule: modifyHeaders Referer acotada a los fetch de la propia extensión y a los hosts', () => {
  const rr = load(makeChrome());
  const r = rr.buildRule(1000, ['cdn.example.com', '127.0.0.1'], 'http://127.0.0.1:3000/p.html');
  assert.deepEqual(r, {
    id: 1000,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: 'http://127.0.0.1:3000/p.html' }] },
    condition: { initiatorDomains: [EXT_ID], resourceTypes: ['xmlhttprequest'], requestDomains: ['cdn.example.com', '127.0.0.1'] }
  });
  assert.equal(rr.USE_TAB_ID_NONE, false, 'variante por defecto: sin tabIds (ambas variantes pasan hotlink.test.js; la estrecha no hace falta)');
  // Variante con tabIds:[TAB_ID_NONE], por opción o por el conmutador de pruebas.
  assert.deepEqual(rr.buildRule(1, ['a.com'], 'http://a.com/', { useTabIdNone: true }).condition.tabIds, [-1]);
  assert.equal(rr.setUseTabIdNone(true), true);
  assert.deepEqual(rr.buildRule(1, ['a.com'], 'http://a.com/').condition.tabIds, [-1]);
  assert.equal(rr.setUseTabIdNone(false), false);
  assert.equal(rr.buildRule(1, ['a.com'], 'http://a.com/').condition.tabIds, undefined);
  // Más de 100 hosts: sin requestDomains (la regla acota solo por iniciador y tipo).
  const many = Array.from({ length: 101 }, (_, i) => 'h' + i + '.com');
  assert.equal(rr.buildRule(1, many, 'http://a.com/').condition.requestDomains, undefined);
  assert.equal(rr.buildRule(1, [], 'http://a.com/').condition.requestDomains, undefined);
});

test('refererFor: url de la página si cabe en 2 KB, si no origin + "/"; topUrl para marcos sin http', () => {
  const rr = load(makeChrome());
  assert.equal(rr.refererFor({ url: 'https://www.pixiv.net/artworks/1' }), 'https://www.pixiv.net/artworks/1');
  const long = 'https://a.com/p?q=' + 'x'.repeat(3000);
  assert.equal(rr.refererFor({ url: long }), 'https://a.com/');
  assert.equal(rr.refererFor({ url: 'about:blank', topUrl: 'http://h.test/page' }), 'http://h.test/page');
  assert.equal(rr.refererFor({ url: 'about:srcdoc' }), '');
  assert.equal(rr.refererFor(null), '');
});

test('refererFor: como el navegador, nunca el fragmento ni las credenciales; solo el origen hacia otro origen o en bajada https→http', () => {
  const rr = load(makeChrome());
  // Fragmento (rutas SPA, tokens OAuth) y user:pw@ fuera (RFC 7231 §5.5.2), query se conserva al mismo origen.
  assert.equal(rr.refererFor({ url: 'http://site.test/p?x=1#access_token=abc' }), 'http://site.test/p?x=1');
  assert.equal(rr.refererFor({ url: 'http://user:pw@site.test/p?x=1#/album/123' }), 'http://site.test/p?x=1');
  assert.equal(rr.refererFor({ url: 'http://user:pw@site.test/p#f' }, ['http://site.test/i.png', 'http://site.test/j.png']), 'http://site.test/p');
  assert.equal(rr.refererFor({ url: 'about:blank', topUrl: 'http://h.test/page#frag' }), 'http://h.test/page');
  // Otro origen (CDN, otro host, otro puerto o esquema) o un objetivo entre varios de otro origen: solo origin + '/'.
  assert.equal(rr.refererFor({ url: 'https://www.pixiv.net/artworks/1?p=2#x' }, ['https://i.pximg.net/img/1.jpg']), 'https://www.pixiv.net/');
  assert.equal(rr.refererFor({ url: 'http://127.0.0.1:3000/pages/hotlink.html' }, 'http://localhost:3000/hotlink/h.png'), 'http://127.0.0.1:3000/');
  assert.equal(rr.refererFor({ url: 'http://a.com/p' }, ['http://a.com/i.png', 'http://a.com:8080/j.png']), 'http://a.com/');
  assert.equal(rr.refererFor({ url: 'https://a.com/p?q=1' }, ['http://a.com/i.png']), 'https://a.com/', 'bajada https→http');
  // Objetivos que no son http(s) (data:, blob:) no cuentan; con lista vacía se asume el mismo origen.
  assert.equal(rr.refererFor({ url: 'https://a.com/p' }, ['data:image/png;base64,AA', 'blob:https://a.com/x']), 'https://a.com/p');
  assert.equal(rr.refererFor({ url: 'https://a.com/p' }, []), 'https://a.com/p');
  // La regla completa lleva ese valor.
  const r = rr.buildRule(1000, ['i.pximg.net'], rr.refererFor({ url: 'https://www.pixiv.net/artworks/1#x' }, ['https://i.pximg.net/1.jpg']));
  assert.equal(r.action.requestHeaders[0].value, 'https://www.pixiv.net/');
});

test('hostsOf: hostname sin puerto, distintos, solo http(s)', () => {
  const rr = load(makeChrome());
  assert.deepEqual(rr.hostsOf(['http://localhost:3000/a.png', 'http://localhost:3000/b.png', 'https://CDN.Example.com/x', 'data:image/png;base64,AA', 'blob:http://x/y', 'nourl']),
    ['localhost', 'cdn.example.com']);
  assert.deepEqual(rr.hostsOf('http://127.0.0.1:8080/i.png'), ['127.0.0.1']);
  assert.deepEqual(rr.hostsOf([]), []);
});

test('nextId: contador en storage.session desde 1000, serializado entre llamadas concurrentes', async () => {
  const m = makeChrome();
  const rr = load(m);
  const ids = await Promise.all([rr.nextId(), rr.nextId(), rr.nextId()]);
  assert.deepEqual(ids, [1000, 1001, 1002]);
  assert.equal(m.session.dnrNextId, 1003);
  // Otro "SW" (módulo recargado) sigue donde el espejo lo dejó.
  const rr2 = load(m);
  assert.equal(await rr2.nextId(), 1003);
});

test('addRefererRule/removeRule/clearAll: updateSessionRules con la regla y retirada por id', async () => {
  const m = makeChrome();
  const rr = load(m);
  const id = await rr.addRefererRule(['localhost'], 'http://127.0.0.1:3000/hotlink.html');
  assert.equal(id, 1000);
  assert.deepEqual(rr.liveRules(), [1000]);
  assert.equal(m.calls.length, 1);
  assert.deepEqual(m.calls[0], { addRules: [rr.buildRule(1000, ['localhost'], 'http://127.0.0.1:3000/hotlink.html')] });
  assert.equal(m.rules.size, 1);
  assert.equal(await rr.removeRule(id), true);
  assert.deepEqual(m.calls[1], { removeRuleIds: [1000] });
  assert.equal(m.rules.size, 0);
  assert.deepEqual(rr.liveRules(), []);
  // Sin referer no se añade nada; removeRule con id raro no llama a Chrome.
  assert.equal(await rr.addRefererRule(['localhost'], ''), null);
  assert.equal(await rr.removeRule(null), false);
  assert.equal(m.calls.length, 2);
  // clearAll retira solo ids ≥ 1000 (los nuestros) y deja las ajenas.
  m.rules.set(7, { id: 7 });
  await rr.addRefererRule(['a.com'], 'http://a.com/');
  await rr.addRefererRule(['b.com'], 'http://b.com/');
  assert.equal(await rr.clearAll(), 2);
  assert.deepEqual(Array.from(m.rules.keys()), [7]);
  assert.deepEqual(rr.liveRules(), []);
  assert.equal(await rr.clearAll(), 0);
});

test('Chrome rechaza la regla: addRefererRule resuelve null (el fetch sigue sin Referer)', async () => {
  const rr = load(makeChrome({ reject: true }));
  assert.equal(await rr.addRefererRule(['a.com'], 'http://a.com/'), null);
  assert.deepEqual(rr.liveRules(), []);
  assert.equal(await rr.removeRule(1000), false);
});

test('sin chrome.declarativeNetRequest (permiso ausente) todo es inerte', async () => {
  const rr = load(makeChrome({ dnr: false }));
  assert.equal(rr.enabled(), false);
  assert.equal(await rr.addRefererRule(['a.com'], 'http://a.com/'), null);
  assert.equal(await rr.removeRule(1000), false);
  assert.equal(await rr.clearAll(), 0);
  // Sin chrome en absoluto (Node): también inerte, ids en memoria.
  const bare = load(null);
  assert.equal(bare.enabled(), false);
  assert.equal(await bare.nextId(), 1000);
  assert.equal(await bare.nextId(), 1001);
  assert.equal(await bare.addRefererRule(['a.com'], 'http://a.com/'), null);
});
