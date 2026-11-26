import {
  bootApp, setTheme, setGlass, applyTaskbar, listApps, openApp,
  notifyPermChanged, notifySessionRevoked, onThemeChange,
} from '/assets/js/app-bridge.js';

import { fmtSize, debounce } from '/assets/js/core/dom.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal, effect } from '/assets/js/core/signal.js';
import {
  permCatalog, permGrants, permGrant, permRevoke, permClear,
  auditNote,
} from '/assets/js/core/qxssh-api.js';
import { collectHostInfo } from '/assets/js/core/hostprobe.js';
import { toast, confirmAction } from '/assets/js/core/ui.js';
import { readCachedPref, setPref } from '/assets/js/core/prefs.js';
import { appIcon } from '/assets/js/icons/index.js';
import { appName } from '/assets/js/apps/apptext.js';
import { pickTerm } from '/assets/js/core/terms.js';
import { setupI18n, t, tf, lang, setLang, currentLangs } from '/assets/js/core/i18n.js';
import { getTaskbarPos, setTaskbarPos } from '/assets/js/desktop/taskbar.js';
import {
  getGlassAlpha, setGlassAlpha, resetGlassAlpha, GLASS_MIN, GLASS_MAX,
} from '/assets/js/desktop/glass.js';
import {
  card, sectionTitle, keyValue, chipGroup, segmented, sidebarSections, spinner, emptyState, errorState,
  searchBox, badge, Collapsible, icon,
} from '/assets/js/core/components.js';

const TAB_DEFS = [
  { id: 'system', key: 'app.settings.tab-host', icon: 'server' },
  { id: 'theme', key: 'app.settings.tab-theme', icon: 'sun' },
  { id: 'apps', key: 'app.settings.tab-app', icon: 'grid' },
];

function tabsNow() {
  return TAB_DEFS.map((tab) => ({ id: tab.id, label: t(tab.key), icon: tab.icon }));
}

