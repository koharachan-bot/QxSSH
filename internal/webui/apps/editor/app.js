/**
 * app.js —— 独立文本编辑器插件
 *
 * 设计要点：
 *  1. 编辑器是独立窗口（不再塞进文件管理器的对话框），可最大化、可并排；
 *  2. 可见性只用 display / 尺寸控制，绝不用 opacity: 0 隐藏或禁用它：
 *     宿主窗口在最小化动画、玻璃透明度调成 0 时元素仍然存在，编辑器必须还能
 *     接收键盘输入与保存——textarea 是原生控件，不依赖透明度就能工作；
 *  3. 保存走 SFTP 上传（server:upload），读走 preview 端点（server:read），
 *     两条链路都带会话令牌，不需要 root。
 */
import { bootApp, setTitle } from '/assets/js/app-bridge.js';
import { highlightHTML, languageForFile } from '/assets/js/core/code-editor.js';
import { sftpPreviewUrl, sftpUpload } from '/assets/js/core/qxssh-api.js';
import { setupI18n, t, tf, onLangChange } from '/assets/js/core/i18n.js';
import { toast } from '/assets/js/core/ui.js';
import { fmtSize } from '/assets/js/core/dom.js';

const MAX_BYTES = 2 << 20;

const st = {
  hostId: '',
  path: '',
  name: '',
  dir: '',
  lang: 'text',
  saved: '',
  content: '',
  loading: false,
  saving: false,
  error: '',
  lineNumbers: true,
  wrap: false,
  dirty: false,
  bytes: 0,
};

let ta = null;
let hl = null;
let gutterInner = null;
let pathEl = null;
let dirtyEl = null;
let posEl = null;
let metaEl = null;
let saveBtn = null;
let emptyEl = null;
let bodyEl = null;
let renderTimer = null;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function splitPath(p) {
  const clean = String(p || '');
  const i = clean.lastIndexOf('/');
  if (i < 0) return { dir: '', name: clean };
  return { dir: clean.slice(0, i) || '/', name: clean.slice(i + 1) };
}

/** 读取远端文件内容 */
async function loadFile() {
  if (!st.path) return;
  st.loading = true;
  st.error = '';
  syncStatus();
  try {
    const res = await fetch(sftpPreviewUrl(st.hostId, st.path));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error(tf('app.editor.load-failed', { v1: fmtSize(text.length) }));
    st.content = text;
    st.saved = text;
    st.bytes = new Blob([text]).size;
    st.dirty = false;
    st.lang = languageForFile(st.name);
    if (ta) {
      ta.value = text;
      ta.readOnly = false;
    }
    paint();
  } catch (e) {
    st.error = (e && e.message) || String(e);
    toast(tf('app.editor.load-failed', { v1: st.error }), 'error');
  } finally {
    st.loading = false;
    syncStatus();
  }
}

/** 保存回远端主机 */
async function saveFile() {
  if (st.saving || !st.path || !ta) return;
  const text = ta.value;
  st.saving = true;
  syncStatus();
  try {
    const file = new File([text], st.name, { type: 'text/plain' });
    await sftpUpload(st.hostId, st.dir, file);
    st.content = text;
    st.saved = text;
    st.bytes = new Blob([text]).size;
    st.dirty = false;
    toast(tf('app.editor.saved', { v1: st.name }), 'success');
  } catch (e) {
    toast(tf('app.editor.save-failed', { v1: (e && e.message) || e }), 'error');
  } finally {
    st.saving = false;
    syncStatus();
  }
}

/** 重绘高亮与行号（输入时按帧节流） */
function paint() {
  if (!ta || !hl) return;
  const text = ta.value;
  const lines = text.split('\n');
  hl.innerHTML = highlightHTML(text + '\n', st.lang);
  if (gutterInner) {
    const total = lines.length;
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= total; i++) frag.appendChild(el('span', null, String(i)));
    gutterInner.textContent = '';
    gutterInner.appendChild(frag);
  }
  if (metaEl) {
    metaEl.textContent = tf('app.editor.lines', { v1: lines.length }) + ' · ' + fmtSize(new Blob([text]).size);
  }
  syncScroll();
  updateCursor();
  st.dirty = text !== st.saved;
  syncStatus();
}

function schedulePaint() {
  if (renderTimer !== null) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    paint();
  }, 60);
}

function syncScroll() {
  if (!ta || !hl) return;
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
  if (gutterInner) gutterInner.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
}

function updateCursor() {
  if (!ta || !posEl) return;
  const before = ta.value.slice(0, ta.selectionStart);
  const line = before.split('\n').length;
  const col = before.length - before.lastIndexOf('\n');
  posEl.textContent = tf('app.editor.cursor', { v1: line, v2: col });
}

