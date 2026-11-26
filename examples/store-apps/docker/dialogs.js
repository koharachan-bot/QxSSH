/**
 * dialogs.js —— Docker 的各类对话框
 * 约定：
 *  1. 日志既有“实时流式”（exec/stream）也有“一次性快照”（exec/run）两条路径，
 *     流式失败会自动退回快照，保证弱网下也能看到日志；
 *  2. 交互式终端直接用 exec/session 的 WebSocket（与内置终端应用同一协议）；
 *  3. 需要在脚本里读写值的控件一律用 dom() 建真实元素（h() 返回的是 vnode）。
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, dom, createView } from '/assets/js/core/vdom.js';
import { toast } from '/assets/js/core/ui.js';
import {
  dialog, codeBlock, kvGrid, JsonViewer, segmented, copyButton, spinner, alertBar,
} from '/assets/js/core/components.js';
import { createLogView } from '/assets/js/core/logview.js';

import * as api from './api.js';
import {
  shortId, parseEnvList, downloadText, pick,
} from './format.js';

/** 内联 SVG（不依赖图标库里是否存在该名字） */
function svgIcon(name) {
  const p = {
    download: '<path d="M8 2.5v7m0 0l2.6-2.6M8 9.5L5.4 6.9M2.5 12.5h11"/>',
    'rotate-cw': '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.2v3h-3"/>',
    terminal: '<path d="M3.2 4.2L7 8l-3.8 3.8M8.6 12h4.2"/>',
  }[name] || '';
  return '<svg class="qicon qicon-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
}

/* ------------------------------------------------------------------ *
 * 彩色日志（实时流式 + 快照回退）
 * ------------------------------------------------------------------ */

