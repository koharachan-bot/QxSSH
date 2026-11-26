/**
 * pods.js —— Pod 列表（专业模式）
 * 表格 + 命名空间过滤 + 日志/describe/exec/删除；彩色日志走 dialogs.js。
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, confirmAction } from '/assets/js/core/ui.js';
import {
  card, table, statusDot, badge, searchBox, spinner, alertBar,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import { age, podTone, readyRatio } from './format.js';
import {
  openPodLogsDialog, openDescribeDialog, openExecDialog, openYamlDialog,
} from './dialogs.js';

export function createPodsView(deps) {
  const el = document.createElement('div');
  el.className = 'k8s-body';

  const rows = signal([]);
  const namespaces = signal([]);
  const loading = signal(false);
  const errorText = signal('');
  const query = signal('');
  const ns = signal('*');
  const stateFilter = signal('all');
  const autoRate = signal(0);
  const showNs = signal(true);

  let timer = null;
  let disposed = false;
  const host = () => deps.host();

  async function loadNamespaces() {
    try {
      const list = await api.listNamespaces(host());
      if (!disposed) namespaces.next(list);
    } catch (e) { /* 命名空间拿不到时仍可查询 */ }
  }

  async function load(silent) {
    if (!silent) loading.next = true;
    errorText.next = '';
    try {
      const list = await api.listPods(host(), { namespace: ns.value });
      if (disposed) return;
      rows.next(list);
    } catch (e) {
      if (disposed) return;
      errorText.next = e.message || String(e);
      rows.next([]);
    } finally {
      if (!disposed) loading.next = false;
    }
  }

  function restartTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    const rate = autoRate.value;
    if (rate > 0) timer = setInterval(() => load(true), rate * 1000);
  }

  function filtered() {
    const q = query.value.toLowerCase().trim();
    const f = stateFilter.value;
    return rows.value.filter((p) => {
      const ok = String(p.phase) === 'Running';
      if (f === 'running' && !ok) return false;
      if (f === 'unhealthy' && ok) return false;
      if (f === 'restarting' && Number(p.restarts || 0) < 1) return false;
      if (!q) return true;
      return [p.name, p.namespace, p.node, p.image, p.ip].join(' ').toLowerCase().includes(q);
    });
  }

  async function removePod(p) {
    const ok = await confirmAction(
      tf('app.k8s.confirm-remove', { v1: p.name }),
      t('app.k8s.confirm-remove-desc'),
      { okText: t('app.k8s.act-remove') },
    );
    if (!ok) return;
    try {
      await api.removeResource(host(), 'pod', p.name, p.namespace);
      toast(t('app.k8s.removed'), 'success');
      load(true);
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  function columns() {
    const cols = [
      {
        key: 'name',
        label: t('app.k8s.col-name'),
        render: (p) => h('div', { class: 'k8s-cell-name' }, [
          h('span', { class: 'mono', text: p.name }),
          h('span', { class: 'k8s-cell-sub', text: p.image || '' , title: p.image || '' }),
        ]),
      },
      {
        key: 'ready',
        label: t('app.k8s.col-ready'),
        width: '74px',
        render: (p) => {
          const r = readyRatio(p.ready);
          return h('span', { class: 'mono ' + (r.ok ? 'k8s-ok' : 'k8s-bad'), text: p.ready || '-' });
        },
      },
      {
        key: 'phase',
        label: t('app.k8s.col-status'),
        width: '110px',
        render: (p) => {
          const tone = podTone(p.phase);
          return h('span', { class: 'k8s-cell-state' }, [
            statusDot(tone === 'ok' ? 'on' : (tone === 'error' ? 'off' : 'busy'), p.phase),
            h('span', { text: String(p.phase || '') }),
          ]);
        },
      },
      {
        key: 'restarts',
        label: t('app.k8s.col-restarts'),
        width: '70px',
        render: (p) => {
          const n = Number(p.restarts || 0);
          return n > 0 ? badge(String(n), n >= 5 ? 'danger' : 'warn') : h('span', { class: 'k8s-dim', text: '0' });
        },
      },
    ];
    if (showNs.value) {
      cols.push({ key: 'namespace', label: t('app.k8s.col-namespace'), width: '120px', render: (p) => h('span', { class: 'k8s-dim mono', text: p.namespace }) });
    }
    cols.push(
      { key: 'node', label: t('app.k8s.col-node'), width: '130px', render: (p) => h('span', { class: 'k8s-dim mono', text: p.node || '-' }) },
      { key: 'ip', label: t('app.k8s.col-ip'), width: '112px', render: (p) => h('span', { class: 'k8s-dim mono', text: p.ip || '-' }) },
      { key: 'age', label: t('app.k8s.col-age'), width: '64px', render: (p) => h('span', { class: 'k8s-dim', text: age(p.started) }) },
      {
        key: 'act',
        label: '',
        width: '220px',
        render: (p) => h('div', { class: 'k8s-row-acts' }, [
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.act-logs'), onClick: () => openPodLogsDialog(host(), p) }),
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.act-exec'), onClick: () => openExecDialog(host(), p) }),
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.act-yaml'), onClick: () => openYamlDialog(host(), { kind: 'pod', name: p.name, namespace: p.namespace, onDone: () => load(true) }) }),
          h('button', { class: 'btn btn-sm btn-ghost dk-danger k8s-danger', text: t('app.k8s.act-remove'), onClick: () => removePod(p) }),
        ]),
      },
    );
    return cols;
  }

  const view = createView(el);
  view.update(() => {
    const list = filtered();
    const running = rows.value.filter((p) => p.phase === 'Running').length;

    const nsSelect = h('select', {
      class: 'select k8s-mini k8s-ns-select',
      onChange: (e) => { ns.next = e.target.value; load(); },
    }, [
      h('option', { value: '*', text: t('app.k8s.ns-all') }),
      ...namespaces.value.map((n) => h('option', { value: n.name, text: n.name, selected: ns.value === n.name })),
    ]);

    const toolbar = h('div', { class: 'k8s-toolbar' }, [
      searchBox(t('app.k8s.search-pods'), (v) => { query.next = v; }, { value: query.value }),
      nsSelect,
      h('div', { class: 'k8s-chips' }, [
        { id: 'all', label: tf('app.k8s.filter-all', { v1: String(rows.value.length) }) },
        { id: 'running', label: tf('app.k8s.filter-running', { v1: String(running) }) },
        { id: 'unhealthy', label: t('app.k8s.filter-unhealthy') },
        { id: 'restarting', label: t('app.k8s.filter-restarting') },
      ].map((it) => h('button', {
        key: it.id,
        class: 'k8s-chip' + (stateFilter.value === it.id ? ' active' : ''),
        type: 'button',
        text: it.label,
        onClick: () => { stateFilter.next = it.id; },
      }))),
      h('span', { class: 'qx-grow' }),
      h('select', {
        class: 'select k8s-mini',
        onChange: (e) => { autoRate.next = Number(e.target.value); restartTimer(); },
      }, [
        h('option', { value: '0', text: t('app.k8s.autorefresh-off') }),
        h('option', { value: '5', text: '5s' }),
        h('option', { value: '10', text: '10s' }),
        h('option', { value: '30', text: '30s' }),
      ]),
      h('button', { class: 'btn btn-sm btn-outline', text: t('app.k8s.refresh'), onClick: () => { loadNamespaces(); load(); } }),
    ]);

    const kids = [];
    if (errorText.value) kids.push(h('div', { class: 'k8s-banner-slot' }, [alertBar('error', t('app.k8s.load-failed'), errorText.value)]));
    kids.push(card(null, [
      toolbar,
      loading.value && !rows.value.length
        ? h('div', { class: 'k8s-loading' }, [spinner(t('app.k8s.loading'))])
        : table(columns(), list, {
          empty: t('app.k8s.no-pods'),
          rowKey: (p) => p.namespace + '/' + p.name,
          onRowClick: (p) => openDescribeDialog(host(), 'pod', p.name, p.namespace),
        }),
    ], { fill: true }));

    return h('div', { class: 'k8s-list-wrap' }, kids);
  });

  return {
    el,
    refresh: () => { loadNamespaces(); return load(); },
    onShow: () => {
      if (!namespaces.value.length) loadNamespaces();
      if (!rows.value.length) load();
    },
    statusBits: () => [{ text: tf('app.k8s.status-pods', { v1: String(rows.value.length) }) }],
    dispose: () => { disposed = true; if (timer) clearInterval(timer); view.unmount(); },
  };
}
