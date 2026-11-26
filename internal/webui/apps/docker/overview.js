/**
 * overview.js —— Docker 总览（傻瓜模式首页）
 * 设计目标：一屏看清“能不能用、跑了什么、要不要清理”，并把高频操作做成一键按钮，
 * 不要求用户记住任何 docker 命令。
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast } from '/assets/js/core/ui.js';
import {
  card, statTile, statusDot, badge, icon, spinner, emptyState, alertBar,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import {
  parsePorts, portsSummary, stateKind, formatBytes, dockerSizeToBytes, formatTime, shortId, imageRef,
} from './format.js';

/** 容器状态 → i18n 标签 */
function stateLabel(kind) {
  return t('app.docker.state-' + kind);
}

/** qx-dot 只认 on/off/busy 三个修饰类 */
function stateTone(kind) {
  if (kind === 'running') return 'on';
  if (kind === 'paused' || kind === 'restarting') return 'busy';
  if (kind === 'dead') return 'off';
  return '';
}

export function createOverviewView(deps) {
  const el = document.createElement('div');
  el.className = 'dk-body';

  const loading = signal(false);
  const snapshot = signal(null);
  const errorText = signal('');
  const busy = signal('');
  const events = signal([]);
  const stats = signal([]);

  let disposed = false;

  function host() { return deps.host(); }

  async function load() {
    const hid = host();
    if (!hid && !deps.local()) { errorText.next = t('app.docker.no-host'); return; }
    loading.next = true;
    errorText.next = '';
    try {
      const [containers, images, networks, volumes, df] = await Promise.all([
        api.listContainers(hid, { all: true }),
        api.listImages(hid).catch(() => []),
        api.listNetworks(hid).catch(() => []),
        api.listVolumes(hid).catch(() => []),
        api.diskUsage(hid).catch(() => []),
      ]);
      if (disposed) return;
      snapshot.next({ containers, images, networks, volumes, df });
      // 事件属于“锦上添花”，失败不影响主视图
      api.listEvents(hid, { since: '1h', limit: 40 }).then((evs) => {
        if (!disposed) events.next(evs);
      }).catch(() => { });
    } catch (e) {
      if (disposed) return;
      errorText.next = e.message || String(e);
      snapshot.next(null);
    } finally {
      if (!disposed) loading.next = false;
    }
  }

  function statsMap() {
    const map = {};
    for (const s of stats.value) {
      map[s.ID] = s;
      map[s.Container] = s;
    }
    return map;
  }

  async function sampleStats() {
    busy.next = 'stats';
    try {
      const list = await api.containerStats(host());
      stats.next(list);
      toast(t('app.docker.stats-sampled'), 'success');
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      busy.next = '';
    }
  }

  async function doAction(container, action) {
    busy.next = container.ID;
    try {
      await api.containerAction(host(), container.ID, action);
      toast(tf('app.docker.action-done', { v1: container.Names, v2: action }), 'success');
      await load();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      busy.next = '';
    }
  }

  async function doQuick(kind) {
    const hid = host();
    busy.next = kind;
    try {
      if (kind === 'start-all') {
        const stopped = (snapshot.value?.containers || []).filter((c) => stateKind(c.State) !== 'running');
        if (!stopped.length) { toast(t('app.docker.nothing-to-start'), 'info'); return; }
        const res = await api.containerBatch(hid, stopped.map((c) => c.ID), 'start');
        const bad = res.filter((x) => !x.ok).length;
        toast(bad ? tf('app.docker.batch-partial', { v1: String(res.length - bad), v2: String(bad) })
          : tf('app.docker.batch-done', { v1: String(res.length) }), bad ? 'warning' : 'success');
      } else if (kind === 'prune-images') {
        await api.prune(hid, 'images', { all: true });
        toast(t('app.docker.prune-images-done'), 'success');
      } else if (kind === 'restart-daemon') {
        await api.restartDocker(hid);
        toast(t('app.docker.restart-daemon-done'), 'success');
      }
      await load();
      deps.refreshEnv?.();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      busy.next = '';
    }
  }

  function healthBanner() {
    const env = deps.env();
    if (!env) return null;
    if (!env.installed) {
      return alertBar('error', t('app.docker.not-installed'), t('app.docker.not-installed-tip'));
    }
    if (!env.server) {
      return h('div', { class: 'dk-banner' }, [
        alertBar('warning', t('app.docker.daemon-down'), t('app.docker.daemon-down-tip')),
        h('button', {
          class: 'btn btn-sm btn-outline',
          disabled: busy.value === 'restart-daemon',
          onClick: () => doQuick('restart-daemon'),
        }, [h('span', { html: icon('rotate-cw', 'qicon qicon-sm') }), h('span', { text: t('app.docker.restart-daemon') })]),
      ]);
    }
    if (!env.socketWritable && !api.isElevated(host())) {
      return alertBar('warning', t('app.docker.socket-denied'), t('app.docker.socket-denied-tip'));
    }
    return null;
  }

  function statRow(snap) {
    const cs = snap.containers || [];
    const running = cs.filter((c) => stateKind(c.State) === 'running').length;
    const stopped = cs.length - running;
    const reclaim = (snap.df || []).reduce((acc, r) => acc + dockerSizeToBytes(r.Reclaimable), 0);
    const imageCount = (snap.images || []).length;

    return h('div', { class: 'dk-stats' }, [
      statTile(t('app.docker.stat-containers'), String(cs.length), { unit: t('app.docker.unit-count') }),
      statTile(t('app.docker.stat-running'), String(running), { kind: 'ok' }),
      statTile(t('app.docker.stat-stopped'), String(stopped)),
      statTile(t('app.docker.stat-images'), String(imageCount)),
      statTile(t('app.docker.stat-networks'), String((snap.networks || []).length)),
      statTile(t('app.docker.stat-volumes'), String((snap.volumes || []).length)),
      statTile(t('app.docker.stat-reclaimable'), formatBytes(reclaim), { kind: reclaim > 0 ? 'warn' : '' }),
    ]);
  }

  function quickActions() {
    const items = [
      { id: 'start-all', icon: 'play', label: t('app.docker.quick-start-all'), tip: t('app.docker.quick-start-all-tip') },
      { id: 'sample-stats', icon: 'activity', label: t('app.docker.quick-stats'), tip: t('app.docker.quick-stats-tip') },
      { id: 'pull', icon: 'download', label: t('app.docker.quick-pull'), tip: t('app.docker.quick-pull-tip') },
      { id: 'mirror', icon: 'globe', label: t('app.docker.quick-mirror'), tip: t('app.docker.quick-mirror-tip') },
      { id: 'prune-images', icon: 'trash-2', label: t('app.docker.quick-prune'), tip: t('app.docker.quick-prune-tip') },
      { id: 'run', icon: 'plus', label: t('app.docker.quick-run'), tip: t('app.docker.quick-run-tip') },
    ];
    return card(t('app.docker.quick-title'), h('div', { class: 'dk-actions' }, items.map((it) => h('button', {
      key: it.id,
      class: 'dk-action',
      type: 'button',
      title: it.tip,
      disabled: !!busy.value,
      onClick: () => {
        if (it.id === 'sample-stats') { sampleStats(); return; }
        if (it.id === 'pull') { deps.openPull?.(); return; }
        if (it.id === 'mirror') { deps.gotoTab?.('mirrors'); return; }
        if (it.id === 'run') { deps.gotoTab?.('containers'); deps.openRun?.(); return; }
        doQuick(it.id);
      },
    }, [
      h('span', { class: 'dk-action-ic', html: icon(it.icon, 'qicon') }),
      h('span', { class: 'dk-action-label', text: it.label }),
    ]))));
  }

  function containerCard(c, smap) {
    const kind = stateKind(c.State);
    const tone = stateTone(kind);
    const ports = portsSummary(c.Ports, 3);
    const st = smap[c.ID] || smap[c.Names];
    const isRunning = kind === 'running';

    return h('div', { key: c.ID, class: 'dk-ccard' }, [
      h('div', { class: 'dk-ccard-head' }, [
        statusDot(tone, stateLabel(kind)),
        h('span', { class: 'dk-ccard-name mono', text: (c.Names || '').split(',')[0] || shortId(c.ID) }),
        h('span', { class: 'qx-grow' }),
        h('span', { class: 'dk-ccard-state', text: c.Status || '' }),
      ]),
      h('div', { class: 'dk-ccard-img mono', title: c.Image, text: imageRef(c.Image) }),
      ports.length ? h('div', { class: 'dk-ccard-ports' }, ports.map((p) => h('span', { class: 'dk-port', text: p }))) : null,
      st ? h('div', { class: 'dk-ccard-metrics' }, [
        h('span', { text: 'CPU ' + (st.CPUPerc || '-') }),
        h('span', { text: t('app.docker.mem') + ' ' + (st.MemUsage || '-') }),
        h('span', { text: 'PIDS ' + (st.PIDs || '-') }),
      ]) : null,
      h('div', { class: 'dk-ccard-acts' }, [
        isRunning
          ? h('button', { class: 'btn btn-sm btn-ghost', title: t('app.docker.act-stop'), onClick: () => doAction(c, 'stop') }, [h('span', { html: icon('square', 'qicon qicon-sm') }), h('span', { text: t('app.docker.act-stop') })])
          : h('button', { class: 'btn btn-sm btn-ghost', title: t('app.docker.act-start'), onClick: () => doAction(c, 'start') }, [h('span', { html: icon('play', 'qicon qicon-sm') }), h('span', { text: t('app.docker.act-start') })]),
        h('button', { class: 'btn btn-sm btn-ghost', title: t('app.docker.act-restart'), onClick: () => doAction(c, 'restart') }, [h('span', { html: icon('rotate-cw', 'qicon qicon-sm') }), h('span', { text: t('app.docker.act-restart') })]),
        h('button', { class: 'btn btn-sm btn-ghost', title: t('app.docker.act-logs'), onClick: () => deps.openLogs?.(c) }, [h('span', { html: icon('file-text', 'qicon qicon-sm') }), h('span', { text: t('app.docker.act-logs') })]),
        h('button', { class: 'btn btn-sm btn-ghost', title: t('app.docker.act-exec'), onClick: () => deps.openExec?.(c) }, [h('span', { html: icon('terminal', 'qicon qicon-sm') }), h('span', { text: t('app.docker.act-exec') })]),
      ]),
    ]);
  }

  function containerBoard(snap) {
    const list = (snap.containers || []).slice().sort((a, b) => {
      const ra = stateKind(a.State) === 'running' ? 0 : 1;
      const rb = stateKind(b.State) === 'running' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return String(a.Names).localeCompare(String(b.Names));
    });
    const smap = statsMap();

    if (!list.length) {
      return card(t('app.docker.board-title'), emptyState(t('app.docker.no-containers')));
    }
    return card(t('app.docker.board-title'), h('div', { class: 'dk-cards' }, list.map((c) => containerCard(c, smap))), {
      tools: h('span', { class: 'qx-count', text: tf('app.docker.board-count', { v1: String(list.length) }) }),
    });
  }

  function eventList() {
    const evs = events.value.slice(-30).reverse();
    if (!evs.length) return null;
    return card(t('app.docker.events-title'), h('div', { class: 'dk-events' }, evs.map((e, i) => {
      const type = String(e.Type || '');
      const action = String(e.Action || '');
      const name = String((e.Actor && e.Actor.Attributes && e.Actor.Attributes.name) || (e.Actor && e.Actor.ID) || '');
      const tone = /die|kill|oom|error|fail/i.test(action) ? 'danger'
        : /start|create|pull|tag/i.test(action) ? 'success'
          : 'default';
      return h('div', { key: i, class: 'dk-event' }, [
        h('span', { class: 'dk-event-time mono', text: formatTime(e.time) }),
        badge(type || 'event', 'default'),
        h('span', { class: 'dk-event-act dk-tone-' + tone, text: action }),
        h('span', { class: 'dk-event-name mono', text: shortId(name, 40), title: name }),
      ]);
    })));
  }

  const view = createView(el);
  view.update(() => {
    const snap = snapshot.value;
    const err = errorText.value;
    const kids = [];

    const banner = healthBanner();
    if (banner) kids.push(h('div', { class: 'dk-banner-slot' }, [banner]));
    if (err) kids.push(h('div', { class: 'dk-banner-slot' }, [alertBar('error', t('app.docker.load-failed'), err)]));

    if (loading.value && !snap) {
      kids.push(h('div', { class: 'dk-loading' }, [spinner(t('app.docker.loading'))]));
    } else if (snap) {
      kids.push(statRow(snap));
      kids.push(h('div', { class: 'dk-grid2' }, [quickActions(), eventList()].filter(Boolean)));
      kids.push(containerBoard(snap));
    }
    return h('div', { class: 'dk-overview' }, kids);
  });

  return {
    el,
    refresh: load,
    onShow: load,
    statusBits: () => {
      const snap = snapshot.value;
      if (!snap) return [];
      const cs = snap.containers || [];
      const running = cs.filter((c) => stateKind(c.State) === 'running').length;
      return [{ text: tf('app.docker.status-containers', { v1: String(running), v2: String(cs.length) }) }];
    },
    dispose: () => {
      disposed = true;
      view.unmount();
    },
  };
}