export function openLogsDialog(host, container) {
  const id = container.ID || container.Id || '';
  const name = (String(container.Names || '').split(',')[0]) || shortId(id);

  const log = createLogView({ emptyText: t('app.docker.logs-empty'), showLineNo: true });
  log.el.style.height = '100%';

  const state = {
    tail: 400, timestamps: true, follow: true, since: '',
    mode: 'stream', timer: null, lastLines: [], abort: null, closed: false, partial: '',
  };
  const meta = dom('span', { class: 'qx-count', text: '' });
  const modeBadge = dom('span', { class: 'dk-live', text: '' });

  function updateMeta() {
    const st = log.stats();
    meta.textContent = tf('app.docker.logs-count', { v1: String(st.total), v2: String(st.error), v3: String(st.warn) });
  }

  function setMode(label) {
    modeBadge.textContent = label;
    modeBadge.className = 'dk-live' + (label === t('app.docker.logs-live') ? ' on' : '');
  }

  /** 把流式分块拼成整行；未闭合的尾巴留到下一块 */
  function feed(chunk) {
    const text = String(chunk || '');
    if (!text) return;
    state.partial += text;
    const parts = state.partial.split('\n');
    state.partial = parts.pop() || '';
    if (!parts.length) return;
    state.lastLines = state.lastLines.concat(parts);
    if (state.lastLines.length > 4000) state.lastLines = state.lastLines.slice(-4000);
    log.appendLines(parts);
    updateMeta();
  }

  function stopStream() {
    if (state.abort) {
      try { state.abort.abort(); } catch (e) { /* 忽略 */ }
      state.abort = null;
    }
  }

  /** 快照模式（流式不可用时的兜底） */
  async function snapshot() {
    stopStream();
    setMode(t('app.docker.logs-snapshot'));
    try {
      const text = await api.containerLogs(host, id, { tail: state.tail, timestamps: state.timestamps });
      if (state.closed) return;
      const next = text.split('\n');
      state.lastLines = next;
      log.setLines(next);
      updateMeta();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  async function startStream() {
    stopStream();
    if (!state.follow) { snapshot(); return; }
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    setMode(t('app.docker.logs-connecting'));
    state.partial = '';
    state.lastLines = [];
    log.clear();

    const ac = new AbortController();
    state.abort = ac;
    try {
      await api.streamLogs(host, id, {
        tail: state.tail,
        timestamps: state.timestamps,
        since: state.since,
        follow: true,
      }, {
        signal: ac.signal,
        onChunk: (chunk) => { if (!state.closed) feed(chunk); },
      });
      if (!state.closed) {
        if (state.partial) feed('\n');
        setMode(t('app.docker.logs-ended'));
      }
    } catch (e) {
      if (state.closed || (e && e.name === 'AbortError')) return;
      // 流被宿主拒绝或网络中断：退回快照 + 定时刷新
      toast(tf('app.docker.logs-stream-fallback', { v1: e.message || String(e) }), 'warning');
      state.mode = 'poll';
      await snapshot();
      if (state.follow && !state.timer) {
        state.timer = setInterval(() => { if (state.follow && !state.closed) snapshot(); }, 4000);
      }
      setMode(t('app.docker.logs-polling'));
    }
  }

  const tailSelect = dom('select', {
    class: 'select dk-mini',
    onChange: (e) => { state.tail = Number(e.target.value); startStream(); },
  }, [200, 400, 1000, 2000].map((n) => dom('option', { value: String(n), text: tf('app.docker.logs-tail', { v1: String(n) }) })));

  const sinceSelect = dom('select', {
    class: 'select dk-mini',
    onChange: (e) => { state.since = e.target.value; startStream(); },
  }, [
    dom('option', { value: '', text: t('app.docker.logs-since-all') }),
    dom('option', { value: '15m', text: '15m' }),
    dom('option', { value: '1h', text: '1h' }),
    dom('option', { value: '6h', text: '6h' }),
    dom('option', { value: '24h', text: '24h' }),
  ]);

  const levelSelect = dom('select', {
    class: 'select dk-mini',
    onChange: (e) => log.setLevel(e.target.value),
  }, [
    dom('option', { value: 'all', text: t('app.docker.logs-level-all') }),
    dom('option', { value: 'error', text: 'ERROR+' }),
    dom('option', { value: 'warn', text: 'WARN+' }),
    dom('option', { value: 'info', text: 'INFO+' }),
    dom('option', { value: 'debug', text: 'DEBUG+' }),
  ]);

  const searchInput = dom('input', {
    class: 'input dk-mini',
    type: 'text',
    placeholder: t('app.docker.logs-search'),
    onInput: (e) => log.setQuery(e.target.value),
  });

  const tsCheck = dom('input', {
    type: 'checkbox',
    checked: true,
    onChange: (e) => { state.timestamps = e.target.checked; startStream(); },
  });
  const followCheck = dom('input', {
    type: 'checkbox',
    checked: true,
    onChange: (e) => { state.follow = e.target.checked; if (!e.target.checked && state.timer) { clearInterval(state.timer); state.timer = null; } startStream(); },
  });

  const tools = h('div', { class: 'dk-log-tools' }, [
    searchInput, levelSelect, tailSelect, sinceSelect,
    h('label', { class: 'dk-mini-check' }, [tsCheck, h('span', { text: t('app.docker.logs-timestamps') })]),
    h('label', { class: 'dk-mini-check' }, [followCheck, h('span', { text: t('app.docker.logs-follow') })]),
    modeBadge, meta,
    copyButton(() => log.toText(), { tip: t('app.docker.copy-logs') }),
    h('button', {
      class: 'btn btn-sm btn-ghost',
      title: t('app.docker.download-logs'),
      onClick: () => {
        const fn = 'docker-' + name + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.log';
        if (!downloadText(fn, log.toText())) toast(t('app.docker.download-failed'), 'danger');
      },
    }, [h('span', { html: svgIcon('download') })]),
    h('button', { class: 'btn btn-sm btn-outline', onClick: () => startStream() }, [h('span', { html: svgIcon('rotate-cw') })]),
  ]);

  const dlg = dialog({
    title: tf('app.docker.logs-title', { v1: name }),
    cls: 'dk-dialog-xl',
    body: [tools, h('div', { class: 'dk-logbox' }, [log.el])],
    onClose: () => {
      state.closed = true;
      stopStream();
      if (state.timer) clearInterval(state.timer);
      log.destroy();
    },
  });

  startStream();
  return dlg;
}

/* ------------------------------------------------------------------ *
 * 交互式终端（WebSocket + xterm）
 * ------------------------------------------------------------------ */

/**
 * 打开容器内交互式 shell。
 * 与“执行一次性命令”不同，这里保持常连接，支持 top/vi 等全屏程序。
 */
export function openTerminalDialog(host, container) {
  const id = container.ID || container.Id || '';
  const name = (String(container.Names || '').split(',')[0]) || shortId(id);

  if (!window.Terminal || !window.FitAddon) {
    toast(t('app.docker.term-unavailable'), 'danger');
    return null;
  }

  const box = document.createElement('div');
  box.className = 'dk-term-box';
  const notice = dom('div', { class: 'dk-term-notice', text: t('app.docker.term-connecting') });

  const dark = document.documentElement.classList.contains('dark');
  const term = new window.Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    scrollback: 5000,
    theme: dark
      ? { background: '#1c1c1e', foreground: '#e3e3e8', cursor: '#6cb6ff', selectionBackground: 'rgba(108,182,255,.3)' }
      : { background: '#ffffff', foreground: '#1d1d1f', cursor: '#0037ff', selectionBackground: 'rgba(0,55,255,.18)' },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(box);

  let ws = null;
  let closed = false;

  function setNotice(text) {
    notice.textContent = text || '';
    notice.style.display = text ? '' : 'none';
  }

  function connect() {
    if (closed) return;
    if (ws) { try { ws.close(); } catch (e) { /* 忽略 */ } }
    setNotice(t('app.docker.term-connecting'));
    try { fit.fit(); } catch (e) { /* 容器尚未布局时忽略 */ }

    let url;
    try {
      url = api.execTermWSUrl(host, id, term.cols, term.rows);
    } catch (e) {
      setNotice(e.message || String(e));
      return;
    }

    let sock;
    try {
      sock = new WebSocket(url);
    } catch (e) {
      setNotice(tf('app.docker.term-failed', { v1: e.message || String(e) }));
      return;
    }
    sock.binaryType = 'arraybuffer';
    ws = sock;

    sock.onopen = () => {
      if (closed) { try { sock.close(); } catch (e) { /* 忽略 */ } return; }
      setNotice('');
      sock.send(JSON.stringify({ t: 'resize', c: term.cols, r: term.rows }));
      term.focus();
    };
    sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg && msg.t === 'exit') {
          setNotice(tf('app.docker.term-exited', { v1: String(msg.code == null ? 0 : msg.code) }));
          return;
        }
        if (msg && msg.t === 'err') {
          setNotice(msg.m || t('app.docker.term-session-failed'));
          return;
        }
        return;
      }
      try { term.write(new Uint8Array(ev.data)); } catch (e) { /* 忽略 */ }
    };
    sock.onclose = () => {
      if (closed) return;
      setNotice(t('app.docker.term-disconnected'));
    };
  }

  const dataSub = term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', d: data }));
  });
  const resizeSub = term.onResize(({ cols, rows }) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', c: cols, r: rows }));
  });

  const onWinResize = () => { try { fit.fit(); } catch (e) { /* 忽略 */ } };
  window.addEventListener('resize', onWinResize);

  const dlg = dialog({
    title: tf('app.docker.term-title', { v1: name }),
    cls: 'dk-dialog-xl',
    body: [
      h('div', { class: 'dk-term-bar' }, [
        h('span', { class: 'dk-dim-text', text: t('app.docker.term-hint') }),
        h('span', { class: 'qx-grow' }),
        h('button', {
          class: 'btn btn-sm btn-outline',
          text: t('app.docker.term-reconnect'),
          onClick: () => { connect(); },
        }),
      ]),
      box,
      notice,
    ],
    onClose: () => {
      closed = true;
      window.removeEventListener('resize', onWinResize);
      try { dataSub.dispose(); } catch (e) { /* 忽略 */ }
      try { resizeSub.dispose(); } catch (e) { /* 忽略 */ }
      if (ws) { try { ws.close(); } catch (e) { /* 忽略 */ } }
      try { term.dispose(); } catch (e) { /* 忽略 */ }
    },
  });

  // 让终端在对话框完成布局后再计算尺寸
  setTimeout(() => {
    try { fit.fit(); } catch (e) { /* 忽略 */ }
    connect();
  }, 60);

  return dlg;
}

