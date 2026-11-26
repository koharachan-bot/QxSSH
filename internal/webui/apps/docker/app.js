/**
 * app.js —— Docker 管理器主入口
 * 双模式：傻瓜模式（总览 + 一键操作 + 卡片）与专业模式（完整表格 + Compose + 控制台），
 * 模式记在本地，切换后侧栏与视图集合一起变化。
 */
import { t, tf, onLangChange, setupI18n, lang } from '/assets/js/core/i18n.js';
import { h } from '/assets/js/core/vdom.js';
import { bootApp } from '/assets/js/app-bridge.js';
import { signal } from '/assets/js/core/signal.js';
import { getState } from '/assets/js/core/store.js';
import { createAppShell } from '/assets/js/core/app-shell.js';
import {
  alertBar, sidebarSections, statusBar, sideAction, segmented,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import { createOverviewView } from './overview.js';
import { createContainersView } from './containers.js';
import { createImagesView } from './images.js';
import { createResourcesView } from './resources.js';
import { createComposeView } from './compose.js';
import { createMirrorsView } from './mirrors.js';
import { createConsoleView } from './console.js';
import { openLogsDialog, openExecDialog, openRunDialog, openPullDialog } from './dialogs.js';

const MODE_KEY = 'qx-docker-mode';

/** 两种模式各自的视图集合与顺序 */
const TABS = {
  simple: [
    { id: 'overview', key: 'app.docker.tab-overview', icon: 'layout-grid' },
    { id: 'containers', key: 'app.docker.tab-containers', icon: 'box' },
    { id: 'mirrors', key: 'app.docker.tab-mirrors', icon: 'globe' },
  ],
  pro: [
    { id: 'overview', key: 'app.docker.tab-overview', icon: 'layout-grid' },
    { id: 'containers', key: 'app.docker.tab-containers', icon: 'box' },
    { id: 'images', key: 'app.docker.tab-images', icon: 'layers' },
    { id: 'resources', key: 'app.docker.tab-networks', icon: 'network' },
    { id: 'compose', key: 'app.docker.tab-compose', icon: 'file-code' },
    { id: 'mirrors', key: 'app.docker.tab-mirrors', icon: 'globe' },
    { id: 'console', key: 'app.docker.tab-console', icon: 'terminal' },
  ],
};

const FACTORIES = {
  overview: createOverviewView,
  containers: createContainersView,
  images: createImagesView,
  resources: createResourcesView,
  compose: createComposeView,
  mirrors: createMirrorsView,
  console: createConsoleView,
};

function readMode() {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === 'simple' || v === 'pro') return v;
  } catch (e) { /* 隐私模式忽略 */ }
  return 'simple';
}

