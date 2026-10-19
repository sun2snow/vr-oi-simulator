'use strict';
// 可选的真实浏览器验收：Node.js 22+ 与 Chrome/Chromium，无第三方测试依赖。
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
execFileSync(process.execPath, ['scripts/build-site.cjs'], { cwd: root });
const site = path.join(root, '_site');
let workerOverride = null;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (!pathname.startsWith('/game/')){ res.writeHead(404).end(); return; }
  const relative = pathname.slice('/game/'.length) || 'index.html';
  const file = path.resolve(site, relative);
  if (!file.startsWith(site + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()){
    res.writeHead(404).end(); return;
  }
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'text/plain');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(relative === 'sw.js' && workerOverride ? workerOverride : fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/game/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-oi-cache-'));
  const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', ['--headless=new', '--no-sandbox',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, 'about:blank']);
  let socket, closeBrowser;
  const timeout = setTimeout(() => { console.error('Browser test timed out'); chrome.kill(); process.exitCode = 1; }, 90000);
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let log = '';
      chrome.stderr.on('data', b => {
        log += b;
        const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) resolve(match[1]);
      });
      chrome.once('error', reject);
      chrome.once('exit', () => reject(new Error('Chrome exited: ' + log)));
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let seq = 0, sessionId;
    const pending = new Map(), exceptions = [];
    socket.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id){
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      }
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    };
    const call = (method, params = {}, session = sessionId) => new Promise((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
    });
    closeBrowser = () => call('Browser.close', {}, null);
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await call('Target.attachToTarget', { targetId, flatten: true }));
    await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
    const evaluate = async expression => {
      const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async expression => {
      for (let i = 0; i < 150; i++){
        try { if (await evaluate(expression)) return; } catch {}
        await delay(100);
      }
      throw new Error('Timed out waiting for: ' + expression);
    };
    const offline = value => call('Network.emulateNetworkConditions', {
      offline: value, latency: 0, downloadThroughput: -1, uploadThroughput: -1
    });
    const ready = 'document.readyState === "complete" && typeof clock !== "undefined" && !!clock';
    await call('Page.navigate', { url });
    await waitFor(ready);
    await evaluate('navigator.serviceWorker.ready.then(() => true)');
    assert.equal(await evaluate('typeof THREE'), 'object');
    console.log('Online WebGL initialization and complete precache: OK');

    await offline(true);
    await call('Page.reload');
    await delay(300); await waitFor(ready);
    assert.equal(await evaluate('!!navigator.serviceWorker.controller'), true);
    assert.equal(await evaluate('Object.keys(THREE).length > 100'), true);
    assert.equal(await evaluate(`(() => { requestLock = () => {}; $('btnStart').click(); return state.started; })()`), true);
    console.log('Offline reload, bundled Three.js and starting the game: OK');

    await offline(false);
    workerOverride = fs.readFileSync(path.join(site, 'sw.js'), 'utf8')
      .replace(/const VERSION = '[^']+';/, "const VERSION = 'browser-test-next';");
    await evaluate(`window.controllerChanges = 0;
      navigator.serviceWorker.addEventListener('controllerchange', () => window.controllerChanges++);
      navigator.serviceWorker.getRegistration().then(r => r.update());`);
    await waitFor('navigator.serviceWorker.getRegistration().then(r => !!r.waiting)');
    assert.equal(await evaluate('window.controllerChanges'), 0);
    assert.equal(await evaluate('state.started && !state.ended'), true);
    console.log('Update waits without taking over the running game: OK');

    await call('Page.navigate', { url: 'about:blank' });
    await delay(1500); // 唯一游戏标签页已关闭，等待新版激活
    await offline(true);
    await call('Page.navigate', { url });
    await waitFor(ready);
    const keys = await evaluate('caches.keys()');
    assert.equal(keys.length, 1);
    assert.ok(keys[0].endsWith(':browser-test-next'));
    assert.deepEqual(exceptions, []);
    console.log('New version activates after closing the game; old cache cleaned; offline launch: OK');
  } finally {
    clearTimeout(timeout);
    const exited = new Promise(resolve => {
      if (chrome.exitCode !== null || !chrome.pid) resolve(); else chrome.once('exit', resolve);
    });
    const killTimer = setTimeout(() => chrome.kill(), 3000);
    // 正常关闭让 Chromium 的缓存进程先退出，避免删 profile 时仍有子进程写入。
    if (closeBrowser && socket?.readyState === WebSocket.OPEN)
      await Promise.race([closeBrowser().catch(() => {}), exited]);
    else chrome.kill();
    await exited;
    clearTimeout(killTimer);
    if (socket) socket.close();
    server.closeAllConnections(); server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