/* ------------------------------------------------------------------ *
 * 一次性命令
 * ------------------------------------------------------------------ */

export function openExecDialog(host, container) {
  const id = container.ID || container.Id || '';
  const name = (String(container.Names || '').split(',')[0]) || shortId(id);
  const history = [];
  let idx = -1;
  let running = false;

  const out = dom('pre', { class: 'dk-exec-out mono', text: t('app.docker.exec-hint') });
  const shellSelect = dom('select', { class: 'select dk-mini' }, [
    dom('option', { value: 'sh', text: 'sh' }),
    dom('option', { value: 'bash', text: 'bash' }),
    dom('option', { value: 'ash', text: 'ash' }),
  ]);

  async function run() {
    const cmd = String(input.value || '').trim();
    if (!cmd || running) return;
    running = true;
    history.push(cmd);
    idx = -1;
    out.textContent += '\n$ ' + cmd + '\n' + t('app.docker.exec-running') + '\n';
    try {
      const r = await api.containerExec(host, id, cmd, { shell: shellSelect.value });
      out.textContent = out.textContent.replace(t('app.docker.exec-running') + '\n', '') + (r.output || '') + '\n[exit ' + r.exit + ']\n';
      out.scrollTop = out.scrollHeight;
    } catch (e) {
      out.textContent += (e.message || String(e)) + '\n';
    } finally {
      running = false;
      input.value = '';
      input.focus();
    }
  }

  const input = dom('input', {
    class: 'input mono',
    type: 'text',
    placeholder: t('app.docker.exec-placeholder'),
    onKeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); run(); return; }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!history.length) return;
        idx = idx < 0 ? history.length - 1 : Math.max(0, idx - 1);
        input.value = history[idx] || '';
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (idx < 0) return;
        idx += 1;
        if (idx >= history.length) { idx = -1; input.value = ''; } else input.value = history[idx];
      }
    },
  });

  const dlg = dialog({
    title: tf('app.docker.exec-title', { v1: name }),
    cls: 'dk-dialog-lg',
    body: [
      h('div', { class: 'dk-exec-bar' }, [
        shellSelect,
        input,
        h('button', { class: 'btn btn-sm btn-primary', text: t('app.docker.exec-run'), onClick: run }),
      ]),
      out,
    ],
  });
  setTimeout(() => input.focus(), 60);
  return dlg;
}