function boot(el, ctx) {
  const hostId = (ctx && ctx.hostId) || '';

  const mode = signal(readMode());
  const env = signal(null);
  const envErr = signal('');
  const viewBits = signal([]);

  const cache = { images: [], networks: [], mirrors: [] };
  const viewCache = {};
  let cur = null;

  const isLocal = () => !hostId;
  const host = () => hostId;

  function hostLabel() {
    if (!hostId) return t('app.docker.local-host');
    const st = getState() || {};
    const hit = (st.hosts || []).find((x) => x.id === hostId);
    return hit ? hit.name : hostId;
  }

  /** 模式切换：换侧栏集合，并尽量停留在同名视图 */
  function applyMode(next) {
    if (next !== 'simple' && next !== 'pro') return;
    mode.next = next;
    try { localStorage.setItem(MODE_KEY, next); } catch (e) { /* 忽略 */ }
    const ids = TABS[next].map((x) => x.id);
    const keep = ids.includes(curId) ? curId : ids[0];
    shell.setTabs(tabsNow);
    switchTo(keep);
  }

  let curId = 'overview';

  function tabsNow() {
    lang();
    return TABS[mode.value].map((d) => ({ id: d.id, icon: d.icon, label: t(d.key) }));
  }

  function deps() {
    return {
      host,
      local: isLocal,
      env: () => env.value,
      refreshEnv: fetchEnv,
      gotoTab: (id) => { shell.setActive(id); switchTo(id); },
      openLogs: (c) => openLogsDialog(hostId, c),
      openExec: (c) => openExecDialog(hostId, c),
      openRun: () => openRunDialog(hostId, { images: cache.images, networks: cache.networks, onDone: () => refreshCurrent() }),
      openPull: () => openPullDialog(hostId, { mirrors: mirrorUrls(), onDone: () => refreshCurrent() }),
      imagesHint: () => cache.images,
      networksHint: () => cache.networks,
      mirrorList: mirrorUrls,
      onChanged: () => refreshCurrent(),
    };
  }

  /** 当前 daemon.json 里已配置的加速站，作为“从加速站拉取”的候选 */
  function mirrorUrls() {
    return cache.mirrors.slice();
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
    if (!v) return;
    if (cur === v) return;
    cur = v;
    contentHost.replaceChildren(v.el);
    if (!v._loaded) {
      v._loaded = true;
      v.onShow ? v.onShow() : v.refresh?.();
    } else {
      v.onShow ? v.onShow() : v.refresh?.();
    }
    refreshStatus();
  }

  function refreshCurrent() {
    cur?.refresh?.();
    fetchCache();
  }

  function refreshStatus() {
    const bits = [{ text: hostLabel(), tip: t('app.docker.target-host') }];
    const e = env.value;
    if (e && e.installed) {
      if (e.server) bits.push({ text: 'Docker ' + e.server, tip: 'Server version' });
      else bits.push({ text: t('app.docker.daemon-down'), tip: e.error || '' });
      if (e.compose) bits.push({ text: 'Compose ' + String(e.compose).replace(/^Docker Compose version\s*/i, ''), tip: 'Compose' });
      if (e.rootless) bits.push({ text: 'rootless', tip: 'Rootless Docker' });
    } else if (e && !e.installed) {
      bits.push({ text: t('app.docker.not-installed'), tip: e.raw || '' });
    }
    bits.push({ text: tf('app.docker.mode-label', { v1: mode.value === 'simple' ? t('app.docker.mode-simple') : t('app.docker.mode-pro') }) });
    if (cur && cur.statusBits) bits.push(...cur.statusBits());
    bits.push(h('span', { key: 'grow', class: 'dk-status-grow' }));
    viewBits.next = bits;
  }

  async function fetchEnv() {
    try {
      const got = await api.detect(hostId);
      env.next = got;
      envErr.next = got.error && !got.installed ? got.error : '';
      if (got.installed) fetchCache();
    } catch (e) {
      env.next = null;
      envErr.next = e.message || String(e);
    }
    refreshStatus();
  }

  /** 预取镜像与网络清单，供“运行容器”对话框做候选 */
  async function fetchCache() {
    try {
      const [imgs, nets, cfg] = await Promise.all([
        api.listImages(hostId).catch(() => []),
        api.listNetworks(hostId).catch(() => []),
        api.readDaemonConfig(hostId).catch(() => null),
      ]);
      cache.images = imgs;
      cache.networks = nets;
      cache.mirrors = cfg && Array.isArray(cfg.json['registry-mirrors']) ? cfg.json['registry-mirrors'] : [];
    } catch (e) { /* 预取失败不影响主流程 */ }
  }

  const contentHost = document.createElement('div');
  contentHost.className = 'qx-main';

  function ModeSwitch() {
    lang();
    return h('div', { class: 'dk-mode-switch' }, [
      segmented([
        { value: 'simple', label: t('app.docker.mode-simple') },
        { value: 'pro', label: t('app.docker.mode-pro') },
      ], mode.value, (v) => applyMode(v)),
    ]);
  }

  function EnvNote() {
    lang();
    const e = env.value;
    let text = t('app.docker.detecting');
    if (e && !e.installed) text = t('app.docker.not-installed');
    else if (e && !e.server) text = t('app.docker.daemon-down');
    else if (e && e.server) text = 'Docker ' + e.server;
    return h('span', { class: 'qx-side-note', text });
  }

  const shell = createAppShell(el, {
    tabs: tabsNow,
    active: 'overview',
    onChange: (id) => switchTo(id),
    sideTop: [
      sidebarSections([{ node: h(ModeSwitch, {}) }, { node: h(EnvNote, {}) }]),
    ],
    actions: [
      sideAction({
        icon: 'rotate-cw',
        label: t('app.docker.action-refresh'),
        tip: t('app.docker.action-refresh-hint'),
        onClick: () => { cur?.refresh?.(); fetchEnv(); },
      }),
    ],
  });

  function mainTree() {
    lang();
    const e = env.value;
    const err = envErr.value;
    const banner = (err || (e && !e.installed))
      ? h('div', { class: 'dk-top-alert' }, [alertBar('error', t('app.docker.not-installed'), err || (e && e.raw) || '')])
      : null;

    return h('div', { class: 'app-root dk-root' }, [
      banner,
      contentHost,
      statusBar(viewBits.value),
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
  scope: 'docker',
}).catch(() => { }).then(() => {
  bootApp(({ root, hostId }) => boot(root, { hostId }));
});
