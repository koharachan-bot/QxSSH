/**
 * app.js —— AI 编程工具启动器（ZCode）
 * 要点：远端操作一律以 argv 数组下发（宿主逐项转义，天然免疫 shell 注入）；
 *       检测走 command -v，安装执行真实 npm / 官方安装脚本；
 *       打开终端交给宿主 terminal 应用的 open API，插件内不实现 PTY。
 */
import { bootApp, getContext, callAppApi, hostToast } from '/assets/js/app-bridge.js';
import { listHosts, execRun } from '/assets/js/core/qxssh-api.js';
import { getPref, setPref, initAppPrefs } from '/assets/js/core/prefs.js';

const TOOL = {
  "bin": "zcode",
  "pkg": "@clid/zcode",
  "title": "ZCode",
  "what": "ZCode 是智谱 / Z.ai 的 AI 编码工作台，官方 CLI 同时提供终端 TUI、Web 界面与 Agent 运行时（登录 GLM Coding Plan 使用）。本插件只负责检测、安装与启动终端界面，终端会话由 QxSSH 的终端应用提供。",
  "mouseNote": "",
  "installs": [
    {
      "label": "npm 全局安装",
      "cmd": "npm install -g @clid/zcode",
      "note": "官方 npm 包，需要 Node.js 18+；装完后可执行文件 zcode 位于 npm 全局 bin 目录。"
    }
  ]
};

const PREF_HOST = 'ai-zcode:last-host';
const PREF_CWD = 'ai-zcode:last-cwd';

const state = {
  hosts: [],
  hostId: '',
  cwd: '',
  home: '',
  probe: null,
  busy: false,
  log: [],
};

const refs = {};

/* ---------------- 小工具 ---------------- */

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function errText(e) {
  return (e && e.message) ? String(e.message) : String(e || '未知错误');
}

function hostLabel(h) {
  if (!h) return '未选择的主机';
  const where = String(h.user || '') + '@' + String(h.address || '') + (h.port ? ':' + h.port : '');
  return (h.name || h.id) + '（' + where + '）';
}

function hostById(id) {
  for (let i = 0; i < state.hosts.length; i += 1) {
    if (state.hosts[i].id === id) return state.hosts[i];
  }
  return null;
}

function currentHostId() {
  const ctx = getContext();
  return (ctx && ctx.hostId) ? String(ctx.hostId) : '';
}

function copyText(text) {
  const finish = function (ok) {
    hostToast(ok ? '已复制到剪贴板' : '复制失败，请手动选中文本复制', ok ? 'success' : 'error');
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(text)).then(function () { finish(true); }, function () { finish(fallbackCopy(text)); });
      return;
    }
  } catch (e) { /* 走兜底 */ }
  finish(fallbackCopy(text));
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = String(text);
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) {
    return false;
  }
}

/* ---------------- 日志 ---------------- */

function logLine(text) {
  const s = String(text === undefined || text === null ? '' : text).replace(/\s+$/, '');
  if (!s) return;
  state.log.push(s);
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
  renderLog();
}

function renderLog() {
  if (!refs.log) return;
  refs.log.textContent = state.log.length ? state.log.join('\n') : '（尚无输出）';
  refs.log.scrollTop = refs.log.scrollHeight;
}

/* ---------------- 骨架 ---------------- */

function fact(label, value) {
  const box = el('div', 'ai-fact');
  box.append(el('span', '', label));
  const code = el('code', '', value);
  box.append(code);
  return { box: box, code: code };
}

