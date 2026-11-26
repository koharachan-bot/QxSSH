/**
 * console.js —— 专业控制台
 * 给熟悉的用户一条直路：直接敲 docker / systemctl 等命令，输出用彩色日志渲染。
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView, dom } from '/assets/js/core/vdom.js';
import { toast } from '/assets/js/core/ui.js';
import { card, copyButton } from '/assets/js/core/components.js';
import { createLogView } from '/assets/js/core/logview.js';

import * as api from './api.js';
import { downloadText } from './format.js';

const HKEY = 'qx-docker-console-history';

const QUICK = [
  { cmd: 'docker ps -a', label: 'docker ps' },
  { cmd: 'docker images', label: 'docker images' },
  { cmd: 'docker system df', label: 'docker system df' },
  { cmd: 'docker info', label: 'docker info' },
  { cmd: 'docker version', label: 'docker version' },
  { cmd: 'docker network ls', label: 'docker network ls' },
  { cmd: 'docker volume ls', label: 'docker volume ls' },
  { cmd: 'docker compose ls', label: 'docker compose ls' },
  { cmd: 'docker events --since 10m --until now', label: 'docker events' },
];

export function createConsoleView(deps) {
  const el = document.createElement('div');
  el.className = 'dk-body';

  const log = createLogView({ emptyText: t('app.docker.console-empty'), showLineNo: false });
  log.el.style.height = '100%';

  let history = [];
  try {
    const raw = localStorage.getItem(HKEY);
    history = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(history)) history = [];
  } catch (e) { history = []; }

  let hIdx = -1;
  let running = false;

  const input = dom('textarea', {
    class: 'input mono dk-console-input',
    rows: '3',
    placeholder: t('app.docker.console-placeholder'),
    onKeydown: (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); return; }
      if (e.key === 'ArrowUp' && !e.shiftKey && input.value.indexOf('\n') < 0) {
        if (!history.length) return;
        e.preventDefault();
        hIdx = hIdx < 0 ? history.length - 1 : Math.max(0, hIdx - 1);
        input.value = history[hIdx] || '';
      } else if (e.key === 'ArrowDown' && !e.shiftKey && input.value.indexOf('\n') < 0) {
        if (hIdx < 0) return;
        e.preventDefault();
        hIdx += 1;
        if (hIdx >= history.length) { hIdx = -1; input.value = ''; } else input.value = history[hIdx];
      }
    },
  });

  function pushHistory(cmd) {
    history = history.filter((x) => x !== cmd);
    history.push(cmd);
    if (history.length > 60) history = history.slice(-60);
    try { localStorage.setItem(HKEY, JSON.stringify(history)); } catch (e) { /* 忽略配额错误 */ }
  }

  async function run() {
    const cmd = String(input.value || '').trim();
    if (!cmd || running) return;
    running = true;
    pushHistory(cmd);
    hIdx = -1;
    log.appendLines(['', '$ ' + cmd]);
    try {
      const r = await api.runCommandLine(deps.host(), cmd);
      const body = String(r.output || '').split('\n');
      log.appendLines(body.concat(['[exit ' + r.exit + ']']));
      if (!r.ok) toast(tf('app.docker.console-exit', { v1: String(r.exit) }), 'warning');
    } catch (e) {
      log.appendLines([String(e.message || e)]);
      toast(e.message || String(e), 'danger');
    } finally {
      running = false;
      input.value = '';
      input.focus();
    }
  }

  const runBtn = dom('button', {
    class: 'btn btn-sm btn-primary',
    text: t('app.docker.console-run'),
    onClick: run,
  });

  const body = h('div', { class: 'dk-console' }, [
    h('div', { class: 'dk-console-bar' }, [
      h('div', { class: 'dk-chips' }, QUICK.map((q) => h('button', {
        key: q.cmd,
        class: 'dk-chip',
        type: 'button',
        text: q.label,
        onClick: () => { input.value = q.cmd; input.focus(); },
      }))),
    ]),
    input,
    h('div', { class: 'dk-console-acts' }, [
      h('span', { class: 'dk-dim-text', text: t('app.docker.console-hint') }),
      h('span', { class: 'qx-grow' }),
      h('button', { class: 'btn btn-sm btn-ghost', text: t('app.docker.console-clear'), onClick: () => log.clear() }),
      copyButton(() => log.toText(), { tip: t('app.docker.copy-output') }),
      h('button', {
        class: 'btn btn-sm btn-ghost',
        text: t('app.docker.download'),
        onClick: () => downloadText('docker-console.log', log.toText()),
      }),
      runBtn,
    ]),
    h('div', { class: 'dk-console-out' }, [log.el]),
  ]);

  const view = createView(el);
  view.update(() => card(null, body, { fill: true }));

  setTimeout(() => input.focus(), 80);

  return {
    el,
    refresh: () => { },
    onShow: () => setTimeout(() => input.focus(), 60),
    statusBits: () => [{ text: t('app.docker.console-status') }],
    dispose: () => { log.destroy(); view.unmount(); },
  };
}
