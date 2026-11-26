/**
 * app.js —— Kubernetes 管理器主入口
 * 双模式：傻瓜模式只看“集群好不好、哪里出问题、日志在哪”；
 * 专业模式给完整资源表、YAML 编辑与 kubectl 控制台。
 */
import { t, tf, onLangChange, setupI18n, lang } from '/assets/js/core/i18n.js';
import { h } from '/assets/js/core/vdom.js';
import { bootApp } from '/assets/js/app-bridge.js';
import { signal } from '/assets/js/core/signal.js';
import { getState } from '/assets/js/core/store.js';
import { toast } from '/assets/js/core/ui.js';
import { createAppShell } from '/assets/js/core/app-shell.js';
import {
  alertBar, sidebarSections, statusBar, sideAction, segmented,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import { createOverviewView } from './overview.js';
import { createPodsView } from './pods.js';
import { createWorkloadsView } from './workloads.js';
import { createDiscoverView } from './discover.js';
import { createNodesView } from './nodes.js';
import { createEventsView } from './events.js';
import { createYamlView } from './yaml.js';
import { createConsoleView } from './console.js';

const MODE_KEY = 'qx-k8s-mode';

const TABS = {
  simple: [
    { id: 'overview', key: 'app.k8s.tab-overview', icon: 'layout-grid' },
    { id: 'pods', key: 'app.k8s.tab-pods', icon: 'box' },
    { id: 'events', key: 'app.k8s.tab-events', icon: 'bell' },
  ],
  pro: [
    { id: 'overview', key: 'app.k8s.tab-overview', icon: 'layout-grid' },
    { id: 'workloads', key: 'app.k8s.tab-workloads', icon: 'layers' },
    { id: 'pods', key: 'app.k8s.tab-pods', icon: 'box' },
    { id: 'discover', key: 'app.k8s.tab-discover', icon: 'network' },
    { id: 'nodes', key: 'app.k8s.tab-nodes', icon: 'server' },
    { id: 'events', key: 'app.k8s.tab-events', icon: 'bell' },
    { id: 'yaml', key: 'app.k8s.tab-yaml', icon: 'file-code' },
    { id: 'console', key: 'app.k8s.tab-console', icon: 'terminal' },
  ],
};

const FACTORIES = {
  overview: createOverviewView,
  pods: createPodsView,
  workloads: createWorkloadsView,
  discover: createDiscoverView,
  nodes: createNodesView,
  events: createEventsView,
  yaml: createYamlView,
  console: createConsoleView,
};

function readMode() {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === 'simple' || v === 'pro') return v;
  } catch (e) { /* 忽略 */ }
  return 'simple';
}

