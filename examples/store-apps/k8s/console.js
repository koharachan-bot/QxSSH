/**
 * console.js —— kubectl 控制台
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView, dom } from '/assets/js/core/vdom.js';
import { toast } from '/assets/js/core/ui.js';
import { card, copyButton } from '/assets/js/core/components.js';
import { createLogView } from '/assets/js/core/logview.js';

import * as api from './api.js';
import { downloadText } from './format.js';

const HKEY = 'qx-k8s-console-history';

const QUICK = [
  { cmd: 'kubectl get pods -A -o wide', label: 'get pods -A' },
  { cmd: 'kubectl get deploy -A', label: 'get deploy -A' },
  { cmd: 'kubectl get svc -A', label: 'get svc -A' },
  { cmd: 'kubectl get nodes -o wide', label: 'get nodes' },
  { cmd: 'kubectl get events -A --sort-by=.lastTimestamp | tail -40', label: 'events' },
  { cmd: 'kubectl top nodes', label: 'top nodes' },
  { cmd: 'kubectl cluster-info', label: 'cluster-info' },
  { cmd: 'kubectl config current-context', label: 'current-context' },
  { cmd: 'kubectl get ns', label: 'get ns' },
];

export function createConsoleView(deps) {
  const el = document.createElement('div');
  el.className = 'k8s-body';

  const log = createLogView({ emptyText: t('app.k8s.console-empty'), showLineNo: false });
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
    class: 'input mono k8s-console-input',
    rows: '3',
    placeholder: t('app.k8s.console-placeholder'),
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
    try { localStorage.setItem(HKEY, JSON.stringify(history)); } catch (e) { /* 忽略 */ }
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
      log.appendLines(String(r.output || '').split('\n').concat(['[exit ' + r.exit + ']']));
      if (!r.ok) toast(tf('app.k8s.console-exit', { v1: String(r.exit) }), 'warning');
    } catch (e) {
      log.appendLines([String(e.message || e)]);
      toast(e.message || String(e), 'danger');
    } finally {
      running = false;
      input.value = '';
      input.focus();
    }
  }

  const body = h('div', { class: 'k8s-console' }, [
    h('div', { class: 'k8s-chips' }, QUICK.map((q) => h('button', {
      key: q.cmd,
      class: 'k8s-chip',
      type: 'button',
      text: q.label,
      onClick: () => { input.value = q.cmd; input.focus(); },
    }))),
    input,
    h('div', { class: 'k8s-console-acts' }, [
      h('span', { class: 'k8s-dim', text: t('app.k8s.console-hint') }),
      h('span', { class: 'qx-grow' }),
      h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.console-clear'), onClick: () => log.clear() }),
      copyButton(() => log.toText(), { tip: t('app.k8s.copy') }),
      h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.download'), onClick: () => downloadText('kubectl-console.log', log.toText()) }),
      h('button', { class: 'btn btn-sm btn-primary', text: t('app.k8s.console-run'), onClick: run }),
    ]),
    h('div', { class: 'k8s-console-out' }, [log.el]),
  ]);

  const view = createView(el);
  view.update(() => card(null, body, { fill: true }));
  setTimeout(() => input.focus(), 80);

  return {
    el,
    refresh: () => { },
    onShow: () => setTimeout(() => input.focus(), 60),
    statusBits: () => [{ text: t('app.k8s.console-status') }],
    dispose: () => { log.destroy(); view.unmount(); },
  };
}
