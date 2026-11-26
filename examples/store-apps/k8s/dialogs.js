/**
 * dialogs.js —— Kubernetes 对话框集合
 * Pod 日志复用 core/logview.js 的彩色渲染；其余是 describe / exec / 扩缩容 / YAML 编辑。
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, dom, createView } from '/assets/js/core/vdom.js';
import { toast } from '/assets/js/core/ui.js';
import { dialog, codeBlock, segmented, copyButton } from '/assets/js/core/components.js';
import { createLogView } from '/assets/js/core/logview.js';

import * as api from './api.js';
import { downloadText, roughYamlCheck, shortContainerName } from './format.js';

/* ------------------------------------------------------------------ *
 * Pod 日志（彩色）
 * ------------------------------------------------------------------ */

export function openPodLogsDialog(host, pod) {
  const ns = pod.namespace || 'default';
  const containers = Array.isArray(pod.containers) && pod.containers.length ? pod.containers : [''];
  const state = { tail: 400, timestamps: true, follow: true, previous: false, container: containers[0] || '', timer: null, last: [] };
  let closed = false;

  const log = createLogView({ emptyText: t('app.k8s.logs-empty'), showLineNo: true });
  log.el.style.height = '100%';

  const meta = dom('span', { class: 'qx-count', text: '' });

  async function fetchOnce(initial) {
    try {
      const text = await api.podLogs(host, pod.name, {
        namespace: ns,
        container: state.container,
        tail: state.tail,
        timestamps: state.timestamps,
        previous: state.previous,
      });
      if (closed) return;
      const next = text.split('\n');
      if (initial || !state.last.length) log.setLines(next);
      else if (next.length >= state.last.length) {
        const anchor = state.last[state.last.length - 1];
        const at = next.lastIndexOf(anchor);
        if (at >= 0 && at < next.length - 1) log.appendLines(next.slice(at + 1));
        else log.setLines(next);
      } else log.setLines(next);
      state.last = next;
      const st = log.stats();
      meta.textContent = tf('app.k8s.logs-count', { v1: String(st.total), v2: String(st.error), v3: String(st.warn) });
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  function restartTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => { if (state.follow && !closed) fetchOnce(false); }, 3000);
  }

  const containerSelect = containers.length > 1
    ? dom('select', {
      class: 'select k8s-mini',
      onChange: (e) => { state.container = e.target.value; state.last = []; fetchOnce(true); },
    }, containers.map((c) => dom('option', { value: c, text: shortContainerName(c, pod.name) })))
    : null;

  const tailSelect = dom('select', {
    class: 'select k8s-mini',
    onChange: (e) => { state.tail = Number(e.target.value); fetchOnce(true); },
  }, [200, 400, 1000, 2000].map((n) => dom('option', { value: String(n), text: tf('app.k8s.logs-tail', { v1: String(n) }) })));

  const levelSelect = dom('select', {
    class: 'select k8s-mini',
    onChange: (e) => log.setLevel(e.target.value),
  }, [
    dom('option', { value: 'all', text: t('app.k8s.logs-level-all') }),
    dom('option', { value: 'error', text: 'ERROR+' }),
    dom('option', { value: 'warn', text: 'WARN+' }),
    dom('option', { value: 'info', text: 'INFO+' }),
  ]);

  const searchInput = dom('input', {
    class: 'input k8s-mini',
    type: 'text',
    placeholder: t('app.k8s.logs-search'),
    onInput: (e) => log.setQuery(e.target.value),
  });

  const prevCheck = dom('input', {
    type: 'checkbox',
    onChange: (e) => { state.previous = e.target.checked; fetchOnce(true); },
  });
  const followCheck = dom('input', {
    type: 'checkbox',
    checked: true,
    onChange: (e) => { state.follow = e.target.checked; },
  });

  const tools = h('div', { class: 'k8s-log-tools' }, [
    containerSelect, searchInput, levelSelect, tailSelect,
    h('label', { class: 'k8s-mini-check' }, [prevCheck, h('span', { text: t('app.k8s.logs-previous') })]),
    h('label', { class: 'k8s-mini-check' }, [followCheck, h('span', { text: t('app.k8s.logs-follow') })]),
    meta,
    copyButton(() => log.toText(), { tip: t('app.k8s.copy-logs') }),
    h('button', {
      class: 'btn btn-sm btn-ghost',
      text: t('app.k8s.download'),
      onClick: () => {
        const fn = pod.name + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.log';
        if (!downloadText(fn, log.toText())) toast(t('app.k8s.download-failed'), 'danger');
      },
    }),
    h('button', { class: 'btn btn-sm btn-outline', text: t('app.k8s.refresh'), onClick: () => fetchOnce(true) }),
  ]);

  const dlg = dialog({
    title: tf('app.k8s.logs-title', { v1: pod.name, v2: ns }),
    cls: 'k8s-dialog-xl',
    body: [tools, h('div', { class: 'k8s-logbox' }, [log.el])],
    onClose: () => {
      closed = true;
      if (state.timer) clearInterval(state.timer);
      log.destroy();
    },
  });

  fetchOnce(true);
  restartTimer();
  return dlg;
}

