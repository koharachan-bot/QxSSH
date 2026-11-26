/**
 * events.js —— 事件流
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { card, badge, searchBox, spinner, alertBar, emptyState } from '/assets/js/core/components.js';

import * as api from './api.js';
import { age } from './format.js';
import { openDescribeDialog } from './dialogs.js';

export function createEventsView(deps) {
  const el = document.createElement('div');
  el.className = 'k8s-body';

  const rows = signal([]);
  const namespaces = signal([]);
  const loading = signal(false);
  const errorText = signal('');
  const query = signal('');
  const typeFilter = signal('all');
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
      const list = await api.listEvents(host(), { namespace: ns.value, limit: 400 });
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

  function filtered() {
    const q = query.value.toLowerCase().trim();
    const f = typeFilter.value;
    return rows.value.filter((e) => {
      if (f === 'warning' && e.type !== 'Warning') return false;
      if (f === 'normal' && e.type === 'Warning') return false;
      if (!q) return true;
      return [e.reason, e.kind, e.name, e.namespace, e.message].join(' ').toLowerCase().includes(q);
    });
  }

  const view = createView(el);
  view.update(() => {
    const list = filtered();
    const warns = rows.value.filter((e) => e.type === 'Warning').length;

    const toolbar = h('div', { class: 'k8s-toolbar' }, [
      searchBox(t('app.k8s.search-events'), (v) => { query.next = v; }, { value: query.value }),
      h('select', {
        class: 'select k8s-mini k8s-ns-select',
        onChange: (e) => { ns.next = e.target.value; load(); },
      }, [
        h('option', { value: '*', text: t('app.k8s.ns-all') }),
        ...namespaces.value.map((n) => h('option', { value: n.name, text: n.name, selected: ns.value === n.name })),
      ]),
      h('div', { class: 'k8s-chips' }, [
        { id: 'all', label: tf('app.k8s.filter-all', { v1: String(rows.value.length) }) },
        { id: 'warning', label: tf('app.k8s.filter-warning', { v1: String(warns) }) },
        { id: 'normal', label: t('app.k8s.filter-normal') },
      ].map((it) => h('button', {
        key: it.id,
        class: 'k8s-chip' + (typeFilter.value === it.id ? ' active' : ''),
        type: 'button',
        text: it.label,
        onClick: () => { typeFilter.next = it.id; },
      }))),
      h('span', { class: 'qx-grow' }),
      h('button', { class: 'btn btn-sm btn-outline', text: t('app.k8s.refresh'), onClick: () => { loadNamespaces(); load(); } }),
    ]);

    const listNode = !list.length
      ? emptyState(t('app.k8s.no-events'))
      : h('div', { class: 'k8s-event-list' }, list.map((e, i) => h('div', {
        key: i,
        class: 'k8s-event-row' + (e.type === 'Warning' ? ' warn' : ''),
        onClick: () => openDescribeDialog(host(), e.kind || 'pod', e.name, e.namespace),
      }, [
        h('span', { class: 'k8s-event-age mono', text: age(e.time) }),
        badge(e.type === 'Warning' ? t('app.k8s.event-warning') : t('app.k8s.event-normal'), e.type === 'Warning' ? 'warn' : 'default'),
        h('span', { class: 'k8s-event-reason', text: e.reason || '' }),
        h('span', { class: 'k8s-event-obj mono', text: (e.kind || '') + '/' + (e.name || '') }),
        e.namespace ? h('span', { class: 'k8s-dim mono', text: e.namespace }) : null,
        e.count > 1 ? badge('x' + e.count, 'default') : null,
        h('span', { class: 'k8s-event-msg', text: e.message || '', title: e.message || '' }),
      ])));

    const kids = [];
    if (errorText.value) kids.push(h('div', { class: 'k8s-banner-slot' }, [alertBar('error', t('app.k8s.load-failed'), errorText.value)]));
    kids.push(card(null, [
      toolbar,
      loading.value && !rows.value.length ? h('div', { class: 'k8s-loading' }, [spinner(t('app.k8s.loading'))]) : listNode,
    ], { fill: true }));

    return h('div', { class: 'k8s-list-wrap' }, kids);
  });

  return {
    el,
    refresh: () => { loadNamespaces(); return load(); },
    onShow: () => { if (!namespaces.value.length) loadNamespaces(); if (!rows.value.length) load(); },
    statusBits: () => [{ text: tf('app.k8s.status-events', { v1: String(rows.value.length) }) }],
    dispose: () => { disposed = true; view.unmount(); },
  };
}