/* ------------------------------------------------------------------ *
 * 详情
 * ------------------------------------------------------------------ */

export function openDetailDialog(host, container) {
  const id = container.ID || container.Id || '';
  const name = (String(container.Names || '').split(',')[0]) || shortId(id);

  const state = { tab: 'overview', loading: true, error: '', inspect: null, extra: '' };
  const box = document.createElement('div');
  box.className = 'dk-detail-body';
  const view = createView(box);

  async function loadTab(tab) {
    state.tab = tab;
    state.loading = true;
    state.error = '';
    render();
    try {
      if (tab === 'process') state.extra = await api.containerTop(host, id);
      else if (tab === 'diff') state.extra = await api.containerDiff(host, id);
      else if (!state.inspect) state.inspect = await api.inspectContainer(host, id);
      if (tab === 'env' && state.inspect) {
        const env = parseEnvList(pick(state.inspect, 'Config.Env', []));
        state.extra = Object.keys(env).sort().map((k) => k + '=' + env[k]).join('\n');
      }
    } catch (e) {
      state.error = e.message || String(e);
    } finally {
      state.loading = false;
      render();
    }
  }

  function kvPairs() {
    const d = state.inspect || {};
    const st = pick(d, 'State', {}) || {};
    const cfg = pick(d, 'Config', {}) || {};
    const nets = Object.keys(pick(d, 'NetworkSettings.Networks', {}) || {});
    const mounts = (pick(d, 'Mounts', []) || []).map((m) => m.Source + ' → ' + m.Destination + (m.RW ? '' : ' (ro)'));
    return { pairs: [
      [t('app.docker.f-id'), shortId(id, 16)],
      [t('app.docker.f-image'), String(cfg.Image || '')],
      [t('app.docker.f-state'), String(st.Status || '')],
      [t('app.docker.f-pid'), String(st.Pid || '')],
      [t('app.docker.f-exit'), String(st.ExitCode == null ? '' : st.ExitCode)],
      [t('app.docker.f-started'), String(st.StartedAt || '')],
      [t('app.docker.f-finished'), String(st.FinishedAt || '')],
      [t('app.docker.f-restart'), String(pick(d, 'HostConfig.RestartPolicy.Name', '') || 'no')],
      [t('app.docker.f-network'), nets.join(', ')],
      [t('app.docker.f-entrypoint'), String((cfg.Entrypoint || []).join(' ') || '-')],
    ], mounts };
  }

  function render() {
    let body;
    if (state.loading) body = h('div', { class: 'dk-loading' }, [spinner(t('app.docker.loading'))]);
    else if (state.error) body = codeBlock(state.error, { cls: 'mono dk-pre' });
    else if (state.tab === 'overview') {
      const { pairs, mounts } = kvPairs();
      body = h('div', null, [
        kvGrid(pairs, { cols: 2 }),
        mounts.length ? h('div', { class: 'dk-kv-block' }, [
          h('div', { class: 'cmp-section-title', text: t('app.docker.mounts-title') }),
          codeBlock(mounts.join('\n'), { cls: 'mono dk-pre' }),
        ]) : null,
      ]);
    } else if (state.tab === 'json') {
      body = JsonViewer({ value: state.inspect, maxDepth: 2, rootLabel: name });
    } else {
      body = codeBlock(state.extra || t('app.docker.empty'), { cls: 'mono dk-pre' });
    }
    return h('div', null, [
      segmented([
        { value: 'overview', label: t('app.docker.detail-overview') },
        { value: 'json', label: t('app.docker.detail-json') },
        { value: 'env', label: t('app.docker.detail-env') },
        { value: 'process', label: t('app.docker.detail-process') },
        { value: 'diff', label: t('app.docker.detail-diff') },
      ], state.tab, (v) => loadTab(v)),
      h('div', { class: 'dk-detail-wrap' }, [body]),
    ]);
  }

  view.update(render);

  const dlg = dialog({
    title: tf('app.docker.detail-title', { v1: name }),
    cls: 'dk-dialog-lg',
    body: [box],
    onClose: () => view.unmount(),
  });

  loadTab('overview');
  return dlg;
}