function syncStatus() {
  if (dirtyEl) {
    dirtyEl.textContent = st.loading ? t('app.editor.loading') : (st.dirty ? t('app.editor.dirty') : '');
    dirtyEl.style.visibility = st.dirty || st.loading ? 'visible' : 'hidden';
  }
  if (saveBtn) {
    saveBtn.disabled = st.saving || !st.path;
    saveBtn.textContent = st.saving ? t('app.editor.saving') : t('app.editor.save');
  }
  if (pathEl) pathEl.textContent = st.path || '';
  if (emptyEl) emptyEl.style.display = st.path ? 'none' : '';
  if (bodyEl) bodyEl.style.display = st.path ? '' : 'none';
  const title = st.name ? st.name : t('app.editor.name');
  if (st._title !== title) {
    st._title = title;
    setTitle(title);
  }
}

function build(root) {
  root.textContent = '';
  const wrap = el('div', 'ed-root');

  const bar = el('div', 'ed-bar');
  pathEl = el('span', 'ed-path');
  dirtyEl = el('span', 'ed-dirty');
  const spacer = el('div', 'ed-spacer');

  const mk = (label, act, primary) => {
    const b = el('button', 'ed-btn' + (primary ? ' ed-primary' : ''), label);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (act === 'save') saveFile();
      else if (act === 'reload') loadFile();
      else if (act === 'lineno') { st.lineNumbers = !st.lineNumbers; gutterEl.style.display = st.lineNumbers ? '' : 'none'; }
      else if (act === 'wrap') { st.wrap = !st.wrap; ta.wrap = st.wrap ? 'soft' : 'off'; hl.style.whiteSpace = st.wrap ? 'pre-wrap' : 'pre'; }
    });
    return b;
  };
  const linenoBtn = mk(t('app.editor.line-numbers'), 'lineno', false);
  const wrapBtn = mk(t('app.editor.wrap'), 'wrap', false);
  const reloadBtn = mk(t('app.editor.reload'), 'reload', false);
  saveBtn = mk(t('app.editor.save'), 'save', true);
  bar.append(pathEl, dirtyEl, spacer, linenoBtn, wrapBtn, reloadBtn, saveBtn);

  bodyEl = el('div', 'ed-body');
  const gutterEl = el('div', 'ed-gutter');
  gutterInner = el('div', 'ed-gutter-inner');
  gutterEl.appendChild(gutterInner);

  const scroll = el('div', 'ed-scroll');
  hl = el('pre', 'ed-hl');
  hl.setAttribute('aria-hidden', 'true');
  ta = document.createElement('textarea');
  ta.className = 'ed-input';
  ta.spellcheck = false;
  ta.wrap = 'off';
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('autocomplete', 'off');
  scroll.append(hl, ta);
  bodyEl.append(gutterEl, scroll);

  emptyEl = el('div', 'ed-empty');
  emptyEl.append(
    el('div', 'ed-empty-title', t('app.editor.empty-title')),
    el('div', 'ed-empty-desc', t('app.editor.empty-desc')),
  );

  const status = el('div', 'ed-status');
  posEl = el('span', 'ed-pos');
  metaEl = el('span', 'ed-meta');
  const hint = el('span', 'ed-hint', t('app.editor.ctrl-s'));
  status.append(posEl, metaEl, hint);

  wrap.append(bar, bodyEl, emptyEl, status);
  root.appendChild(wrap);
  // 让编辑器容器保留 window 的变量作用域
  wrap._gutter = gutterEl;
  return { wrap, gutterEl };
}

function bindEditor(gutterEl) {
  ta.addEventListener('input', () => { schedulePaint(); });
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('keyup', updateCursor);
  ta.addEventListener('click', updateCursor);
  ta.addEventListener('focus', updateCursor);

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveFile();
    }
  });
}

function openPath(path, hostId) {
  st.path = String(path || '');
  const parts = splitPath(st.path);
  st.dir = parts.dir;
  st.name = parts.name;
  st.hostId = hostId || st.hostId;
  st.lang = languageForFile(st.name);
  st.loading = true;
  syncStatus();
  loadFile();
}

export async function boot(rootArg) {
  await setupI18n().catch(() => { });
  const { root, hostId, params } = rootArg;
  st.hostId = hostId || params.host || '';

  const built = build(root);
  bindEditor(built.gutterEl);
  syncStatus();

  if (params.file) openPath(params.file, st.hostId);

  onLangChange(() => {
    if (params.file) return;
    syncStatus();
  });
}

bootApp(({ root, hostId, params }) => boot({ root, hostId, params }));
