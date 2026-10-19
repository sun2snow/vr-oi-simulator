'use strict';
/* 静态资源缓存与 localStorage 游戏存档相互独立；失败不清空任何用户数据。 */
(() => {
  const status = document.getElementById('cacheStatus');
  const report = text => { if (status) status.textContent = text; };
  if (location.protocol === 'file:'){
    report('本地文件模式：资源已在本机，无需启用离线缓存。');
    return;
  }
  if (!window.isSecureContext || !('serviceWorker' in navigator)){
    report('当前环境不支持离线缓存；请使用 HTTPS 和支持 Service Worker 的浏览器。在线游玩不受影响。');
    return;
  }

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn';
  retry.textContent = '重试离线缓存';
  retry.hidden = true;
  retry.style.cssText = 'display:none;margin:8px auto;font-size:12px';
  const details = document.createElement('details');
  details.hidden = true;
  details.style.cssText = 'max-width:640px;margin:8px auto;padding:0 20px;font-size:12px;color:#aebdd8';
  const summary = document.createElement('summary');
  summary.textContent = '查看缓存错误（可复制反馈）';
  const diagnostic = document.createElement('pre');
  diagnostic.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto;text-align:left';
  details.append(summary, diagnostic);
  if (status) status.after(retry, details);

  const workerURL = new URL('./sw.js', location.href).href;
  const retryDelays = [1500, 4000];
  let registration = null, busy = false, retryTimer = null, retryCount = 0;
  const watchedWorkers = new WeakSet(), watchedRegistrations = new WeakSet();

  function setRetryVisible(visible){
    retry.hidden = !visible;
    retry.style.display = visible ? 'block' : 'none';
  }
  function clearRetryTimer(){
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  function describeError(error){
    const text = String(error?.message || error || '未知错误');
    if (/ssl|certificate|证书/i.test(text))
      return '浏览器未能验证缓存脚本的 HTTPS 证书。请勿忽略证书警告；稍后重试，并检查设备时间或网络代理。';
    if (/mime|404|status code|redirect/i.test(text))
      return '缓存脚本没有正常返回。可能是网络代理或部署缓存尚未同步，请稍后重试。';
    if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError' || /denied|disabled|disallow/i.test(text))
      return '浏览器限制了离线缓存。请检查该网站的存储权限、隐私模式或扩展设置。';
    if (error?.name === 'QuotaExceededError')
      return '浏览器存储空间不足。请释放空间后重试；不要清除本站数据，以免丢失存档。';
    return '离线缓存暂未就绪，可能是网络或浏览器限制。在线游玩不受影响。';
  }
  function showFailure(error, stage){
    const message = describeError(error);
    console.warn('离线缓存失败 [' + stage + ']：', error);
    diagnostic.textContent = `${stage}\n${error?.name || 'Error'}: ${error?.message || error}\n脚本：${workerURL}`;
    details.hidden = false;
    setRetryVisible(true);
    const hasCache = !!registration?.active;
    report((hasCache ? '现有版本缓存仍可使用。' : '') + message);
    // 权限/配额问题需要用户处理；网络与证书传播问题最多自动重试两次。
    const permissionError = (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') &&
      !/ssl|certificate|证书/i.test(String(error?.message || ''));
    if (!hasCache && !permissionError && error?.name !== 'QuotaExceededError' &&
        navigator.onLine !== false && retryCount < retryDelays.length){
      clearRetryTimer();
      const delay = retryDelays[retryCount++];
      report(message + ` ${delay / 1000} 秒后自动重试（${retryCount}/${retryDelays.length}）。`);
      retryTimer = setTimeout(() => { retryTimer = null; start(); }, delay);
    }
  }
  function renderState(){
    if (!registration) return;
    if (registration.waiting || registration.active){
      clearRetryTimer();
      details.hidden = true;
      setRetryVisible(false);
      report(registration.waiting
        ? '新版本已下载；关闭所有游戏标签页后重新打开即可更新，不会中断当前战斗。'
        : '游戏资源已缓存，可离线重新打开；浏览器清理数据后需再次联网。');
    }
  }
  function watch(worker){
    if (!worker || watchedWorkers.has(worker)) return;
    watchedWorkers.add(worker);
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' || worker.state === 'activated') renderState();
      if (worker.state === 'redundant'){
        // statechange 不提供安装异常，不能把网络/校验/配额失败误报成某一个原因。
        showFailure(new Error('资源预缓存未完成。可能是网络中断、空间不足或版本同步中，请重试。'), '资源缓存安装');
      }
    });
  }
  async function start(){
    if (busy) return;
    busy = true;
    retry.disabled = true;
    clearRetryTimer();
    report(registration?.active ? '正在检查离线缓存更新……' : '正在准备离线缓存，首次加载请保持联网……');
    let stage = '注册 Service Worker';
    try {
      registration = await navigator.serviceWorker.register(workerURL, { updateViaCache: 'none' });
      watch(registration.installing);
      if (!watchedRegistrations.has(registration)){
        watchedRegistrations.add(registration);
        registration.addEventListener('updatefound', () => watch(registration.installing));
      }
      renderState();
      // 新安装已在下载时不再发起重复 update；失败后手动重试可重新触发安装。
      if (!registration.installing && !registration.waiting && navigator.onLine !== false){
        stage = '检查缓存版本';
        await registration.update();
      }
    } catch(error){
      showFailure(error, stage);
    } finally {
      busy = false;
      retry.disabled = false;
    }
  }
  function retryNow(){
    if (busy) return;
    retryCount = 0;
    start();
  }
  retry.addEventListener('click', retryNow);
  window.addEventListener('online', () => {
    if (!registration?.active && !registration?.installing) retryNow();
  });
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
})();