function boot(el, ctx) {
  const hostId = (ctx && ctx.hostId) || '';

  const mode = signal(readMode());
  const env = signal(null);
  const info = signal(null);
  const bits = signal([]);

  const viewCache = {};
  let cur = null;
  let curId = 'overview';

  const host = () => hostId;

  function hostLabel() {
    if (!hostId) return t('app.k8s.local-host');
    const st = getState() || {};
    const hit = (st.hosts || []).find((x) => x.id === hostId);
    return hit ? hit.name : hostId;
  }

  let shell = null;

  function tabsNow() {
    lang();
    return TABS[mode.value].map((d) => ({ id: d.id, icon: d.icon, label: t(d.key) }));
  }

  function deps() {
    return {
      host,
      local: () => !hostId,
      env: () => env.value,
      refreshEnv: fetchEnv,
      gotoTab: (id) => { shell.setActive(id); switchTo(id); },
      onChanged: () => { cur?.refresh?.(); },
    };
  }

  function applyMode(next) {
    if (next !== 'simple' && next !== 'pro') return;
    mode.next = next;
    try { localStorage.setItem(MODE_KEY, next); } catch (e) { /* 忽略 */ }
    const ids = TABS[next].map((x) => x.id);
    const keep = ids.includes(curId) ? curId : ids[0];
    shell.setTabs(tabsNow);
    switchTo(keep);
  }

  function getView(id) {
    if (!viewCache[id]) {
      const f = FACTORIES[id];
      viewCache[id] = f ? f(deps()) : null;
    }
    return viewCache[id];
  }

  function switchTo(id) {
    if (!FACTORIES[id]) return;
    curId = id;
    const v = getView(id);
    if (!v || cur === v) return;
    cur = v;
    contentHost.replaceChildren(v.el);
    if (!v._loaded) { v._loaded = true; v.onShow ? v.onShow() : v.refresh?.(); }
    else v.onShow ? v.onShow() : v.refresh?.();
    refreshStatus();
  }

  function refreshStatus() {
    const list = [{ text: hostLabel(), tip: t('app.k8s.target-host') }];
    const e = env.value;
    if (e) {
      if (!e.installed) list.push({ text: t('app.k8s.not-installed'), tip: e.raw || '' });
      else {
        if (e.context) list.push({ text: 'ctx: ' + e.context, tip: t('app.k8s.context') });
        if (e.client) list.push({ text: e.client, tip: 'kubectl' });
        if (!e.reachable) list.push({ text: t('app.k8s.unreachable'), tip: e.error || '' });
      }
    }
    const inf = info.value;
    if (inf && inf.server) list.push({ text: inf.server, tip: t('app.k8s.server') });
    list.push({ text: tf('app.k8s.mode-label', { v1: mode.value === 'simple' ? t('app.k8s.mode-simple') : t('app.k8s.mode-pro') }) });
    if (cur && cur.statusBits) list.push(...cur.statusBits());
    list.push(h('span', { key: 'grow', class: 'k8s-status-grow' }));
    bits.next = list;
  }

  async function fetchEnv() {
    try {
      const got = await api.detect(hostId);
      env.next = got;
      if (got.installed && got.reachable) {
        api.contextInfo(hostId).then((inf) => { if (inf) info.next = inf; }).catch(() => { });
      }
    } catch (e) {
      env.next = null;
    }
    refreshStatus();
  }

  const installing = signal(false);

  /** 一键安装 kubectl：安装完成后重新探测环境 */
  async function doInstall() {
    if (installing.value) return;
    installing.next = true;
    toast(t('app.k8s.install-start'), 'info');
    try {
      const r = await api.installKubectl(hostId);
      if (r.ok) toast(t('app.k8s.install-ok'), 'success');
      else if (/QX_NO_DOWNLOADER/.test((r.err || '') + (r.out || ''))) toast(t('app.k8s.install-no-downloader'), 'error');
      else if (/QX_UNSUPPORTED_ARCH/.test((r.err || '') + (r.out || ''))) toast(t('app.k8s.install-bad-arch'), 'error');
      else toast((r.err || t('app.k8s.install-failed')).slice(0, 300), 'error');
    } finally {
      installing.next = false;
    }
    await fetchEnv();
  }

  const contentHost = document.createElement('div');
  contentHost.className = 'qx-main';

  function ModeSwitch() {
    lang();
    return h('div', { class: 'k8s-mode-switch' }, [
      segmented([
        { value: 'simple', label: t('app.k8s.mode-simple') },
        { value: 'pro', label: t('app.k8s.mode-pro') },
      ], mode.value, (v) => applyMode(v)),
    ]);
  }

  function EnvNote() {
    lang();
    const e = env.value;
    let text = t('app.k8s.detecting');
    if (e && !e.installed) text = t('app.k8s.not-installed');
    else if (e && !e.reachable) text = t('app.k8s.unreachable');
    else if (e && e.context) text = e.context;
    return h('span', { class: 'qx-side-note', text });
  }

  shell = createAppShell(el, {
    tabs: tabsNow,
    active: 'overview',
    onChange: (id) => switchTo(id),
    sideTop: [sidebarSections([{ node: h(ModeSwitch, {}) }, { node: h(EnvNote, {}) }])],
    actions: [
      sideAction({
        icon: 'rotate-cw',
        label: t('app.k8s.action-refresh'),
        tip: t('app.k8s.action-refresh-hint'),
        onClick: () => { cur?.refresh?.(); fetchEnv(); },
      }),
    ],
  });

  function mainTree() {
    lang();
    const e = env.value;
    const banner = (e && !e.installed)
      ? h('div', { class: 'k8s-top-alert' }, [
          alertBar('error', t('app.k8s.not-installed'), t('app.k8s.not-installed-tip'), {
            actions: [
              h('button', {
                class: 'btn btn-sm btn-primary',
                type: 'button',
                disabled: installing.value,
                text: installing.value ? t('app.k8s.install-running') : t('app.k8s.install-now'),
                onClick: () => doInstall(),
              }),
            ],
          }),
        ])
      : (e && !e.reachable)
        ? h('div', { class: 'k8s-top-alert' }, [alertBar('error', t('app.k8s.unreachable'), e.error || '')])
        : null;
    return h('div', { class: 'app-root k8s-root' }, [
      banner,
      contentHost,
      statusBar(bits.value),
    ]);
  }

  shell.setMain(mainTree);

  const offLang = onLangChange(() => {
    shell.setTabs(tabsNow);
    refreshStatus();
  });

  switchTo('overview');
  fetchEnv();

  return () => {
    offLang();
    for (const id of Object.keys(viewCache)) viewCache[id]?.dispose?.();
    shell.destroy();
  };
}

setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'],
  scope: 'k8s',
}).catch(() => { }).then(() => {
  bootApp(({ root, hostId }) => boot(root, { hostId }));
});
