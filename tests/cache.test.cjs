'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
execFileSync(process.execPath, ['scripts/build-site.cjs'], { cwd: root });
const worker = fs.readFileSync(path.join(root, '_site/sw.js'), 'utf8');

function fixture(scope = 'https://example.test/game/'){
  const handlers = {}, stores = new Map();
  let networkRequests = 0;
  const ctx = vm.createContext({
    URL, Request, Response, Map,
    self: { registration: { scope }, addEventListener: (name, fn) => { handlers[name] = fn; } },
    caches: {
      async open(name){
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name);
        return {
          async addAll(requests){
            for (const request of requests){
              assert.ok(request.integrity.startsWith('sha256-'));
              assert.equal(request.cache, 'reload');
              store.set(request.url, new Response('cached ' + request.url));
            }
          },
          async match(key){ return store.get(key)?.clone(); },
          async put(key, response){ store.set(key, response); }
        };
      },
      async keys(){ return Array.from(stores.keys()); },
      async delete(key){ return stores.delete(key); }
    },
    fetch: async () => { networkRequests++; throw new Error('offline'); }
  });
  vm.runInContext(worker, ctx);
  const run = code => vm.runInContext(code, ctx);
  const lifecycle = name => {
    let work;
    handlers[name]({ waitUntil: promise => { work = promise; } });
    return work;
  };
  const request = async (url, mode = 'cors', method = 'GET') => {
    let response;
    handlers.fetch({ request: { url, mode, method }, respondWith: p => { response = p; }, waitUntil(){} });
    return response;
  };
  return { run, stores, lifecycle, request, count: () => networkRequests };
}

test('site build is deterministic and all cached files have matching SHA-256 integrity', () => {
  const f = fixture();
  const manifest = f.run('ASSETS');
  for (const file of manifest){
    const bytes = fs.readFileSync(path.join(root, '_site', file.path));
    assert.equal(file.integrity, 'sha256-' + crypto.createHash('sha256').update(bytes).digest('base64'));
  }
  assert.ok(manifest.some(x => x.path === 'vendor/three.min.js'));
  assert.ok(manifest.some(x => x.path === 'js/cache.js'));
  assert.equal(fs.existsSync(path.join(root, '_site/tests')), false);
  assert.equal(fs.existsSync(path.join(root, '_site/.local')), false);
  assert.equal(fs.existsSync(path.join(root, '_site/.github')), false);
  assert.equal(fs.existsSync(path.join(root, '_site/.nojekyll')), false);
  execFileSync(process.execPath, ['scripts/build-site.cjs'], { cwd: root });
  assert.equal(fs.readFileSync(path.join(root, '_site/sw.js'), 'utf8'), worker);
});

test('installed shell, entry and scripts load entirely from cache while offline', async () => {
  const f = fixture();
  await f.lifecycle('install');
  for (const [url, mode] of [
    ['https://example.test/game/', 'navigate'],
    ['https://example.test/game/index.html?launch=1', 'navigate'],
    ['https://example.test/game/js/main.js', 'cors'],
    ['https://example.test/game/vendor/three.min.js', 'cors']
  ]){
    assert.equal((await f.request(url, mode)).status, 200);
  }
  assert.equal(f.count(), 0);
});

test('only known GET assets are intercepted; unrelated sites and requests stay untouched', async () => {
  const f = fixture();
  assert.equal(await f.request('https://example.test/game/missing', 'navigate'), undefined);
  assert.equal(await f.request('https://other.test/game/js/main.js'), undefined);
  assert.equal(await f.request('https://example.test/game/index.html', 'cors', 'POST'), undefined);
});

test('activation cleans only this scope; updates never forcibly take over a running game', async () => {
  const f = fixture();
  f.stores.set('vr-oi:https://example.test/game/:old', new Map());
  f.stores.set('vr-oi:https://example.test/other/:old', new Map());
  f.stores.set('another-app', new Map());
  await f.lifecycle('install');
  await f.lifecycle('activate');
  assert.equal(f.stores.has('vr-oi:https://example.test/game/:old'), false);
  assert.equal(f.stores.has('vr-oi:https://example.test/other/:old'), true);
  assert.equal(f.stores.has('another-app'), true);
  assert.ok(f.stores.has(f.run('CACHE_NAME')));
  assert.doesNotMatch(worker, /(?:self\.)?skipWaiting\s*\(/);
  assert.doesNotMatch(worker, /clients\.claim\s*\(/);
});

test('custom domain root uses the same offline shell as project-subpath hosting', async () => {
  const f = fixture('https://game.example.test/');
  await f.lifecycle('install');
  assert.equal((await f.request('https://game.example.test/', 'navigate')).status, 200);
});

test('incomplete cache while offline returns a useful error, not unrelated HTML as JavaScript', async () => {
  const f = fixture();
  const response = await f.request('https://example.test/game/js/main.js');
  assert.equal(response.status, 503);
  assert.match(await response.text(), /缓存不完整/);
  assert.equal(f.count(), 1);
});