function buildShell(root) {
  clear(root);
  const wrap = el('div', 'ai-root');

  const head = el('div', 'ai-head');
  const headMain = el('div', 'ai-head-main');
  headMain.append(el('div', 'ai-head-title', TOOL.title + ' 启动器'));
  headMain.append(el('div', 'ai-head-sub', '检测 ' + TOOL.bin + '、安装、在 QxSSH 终端里启动'));
  head.append(headMain);
  refs.badge = el('span', 'ai-badge', '待检测');
  head.append(refs.badge);
  wrap.append(head);

  const info = el('section', 'ai-card');
  info.append(el('div', 'ai-card-title', '这个工具是什么'));
  info.append(el('p', 'ai-desc', TOOL.what));
  const facts = el('div', 'ai-facts');
  const f1 = fact('可执行命令', TOOL.bin);
  const f2 = fact('npm 包名', TOOL.pkg);
  const f3 = fact('预计安装位置', '检测中…');
  facts.append(f1.box, f2.box, f3.box);
  info.append(facts);
  refs.installPath = f3.code;
  if (TOOL.mouseNote) info.append(el('p', 'ai-note ai-mouse', TOOL.mouseNote));
  wrap.append(info);

  const hostCard = el('section', 'ai-card');
  hostCard.append(el('div', 'ai-card-title', '主机与工作目录'));
  const rowHost = el('label', 'ai-row');
  rowHost.append(el('span', 'ai-label', '主机'));
  refs.hostSelect = el('select', 'ai-select');
  refs.hostSelect.addEventListener('change', onHostChange);
  rowHost.append(refs.hostSelect);
  hostCard.append(rowHost);

  refs.hostHint = el('p', 'ai-hint', '');
  hostCard.append(refs.hostHint);

  const rowCwd = el('label', 'ai-row');
  rowCwd.append(el('span', 'ai-label', '工作目录'));
  refs.cwd = el('input', 'ai-input');
  refs.cwd.type = 'text';
  refs.cwd.spellcheck = false;
  refs.cwd.placeholder = '留空表示登录目录，例如 ~/projects/app';
  refs.cwd.addEventListener('change', onCwdChange);
  rowCwd.append(refs.cwd);
  hostCard.append(rowCwd);

  const actions = el('div', 'ai-row ai-actions');
  refs.detectBtn = el('button', 'btn btn-outline btn-sm', '重新检测');
  refs.detectBtn.addEventListener('click', function () { detect(); });
  actions.append(refs.detectBtn);
  refs.statusText = el('span', 'ai-status', '尚未检测');
  actions.append(refs.statusText);
  hostCard.append(actions);
  wrap.append(hostCard);

  const installCard = el('section', 'ai-card');
  installCard.append(el('div', 'ai-card-title', '安装'));
  refs.installBody = el('div', 'ai-install');
  installCard.append(refs.installBody);
  wrap.append(installCard);

  const openCard = el('section', 'ai-card');
  openCard.append(el('div', 'ai-card-title', '打开'));
  refs.openHint = el('p', 'ai-note', '');
  openCard.append(refs.openHint);
  refs.openBtn = el('button', 'btn btn-primary', '在新终端中打开 ' + TOOL.bin);
  refs.openBtn.addEventListener('click', function () { openTerminal(); });
  openCard.append(refs.openBtn);
  wrap.append(openCard);

  const logCard = el('section', 'ai-card ai-log-card');
  logCard.append(el('div', 'ai-card-title', '执行输出'));
  refs.log = el('pre', 'ai-log', '（尚无输出）');
  logCard.append(refs.log);
  wrap.append(logCard);

  root.append(wrap);
}

/* ---------------- 渲染 ---------------- */

function render() {
  if (!refs.badge) return;
  renderBadge();
  renderHosts();
  renderStatus();
  renderInstall();
  renderOpen();
  renderLog();
  if (refs.detectBtn) refs.detectBtn.disabled = state.busy;
}

function renderBadge() {
  const b = refs.badge;
  if (!b) return;
  let cls = 'ai-badge';
  let text = '待检测';
  if (state.busy) {
    text = '执行中…';
  } else if (!state.hostId) {
    text = '未选择主机';
  } else if (!state.probe) {
    text = '待检测';
  } else if (state.probe.installed) {
    text = '已安装';
    cls += ' ai-badge-ok';
  } else if (state.probe.error) {
    text = '检测失败';
    cls += ' ai-badge-warn';
  } else {
    text = '未安装';
    cls += ' ai-badge-warn';
  }
  b.textContent = text;
  b.className = cls;
}

