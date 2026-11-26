/**
 * nodes.js —— 节点视图（容量 + 实时用量）
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast } from '/assets/js/core/ui.js';
import { card, table, statusDot, badge, spinner, alertBar, progressBar } from '/assets/js/core/components.js';

import * as api from './api.js';
import { age, parseCpu, parseMem, formatCpu, formatBytes } from './format.js';
import { openDescribeDialog, openYamlDialog } from './dialogs.js';

export function createNodesView(deps) {
  const el = document.createElement('div');
  el.className = 'k8s-body';

  const rows = signal([]);
  const metrics = signal(null);
  const loading = signal(false);
  const errorText = signal('');
  const busy = signal('');

  let disposed = false;
  const host = () => deps.host();

  async function load() {
    loading.next = true;
    errorText.next = '';
    try {
      const list = await api.listNodes(host());
      if (disposed) return;
      rows.next(list);
      const m = await api.topNodes(host());
      if (!disposed) metrics.next(m);
    } catch (e) {
      if (disposed) return;
      errorText.next = e.message || String(e);
      rows.next([]);
    } finally {
      if (!disposed) loading.next = false;
    }
  }

  async function loadMetrics() {
    busy.next('m');
    try {
      const m = await api.topNodes(host());
      metrics.next(m);
      if (!m.available) toast(t('app.k8s.metrics-unavailable'), 'warning');
    } finally {
      busy.next('');
    }
  }

  function metricsMap() {
    const map = {};
    const m = metrics.value;
    if (m && m.available) for (const r of m.rows) map[r.name] = r;
    return map;
  }

  function columns() {
    const mMap = metricsMap();
    return [
      {
        key: 'name',
        label: t('app.k8s.col-node'),
        render: (n) => {
          const mr = mMap[n.name];
          return h('div', { class: 'k8s-cell-name' }, [
            h('span', { class: 'mono', text: n.name }),
            h('span', { class: 'k8s-cell-sub', text: (n.os || '') + (mr ? ' · ' + (mr.cpu || '') + ' / ' + (mr.mem || '') : '') }),
          ]);
        },
      },
      {
        key: 'ready',
        label: t('app.k8s.col-status'),
        width: '110px',
        render: (n) => h('span', { class: 'k8s-cell-state' }, [
          statusDot(n.ready ? 'on' : 'off', n.readyRaw || ''),
          h('span', { text: n.ready ? t('app.k8s.node-ready') : t('app.k8s.node-notready') }),
        ]),
      },
      { key: 'version', label: t('app.k8s.col-version'), width: '120px', render: (n) => h('span', { class: 'mono k8s-dim', text: n.version || '-' }) },
      {
        key: 'cpu',
        label: t('app.k8s.col-cpu'),
        width: '140px',
        render: (n) => {
          const mr = mMap[n.name];
          const pct = mr ? parseFloat(String(mr.cpuPct || '0')) : null;
          return h('div', { class: 'k8s-ready-cell' }, [
            h('span', { class: 'mono', text: (n.cpu || '-') + (mr ? ' / ' + mr.cpu : '') }),
            pct != null ? progressBar(pct, { kind: pct > 85 ? 'danger' : (pct > 65 ? 'warn' : '') }) : null,
          ]);
        },
      },
      {
        key: 'mem',
        label: t('app.k8s.col-mem'),
        width: '150px',
        render: (n) => {
          const mr = mMap[n.name];
          const pct = mr ? parseFloat(String(mr.memPct || '0')) : null;
          return h('div', { class: 'k8s-ready-cell' }, [
            h('span', { class: 'mono', text: (n.mem ? formatBytes(parseMem(n.mem)) : '-') + (mr ? ' / ' + mr.mem : '') }),
            pct != null ? progressBar(pct, { kind: pct > 85 ? 'danger' : (pct > 65 ? 'warn' : '') }) : null,
          ]);
        },
      },
      { key: 'pods', label: t('app.k8s.col-podslots'), width: '90px', render: (n) => h('span', { class: 'mono k8s-dim', text: n.pods || '-' }) },
      { key: 'age', label: t('app.k8s.col-age'), width: '62px', render: (n) => h('span', { class: 'k8s-dim', text: age(n.created) }) },
      {
        key: 'act',
        label: '',
        width: '170px',
        render: (n) => h('div', { class: 'k8s-row-acts' }, [
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.act-describe'), onClick: () => openDescribeDialog(host(), 'node', n.name, '') }),
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.act-yaml'), onClick: () => openYamlDialog(host(), { kind: 'node', name: n.name, namespace: '', onDone: () => load() }) }),
        ]),
      },
    ];
  }

  const view = createView(el);
  view.update(() => {
    const m = metrics.value;
    const kids = [];
    if (errorText.value) kids.push(h('div', { class: 'k8s-banner-slot' }, [alertBar('error', t('app.k8s.load-failed'), errorText.value)]));
    if (m && !m.available) kids.push(h('div', { class: 'k8s-banner-slot' }, [alertBar('warning', t('app.k8s.metrics-unavailable'), m.error || '')]));

    kids.push(card(null, [
      h('div', { class: 'k8s-toolbar' }, [
        h('span', { class: 'k8s-dim', text: tf('app.k8s.nodes-total', { v1: String(rows.value.length) }) }),
        h('span', { class: 'qx-grow' }),
        h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.metrics-refresh'), disabled: busy.value === 'm', onClick: loadMetrics }),
        h('button', { class: 'btn btn-sm btn-outline', text: t('app.k8s.refresh'), onClick: load }),
      ]),
      loading.value && !rows.value.length
        ? h('div', { class: 'k8s-loading' }, [spinner(t('app.k8s.loading'))])
        : table(columns(), rows.value, { empty: t('app.k8s.no-nodes'), rowKey: (n) => n.name }),
    ], { fill: true }));

    return h('div', { class: 'k8s-list-wrap' }, kids);
  });

  return {
    el,
    refresh: load,
    onShow: () => { if (!rows.value.length) load(); },
    statusBits: () => [{ text: tf('app.k8s.status-nodes', { v1: String(rows.value.length) }) }],
    dispose: () => { disposed = true; view.unmount(); },
  };
}
