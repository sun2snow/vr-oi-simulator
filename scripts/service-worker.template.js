'use strict';
/* 由 build-site.cjs 注入资源摘要。整个版本原子缓存，避免新旧脚本混用。 */
const VERSION = '__CACHE_VERSION__';
const ASSETS = /* __ASSETS__ */ [];
const PREFIX = 'vr-oi:' + self.registration.scope + ':';
const CACHE_NAME = PREFIX + VERSION;
const resources = new Map(ASSETS.map(asset => [
  new URL(asset.path, self.registration.scope).href, asset.integrity
]));
const indexURL = new URL('index.html', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // SRI 校验阻止 CDN 部署传播期间把不同版本拼成一个快照。
    await cache.addAll(Array.from(resources, ([url, integrity]) =>
      new Request(url, { cache: 'reload', integrity })));
    // 不 skipWaiting：旧版本的所有标签页关闭后才切换，不中断战斗。
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    // 不 claim 当前已打开页面，避免第一次安装时接管一个不同版本的页面。
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  url.hash = ''; url.search = '';
  let key = url.href;
  if (event.request.mode === 'navigate' && key === self.registration.scope) key = indexURL;
  if (!resources.has(key)) return; // 不缓存未知路径、第三方、API 或用户数据。
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(key);
    if (cached) return cached;
    try {
      // 缓存被部分清理后，仅补回与当前版本摘要匹配的资源。
      const response = await fetch(new Request(key, {
        cache: 'reload', integrity: resources.get(key)
      }));
      if (!response.ok) throw new Error('Resource unavailable');
      event.waitUntil(cache.put(key, response.clone()));
      return response;
    } catch(error){
      return new Response('游戏缓存不完整。请联网，关闭所有游戏标签页后重新打开。', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