function renderHosts() {
  const sel = refs.hostSelect;
  if (!sel) return;
  clear(sel);
  if (!state.hosts.length) {
    sel.disabled = true;
    const o = el('option', '', '（宿主还没有配置主机）');
    o.value = '';
    sel.append(o);
    if (refs.hostHint) refs.hostHint.textContent = '请先在 QxSSH 主机列表里添加一台主机。';
    return;
  }
  sel.disabled = state.busy;
  const cur = currentHostId();
  state.hosts.forEach(function (h) {
    const o = el('option', '', hostLabel(h) + (h.id === cur ? '（当前工作区）' : ''));
    o.value = h.id;
    sel.append(o);
  });
  if (state.hostId) sel.value = state.hostId;
  if (refs.hostHint) {
    const same = !cur || state.hostId === cur;
    refs.hostHint.textContent = same
      ? '宿主终端会话绑定当前工作区主机，可直接在这台主机上打开终端。'
      : '选中的主机不是当前工作区主机：检测与安装照常可用，但打开终端前需先在桌面切换到该主机。';
  }
}

function renderStatus() {
  if (!refs.statusText) return;
  const p = state.probe;
  if (state.busy) { refs.statusText.textContent = '正在与主机通信…'; return; }
  if (!state.hostId) { refs.statusText.textContent = '未选择主机'; return; }
  if (!p) { refs.statusText.textContent = '尚未检测'; return; }
  if (p.installed) {
    const parts = ['已安装：' + p.bin];
    if (p.version) parts.push('版本 ' + p.version);
    if (p.os) parts.push(p.os);
    refs.statusText.textContent = parts.join(' · ');
    return;
  }
  if (p.error) { refs.statusText.textContent = '检测失败：' + p.error; return; }
  refs.statusText.textContent = '未检测到 ' + TOOL.bin + '（命令不在 PATH 中）';
}

function renderInstall() {
  const body = refs.installBody;
  if (!body) return;
  clear(body);
  if (!state.hostId) {
    body.append(el('p', 'ai-note', '请先选择主机。'));
    return;
  }
  if (state.busy) {
    body.append(el('p', 'ai-note', '命令执行中，请稍候…'));
    return;
  }
  if (!state.probe) {
    body.append(el('p', 'ai-note', '尚未检测：可先点「重新检测」，或直接选择下方方案安装。'));
    appendInstallPlans(body);
    return;
  }
  if (state.probe.installed) {
    const line = el('p', 'ai-note', '已安装：' + state.probe.bin + (state.probe.version ? '（' + state.probe.version + '）' : ''));
    body.append(line);
    if (state.probe.npmRoot) body.append(el('p', 'ai-hint', 'npm 全局前缀：' + state.probe.npmRoot));
    const row = el('div', 'ai-actions');
    const up = el('button', 'btn btn-outline btn-sm', '升级到最新版本');
    up.addEventListener('click', function () {
      runInstall({ label: 'npm 升级', cmd: 'npm i -g ' + TOOL.pkg });
    });
    row.append(up);
    body.append(row);
    return;
  }
  if (state.probe.error) body.append(el('p', 'ai-note ai-error', '检测失败：' + state.probe.error));
  if (!state.probe.npm) {
    body.append(el('p', 'ai-note', '主机上没有找到 npm：npm 方案需要 Node.js 18+ 与 npm，请先安装 Node.js。'));
  }
  appendInstallPlans(body);
}

function appendInstallPlans(body) {
  if (!TOOL.installs || !TOOL.installs.length) {
    body.append(el('p', 'ai-note', '暂未提供自动安装方案，请按官方文档手动安装。'));
    return;
  }
  TOOL.installs.forEach(function (spec) {
    const box = el('div', 'ai-install-item');
    const headRow = el('div', 'ai-install-head');
    headRow.append(el('span', 'ai-install-label', spec.label));
    const btn = el('button', 'btn btn-primary btn-sm', '一键安装');
    btn.disabled = !!state.busy;
    btn.addEventListener('click', function () {
      runInstall(spec);
    });
    headRow.append(btn);
    box.append(headRow);

    const cmdRow = el('div', 'ai-cmd');
    cmdRow.append(el('code', '', spec.cmd));
    const copy = el('button', 'btn btn-text btn-sm', '复制');
    copy.addEventListener('click', function () { copyText(spec.cmd); });
    cmdRow.append(copy);
    box.append(cmdRow);

    if (spec.note) box.append(el('p', 'ai-hint', spec.note));
    body.append(box);
  });
}