function boot(el, ctx) {
  const hostId = ctx.hostId;

  const LEGACY_TABS = { wallpaper: 'theme', taskbar: 'theme' };
  const activeTab = signal(LEGACY_TABS[ctx.initialTab] || ctx.initialTab || 'system');

  const hostCfg = signal(null);



  const glassAlpha = signal(typeof ctx.glass === 'number' ? ctx.glass : getGlassAlpha());
  const themeMode = signal(readCachedPref('qx-theme') || ctx.themeMode || 'system');
  const taskbarPos = signal(ctx.taskbarPos || getTaskbarPos());

  const offTheme = onThemeChange((th, mode) => {
    const cur = mode || readCachedPref('qx-theme') || 'system';
    if (cur && themeMode.value !== cur) themeMode.next = cur;
  });

  const permLoaded = signal(false);
  const permErr = signal('');
  const catalog = signal({ groups: [], perms: [] });
  const grants = signal({});
  const permApps = signal([]);
  const permSel = signal('');
  const permView = signal('list');
  const permQ = signal('');
  const permAq = signal('');

  let permLoadP = null;
  function ensurePermData() {
    if (permLoadP) return permLoadP;
    permLoadP = Promise.all([permCatalog(), permGrants(), listApps()])
      .then(([cat, g, apps]) => {
        const list = (Array.isArray(apps) ? apps : [])
          .slice()
          .sort((a, b) => (b.systemApp === true) - (a.systemApp === true));
        catalog.next = cat || { groups: [], perms: [] };
        grants.next = (g && g.grants) || {};
        permApps.next = list;
        permSel.next = (list.find((a) => a.systemApp !== true) || list[0] || {}).id || '';
        permErr.next = '';
        permLoaded.next = true;
      })
      .catch((e) => {
        permLoadP = null;
        permErr.next = (e && e.message) || String(e);
        throw e;
      });
    return permLoadP;
  }


  const broadcastGlass = debounce((v) => setGlass(v), 80);

  async function ensureHostCfg() {
    if (hostCfg.value) return;
    try {
      hostCfg.next = await collectHostInfo(hostId);
    } catch (e) {
      hostCfg.next = { error: e.message };
    }
  }

  function systemTree() {
    if (!hostCfg.value) return spinner(t('app.settings.host-loading'));
    if (hostCfg.value.error) return errorState(t('app.settings.host-load-failed') + hostCfg.value.error);
    const c = hostCfg.value;

    const cpu = [c.cpuModel, (c.cpuVendor && c.cpuVendor !== c.cpuModel) ? `(${c.cpuVendor})` : '']
      .filter(Boolean).join(' ');

    const diskRows = (c.disks && c.disks.length)
      ? c.disks.map((d) => keyValue(
        d.model ? `${d.name} · ${d.model}` : d.name,
        `${fmtSize(d.size)}${d.type && d.type !== '-' ? ' · ' + d.type : ''}${d.tran ? ' · ' + d.tran : ''}`,
      ))
      : [emptyState(t('app.settings.disk-none'))];

    const storage = c.storage || [];
    const storageRows = storage.length
      ? storage.map((s) => {
        const used = s.usedBytes != null ? s.usedBytes : s.usedGB * 1024 ** 3;
        const total = s.totalBytes != null ? s.totalBytes : s.totalGB * 1024 ** 3;
        const pct = total ? ` · ${((used / total) * 100).toFixed(1)}%` : '';
        const mp = s.mount && s.mount !== '/' ? tf('app.settings.disk-mount', { v1: (s.mount) }) : t('app.settings.disk-root');
        return keyValue(
          tf('app.settings.disk-label', { v1: (s.device || s.mount), v2: (s.isSystem ? t('app.settings.disk-system') : '') }),
          `${fmtSize(used)} / ${fmtSize(total)}${pct}${mp}`,
        );
      })
      : [emptyState(t('app.settings.fs-none'))];

    return card(t('app.settings.host-hardware'), [
      sectionTitle(t('app.settings.host')),
      keyValue(t('app.settings.hostname'), c.hostname),
      keyValue(t('app.settings.os'), c.os),
      keyValue(t('app.settings.kernel'), c.kernel),
      keyValue(t('app.settings.arch'), c.arch),
      keyValue(t('app.settings.uptime'), c.uptime),
      c.net ? keyValue(t('app.settings.address'), c.net) : null,
      sectionTitle(t('app.settings.section-cpu')),
      keyValue(t('app.settings.model'), cpu || '-'),
      keyValue(t('app.settings.cores'), c.cores ? tf('app.settings.cores-value', { v1: (c.cores) }) : '-'),
      keyValue(t('app.settings.threads'), c.threads ? tf('app.settings.threads-value', { v1: (c.threads) }) : '-'),
      keyValue(t('app.settings.max-freq'), c.cpuFreq || '-'),
      sectionTitle(t('app.settings.section-memory')),
      keyValue(t('app.settings.total-capacity'), c.memTotal ? fmtSize(c.memTotal) : '-'),
      sectionTitle(t('app.settings.section-disk')),
      ...diskRows,
      sectionTitle(t('app.settings.fs-usage')),
      ...storageRows,
      sectionTitle(t('app.settings.root-fs')),
      keyValue(t('app.settings.used'), c.rootUsed ? fmtSize(c.rootUsed) : '-'),
      keyValue(t('app.settings.total'), c.rootTotal ? fmtSize(c.rootTotal) : '-'),
      c.rootTotal
        ? keyValue(
          t('app.settings.usage-rate'),
          `${((c.rootUsed / c.rootTotal) * 100).toFixed(1)}%`,
        )
        : null,
    ]);
  }

  // 壁纸的增删与挑选已经全部搬进「壁纸猫猫」，设置页只留一个入口，
  // 避免两处各写一套壁纸状态（旧代码在这里维护了 300 行重复逻辑）。
  function wallpaperTree() {
    return card(t('app.settings.wallpaper-title'), [
      h('div', { class: 'st-wall-moved' }, [
        h('span', { class: 'st-wall-moved-ic', html: icon('image', 'qicon') }),
        h('div', { class: 'st-wall-moved-main' }, [
          h('span', { class: 'st-wall-moved-title', text: t('app.settings.wallpaper-moved-title') }),
          h('p', { class: 'st-glass-hint', text: t('app.settings.wallpaper-moved-body') }),
        ]),
      ]),
      h('button', {
        class: 'btn btn-primary btn-sm',
        type: 'button',
        html: `${icon('image', 'qicon qicon-sm')}<span>${t('app.settings.wallpaper-open')}</span>`,
        onClick: () => {
          try {
            openApp('wallpapercat');
          } catch {
            toast(t('app.settings.wallpaper-open-failed'), 'error');
          }
        },
      }),
    ]);
  }

  function applyThemeMode(mode) {
    ctx.themeMode = mode;
    setPref('qx-theme', mode);
    setTheme(mode);
    const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = mode === 'dark' || (mode === 'system' && prefersDark);
    document.documentElement.classList.toggle('dark', isDark);

    auditNote('theme', mode);
    toast(t('app.settings.theme-switched'), 'success');
    themeMode.next = mode;
  }

  function themeCard() {
    return card(t('app.settings.field-theme'), [
      segmented([
        { value: 'light', label: t('app.settings.theme-light') },
        { value: 'dark', label: t('app.settings.theme-dark') },
        { value: 'system', label: t('app.settings.theme-system') },
      ], themeMode.value, (m) => applyThemeMode(m)),
    ]);
  }

  function taskbarCard() {
    const labels = { top: t('app.settings.pos-top'), bottom: t('app.settings.pos-bottom'), left: t('app.settings.pos-left'), right: t('app.settings.pos-right') };
    return card(t('app.settings.field-taskbar-pos'), [
      segmented(['top', 'bottom', 'left', 'right'].map((p) => ({ value: p, label: labels[p] })),
        taskbarPos.value, (p) => {
          setTaskbarPos(p);
          taskbarPos.next = p;
          applyTaskbar(p);
          auditNote('taskbar', `position ${p}`);
          toast(t('app.settings.taskbar-pos-set'), 'success');
        }),
    ]);
  }

  function languageCard() {
    const langs = currentLangs();
    return card(t('app.settings.field-language'), [
      segmented(
        langs.map((l) => ({ value: l.code, label: l.label })),
        lang(),
        (code) => {
          if (code === lang()) return;
          setLang(code).then((now) => {
            if (now !== code) {
              toast(t('app.settings.lang-switch-failed'), 'error');
              return;
            }
            auditNote('i18n', `lang ${now}`);
          }).catch(() => {
            toast(t('app.settings.lang-switch-failed'), 'error');
          });
        },
      ),
      h('div', { class: 'st-note', style: { marginTop: '10px' } }, [
        h('span', { class: 'st-note-ic', html: icon('info', 'qicon qicon-sm') }),
        h('span', { class: 'st-note-text', text: t('app.settings.lang-note') }),
      ]),
    ]);
  }

  function glassCard() {
    const cur = glassAlpha.value;
    const range = { current: null };
    return card(t('app.settings.field-blur'), [
      h('div', { class: 'st-glass-row' }, [
        h('span', { class: 'st-glass-label', text: t('app.settings.field-opacity') }),
        h('span', { class: 'st-glass-val', text: `${Math.round(cur * 100)}%` }),
      ]),
      h('input', {
        ref: range,
        class: 'st-glass-range',
        type: 'range',
        min: String(GLASS_MIN),
        max: String(GLASS_MAX),
        step: 'any',
        value: String(cur),
        'aria-label': t('app.settings.blur-opacity'),
        onInput: (ev) => {
          const n = setGlassAlpha(ev.target.value);
          glassAlpha.next = n;
          broadcastGlass(n);
        },
        onChange: (ev) => { auditNote('glass', `alpha ${ev.target.value}`); },
      }),
      h('div', { class: 'st-glass-foot' }, [
        h('span', {
          class: 'st-glass-hint',
          text: t('app.settings.opacity-hint'),
        }),
        h('button', {
          class: 'btn btn-ghost btn-sm',
          text: t('app.settings.action-restore-defaults'),
          onClick: () => {
            const n = resetGlassAlpha();
            if (range.current) range.current.value = String(n);
            glassAlpha.next = n;
            setGlass(n);
            toast(t('app.settings.blur-default'), 'success');
          },
        }),
      ]),
    ]);
  }

  function themeTree() {
    return [languageCard(), themeCard(), glassCard(), taskbarCard(), wallpaperTree()];
  }

  function defaultPermIds() {
    return (catalog.value.perms || []).filter((p) => p.default === true).map((p) => p.id);
  }

  function grantedIds(appId) {
    const set = new Set(Object.keys(grants.value[appId] || {}));
    for (const id of defaultPermIds()) set.add(id);
    return set;
  }

  async function togglePerm(permId, on) {
    const appId = permSel.value;
    if (!appId) return;
    const before = grants.value[appId] || {};
    const next = new Set(Object.keys(before));
    if (on) next.add(permId); else next.delete(permId);
    const pairs = [...next].map((k) => [k, before[k] || '']);
    grants.next = { ...grants.value, [appId]: Object.fromEntries(pairs) };
    try {
      const d = on ? await permGrant(appId, [permId]) : await permRevoke(appId, [permId]);
      if (d && d.granted) grants.next = { ...grants.value, [appId]: d.granted };
    } catch (e) {
      grants.next = { ...grants.value, [appId]: before };
      toast(t('app.settings.save-failed') + (e.message || e), 'error');
    }
  }

  async function clearAllPerms() {
    const sel = permApps.value.find((a) => a.id === permSel.value);
    if (!sel) return;
    const ok = await confirmAction(
      tf('app.settings.confirm-clear-title', { v1: (appName(sel) || sel.id) }),
      t('app.settings.confirm-clear-body'),
      { okText: t('app.settings.action-clear') },
    );
    if (!ok) return;
    try {
      await permClear(permSel.value);
      grants.next = { ...grants.value, [permSel.value]: {} };
      try { notifySessionRevoked(permSel.value); } catch { }
      toast(t('app.settings.grants-cleared'), 'success');
    } catch (e) {
      toast(t('app.settings.clear-failed') + (e.message || e), 'error');
    }
  }

  async function revokeAppSession() {
    const sel = permApps.value.find((a) => a.id === permSel.value);
    if (!sel) return;
    const ok = await confirmAction(
      tf('app.settings.confirm-revoke-title', { v1: (appName(sel) || sel.id) }),
      t('app.settings.confirm-revoke-body'),
      { okText: t('app.settings.action-revoke-tokens') },
    );
    if (!ok) return;
    try {
      const { sysCall } = await import('/assets/js/core/sys.js');
      await sysCall('session/revoke', { app: sel.id });
      try { notifySessionRevoked(sel.id); } catch { }
      toast(t('app.settings.revoke-tokens-success'), 'success');
    } catch (e) {
      toast(t('app.settings.revoke-tokens-failed') + (e.message || e), 'error');
    }
  }

  const onPermAppSearch = debounce((v) => { permAq.next = v; }, 250);
  const onPermNodeSearch = debounce((v) => { permQ.next = v; }, 250);

  function appSearchBox() {
    return searchBox(t('app.settings.perm-search-apps'), (v) => onPermAppSearch(v));
  }

  function nodeSearchBox() {
    return searchBox(t('app.settings.perm-search-nodes'), (v) => onPermNodeSearch(v));
  }

  function appListTree() {
    const q = permAq.value.toLowerCase();
    const hitApp = (a) => !q
      || String(appName(a)).toLowerCase().includes(q)
      || String(a.id || '').toLowerCase().includes(q);

    const appRows = permApps.value.filter(hitApp).map((a) => {
      const count = Object.keys(grants.value[a.id] || {}).length;
      return h('button', {
        key: a.id,
        class: 'st-app-row',
        type: 'button',
        onClick: () => {
          permSel.next = a.id;
          permView.next = 'detail';
          permQ.next = '';
        },
      }, [
        h('span', { class: 'st-app-icon', html: appIcon(a.icon || a.id, 'qicon', a.id) }),
        h('span', { class: 'st-app-name', text: appName(a) || a.id }),
        a.systemApp === true
          ? badge(t('app.settings.perm-group-system'), 'success')
          : h('span', { class: 'st-app-count', text: count ? tf('app.settings.perm-granted-count', { v1: count }) : t('app.settings.perm-not-granted') }),
        h('span', { class: 'st-app-chevron', html: icon('chevron', 'qicon qicon-sm') }),
      ]);
    });

    return h('div', { class: 'st-card-stack' }, [
      h('div', { class: 'st-perm-tools' }, [appSearchBox()]),
      card(t('app.settings.perm-group-app'), [h('div', {
        class: 'st-app-list',
      }, appRows.length ? appRows : [emptyState(t('app.settings.perm-no-apps'))])]),
    ]);
  }

  function permRow(p, selSystem, granted) {
    const isDef = p.default === true;
    const on = granted.has(p.id) || isDef;
    const danger = Number(p.danger) || 0;
    const desc = pickTerm(p.descKey, p.desc);
    return h('label', { class: 'st-perm-row', title: p.id }, [
      h('span', { class: 'st-perm-main' }, [
        h('span', { class: 'st-perm-label', text: pickTerm(p.labelKey, p.label) }),
        isDef ? badge(t('app.settings.risk-default'), 'success') : null,
        danger ? badge(danger >= 3 ? t('app.settings.risk-high') : danger === 2 ? t('app.settings.risk-moderate') : t('app.settings.risk-caution'), danger >= 2 ? 'danger' : 'warn') : null,
        h('span', { class: 'st-perm-id mono', text: p.id }),
      ].filter(Boolean)),
      desc ? h('span', { class: 'st-perm-desc', text: desc }) : null,
      isDef ? null : h('input', {
        type: 'checkbox',
        checked: on,
        disabled: selSystem || !permSel.value,
        ref: (el) => { if (el) el.checked = on; },
        onChange: (e) => togglePerm(p.id, e.target.checked),
      }),
    ]);
  }

  function permDetailTree() {
    const sel = permApps.value.find((a) => a.id === permSel.value) || null;
    if (!sel) return appListTree();
    const selSystem = sel.systemApp === true;
    const granted = grantedIds(sel.id);
    const count = granted.size;

    const q = permQ.value.toLowerCase();
    const hitP = (p) => !q
      || String(p.id).toLowerCase().includes(q)
      || String(pickTerm(p.labelKey, p.label) || '').toLowerCase().includes(q)
      || String(pickTerm(p.descKey, p.desc) || '').toLowerCase().includes(q);

    const backBtn = h('button', {
      class: 'btn btn-ghost btn-sm st-detail-back',
      type: 'button',
      html: tf('app.settings.nav-back', { v1: (icon('chevron', 'qicon qicon-sm st-back-ic')) }),
      onClick: () => { permView.next = 'list'; },
    });

    const headBar = h('div', { class: 'st-detail-head' }, [
      backBtn,
      h('span', { class: 'st-app-icon st-detail-icon', html: appIcon(sel.icon || sel.id, 'qicon', sel.id) }),
      h('div', { class: 'st-detail-title' }, [
        h('span', { class: 'st-app-name', text: appName(sel) || sel.id }),
        selSystem
          ? badge(t('app.settings.perm-group-system'), 'success')
          : h('span', { class: 'st-app-count', text: count ? tf('app.settings.perm-granted-count', { v1: count }) : t('app.settings.perm-not-granted') }),
      ]),
      !selSystem ? h('button', {
        class: 'btn btn-ghost btn-sm', text: t('app.settings.action-revoke-tokens'), onClick: revokeAppSession,
      }) : null,
      !selSystem ? h('button', {
        class: 'btn btn-ghost btn-sm', text: t('app.settings.action-revoke-all'), onClick: clearAllPerms,
      }) : null,
    ].filter(Boolean));

    const matrixNote = selSystem
      ? h('div', {
        class: 'st-perm-note',
        text: t('app.settings.system-app-trusted'),
      })
      : null;

    const groupCards = catalog.value.groups.map((g) => {
      const all = (catalog.value.perms || []).filter((p) => p.group === g.key);
      const rows = all.filter(hitP);
      if (!rows.length) return null;
      const onCount = all.filter((p) => granted.has(p.id)).length;
      const seeded = all.some((p) => p.default === true);
      return h(Collapsible, {
        key: q ? `${g.key}#search` : g.key,
        title: tf('app.settings.perm-group-progress', { v1: pickTerm(g.labelKey, g.label), v2: onCount, v3: (all.length) }),
        body: rows.map((p) => permRow(p, selSystem, granted)),
        open: !!q || seeded,
        cls: 'st-perm-fold',
      });
    }).filter(Boolean);

    return h('div', { class: 'st-card-stack' }, [
      headBar,
      h('div', { class: 'st-perm-tools' }, [nodeSearchBox()]),
      matrixNote,
      h('div', { class: 'st-perm-groups' },
        groupCards.length ? groupCards : [emptyState(t('app.settings.perm-no-match'))]),
    ]);
  }

  function permMainTree() {
    if (permErr.value) return errorState(t('app.settings.perm-catalog-failed') + permErr.value);
    if (!permLoaded.value) return spinner(t('app.settings.perm-catalog-loading'));
    return permView.value === 'detail' ? permDetailTree() : appListTree();
  }

  const contentByTab = {
    system: systemTree,
    theme: themeTree,
    apps: permMainTree,
  };

  function rootTree() {
    lang();
    const body = contentByTab[activeTab.value]();
    const sidebar = h('aside', { class: 'cmp-sidebar' },
      sidebarSections([{ items: tabsNow() }], activeTab.value, (id) => { activeTab.next = id; }));
    const nodes = (Array.isArray(body) ? body : [body]).filter(Boolean);
    const stack = nodes.length > 1
      ? h('div', { class: 'st-card-stack' }, nodes)
      : nodes[0];
    return h('div', { class: 'app-settings' }, [
      sidebar,
      h('div', { class: 'st-content' }, [h('div', { class: 'st-content-scroll' }, stack)]),
    ]);
  }

  const view = createView(el);
  view.update(rootTree);

  effect(() => {
    const t = activeTab.value;
    if (t === 'system') ensureHostCfg();
    if (t === 'apps') ensurePermData().catch(() => { });
  });



  return () => {
    offTheme();
    onPermAppSearch.cancel();
    onPermNodeSearch.cancel();
    broadcastGlass.cancel();
    view.unmount();
  };
}

setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'],
}).catch(() => { }).then(() => {
  bootApp(({ root, hostId, params, ctx }) => boot(root, { ...(ctx || {}), hostId, initialTab: params.tab || undefined }));
});
