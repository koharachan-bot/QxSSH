/**
 * containers.js —— 容器列表（专业模式主力视图）
 * 表格 + 批量操作 + 行内快捷动作；行点击打开详情，日志/终端走 dialogs.js。
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, confirmAction } from '/assets/js/core/ui.js';
import {
  card, table, statusDot, badge, searchBox, spinner, emptyState, alertBar, sideAction,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import {
  parsePorts, portsSummary, stateKind, shortId, imageRef, formatTime,
} from './format.js';
import {
  openLogsDialog, openExecDialog, openDetailDialog, openRunDialog, openTerminalDialog,
} from './dialogs.js';

function stateTone(kind) {
  if (kind === 'running') return 'on';
  if (kind === 'paused' || kind === 'restarting') return 'busy';
  if (kind === 'dead') return 'off';
  return '';
}

function stateBadge(kind) {
  const map = { running: 'success', paused: 'warn', restarting: 'warn', dead: 'danger' };
  return map[kind] || 'default';
}

export function createContainersView(deps) {
  const el = document.createElement('div');
  el.className = 'dk-body';

  const rows = signal([]);
  const loading = signal(false);
  const errorText = signal('');
  const query = signal('');
  const filter = signal('all');
  const checked = signal(new Set());
  const autoRate = signal(0);
  const busyId = signal('');

  let timer = null;
  let disposed = false;

  const host = () => deps.host();

  async function load(silent) {
    const hid = host();
    if (!silent) loading.next = true;
    errorText.next = '';
    try {
      const list = await api.listContainers(hid, { all: true });
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
    const f = filter.value;
    return rows.value.filter((c) => {
      const kind = stateKind(c.State);
      if (f === 'running' && kind !== 'running') return false;
      if (f === 'stopped' && kind === 'running') return false;
      if (f === 'paused' && kind !== 'paused') return false;
      if (!q) return true;
      const hay = [c.Names, c.Image, c.ID, c.Ports, c.Status].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  async function act(container, action) {
    busyId.next(container.ID);
    try {
      if (action === 'remove') {
        const ok = await confirmAction(
          tf('app.docker.confirm-remove-title', { v1: container.Names }),
          t('app.docker.confirm-remove-desc'),
          { okText: t('app.docker.act-remove') },
        );
        if (!ok) return;
      }
      await api.containerAction(host(), container.ID, action);
      toast(tf('app.docker.action-done', { v1: container.Names, v2: action }), 'success');
      await load(true);
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      busyId.next('');
    }
  }

  /** 按原参数重建容器：改配置后用它把新配置落到一个全新容器上 */
  async function rebuild(container) {
    const ok = await confirmAction(
      tf('app.docker.confirm-rebuild-title', { v1: container.Names }),
      t('app.docker.confirm-rebuild-desc'),
      { okText: t('app.docker.act-rebuild'), danger: true },
    );
    if (!ok) return;
    busyId.next(container.ID);
    try {
      const r = await api.recreateContainer(host(), container.ID);
      toast(tf('app.docker.rebuild-ok', { v1: r.name, v2: String(r.id).slice(0, 12) }), 'success');
      for (const w of (r.warnings || [])) toast(w, 'warning');
      await load(true);
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      busyId.next('');
    }
  }

  async function batch(action) {
    const ids = [...checked.value];
    if (!ids.length) return;
    if (action === 'remove') {
      const ok = await confirmAction(
        tf('app.docker.confirm-batch-remove', { v1: String(ids.length) }),
        t('app.docker.confirm-remove-desc'),
        { okText: t('app.docker.act-remove') },
      );
      if (!ok) return;
    }
    const res = await api.containerBatch(host(), ids, action);
    const bad = res.filter((x) => !x.ok).length;
    toast(bad
      ? tf('app.docker.batch-partial', { v1: String(res.length - bad), v2: String(bad) })
      : tf('app.docker.batch-done', { v1: String(res.length) }), bad ? 'warning' : 'success');
    checked.next(new Set());
    await load(true);
  }

  function toggleCheck(id, on) {
    const next = new Set(checked.value);
    if (on) next.add(id); else next.delete(id);
    checked.next(next);
  }

  function rowActions(c) {
    const kind = stateKind(c.State);
    const running = kind === 'running';
    const btn = (icon, tip, onClick, cls) => h('button', {
      class: 'dk-ibtn ' + (cls || ''),
      type: 'button',
      title: tip,
      onClick: (e) => { e.stopPropagation(); onClick(); },
      html: iconPath(icon),
    });

    return h('div', { class: 'dk-row-acts' }, [
      running
        ? btn('stop', t('app.docker.act-stop'), () => act(c, 'stop'))
        : btn('play', t('app.docker.act-start'), () => act(c, 'start')),
      btn('restart', t('app.docker.act-restart'), () => act(c, 'restart')),
      btn('logs', t('app.docker.act-logs'), () => openLogsDialog(host(), c)),
      btn('terminal', t('app.docker.act-terminal'), () => openTerminalDialog(host(), c)),
      btn('exec', t('app.docker.act-exec'), () => openExecDialog(host(), c)),
      btn('rebuild', t('app.docker.act-rebuild'), () => rebuild(c)),
      btn('trash', t('app.docker.act-remove'), () => act(c, 'remove'), 'danger'),
    ]);
  }

  function iconPath(name) {
    const p = {
      play: '<path d="M5 3.2l7 4.8-7 4.8z"/>',
      stop: '<rect x="4" y="4" width="8" height="8" rx="1.2"/>',
      restart: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.2v3h-3"/>',
      logs: '<path d="M3 3.5h10M3 8h10M3 12.5h6"/>',
      terminal: '<path d="M3.2 4.2L7 8l-3.8 3.8M8.6 12h4.2"/>',
      trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5"/>',
      exec: '<path d="M2.5 3.5h11v9h-11zM4.8 6l2 1.8-2 1.8M8.2 9.8h3"/>',
      rebuild: '<path d="M13 8a5 5 0 1 1-1.6-3.6M13 2v3.2h-3.2"/><path d="M6.5 6.5h3v3h-3z"/>',
    }[name] || '';
    return '<svg class="qicon qicon-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
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
        key: 'Names',
        label: t('app.docker.col-name'),
        render: (row) => h('div', { class: 'dk-cell-name' }, [
          h('span', { class: 'mono', text: (String(row.Names || '').split(',')[0]) || shortId(row.ID) }),
          h('span', { class: 'dk-cell-id mono', text: shortId(row.ID, 12) }),
        ]),
      },
      {
        key: 'Image',
        label: t('app.docker.col-image'),
        render: (row) => h('span', { class: 'mono dk-ellipsis', title: row.Image, text: imageRef(row.Image) }),
      },
      {
        key: 'State',
        label: t('app.docker.col-state'),
        width: '120px',
        render: (row) => {
          const kind = stateKind(row.State);
          return h('span', { class: 'dk-cell-state' }, [
            statusDot(stateTone(kind), row.Status || ''),
            h('span', { text: t('app.docker.state-' + kind) }),
          ]);
        },
      },
      {
        key: 'Ports',
        label: t('app.docker.col-ports'),
        render: (row) => {
          const list = portsSummary(row.Ports, 2);
          return h('span', { class: 'mono dk-cell-ports', text: list.join(' ') || '-' });
        },
      },
      {
        key: 'CreatedAt',
        label: t('app.docker.col-created'),
        width: '150px',
        render: (row) => h('span', { class: 'dk-cell-dim', text: row.CreatedAt || row.RunningFor || '' }),
      },
      {
        key: 'act',
        label: '',
        width: '210px',
        render: (row) => rowActions(row),
      },
    ];
  }

  function toolbarNode() {
    const total = rows.value.length;
    const running = rows.value.filter((c) => stateKind(c.State) === 'running').length;
    const selCount = checked.value.size;

    const filterItems = [
      { id: 'all', label: tf('app.docker.filter-all', { v1: String(total) }) },
      { id: 'running', label: tf('app.docker.filter-running', { v1: String(running) }) },
      { id: 'stopped', label: tf('app.docker.filter-stopped', { v1: String(total - running) }) },
      { id: 'paused', label: t('app.docker.filter-paused') },
    ];

    return h('div', { class: 'dk-toolbar' }, [
      searchBox(t('app.docker.search-containers'), (v) => { query.next = v; }, { value: query.value }),
      h('div', { class: 'dk-chips' }, filterItems.map((it) => h('button', {
        key: it.id,
        type: 'button',
        class: 'dk-chip' + (filter.value === it.id ? ' active' : ''),
        text: it.label,
        onClick: () => { filter.next = it.id; },
      }))),
      h('span', { class: 'qx-grow' }),
      selCount ? h('div', { class: 'dk-batch' }, [
        h('span', { text: tf('app.docker.selected-n', { v1: String(selCount) }) }),
        h('button', { class: 'btn btn-sm btn-ghost', text: t('app.docker.act-start'), onClick: () => batch('start') }),
        h('button', { class: 'btn btn-sm btn-ghost', text: t('app.docker.act-stop'), onClick: () => batch('stop') }),
        h('button', { class: 'btn btn-sm btn-ghost', text: t('app.docker.act-restart'), onClick: () => batch('restart') }),
        h('button', { class: 'btn btn-sm btn-danger', text: t('app.docker.act-remove'), onClick: () => batch('remove') }),
      ]) : null,
      h('select', {
        class: 'select dk-mini',
        onChange: (e) => { autoRate.next = Number(e.target.value); restartTimer(); },
      }, [
        h('option', { value: '0', text: t('app.docker.autorefresh-off') }),
        h('option', { value: '5', text: '5s' }),
        h('option', { value: '10', text: '10s' }),
        h('option', { value: '30', text: '30s' }),
      ]),
      h('button', {
        class: 'btn btn-sm btn-outline',
        onClick: () => load(false),
        text: t('app.docker.refresh'),
      }),
      h('button', {
        class: 'btn btn-sm btn-primary',
        text: t('app.docker.run-new'),
        onClick: () => openRunDialog(host(), {
          images: deps.imagesHint ? deps.imagesHint() : [],
          networks: deps.networksHint ? deps.networksHint() : [],
          onDone: () => { load(false); deps.onChanged?.(); },
        }),
      }),
    ]);
  }

  const view = createView(el);
  view.update(() => {
    const list = filtered();
    const err = errorText.value;
    const kids = [];
    if (err) kids.push(h('div', { class: 'dk-banner-slot' }, [alertBar('error', t('app.docker.load-failed'), err)]));
    kids.push(card(null, [
      toolbarNode(),
      loading.value && !rows.value.length
        ? h('div', { class: 'dk-loading' }, [spinner(t('app.docker.loading'))])
        : table(columns(), list, {
          empty: t('app.docker.no-containers'),
          rowKey: (r) => r.ID,
          onRowClick: (row) => openDetailDialog(host(), row),
        }),
    ], { fill: true }));
    return h('div', { class: 'dk-list-wrap' }, kids);
  });

  async function refresh() { await load(false); }

  return {
    el,
    refresh,
    onShow: () => { if (!rows.value.length) load(false); },
    statusBits: () => {
      const list = rows.value;
      const running = list.filter((c) => stateKind(c.State) === 'running').length;
      return [{ text: tf('app.docker.status-containers', { v1: String(running), v2: String(list.length) }) }];
    },
    dispose: () => {
      disposed = true;
      if (timer) clearInterval(timer);
      view.unmount();
    },
  };
}