function renderOpen() {
  const btn = refs.openBtn;
  if (!btn) return;
  const cur = currentHostId();
  const same = !cur || state.hostId === cur;
  const installed = !!(state.probe && state.probe.installed);
  let hint = '';
  if (!state.hostId) hint = '请先选择主机。';
  else if (!installed) hint = '还没有检测到 ' + TOOL.bin + '：先完成安装，或确认它已在主机 PATH 里后重新检测。';
  else if (!same) hint = '宿主终端绑定当前工作区主机，请先在桌面切换到「' + hostLabel(hostById(cur)) + '」，再回到这里打开。';
  else hint = '将新开一个宿主终端，执行 ' + TOOL.bin + '，工作目录为 ' + (state.cwd || '登录目录') + '。';
  if (TOOL.mouseNote) hint += ' ' + TOOL.mouseNote;
  refs.openHint.textContent = hint;
  btn.disabled = state.busy || !state.hostId || !installed || !same;
}

/* ---------------- 行为 ---------------- */

function detectScript() {
  const b = TOOL.bin;
  return [
    'echo "BIN $(command -v ' + b + ' 2>/dev/null || echo -)"',
    'echo "VER $(' + b + ' --version 2>/dev/null | head -n 1)"',
    'echo "HOME $HOME"',
    'echo "NPM $(command -v npm 2>/dev/null || echo -)"',
    'echo "NPMROOT $(npm prefix -g 2>/dev/null || echo -)"',
    'echo "OS $(uname -sr 2>/dev/null)"'
  ].join('; ');
}

function parseKV(text) {
  const map = {};
  String(text || '').split('\n').forEach(function (line) {
    const i = line.indexOf(' ');
    if (i <= 0) return;
    const k = line.slice(0, i);
    const v = line.slice(i + 1).trim();
    if (!map[k]) map[k] = v;
  });
  return map;
}

async function detect() {
  if (state.busy) return;
  const hostId = state.hostId;
  if (!hostId) { state.probe = null; render(); return; }
  state.busy = true;
  state.probe = null;
  render();
  logLine('检测 ' + TOOL.bin + ' @ ' + hostLabel(hostById(hostId)) + '：sh -lc "command -v ' + TOOL.bin + '"');
  try {
    const r = await execRun({ host: hostId, argv: ['sh', '-lc', detectScript()], timeout: 25 });
    const out = String((r && r.output) || '');
    const map = parseKV(out);
    const bin = (map.BIN && map.BIN !== '-') ? map.BIN : '';
    state.home = (map.HOME && map.HOME !== '-') ? map.HOME : '';
    if (!state.cwd) state.cwd = getPref(PREF_CWD, '') || state.home || '~';
    if (refs.cwd && !refs.cwd.value) refs.cwd.value = state.cwd;
    state.probe = {
      installed: !!bin,
      bin: bin,
      version: (map.VER && map.VER !== '-') ? map.VER : '',
      npm: (map.NPM && map.NPM !== '-') ? map.NPM : '',
      npmRoot: (map.NPMROOT && map.NPMROOT !== '-') ? map.NPMROOT : '',
      os: map.OS || '',
      error: (r && r.ok === false) ? String(r.error || '命令执行失败') : '',
      raw: out,
    };
    if (bin) logLine('找到 ' + bin + (state.probe.version ? '（' + state.probe.version + '）' : ''));
    else logLine('未找到 ' + TOOL.bin + (state.probe.npmRoot ? '；npm 全局前缀：' + state.probe.npmRoot : ''));
  } catch (e) {
    state.probe = { installed: false, bin: '', version: '', npm: '', npmRoot: '', os: '', error: errText(e), raw: '' };
    logLine('检测失败：' + errText(e));
  }
  state.busy = false;
  render();
}

async function runInstall(spec) {
  if (state.busy || !state.hostId) return;
  const hostId = state.hostId;
  const cmd = String((spec && spec.cmd) || '').trim();
  if (!cmd) return;
  state.busy = true;
  render();
  const wrapped = /^curl\s/.test(cmd)
    ? cmd
    : 'command -v npm >/dev/null 2>&1 || { echo "未找到 npm：请先在主机上安装 Node.js 18+ 与 npm"; exit 127; }; ' + cmd;
  logLine('$ ' + cmd);
  try {
    const r = await execRun({ host: hostId, argv: ['sh', '-lc', wrapped], timeout: 280 });
    const out = String((r && r.output) || '').trim();
    if (out) logLine(out);
    if (r && r.ok === false) {
      logLine('安装返回失败（退出码 ' + (r.exit === undefined || r.exit === null ? '?' : r.exit) + '）：' + (r.error || '见上方输出'));
    } else {
      logLine('安装命令执行完成，正在重新检测…');
    }
  } catch (e) {
    logLine('安装失败：' + errText(e));
  }
  state.busy = false;
  render();
  await detect();
}

