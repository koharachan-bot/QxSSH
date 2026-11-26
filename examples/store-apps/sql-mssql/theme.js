/**
 * theme.js —— 首屏主题初始化
 * 独立成外部脚本，避免依赖宿主对行内脚本的 CSP 放行；先按 URL 参数与系统偏好定色，
 * 之后由 app.js 收到宿主的 init/theme 消息再校正。
 */
(function () {
  var theme = '';
  try { theme = new URLSearchParams(location.search).get('theme') || ''; } catch (e) { theme = ''; }
  var dark = theme === 'dark' || (theme !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
})();
