/**
 * workloads.js —— Deployment / StatefulSet / DaemonSet 统一视图
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, confirmAction } from '/assets/js/core/ui.js';
import {
  card, table, badge, searchBox, spinner, alertBar, progressBar,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import { readyRatio, age, workloadTone } from './format.js';
import { openDescribeDialog, openScaleDialog, openYamlDialog, openPodLogsDialog } from './dialogs.js';

export function createWorkloadsView(deps) {
  const el = document.createElement('div');
  el.className = 'k8s-body';

  const rows = signal([]);
  const namespaces = signal([]);
  const loading = signal(false);
  const errorText = signal('');
  const query = signal('');
  const ns = signal('*');
  const kindFilter = signal('all');
  const busy = signal('');

  let disposed = false;
  const host = () => deps.host();

  async function loadNamespaces() {
    try {
      const list = await api.listNamespaces(host());
      if (!disposed) namespaces.next(list);
    } catch (e) { /* 忽略 */ }
  }

  async function load() {
    loading.next = true;
    errorText.next = '';
    try {
      const [deploys, others] = await Promise.all([
        api.listDeployments(host(), { namespace: ns.value }),
        api.listWorkloadOthers(host(), { namespace: ns.value }),
      ]);
      if (disposed) return;
      rows.next([...deploys, ...others]);
    } catch (e) {
      if (disposed) return;
      errorText.next = e.message || String(e);
      rows.next([]);
    } finally {
      if (!disposed) loading.next = false;
    }
  }

  function filtered() {
    const q = query.value.toLowerCase().trim();
    const k = kindFilter.value;
    return rows.value.filter((w) => {
      if (k !== 'all' && w.kind !== k) return false;
      if (!q) return true;
      return [w.name, w.namespace, w.image].join(' ').toLowerCase().includes(q);
    });
  }

  async function restart(w) {
    busy.next(w.name);
    try {
      await api.rolloutRestart(host(), w.kind, w.name, w.namespace);
      toast(tf('app.k8s.restart-ok', { v1: w.name }), 'success');
      await load();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      busy.next('');
    }
  }

  async function remove(w) {
    const ok = await confirmAction(tf('app.k8s.confirm-remove', { v1: w.name }), t('app.k8s.confirm-remove-desc'), {
      okText: t('app.k8s.act-remove'),
    });
    if (!ok) return;
    try {
      await api.removeResource(host(), w.kind, w.name, w.namespace);
      toast(t('app.k8s.removed'), 'success');
      await load();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  /** 打开该工作负载下最合适的一个 Pod 日志 */
  async function logs(w) {
    try {
      const pods = await api.listPods(host(), { namespace: w.namespace });
      const hit = pods.find((p) => String(p.name).startsWith(w.name + '-'))
        || pods.find((p) => (p.owners || []).includes(w.name));
      if (!hit) { toast(t('app.k8s.no-pods-for-workload'), 'warning'); return; }
      openPodLogsDialog(host(), hit);
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  function columns() {
    return [
      {
        key: 'kind',
        label: t('app.k8s.col-kind'),
        width: '112px',
        render: (w) => badge(w.kind, 'default'),
      },
      {
        key: 'name',
        label: t('app.k8s.col-name'),
        render: (w) => h('div', { class: 'k8s-cell-name' }, [
          h('span', { class: 'mono', text: w.name }),
          h('span', { class: 'k8s-cell-sub', text: w.image || '', title: w.image || '' }),
        ]),
      },
      { key: 'namespace', label: t('app.k8s.col-namespace'), width: '120px', render: (w) => h('span', { class: 'k8s-dim mono', text: w.namespace }) },
      {
        key: 'ready',
        label: t('app.k8s.col-ready'),
        width: '130px',
        render: (w) => {
          const r = readyRatio(w.ratio);
          const tone = workloadTone('', w.ratio);
          return h('div', { class: 'k8s-ready-cell' }, [
            h('span', { class: 'mono ' + (r.ok ? 'k8s-ok' : (r.ready === 0 ? 'k8s-bad' : 'k8s-warn')), text: w.ratio }),
            progressBar(r.pct, { kind: tone === 'error' ? 'danger' : (tone === 'warn' ? 'warn' : '') }),
          ]);
        },
      },
      { key: 'age', label: t('app.k8s.col-age'), width: '64px', render: (w) => h('span', { class: 'k8s-dim', text: age(w.created) }) },
      {
        key: 'act',
        label: '',
        width: '300px',
        render: (w) => h('div', { class: 'k8s-row-acts' }, [
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.act-logs'), onClick: () => logs(w) }),
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.act-scale'), onClick: () => openScaleDialog(host(), w, () => load()) }),
          h('button', {
            class: 'btn btn-sm btn-ghost',
            text: t('app.k8s.act-restart'),
            disabled: busy.value === w.name,
            onClick: () => restart(w),
          }),
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.act-yaml'), onClick: () => openYamlDialog(host(), { kind: w.kind, name: w.name, namespace: w.namespace, onDone: () => load() }) }),
          h('button', { class: 'btn btn-sm btn-ghost k8s-danger', text: t('app.k8s.act-remove'), onClick: () => remove(w) }),
        ]),
      },
    ];
  }

  const view = createView(el);
  view.update(() => {
    const list = filtered();
    const degraded = rows.value.filter((w) => !readyRatio(w.ratio).ok).length;

    const toolbar = h('div', { class: 'k8s-toolbar' }, [
      searchBox(t('app.k8s.search-workloads'), (v) => { query.next = v; }, { value: query.value }),
      h('select', {
        class: 'select k8s-mini k8s-ns-select',
        onChange: (e) => { ns.next = e.target.value; load(); },
      }, [
        h('option', { value: '*', text: t('app.k8s.ns-all') }),
        ...namespaces.value.map((n) => h('option', { value: n.name, text: n.name, selected: ns.value === n.name })),
      ]),
      h('div', { class: 'k8s-chips' }, [
        { id: 'all', label: t('app.k8s.kind-all') },
        { id: 'Deployment', label: 'Deployment' },
        { id: 'StatefulSet', label: 'StatefulSet' },
        { id: 'DaemonSet', label: 'DaemonSet' },
      ].map((it) => h('button', {
        key: it.id,
        class: 'k8s-chip' + (kindFilter.value === it.id ? ' active' : ''),
        type: 'button',
        text: it.label,
        onClick: () => { kindFilter.next = it.id; },
      }))),
      h('span', { class: 'qx-grow' }),
      degraded ? badge(tf('app.k8s.degraded-n', { v1: String(degraded) }), 'warn') : null,
      h('button', { class: 'btn btn-sm btn-outline', text: t('app.k8s.refresh'), onClick: () => { loadNamespaces(); load(); } }),
    ]);

    const kids = [];
    if (errorText.value) kids.push(h('div', { class: 'k8s-banner-slot' }, [alertBar('error', t('app.k8s.load-failed'), errorText.value)]));
    kids.push(card(null, [
      toolbar,
      loading.value && !rows.value.length
        ? h('div', { class: 'k8s-loading' }, [spinner(t('app.k8s.loading'))])
        : table(columns(), list, {
          empty: t('app.k8s.no-workloads'),
          rowKey: (w) => w.kind + '/' + w.namespace + '/' + w.name,
          onRowClick: (w) => openDescribeDialog(host(), w.kind, w.name, w.namespace),
        }),
    ], { fill: true }));
    return h('div', { class: 'k8s-list-wrap' }, kids);
  });

  return {
    el,
    refresh: () => { loadNamespaces(); return load(); },
    onShow: () => { if (!namespaces.value.length) loadNamespaces(); if (!rows.value.length) load(); },
    statusBits: () => [{ text: tf('app.k8s.status-workloads', { v1: String(rows.value.length) }) }],
    dispose: () => { disposed = true; view.unmount(); },
  };
}
