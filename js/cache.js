'use strict';
/* 静态资源缓存与 localStorage 游戏存档相互独立。file:// 模式仍可直接玩。 */
(() => {
  const status = document.getElementById('cacheStatus');
  const report = text => { if (status) status.textContent = text; };
  if (location.protocol === 'file:'){
    report('本地文件模式：资源已在本机，无需启用离线缓存。');
    return;
  }
  if (!window.isSecureContext || !('serviceWorker' in navigator)){
    report('当前环境不支持离线缓存；仍可正常在线游玩。');
    return;
  }
  window.addEventListener('load', async () => {
    try {
      report('正在准备离线缓存，首次加载请保持联网……');
      const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      const updateStatus = () => report(registration.waiting
        ? '新版本已下载；关闭所有游戏标签页后重新打开即可更新，不会中断当前战斗。'
        : '游戏资源已缓存，可离线重新打开；浏览器清理数据后需再次联网。');
      const watch = worker => {
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' || worker.state === 'activated') updateStatus();
          if (worker.state === 'redundant' && !registration.active)
            report('离线缓存未完成，请保持联网后重新打开游戏。');
        });
      };
      watch(registration.installing);
      registration.addEventListener('updatefound', () => watch(registration.installing));
      if (registration.active || registration.waiting) updateStatus();
      navigator.serviceWorker.ready.then(updateStatus);
      // 绕过 HTTP 缓存检查版本；离线时失败不影响已有缓存。
      registration.update().catch(() => {});
    } catch(error){
      report('离线缓存暂不可用；仍可在线游玩。请检查 HTTPS、存储权限或稍后重试。');
      console.warn('离线缓存注册失败：', error);
    }
  });
})();
