/**
 * images.js —— 镜像列表
 * 关注点：体积排序、悬空镜像识别、批量删除、以及“从加速站拉取”的入口。
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, confirmAction } from '/assets/js/core/ui.js';
import {
  card, table, badge, searchBox, spinner, alertBar, codeBlock,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import { shortId, sizeValue, formatBytes, downloadText } from './format.js';
import { openPullDialog, openRunDialog, openBuildDialog } from './dialogs.js';

export function createImagesView(deps) {
  const el = document.createElement('div');
  el.className = 'dk-body';

  const rows = signal([]);
  const loading = signal(false);
  const errorText = signal('');
  const query = signal('');
  const checked = signal(new Set());
  const sortBy = signal('size');

  let disposed = false;
  const host = () => deps.host();

  async function load() {
    loading.next = true;
    errorText.next = '';
    try {
      const list = await api.listImages(host());
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

  function refOf(row) {
    const repo = row.Repository || '';
    const tag = row.Tag || '';
    if (!repo || repo === '<none>') return row.ID;
    return repo + (tag && tag !== '<none>' ? ':' + tag : '');
  }

  function filtered() {
    const q = query.value.toLowerCase().trim();
    let list = rows.value.filter((r) => {
      if (!q) return true;
      return [r.Repository, r.Tag, r.ID].join(' ').toLowerCase().includes(q);
    });
    const by = sortBy.value;
    list = list.slice().sort((a, b) => {
      if (by === 'size') return sizeValue(b.Size) - sizeValue(a.Size);
      if (by === 'name') return String(a.Repository).localeCompare(String(b.Repository));
      return String(b.CreatedAt || '').localeCompare(String(a.CreatedAt || ''));
    });
    return list;
  }

  function toggleCheck(id, on) {
    const next = new Set(checked.value);
    if (on) next.add(id); else next.delete(id);
    checked.next(next);
  }

  async function removeOne(row) {
    const ref = refOf(row);
    const ok = await confirmAction(tf('app.docker.confirm-remove-image', { v1: ref }), t('app.docker.confirm-remove-desc'), {
      okText: t('app.docker.act-remove'),
    });
    if (!ok) return;
    try {
      await api.removeImage(host(), row.ID, { force: true });
      toast(t('app.docker.image-removed'), 'success');
      await load();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    }
  }

  async function removeSelected() {
    const ids = [...checked.value];
    if (!ids.length) return;
    const ok = await confirmAction(tf('app.docker.confirm-batch-remove', { v1: String(ids.length) }), t('app.docker.confirm-remove-desc'), {
      okText: t('app.docker.act-remove'),
    });
    if (!ok) return;
    let bad = 0;
    for (const id of ids) {
      try { await api.removeImage(host(), id, { force: true }); } catch (e) { bad += 1; }
    }
    toast(bad ? tf('app.docker.batch-partial', { v1: String(ids.length - bad), v2: String(bad) }) : tf('app.docker.batch-done', { v1: String(ids.length) }), bad ? 'warning' : 'success');
    checked.next(new Set());
    await load();
  }

  async function pruneDangling() {
    try {
      const out = await api.prune(host(), 'images', { all: false });
      toast(t('app.docker.prune-images-done'), 'success');
      await load();
      return out;
    } catch (e) {
      toast(e.message || String(e), 'danger');
      return '';
    }
  }

  function columns() {
    return [
      {
        key: 'sel',
        label: '',
        width: '30px',
        render: (row) => h('input', {
          type: 'checkbox',
          checked: checked.value.has(row.ID),
          onClick: (e) => e.stopPropagation(),
          onChange: (e) => toggleCheck(row.ID, e.target.checked),
        }),
      },
      {
        key: 'Repository',
        label: t('app.docker.col-repo'),
        render: (row) => {
          const dangling = !row.Repository || row.Repository === '<none>';
          return h('div', { class: 'dk-cell-name' }, [
            h('span', { class: 'mono', text: dangling ? '<none>' : row.Repository }),
            h('span', {
              class: 'dk-cell-id mono',
              text: dangling ? t('app.docker.image-dangling') : (row.Tag || 'latest'),
            }),
          ]);
        },
      },
      {
        key: 'ID',
        label: 'ID',
        width: '110px',
        render: (row) => h('span', { class: 'mono dk-cell-dim', text: shortId(row.ID, 12) }),
      },
      {
        key: 'Size',
        label: t('app.docker.col-size'),
        width: '110px',
        render: (row) => h('span', { class: 'dk-cell-size', text: row.Size || formatBytes(sizeValue(row.Size)) }),
      },
      {
        key: 'Containers',
        label: t('app.docker.col-containers'),
        width: '90px',
        render: (row) => {
          const n = Number(row.Containers || 0);
          return n > 0 ? badge(String(n), 'success') : h('span', { class: 'dk-cell-dim', text: '0' });
        },
      },
      {
        key: 'CreatedAt',
        label: t('app.docker.col-created'),
        width: '140px',
        render: (row) => h('span', { class: 'dk-cell-dim', text: row.CreatedAt || row.CreatedSince || '' }),
      },
      {
        key: 'act',
        label: '',
        width: '96px',
        render: (row) => h('div', { class: 'dk-row-acts' }, [
          h('button', {
            class: 'btn btn-sm btn-ghost',
            text: t('app.docker.act-run'),
            onClick: (e) => {
              e.stopPropagation();
              openRunDialog(host(), {
                images: rows.value,
                networks: deps.networksHint ? deps.networksHint() : [],
                onDone: () => { load(); deps.onChanged?.(); },
              });
            },
          }),
          h('button', {
            class: 'btn btn-sm btn-ghost dk-danger',
            text: t('app.docker.act-remove'),
            onClick: (e) => { e.stopPropagation(); removeOne(row); },
          }),
        ]),
      },
    ];
  }

  const view = createView(el);
  view.update(() => {
    const list = filtered();
    const totalSize = rows.value.reduce((a, r) => a + sizeValue(r.Size), 0);
    const selCount = checked.value.size;

    const toolbar = h('div', { class: 'dk-toolbar' }, [
      searchBox(t('app.docker.search-images'), (v) => { query.next = v; }, { value: query.value }),
      h('select', {
        class: 'select dk-mini',
        onChange: (e) => { sortBy.next = e.target.value; },
      }, [
        h('option', { value: 'size', text: t('app.docker.sort-size') }),
        h('option', { value: 'name', text: t('app.docker.sort-name') }),
        h('option', { value: 'created', text: t('app.docker.sort-created') }),
      ]),
      h('span', { class: 'dk-dim-text', text: tf('app.docker.images-total', { v1: String(rows.value.length), v2: formatBytes(totalSize) }) }),
      h('span', { class: 'qx-grow' }),
      selCount ? h('button', { class: 'btn btn-sm btn-danger', text: tf('app.docker.remove-n', { v1: String(selCount) }), onClick: removeSelected }) : null,
      h('button', { class: 'btn btn-sm btn-ghost', text: t('app.docker.prune-dangling'), onClick: pruneDangling }),
      h('button', { class: 'btn btn-sm btn-outline', text: t('app.docker.refresh'), onClick: load }),
      h('button', {
        class: 'btn btn-sm btn-outline',
        text: t('app.docker.build-open'),
        onClick: () => openBuildDialog(host(), { onDone: () => { load(); deps.onChanged?.(); } }),
      }),
      h('button', {
        class: 'btn btn-sm btn-primary',
        text: t('app.docker.pull-new'),
        onClick: () => openPullDialog(host(), {
          mirrors: deps.mirrorList ? deps.mirrorList() : [],
          onDone: () => { load(); deps.onChanged?.(); },
        }),
      }),
    ]);

    const kids = [];
    if (errorText.value) kids.push(h('div', { class: 'dk-banner-slot' }, [alertBar('error', t('app.docker.load-failed'), errorText.value)]));
    kids.push(card(null, [
      toolbar,
      loading.value && !rows.value.length
        ? h('div', { class: 'dk-loading' }, [spinner(t('app.docker.loading'))])
        : table(columns(), list, { empty: t('app.docker.no-images'), rowKey: (r) => r.ID }),
    ], { fill: true }));
    return h('div', { class: 'dk-list-wrap' }, kids);
  });

  return {
    el,
    refresh: load,
    onShow: () => { if (!rows.value.length) load(); },
    statusBits: () => [{ text: tf('app.docker.status-images', { v1: String(rows.value.length) }) }],
    dispose: () => { disposed = true; view.unmount(); },
  };
}