async function openTerminal() {
  if (state.busy) return;
  const hostId = state.hostId;
  if (!hostId) return;
  const cur = currentHostId();
  if (cur && hostId !== cur) {
    hostToast('宿主终端绑定当前工作区主机，请先在桌面切换到该主机', 'error');
    return;
  }
  const cwd = String(state.cwd || '').trim();
  state.busy = true;
  render();
  if (cwd) {
    try {
      const chk = await execRun({
        host: hostId,
        argv: ['sh', '-lc', '[ -d "$1" ] && echo YES || echo NO', 'sh', cwd],
        timeout: 15,
      });
      const okDir = /YES/.test(String((chk && chk.output) || ''));
      if (!okDir) {
        state.busy = false;
        render();
        logLine('工作目录不存在或不可访问：' + cwd);
        hostToast('工作目录不存在：' + cwd, 'error');
        return;
      }
    } catch (e) {
      logLine('目录校验失败（继续打开）：' + errText(e));
    }
  }
  try {
    const res = await callAppApi('terminal', 'open', {
      cwd: cwd,
      command: TOOL.bin,
      name: TOOL.title,
    }, { autoOpen: true, keepOpen: true, timeout: 30000 });
    setPref(PREF_HOST, hostId);
    setPref(PREF_CWD, cwd);
    logLine('已在终端打开 ' + TOOL.bin + (cwd ? '（工作目录 ' + cwd + '）' : '') + (res && res.tabId ? '，tab ' + res.tabId : ''));
    hostToast('已在终端启动 ' + TOOL.bin, 'success');
  } catch (e) {
    logLine('打开终端失败：' + errText(e));
    hostToast('打开终端失败：' + errText(e), 'error');
  }
  state.busy = false;
  render();
}

/* ---------------- 事件 ---------------- */

function onHostChange() {
  const next = refs.hostSelect ? refs.hostSelect.value : '';
  if (!next || next === state.hostId) return;
  state.hostId = next;
  setPref(PREF_HOST, next);
  state.probe = null;
  render();
  detect();
}

function onCwdChange() {
  if (!refs.cwd) return;
  state.cwd = String(refs.cwd.value || '').trim();
  setPref(PREF_CWD, state.cwd);
  renderOpen();
}

/* ---------------- 启动 ---------------- */

async function loadHostsList() {
  try {
    const r = await listHosts();
    const arr = (r && r.hosts) || [];
    state.hosts = arr.map(function (h) {
      return {
        id: String(h.id),
        name: String(h.name || h.id),
        user: String(h.user || ''),
        address: String(h.address || ''),
        port: Number(h.port) || 0,
      };
    });
  } catch (e) {
    state.hosts = [];
    logLine('读取主机列表失败：' + errText(e));
  }
}

function boot(root, ctx) {
  if (!root) return function () {};
  buildShell(root);
  render();
  let stopped = false;

  initAppPrefs().catch(function () { return null; }).then(function () {
    return loadHostsList();
  }).then(function () {
    if (stopped) return null;
    const saved = getPref(PREF_HOST, '');
    const savedOk = !!saved && state.hosts.some(function (h) { return h.id === saved; });
    const ctxHost = (ctx && ctx.hostId) ? String(ctx.hostId) : '';
    state.hostId = savedOk ? saved : (ctxHost || (state.hosts[0] ? state.hosts[0].id : ''));
    state.cwd = getPref(PREF_CWD, '');
    if (refs.cwd) refs.cwd.value = state.cwd;
    if (state.hostId) setPref(PREF_HOST, state.hostId);
    render();
    return detect();
  }).catch(function (e) {
    logLine('初始化失败：' + errText(e));
    render();
  });

  return function () { stopped = true; };
}

bootApp(function (args) { return boot(args.root, args.ctx); }, { root: '#app' });