/* ------------------------------------------------------------------ *
 * 运行 / 拉取 / 构建
 * ------------------------------------------------------------------ */

export function openRunDialog(host, opts) {
  const o = opts || {};
  const images = o.images || [];
  const networks = o.networks || [];
  const f = {
    image: '', name: '', ports: '', envs: '', volumes: '',
    restart: 'no', network: '', command: '', autoRemove: false,
  };

  const field = (label, control, hint) => h('label', { class: 'dk-field' }, [
    h('span', { class: 'dk-field-label', text: label }),
    control,
    hint ? h('span', { class: 'dk-field-hint', text: hint }) : null,
  ]);

  const imageInput = dom('input', {
    class: 'input mono',
    type: 'text',
    placeholder: t('app.docker.run-image-ph'),
    onInput: (e) => { f.image = e.target.value.trim(); },
  });
  const listId = 'dk-img-' + Math.random().toString(36).slice(2, 8);
  imageInput.setAttribute('list', listId);
  const datalist = h('datalist', { id: listId }, images.slice(0, 80).map((im) => h('option', {
    value: (im.Repository || '') + ':' + (im.Tag === '<none>' ? 'latest' : (im.Tag || 'latest')),
  })));

  const nameInput = dom('input', { class: 'input mono', type: 'text', placeholder: 'my-app', onInput: (e) => { f.name = e.target.value.trim(); } });
  const portsInput = dom('input', { class: 'input mono', type: 'text', placeholder: '8080:80, 3306:3306', onInput: (e) => { f.ports = e.target.value; } });
  const envInput = dom('textarea', { class: 'input mono', rows: '2', placeholder: 'TZ=Asia/Shanghai\nMODE=prod', onInput: (e) => { f.envs = e.target.value; } });
  const volInput = dom('textarea', { class: 'input mono', rows: '2', placeholder: '/srv/data:/data', onInput: (e) => { f.volumes = e.target.value; } });
  const cmdInput = dom('input', { class: 'input mono', type: 'text', placeholder: t('app.docker.run-cmd-ph'), onInput: (e) => { f.command = e.target.value; } });

  const restartSelect = dom('select', { class: 'select', onChange: (e) => { f.restart = e.target.value; } }, [
    dom('option', { value: 'no', text: t('app.docker.restart-no') }),
    dom('option', { value: 'unless-stopped', text: 'unless-stopped' }),
    dom('option', { value: 'always', text: 'always' }),
    dom('option', { value: 'on-failure', text: 'on-failure' }),
  ]);

  const netSelect = dom('select', { class: 'select', onChange: (e) => { f.network = e.target.value; } }, [
    dom('option', { value: '', text: t('app.docker.run-net-default') }),
    ...networks.map((n) => dom('option', { value: n.Name, text: n.Name })),
  ]);

  const rmCheck = dom('input', { type: 'checkbox', onChange: (e) => { f.autoRemove = e.target.checked; } });

  const body = h('div', { class: 'dk-form' }, [
    datalist,
    field(t('app.docker.run-image'), imageInput, t('app.docker.run-image-hint')),
    field(t('app.docker.run-name'), nameInput, t('app.docker.run-name-hint')),
    field(t('app.docker.run-ports'), portsInput, t('app.docker.run-ports-hint')),
    field(t('app.docker.run-envs'), envInput, t('app.docker.run-envs-hint')),
    field(t('app.docker.run-volumes'), volInput, t('app.docker.run-volumes-hint')),
    h('div', { class: 'dk-form-row' }, [
      field(t('app.docker.run-restart'), restartSelect),
      field(t('app.docker.run-network'), netSelect),
    ]),
    field(t('app.docker.run-command'), cmdInput, t('app.docker.run-command-hint')),
    h('label', { class: 'dk-mini-check' }, [rmCheck, h('span', { text: t('app.docker.run-rm') })]),
  ]);

  let dlg = null;
  const runBtn = dom('button', {
    class: 'btn btn-primary btn-sm',
    text: t('app.docker.run-submit'),
    onClick: async () => {
      if (!f.image) { toast(t('app.docker.run-need-image'), 'warning'); imageInput.focus(); return; }
      runBtn.disabled = true;
      try {
        const newId = await api.runContainer(host, {
          image: f.image,
          name: f.name,
          ports: f.ports.split(/[,\s]+/).filter(Boolean),
          envs: f.envs.split('\n').map((x) => x.trim()).filter(Boolean),
          volumes: f.volumes.split('\n').map((x) => x.trim()).filter(Boolean),
          restart: f.restart === 'no' ? '' : f.restart,
          network: f.network,
          command: f.command,
          autoRemove: f.autoRemove,
        });
        toast(tf('app.docker.run-ok', { v1: shortId(newId) }), 'success');
        dlg.close();
        if (o.onDone) o.onDone();
      } catch (e) {
        toast(e.message || String(e), 'danger');
      } finally {
        runBtn.disabled = false;
      }
    },
  });

  dlg = dialog({
    title: t('app.docker.run-title'),
    cls: 'dk-dialog-lg',
    body: [body],
    actions: [
      h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.cancel'), onClick: () => dlg.close() }),
      runBtn,
    ],
  });
  setTimeout(() => imageInput.focus(), 60);
  return dlg;
}

