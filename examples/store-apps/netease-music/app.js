/**
 * app.js —— 网易云音乐插件外壳
 *
 * 页面主体是第三方站点，这里只做三件事：
 *  1. 透传主题（宿主会把 qx-theme 写进 localStorage）；
 *  2. 「重新加载」按钮重置 iframe，解决站点自己卡住的情况；
 *  3. 若 iframe 长时间没有 load 事件，给出兜底提示与外部打开入口。
 */
(function () {
  'use strict';

  var frame = document.getElementById('player');
  var fallback = document.getElementById('fallback');
  var reloadBtn = document.getElementById('reload');
  var external = document.getElementById('external');

  var SRC = 'https://music.163.com/st/webplayer';
  external.href = SRC;

  var loaded = false;
  frame.addEventListener('load', function () {
    loaded = true;
    fallback.hidden = true;
  });

  // 12 秒内没有任何 load 事件，认为嵌入被拒或网络异常。
  setTimeout(function () {
    if (!loaded) fallback.hidden = false;
  }, 12000);

  reloadBtn.addEventListener('click', function () {
    loaded = false;
    fallback.hidden = true;
    frame.src = 'about:blank';
    setTimeout(function () { frame.src = SRC; }, 80);
  });

  // 主题跟随：宿主通过参数或 localStorage 传 dark/light
  function syncTheme() {
    var dark = document.documentElement.classList.contains('dark');
    document.body.dataset.theme = dark ? 'dark' : 'light';
  }
  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true, attributeFilter: ['class'],
  });
})();
