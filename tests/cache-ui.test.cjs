'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../js/cache.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function emitter(props = {}){
  const listeners = new Map();
  return Object.assign({
    addEventListener(name, fn){
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    emit(name){ for (const fn of listeners.get(name) || []) fn(); }
  }, props);
}
function error(name, message){ return Object.assign(new Error(message), { name }); }
function fixture(register){
  let calls = 0, seq = 0;
  const timers = new Map(), elements = [];
  const status = { textContent: '', after(){} };
  const active = emitter({ active: {}, waiting: null, installing: null, update: async () => {} });
  const navigator = { onLine: true, serviceWorker: { register: async () => register(++calls, active) } };
  const window = emitter({ isSecureContext: true });
  vm.runInNewContext(code, {
    URL, WeakSet, location: { protocol: 'https:', href: 'https://game.example.test/' },
    navigator, window, console: { warn(){} },
    document: {
      readyState: 'complete', getElementById: () => status,
      createElement(tag){
        const el = emitter({ tag, hidden: false, disabled: false, textContent: '', style: {}, append(){} });
        elements.push(el); return el;
      }
    },
    setTimeout(fn, ms){ const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  const fireTimer = async () => {
    const [id, job] = timers.entries().next().value;
    timers.delete(id); job.fn(); await flush();
  };
  return { status, elements, active, navigator, window, timers, fireTimer, calls: () => calls,
    retry: () => elements.find(e => e.tag === 'button'),
    details: () => elements.find(e => e.tag === 'details'),
    diagnostic: () => elements.find(e => e.tag === 'pre') };
}

test('transient registration failure retries automatically and clears the error on success', async () => {
  const f = fixture((n, active) => { if (n === 1) throw error('TypeError', 'Failed to fetch'); return active; });
  await flush();
  assert.equal(f.calls(), 1);
  assert.match(f.status.textContent, /自动重试/);
  assert.match(f.diagnostic().textContent, /TypeError: Failed to fetch/);
  assert.match(f.diagnostic().textContent, /https:\/\/game\.example\.test\/sw\.js/);
  await f.fireTimer();
  assert.equal(f.calls(), 2);
  assert.match(f.status.textContent, /游戏资源已缓存/);
  assert.equal(f.details().hidden, true);
  assert.equal(f.retry().hidden, true);
});

test('persistent failures are limited to two automatic retries', async () => {
  const f = fixture(() => { throw error('TypeError', 'Failed to fetch'); });
  await flush(); await f.fireTimer(); await f.fireTimer();
  assert.equal(f.calls(), 3);
  assert.equal(f.timers.size, 0);
  assert.equal(f.retry().hidden, false);
  assert.equal(f.retry().disabled, false);
});

test('permissions failure explains the restriction without blindly retrying; manual retry works', async () => {
  const f = fixture((n, active) => {
    if (n === 1) throw error('SecurityError', 'Service Worker access denied'); return active;
  });
  await flush();
  assert.match(f.status.textContent, /存储权限/);
  assert.equal(f.timers.size, 0);
  f.retry().emit('click'); await flush();
  assert.match(f.status.textContent, /游戏资源已缓存/);
});

test('certificate failures explain the cause and allow a bounded propagation retry', async () => {
  const f = fixture(() => { throw error('SecurityError', 'An SSL certificate error occurred when fetching the script.'); });
  await flush();
  assert.match(f.status.textContent, /HTTPS 证书/);
  assert.match(f.status.textContent, /请勿忽略证书警告/);
  assert.equal(f.timers.size, 1);
});

test('precache install failure offers a retry rather than displaying a false success', async () => {
  const worker = emitter({ state: 'installing' });
  const registration = emitter({ installing: worker, active: null, waiting: null, update: async () => {} });
  const f = fixture(() => registration);
  await flush();
  assert.doesNotMatch(f.status.textContent, /游戏资源已缓存/);
  registration.installing = null; worker.state = 'redundant'; worker.emit('statechange');
  assert.equal(f.retry().hidden, false);
  assert.match(f.diagnostic().textContent, /资源预缓存未完成/);
});

test('failed update does not claim the existing cache has been lost', async () => {
  const f = fixture((n, active) => {
    active.update = async () => { throw error('TypeError', 'Failed to fetch'); }; return active;
  });
  await flush();
  assert.match(f.status.textContent, /现有版本缓存仍可使用/);
  assert.equal(f.timers.size, 0);
});

test('coming back online retries a failed first registration', async () => {
  const f = fixture((n, active) => { if (n === 1) throw error('TypeError', 'offline'); return active; });
  f.navigator.onLine = false;
  await flush();
  assert.equal(f.timers.size, 0);
  f.navigator.onLine = true; f.window.emit('online'); await flush();
  assert.equal(f.calls(), 2);
  assert.match(f.status.textContent, /游戏资源已缓存/);
});
