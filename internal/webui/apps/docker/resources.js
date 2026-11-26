/**
 * resources.js —— 网络与存储卷
 * 两块并排：网络看驱动/范围与容器连接，卷看挂载点与占用；都支持新建与删除。
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, confirmAction } from '/assets/js/core/ui.js';
import {
  card, table, badge, spinner, alertBar, promptDialog,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import { shortId } from './format.js';

export function createResourcesView(deps) {
  const el = document.createElement('div');
  el.className = 'dk-body';

  const networks = signal([]);
  const volumes = signal([]);
  const loading = signal(false);
  const errorText = signal('');
  let disposed = false;
  const host = () => deps.host();

  async function load() {
    loading.next = true;
    errorText.next = '';
    try {
      const [nets, vols] = await Promise.all([api.listNetworks(host()), api.listVolumes(host())]);
      if (disposed) return;
      networks.next(nets);
      volumes.next(vols);
    } catch (e) {
      if (disposed) return;
      errorText.next = e.message || String(e);
    } finally {
      if (!disposed) loading.next = false;
    }
  }

  async function newNetwork() {
    const name = await promptDialog({ title: t('app.docker.network-new'), desc: t('app.docker.network-new-desc'), placeholder: 'app-net' });
    if (!name) return;
    try {
      await api.createNetwork(host(), name, { driver: 'bridge' });
      toast(t('app.docker.network-created'), 'success');
      load();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  async function newVolume() {
    const name = await promptDialog({ title: t('app.docker.volume-new'), desc: t('app.docker.volume-new-desc'), placeholder: 'app-data' });
    if (!name) return;
    try {
      await api.createVolume(host(), name);
      toast(t('app.docker.volume-created'), 'success');
      load();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  async function removeNetwork(row) {
    const ok = await confirmAction(tf('app.docker.confirm-remove-network', { v1: row.Name }), t('app.docker.confirm-remove-desc'), { okText: t('app.docker.act-remove') });
    if (!ok) return;
    try {
      await api.removeNetwork(host(), row.ID || row.Name);
      toast(t('app.docker.network-removed'), 'success');
      load();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  async function removeVolume(row) {
    const ok = await confirmAction(tf('app.docker.confirm-remove-volume', { v1: row.Name }), t('app.docker.confirm-remove-desc'), { okText: t('app.docker.act-remove') });
    if (!ok) return;
    try {
      await api.removeVolume(host(), row.Name);
      toast(t('app.docker.volume-removed'), 'success');
      load();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  function netColumns() {
    return [
      { key: 'Name', label: t('app.docker.col-name'), render: (r) => h('span', { class: 'mono', text: r.Name }) },
      { key: 'Driver', label: t('app.docker.col-driver'), width: '100px', render: (r) => badge(r.Driver || '-', 'default') },
      { key: 'Scope', label: t('app.docker.col-scope'), width: '90px', render: (r) => h('span', { class: 'dk-cell-dim', text: r.Scope || 'local' }) },
      { key: 'ID', label: 'ID', width: '100px', render: (r) => h('span', { class: 'mono dk-cell-dim', text: shortId(r.ID, 10) }) },
      {
        key: 'act',
        label: '',
        width: '80px',
        render: (r) => (['bridge', 'host', 'none'].includes(r.Name) ? h('span', { class: 'dk-cell-dim', text: '-' }) : h('button', {
          class: 'btn btn-sm btn-ghost dk-danger',
          text: t('app.docker.act-remove'),
          onClick: () => removeNetwork(r),
        })),
      },
    ];
  }

  function volColumns() {
    return [
      { key: 'Name', label: t('app.docker.col-name'), render: (r) => h('span', { class: 'mono', text: r.Name }) },
      { key: 'Driver', label: t('app.docker.col-driver'), width: '100px', render: (r) => badge(r.Driver || '-', 'default') },
      { key: 'Mountpoint', label: t('app.docker.col-mountpoint'), render: (r) => h('span', { class: 'mono dk-cell-dim dk-ellipsis', title: r.Mountpoint, text: r.Mountpoint || '-' }) },
      {
        key: 'act',
        label: '',
        width: '80px',
        render: (r) => h('button', {
          class: 'btn btn-sm btn-ghost dk-danger',
          text: t('app.docker.act-remove'),
          onClick: () => removeVolume(r),
        }),
      },
    ];
  }

  const view = createView(el);
  view.update(() => {
    const kids = [];
    if (errorText.value) kids.push(h('div', { class: 'dk-banner-slot' }, [alertBar('error', t('app.docker.load-failed'), errorText.value)]));

    const netCard = card(t('app.docker.tab-networks'), [
      h('div', { class: 'dk-toolbar' }, [
        h('span', { class: 'dk-dim-text', text: tf('app.docker.nets-total', { v1: String(networks.value.length) }) }),
        h('span', { class: 'qx-grow' }),
        h('button', { class: 'btn btn-sm btn-ghost', text: t('app.docker.refresh'), onClick: load }),
        h('button', { class: 'btn btn-sm btn-outline', text: t('app.docker.network-new'), onClick: newNetwork }),
      ]),
      table(netColumns(), networks.value, { empty: t('app.docker.no-networks'), rowKey: (r) => r.ID || r.Name }),
    ], { fill: true });

    const volCard = card(t('app.docker.tab-volumes'), [
      h('div', { class: 'dk-toolbar' }, [
        h('span', { class: 'dk-dim-text', text: tf('app.docker.vols-total', { v1: String(volumes.value.length) }) }),
        h('span', { class: 'qx-grow' }),
        h('button', { class: 'btn btn-sm btn-outline', text: t('app.docker.volume-new'), onClick: newVolume }),
      ]),
      table(volColumns(), volumes.value, { empty: t('app.docker.no-volumes'), rowKey: (r) => r.Name }),
    ], { fill: true });

    kids.push(h('div', { class: 'dk-res-grid' }, [netCard, volCard]));
    return h('div', { class: 'dk-res-wrap' }, kids);
  });

  return {
    el,
    refresh: load,
    onShow: () => { if (!networks.value.length && !volumes.value.length) load(); },
    statusBits: () => ([
      { text: tf('app.docker.status-networks', { v1: String(networks.value.length) }) },
      { text: tf('app.docker.status-volumes', { v1: String(volumes.value.length) }) },
    ]),
    dispose: () => { disposed = true; view.unmount(); },
  };
}