/** 拉取镜像（实时显示进度，可选国内加速前缀） */
export function openPullDialog(host, opts) {
  const o = opts || {};
  const mirrors = o.mirrors || [];
  const f = { ref: '', mirror: '' };

  const refInput = dom('input', {
    class: 'input mono',
    type: 'text',
    placeholder: 'nginx:1.27 / registry.k8s.io/pause:3.9',
    onInput: (e) => { f.ref = e.target.value.trim(); },
  });
  const mirrorSelect = dom('select', { class: 'select', onChange: (e) => { f.mirror = e.target.value; } }, [
    dom('option', { value: '', text: t('app.docker.pull-direct') }),
    ...mirrors.map((m) => dom('option', { value: m, text: m })),
  ]);
  const out = dom('pre', { class: 'dk-exec-out mono', text: '' });
  let dlg = null;

  const pullBtn = dom('button', {
    class: 'btn btn-primary btn-sm',
    text: t('app.docker.pull-submit'),
    onClick: async () => {
      if (!f.ref) { refInput.focus(); return; }
      pullBtn.disabled = true;
      out.textContent = t('app.docker.pull-running') + '\n';
      const target = f.mirror ? f.mirror.replace(/\/+$/, '') + '/' + f.ref : f.ref;
      try {
        await api.pullImageStream(host, target, {
          onChunk: (chunk) => { out.textContent += chunk; out.scrollTop = out.scrollHeight; },
        });
        if (f.mirror) {
          await api.tagImage(host, target, f.ref);
          out.textContent += '\n' + t('app.docker.pull-retagged');
        }
        toast(t('app.docker.pull-ok'), 'success');
        if (o.onDone) o.onDone();
      } catch (e) {
        out.textContent += '\n' + (e.message || String(e));
        toast(t('app.docker.pull-fail'), 'danger');
      } finally {
        pullBtn.disabled = false;
      }
    },
  });

  dlg = dialog({
    title: t('app.docker.pull-title'),
    cls: 'dk-dialog-lg',
    body: [
      h('label', { class: 'dk-field' }, [h('span', { class: 'dk-field-label', text: t('app.docker.pull-ref') }), refInput]),
      h('label', { class: 'dk-field' }, [
        h('span', { class: 'dk-field-label', text: t('app.docker.pull-mirror') }),
        mirrorSelect,
        h('span', { class: 'dk-field-hint', text: t('app.docker.pull-mirror-hint') }),
      ]),
      out,
    ],
    actions: [
      h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.cancel'), onClick: () => dlg.close() }),
      pullBtn,
    ],
  });
  setTimeout(() => refInput.focus(), 60);
  return dlg;
}

