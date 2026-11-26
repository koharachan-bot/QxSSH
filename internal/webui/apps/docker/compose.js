/**
 * compose.js —— Compose 项目视图
 * 能力：列出项目、看/改 compose 文件本体、以流式输出执行 up/down/restart/pull/build。
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView, dom } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, confirmAction } from '/assets/js/core/ui.js';
import {
  card, table, badge, codeBlock, spinner, alertBar, dialog, copyButton,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import { downloadText } from './format.js';

/** 从项目的 ConfigFiles 推导目录与首个文件 */
function projectPaths(project) {
  const files = String(project.ConfigFiles || '').split(',').map((s) => s.trim()).filter(Boolean);
  const file = files[0] || '';
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  return { file, dir };
}

/** 流式执行一个 compose 动作，把输出实时画出来 */
function runAction(host, project, action, onDone) {
  const { dir, file } = projectPaths(project);
  const out = dom('pre', { class: 'dk-exec-out mono', text: t('app.docker.compose-running', { v1: action }) + '\n' });
  const abort = new AbortController();
  let closed = false;

  const dlg = dialog({
    title: tf('app.docker.compose-act-title', { v1: action, v2: project.Name || '' }),
    cls: 'dk-dialog-lg',
    body: [
      h('div', { class: 'dk-row' }, [
        h('span', { class: 'dk-dim-text mono', text: (file || dir || '') }),
        h('span', { class: 'qx-grow' }),
        copyButton(() => out.textContent || '', { tip: t('app.docker.copy-output') }),
      ]),
      out,
    ],
    onClose: () => {
      closed = true;
      try { abort.abort(); } catch (e) { /* 忽略 */ }
    },
  });

  api.composeActionStream(host, { dir, file, project: project.Name, action }, {
    signal: abort.signal,
    onChunk: (chunk) => {
      if (closed) return;
      out.textContent += chunk;
      out.scrollTop = out.scrollHeight;
    },
  }).then(() => {
    if (closed) return;
    out.textContent += '\n[exit 0]\n';
    toast(tf('app.docker.compose-done', { v1: action }), 'success');
    if (onDone) onDone();
  }).catch((e) => {
    if (closed || (e && e.name === 'AbortError')) return;
    out.textContent += '\n' + (e.message || String(e));
    toast(e.message || String(e), 'danger');
  });

  return dlg;
}

/** 读取 / 编辑 / 保存 compose 文件 */
function editFile(host, project, onDone) {
  const { dir } = projectPaths(project);
  const ta = dom('textarea', { class: 'input mono dk-yaml-editor', rows: '20', spellcheck: 'false' });
  const status = dom('div', { class: 'dk-dim-text', text: t('app.docker.compose-file-loading') });
  let closed = false;
  let loadedPath = '';

  async function load() {
    try {
      const r = await api.readComposeFile(host, dir);
      loadedPath = r.path;
      ta.value = r.content;
      status.textContent = r.path;
    } catch (e) {
      status.textContent = e.message || String(e);
    }
  }

  async function save() {
    try {
      const r = await api.saveComposeFile(host, dir, ta.value);
      status.textContent = tf('app.docker.compose-file-saved', { v1: r.path });
      toast(t('app.docker.compose-file-saved-ok'), 'success');
      if (onDone) onDone();
    } catch (e) {
      status.textContent = e.message || String(e);
      toast(e.message || String(e), 'danger');
    }
  }

  const saveBtn = h('button', { class: 'btn btn-primary btn-sm', text: t('app.docker.compose-file-save'), onClick: save });

  dialog({
    title: tf('app.docker.compose-file-title', { v1: project.Name || '' }),
    cls: 'dk-dialog-xl',
    body: [
      h('div', { class: 'dk-row' }, [
        status,
        h('span', { class: 'qx-grow' }),
        copyButton(() => String(ta.value || ''), { tip: t('app.docker.copy-output') }),
        h('button', { class: 'btn btn-sm btn-ghost', text: t('app.docker.download'), onClick: () => downloadText('docker-compose.yml', String(ta.value || '')) }),
        h('button', { class: 'btn btn-sm btn-ghost', text: t('app.docker.reload'), onClick: load }),
        saveBtn,
      ]),
      h('div', { class: 'dk-yaml-wrap' }, [ta]),
    ],
    onClose: () => { closed = true; },
  });

  load();
}

