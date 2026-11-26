/**
 * discover.js —— 服务与入口（Service / Ingress）
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, confirmAction } from '/assets/js/core/ui.js';
import { card, table, badge, spinner, alertBar } from '/assets/js/core/components.js';

import * as api from './api.js';
import { age } from './format.js';
import { openDescribeDialog, openYamlDialog } from './dialogs.js';

export function createDiscoverView(deps) {
  const el = document.createElement('div');
  el.className = 'k8s-body';

  const services = signal([]);
  const ingresses = signal([]);
  const namespaces = signal([]);
  const loading = signal(false);
  const errorText = signal('');
  const ns = signal('*');

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
      const [svc, ing] = await Promise.all([
        api.listServices(host(), { namespace: ns.value }),
        api.listIngresses(host(), { namespace: ns.value }),
      ]);
      if (disposed) return;
      services.next(svc);
      ingresses.next(ing);
    } catch (e) {
      if (disposed) return;
      errorText.next = e.message || String(e);
      services.next([]);
      ingresses.next([]);
    } finally {
      if (!disposed) loading.next = false;
    }
  }

  async function removeSvc(s) {
    const ok = await confirmAction(tf('app.k8s.confirm-remove', { v1: s.name }), t('app.k8s.confirm-remove-desc'), { okText: t('app.k8s.act-remove') });
    if (!ok) return;
    try {
      await api.removeResource(host(), 'svc', s.name, s.namespace);
      toast(t('app.k8s.removed'), 'success');
      load();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  function svcColumns() {
    return [
      { key: 'name', label: t('app.k8s.col-name'), render: (s) => h('span', { class: 'mono', text: s.name }) },
      { key: 'namespace', label: t('app.k8s.col-namespace'), width: '110px', render: (s) => h('span', { class: 'k8s-dim mono', text: s.namespace }) },
      {
        key: 'type',
        label: t('app.k8s.col-type'),
        width: '112px',
        render: (s) => badge(s.type || 'ClusterIP', s.type === 'LoadBalancer' ? 'success' : 'default'),
      },
      { key: 'clusterIP', label: t('app.k8s.col-clusterip'), width: '128px', render: (s) => h('span', { class: 'mono k8s-dim', text: s.clusterIP || '-' }) },
      {
        key: 'port',
        label: t('app.k8s.col-port'),
        width: '150px',
        render: (s) => h('span', { class: 'mono', text: (s.port || '-') + (s.nodePort ? ' → ' + s.nodePort : '') + (s.protocol ? '/' + s.protocol : '') }),
      },
      { key: 'age', label: t('app.k8s.col-age'), width: '62px', render: (s) => h('span', { class: 'k8s-dim', text: age(s.created) }) },
      {
        key: 'act',
        label: '',
        width: '180px',
        render: (s) => h('div', { class: 'k8s-row-acts' }, [
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.act-describe'), onClick: () => openDescribeDialog(host(), 'svc', s.name, s.namespace) }),
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.act-yaml'), onClick: () => openYamlDialog(host(), { kind: 'svc', name: s.name, namespace: s.namespace, onDone: () => load() }) }),
          h('button', { class: 'btn btn-sm btn-ghost k8s-danger', text: t('app.k8s.act-remove'), onClick: () => removeSvc(s) }),
        ]),
      },
    ];
  }

  function ingColumns() {
    return [
      { key: 'name', label: t('app.k8s.col-name'), render: (s) => h('span', { class: 'mono', text: s.name }) },
      { key: 'namespace', label: t('app.k8s.col-namespace'), width: '110px', render: (s) => h('span', { class: 'k8s-dim mono', text: s.namespace }) },
      { key: 'host', label: t('app.k8s.col-host'), render: (s) => h('span', { class: 'mono', text: s.host || '-' }) },
      { key: 'className', label: t('app.k8s.col-class'), width: '130px', render: (s) => h('span', { class: 'k8s-dim', text: s.className || '-' }) },
      { key: 'address', label: t('app.k8s.col-address'), width: '140px', render: (s) => h('span', { class: 'mono k8s-dim', text: s.address || '-' }) },
      { key: 'age', label: t('app.k8s.col-age'), width: '62px', render: (s) => h('span', { class: 'k8s-dim', text: age(s.created) }) },
      {
        key: 'act',
        label: '',
        width: '150px',
        render: (s) => h('div', { class: 'k8s-row-acts' }, [
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.act-describe'), onClick: () => openDescribeDialog(host(), 'ing', s.name, s.namespace) }),
          h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.act-yaml'), onClick: () => openYamlDialog(host(), { kind: 'ing', name: s.name, namespace: s.namespace, onDone: () => load() }) }),
        ]),
      },
    ];
  }

  const view = createView(el);
  view.update(() => {
    const kids = [];
    if (errorText.value) kids.push(h('div', { class: 'k8s-banner-slot' }, [alertBar('error', t('app.k8s.load-failed'), errorText.value)]));

    const bar = h('div', { class: 'k8s-toolbar' }, [
      h('select', {
        class: 'select k8s-mini k8s-ns-select',
        onChange: (e) => { ns.next = e.target.value; load(); },
      }, [
        h('option', { value: '*', text: t('app.k8s.ns-all') }),
        ...namespaces.value.map((n) => h('option', { value: n.name, text: n.name, selected: ns.value === n.name })),
      ]),
      h('span', { class: 'qx-grow' }),
      h('button', { class: 'btn btn-sm btn-outline', text: t('app.k8s.refresh'), onClick: () => { loadNamespaces(); load(); } }),
    ]);

    kids.push(card(null, [bar], { fill: false }));

    if (loading.value && !services.value.length && !ingresses.value.length) {
      kids.push(h('div', { class: 'k8s-loading' }, [spinner(t('app.k8s.loading'))]));
    } else {
      kids.push(card(tf('app.k8s.svc-title', { v1: String(services.value.length) }),
        table(svcColumns(), services.value, { empty: t('app.k8s.no-services'), rowKey: (s) => s.namespace + '/' + s.name })));
      kids.push(card(tf('app.k8s.ing-title', { v1: String(ingresses.value.length) }),
        table(ingColumns(), ingresses.value, { empty: t('app.k8s.no-ingresses'), rowKey: (s) => s.namespace + '/' + s.name })));
    }

    return h('div', { class: 'k8s-list-wrap' }, kids);
  });

  return {
    el,
    refresh: () => { loadNamespaces(); return load(); },
    onShow: () => { if (!namespaces.value.length) loadNamespaces(); if (!services.value.length && !ingresses.value.length) load(); },
    statusBits: () => [
      { text: tf('app.k8s.status-svc', { v1: String(services.value.length) }) },
      { text: tf('app.k8s.status-ing', { v1: String(ingresses.value.length) }) },
    ],
    dispose: () => { disposed = true; view.unmount(); },
  };
}