/** 构建镜像（流式输出构建过程） */
export function openBuildDialog(host, opts) {
  const o = opts || {};
  const f = { dir: '', tag: '' };
  const dirInput = dom('input', { class: 'input mono', type: 'text', placeholder: '/srv/app', onInput: (e) => { f.dir = e.target.value.trim(); } });
  const tagInput = dom('input', { class: 'input mono', type: 'text', placeholder: 'my-app:1.0', onInput: (e) => { f.tag = e.target.value.trim(); } });
  const out = dom('pre', { class: 'dk-exec-out mono', text: '' });
  let dlg = null;

  const buildBtn = dom('button', {
    class: 'btn btn-primary btn-sm',
    text: t('app.docker.build-submit'),
    onClick: async () => {
      if (!f.dir) { dirInput.focus(); return; }
      buildBtn.disabled = true;
      out.textContent = t('app.docker.build-running') + '\n';
      try {
        await api.buildImageStream(host, f.dir, f.tag, {
          onChunk: (chunk) => { out.textContent += chunk; out.scrollTop = out.scrollHeight; },
        });
        toast(t('app.docker.build-ok'), 'success');
        if (o.onDone) o.onDone();
      } catch (e) {
        out.textContent += '\n' + (e.message || String(e));
        toast(t('app.docker.build-fail'), 'danger');
      } finally {
        buildBtn.disabled = false;
      }
    },
  });

  dlg = dialog({
    title: t('app.docker.build-title'),
    cls: 'dk-dialog-lg',
    body: [
      h('label', { class: 'dk-field' }, [h('span', { class: 'dk-field-label', text: t('app.docker.build-dir') }), dirInput,
        h('span', { class: 'dk-field-hint', text: t('app.docker.build-dir-hint') })]),
      h('label', { class: 'dk-field' }, [h('span', { class: 'dk-field-label', text: t('app.docker.build-tag') }), tagInput,
        h('span', { class: 'dk-field-hint', text: t('app.docker.build-tag-hint') })]),
      out,
    ],
    actions: [
      h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.cancel'), onClick: () => dlg.close() }),
      buildBtn,
    ],
  });
  setTimeout(() => dirInput.focus(), 60);
  return dlg;
}