export function createComposeView(deps) {
  const el = document.createElement('div');
  el.className = 'dk-body';

  const rows = signal([]);
  const loading = signal(false);
  const errorText = signal('');

  let disposed = false;
  const host = () => deps.host();

  async function load() {
    loading.next = true;
    errorText.next = '';
    try {
      const list = await api.listComposeProjects(host());
      if (disposed) return;
      // compose ls 只给出正在运行的项目；顺带补上目录下的静态项目需要用户显式部署
      rows.next(list);
    } catch (e) {
      if (disposed) return;
      errorText.next = e.message || String(e);
      rows.next([]);
    } finally {
      if (!disposed) loading.next = false;
    }
  }

  async function act(project, action) {
    if (action === 'down') {
      const ok = await confirmAction(
        tf('app.docker.compose-down-confirm', { v1: project.Name }),
        t('app.docker.confirm-remove-desc'),
        { okText: t('app.docker.compose-act-down') },
      );
      if (!ok) return;
    }
    runAction(host(), project, action, () => { load(); deps.onChanged?.(); });
  }

  function openDeploy() {
    const dirInput = dom('input', { class: 'input mono', type: 'text', placeholder: '/srv/myapp' });
    const fileInput = dom('input', { class: 'input mono', type: 'text', placeholder: 'docker-compose.yml', value: 'docker-compose.yml' });
    let dlg = null;
    const deployBtn = dom('button', {
      class: 'btn btn-primary btn-sm',
      text: t('app.docker.compose-deploy-run'),
      onClick: async () => {
        const dir = String(dirInput.value || '').trim();
        const file = String(fileInput.value || '').trim();
        if (!dir) { dirInput.focus(); return; }
        deployBtn.disabled = true;
        try {
          await api.composeAction(host(), { dir, file: file ? dir.replace(/\/+$/, '') + '/' + file : '', action: 'up' });
          toast(t('app.docker.compose-up-ok'), 'success');
          dlg.close();
          load();
          deps.onChanged?.();
        } catch (e) {
          toast(e.message || String(e), 'danger');
        } finally {
          deployBtn.disabled = false;
        }
      },
    });
    dlg = dialog({
      title: t('app.docker.compose-deploy-title'),
      cls: 'dk-dialog-lg',
      body: [
        h('label', { class: 'dk-field' }, [h('span', { class: 'dk-field-label', text: t('app.docker.compose-dir') }), dirInput,
          h('span', { class: 'dk-field-hint', text: t('app.docker.compose-dir-hint') })]),
        h('label', { class: 'dk-field' }, [h('span', { class: 'dk-field-label', text: t('app.docker.compose-file') }), fileInput]),
      ],
      actions: [
        h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.cancel'), onClick: () => dlg.close() }),
        deployBtn,
      ],
    });
    setTimeout(() => dirInput.focus(), 60);
  }

  function columns() {
    return [
      { key: 'Name', label: t('app.docker.col-project'), render: (r) => h('span', { class: 'mono', text: r.Name }) },
      {
        key: 'Status',
        label: t('app.docker.col-status'),
        width: '170px',
        render: (r) => badge(
          String(r.Status || '').includes('running') ? t('app.docker.compose-running-state') : t('app.docker.compose-stopped-state'),
          String(r.Status || '').includes('running') ? 'success' : 'default',
        ),
      },
      {
        key: 'ConfigFiles',
        label: t('app.docker.col-config'),
        render: (r) => h('span', { class: 'mono dk-cell-dim dk-ellipsis', title: r.ConfigFiles, text: r.ConfigFiles || '-' }),
      },
      {
        key: 'act',
        label: '',
        width: '340px',
        render: (r) => h('div', { class: 'dk-row-acts' }, [
          h('button', { class: 'btn btn-sm btn-ghost', text: 'up -d', onClick: () => act(r, 'up') }),
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.docker.compose-act-restart'), onClick: () => act(r, 'restart') }),
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.docker.compose-act-pull'), onClick: () => act(r, 'pull') }),
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.docker.compose-file-edit'), onClick: () => editFile(host(), r, () => load()) }),
          h('button', { class: 'btn btn-sm btn-ghost dk-danger', text: t('app.docker.compose-act-down'), onClick: () => act(r, 'down') }),
        ]),
      },
    ];
  }

  const view = createView(el);
  view.update(() => {
    const kids = [];
    const env = deps.env();
    if (env && !env.compose) kids.push(alertBar('warning', t('app.docker.compose-missing'), t('app.docker.compose-missing-tip')));
    if (errorText.value) kids.push(h('div', { class: 'dk-banner-slot' }, [alertBar('error', t('app.docker.load-failed'), errorText.value)]));

    kids.push(card(null, [
      h('div', { class: 'dk-toolbar' }, [
        h('span', { class: 'dk-dim-text', text: tf('app.docker.compose-total', { v1: String(rows.value.length) }) }),
        h('span', { class: 'qx-grow' }),
        h('button', { class: 'btn btn-sm btn-ghost', text: t('app.docker.refresh'), onClick: load }),
        h('button', { class: 'btn btn-sm btn-primary', text: t('app.docker.compose-deploy'), onClick: openDeploy }),
      ]),
      loading.value && !rows.value.length
        ? h('div', { class: 'dk-loading' }, [spinner(t('app.docker.loading'))])
        : table(columns(), rows.value, { empty: t('app.docker.compose-empty'), rowKey: (r) => r.Name }),
    ], { fill: true }));

    return h('div', { class: 'dk-list-wrap' }, kids);
  });

  return {
    el,
    refresh: load,
    onShow: () => { if (!rows.value.length) load(); },
    statusBits: () => [{ text: tf('app.docker.compose-total', { v1: String(rows.value.length) }) }],
    dispose: () => { disposed = true; view.unmount(); },
  };
}