/* ------------------------------------------------------------------ *
 * describe
 * ------------------------------------------------------------------ */

export function openDescribeDialog(host, kind, name, namespace) {
  const out = dom('pre', { class: 'k8s-pre mono', text: t('app.k8s.loading') });
  const dlg = dialog({
    title: tf('app.k8s.describe-title', { v1: kind, v2: name }),
    cls: 'k8s-dialog-xl',
    body: [
      h('div', { class: 'k8s-row' }, [
        h('span', { class: 'qx-grow' }),
        copyButton(() => out.textContent || '', { tip: t('app.k8s.copy') }),
        h('button', {
          class: 'btn btn-sm btn-ghost',
          text: t('app.k8s.download'),
          onClick: () => downloadText(name + '.describe.txt', out.textContent || ''),
        }),
      ]),
      out,
    ],
  });
  api.describe(host, kind, name, namespace).then((text) => {
    out.textContent = text || t('app.k8s.empty');
  }).catch((e) => { out.textContent = e.message || String(e); });
  return dlg;
}

/* ------------------------------------------------------------------ *
 * Pod 内执行
 * ------------------------------------------------------------------ */

export function openExecDialog(host, pod) {
  const ns = pod.namespace || 'default';
  const containers = Array.isArray(pod.containers) && pod.containers.length ? pod.containers : [''];
  const history = [];
  let idx = -1;
  let running = false;

  const out = dom('pre', { class: 'k8s-exec-out mono', text: t('app.k8s.exec-hint') });
  const input = dom('input', {
    class: 'input mono',
    type: 'text',
    placeholder: t('app.k8s.exec-placeholder'),
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

  const shellSelect = dom('select', { class: 'select k8s-mini' }, [
    dom('option', { value: 'sh', text: 'sh' }),
    dom('option', { value: 'bash', text: 'bash' }),
    dom('option', { value: 'ash', text: 'ash' }),
  ]);
  const containerSelect = containers.length > 1
    ? dom('select', { class: 'select k8s-mini' }, containers.map((c) => dom('option', { value: c, text: shortContainerName(c, pod.name) })))
    : null;

  async function run() {
    const cmd = String(input.value || '').trim();
    if (!cmd || running) return;
    running = true;
    history.push(cmd);
    idx = -1;
    out.textContent += '\n$ ' + cmd + '\n' + t('app.k8s.exec-running') + '\n';
    try {
      const r = await api.execPod(host, pod.name, cmd, {
        namespace: ns,
        container: containerSelect ? containerSelect.value : (containers[0] || ''),
        shell: shellSelect.value,
      });
      out.textContent = out.textContent.replace(t('app.k8s.exec-running') + '\n', '') + (r.output || '') + '\n[exit ' + r.exit + ']\n';
      out.scrollTop = out.scrollHeight;
    } catch (e) {
      out.textContent += (e.message || String(e)) + '\n';
    } finally {
      running = false;
      input.value = '';
      input.focus();
    }
  }

  const dlg = dialog({
    title: tf('app.k8s.exec-title', { v1: pod.name, v2: ns }),
    cls: 'k8s-dialog-lg',
    body: [
      h('div', { class: 'k8s-exec-bar' }, [
        containerSelect, shellSelect, input,
        h('button', { class: 'btn btn-sm btn-primary', text: t('app.k8s.exec-run'), onClick: run }),
      ]),
      out,
    ],
  });
  setTimeout(() => input.focus(), 60);
  return dlg;
}

/* ------------------------------------------------------------------ *
 * 扩缩容
 * ------------------------------------------------------------------ */

export function openScaleDialog(host, wl, onDone) {
  const cur = wl.want || wl.ready || 1;
  const input = dom('input', {
    class: 'input mono',
    type: 'number',
    min: '0',
    value: String(cur),
  });
  let dlg = null;
  const okBtn = dom('button', {
    class: 'btn btn-primary btn-sm',
    text: t('app.k8s.scale-submit'),
    onClick: async () => {
      okBtn.disabled = true;
      try {
        const out = await api.scale(host, wl.kind, wl.name, wl.namespace, input.value);
        toast(out || t('app.k8s.scale-ok'), 'success');
        dlg.close();
        onDone?.();
      } catch (e) {
        toast(e.message || String(e), 'danger');
      } finally {
        okBtn.disabled = false;
      }
    },
  });
  dlg = dialog({
    title: tf('app.k8s.scale-title', { v1: wl.name }),
    cls: 'k8s-dialog-sm',
    body: [
      h('div', { class: 'k8s-dim', text: tf('app.k8s.scale-current', { v1: String(cur), v2: wl.namespace || '' }) }),
      h('label', { class: 'k8s-field' }, [h('span', { class: 'k8s-field-label', text: t('app.k8s.scale-replicas') }), input]),
    ],
    actions: [
      h('button', { class: 'btn btn-ghost btn-sm', text: t('app.k8s.cancel'), onClick: () => dlg.close() }),
      okBtn,
    ],
  });
  setTimeout(() => { input.focus(); input.select?.(); }, 60);
  return dlg;
}

/* ------------------------------------------------------------------ *
 * YAML 查看 / 编辑
 * ------------------------------------------------------------------ */

/**
 * 打开某资源的 YAML 编辑器：读取 → 编辑 → apply / dry-run。
 */
export function openYamlDialog(host, { kind, name, namespace, onDone } = {}) {
  const ta = dom('textarea', { class: 'input mono k8s-yaml', rows: '18', spellcheck: 'false' });
  const status = dom('span', { class: 'k8s-dim', text: t('app.k8s.yaml-loading') });
  const box = document.createElement('div');
  box.className = 'k8s-yaml-box';
  box.appendChild(ta);
  let dlg = null;

  async function load() {
    try {
      const yaml = await api.getYaml(host, kind, name, namespace);
      ta.value = yaml;
      status.textContent = tf('app.k8s.yaml-loaded', { v1: String(yaml.split('\n').length) });
    } catch (e) {
      ta.value = '';
      status.textContent = e.message || String(e);
    }
  }

  async function apply(dryRun) {
    const text = String(ta.value || '');
    const chk = roughYamlCheck(text);
    if (!chk.ok) { toast(tf('app.k8s.yaml-invalid', { v1: chk.reason }), 'warning'); return; }
    status.textContent = t('app.k8s.yaml-applying');
    try {
      const r = await api.applyYaml(host, text, { dryRun });
      status.textContent = (dryRun ? t('app.k8s.yaml-dryrun-prefix') : '') + (r.output || '');
      toast(r.ok ? t('app.k8s.yaml-applied') : t('app.k8s.yaml-apply-failed'), r.ok ? 'success' : 'danger');
      if (r.ok && !dryRun) {
        onDone?.();
      }
    } catch (e) {
      status.textContent = e.message || String(e);
      toast(e.message || String(e), 'danger');
    }
  }

  dlg = dialog({
    title: name ? tf('app.k8s.yaml-title', { v1: kind, v2: name }) : t('app.k8s.yaml-title-new'),
    cls: 'k8s-dialog-xl',
    body: [
      h('div', { class: 'k8s-row' }, [
        h('span', { class: 'qx-grow' }),
        h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.yaml-reload'), onClick: load }),
        copyButton(() => String(ta.value || ''), { tip: t('app.k8s.copy') }),
        h('button', { class: 'btn btn-sm btn-outline', text: t('app.k8s.yaml-dryrun'), onClick: () => apply('server') }),
        h('button', { class: 'btn btn-sm btn-primary', text: t('app.k8s.yaml-apply'), onClick: () => apply('') }),
      ]),
      box,
      status,
    ],
  });

  if (kind && name) load();
  else status.textContent = t('app.k8s.yaml-hint-new');
  return dlg;
}

/** 新建资源：空白 YAML 编辑器 + 常用模板 */
export function openApplyDialog(host, onDone) {
  return openYamlDialog(host, { kind: '', name: '', namespace: '', onDone });
}
