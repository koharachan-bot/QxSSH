/**
 * desktop/host-switch.js —— 桌面内切换主机
 * 要点：不离开桌面即可挑选另一台机器；弹窗内并发探测在线状态，选中在线主机后直接跳转到对应桌面，
 * 离线主机点击会重新探测一次，失败则提示，避免切到连不上的机器。
 */
import { h } from '../core/vdom.js';
import { signal } from '../core/signal.js';
import { dialog } from '../core/components.js';
import { getState, loadHosts } from '../core/store.js';
import { probeHost } from '../core/qxssh-api.js';
import { flushPrefs } from '../core/prefs.js';
import { toast } from '../core/ui.js';
import { t, tf } from '../core/i18n.js';
import { icon } from '../icons/index.js';

const PROBE_CONCURRENCY = 3;
// 主机多时只自动探测前若干台，其余点击时再探测，避免打开弹窗就建一堆 SSH 连接
const AUTO_PROBE_MAX = 12;

/** 拼出某台主机的桌面地址 */
export function desktopUrlFor(hostId) {
  const u = new URL('desktop.html', location.href);
  u.searchParams.set('host', hostId);
  return u.toString();
}

/** 先落盘偏好，再整页跳到目标主机的桌面 */
export function switchDesktopTo(hostId) {
  try {
    flushPrefs();
  } catch (err) {
    console.warn('[host-switch] 保存偏好失败', err);
  }
  location.replace(desktopUrlFor(hostId));
}

function osIdOf(host) {
  return host.osId || 'linux';
}

/**
 * 打开「切换主机」弹窗。
 * @param {{ currentId?: string, onPick?: (host) => void, onClosed?: () => void }} opts
 *        onPick 选中另一台可用主机时回调（由调用方负责跳转）；onClosed 弹窗关闭时回调
 */
export function openHostSwitcher({ currentId = '', onPick, onClosed } = {}) {
  const ctl = {
    query: signal(''),
    probes: signal(new Map()),
    active: signal(0),
    rev: signal(0),
  };
  const focusInput = { current: null };
  const all = { list: [...(getState().hosts || [])] };

  function setProbe(id, state) {
    ctl.probes.next = new Map(ctl.probes.value).set(id, state);
  }

  function probeOf(host) {
    if (!host || host.id === currentId) return 'ok';
    return ctl.probes.value.get(host.id) || 'idle';
  }

  async function probeOne(id) {
    setProbe(id, 'testing');
    try {
      const r = await probeHost(id);
      setProbe(id, r && r.ok ? 'ok' : 'fail');
    } catch (err) {
      console.warn('[host-switch] 探测主机失败', id, err);
      setProbe(id, 'fail');
    }
    return ctl.probes.value.get(id);
  }

  async function probeHosts(list) {
    const queue = list.filter((x) => x.id !== currentId).map((x) => x.id);
    if (!queue.length) return;
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        await probeOne(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, worker));
  }

  function filtered() {
    const q = ctl.query.value.trim().toLowerCase();
    if (!q) return all.list;
    return all.list.filter((x) => `${x.name} ${x.address} ${x.user} ${x.note || ''} ${x.group || ''}`
      .toLowerCase().includes(q));
  }

  function scrollActive() {
    requestAnimationFrame(() => {
      const el = document.querySelector('.host-switch-row.active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function move(delta) {
    const list = filtered();
    if (!list.length) return;
    ctl.active.next = (ctl.active.value + delta + list.length) % list.length;
    scrollActive();
  }

  async function pick(host) {
    if (!host) return;
    if (host.id === currentId) {
      close();
      return;
    }
    const st = probeOf(host);
    if (st === 'testing') {
      toast(t('app.switch.probing-retry'), 'info');
      return;
    }
    if (st !== 'ok') {
      const again = await probeOne(host.id);
      if (again !== 'ok') {
        toast(tf('app.switch.offline-blocked', { v1: host.name }), 'error');
        return;
      }
    }
    close();
    onPick?.(host);
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const list = filtered();
      if (!list.length) return;
      pick(list[Math.min(ctl.active.value, list.length - 1)]).catch((err) => toast(String(err), 'error'));
    }
  }

  function statusBadge(state) {
    const meta = {
      ok: { cls: 'online', text: t('app.switch.online') },
      fail: { cls: 'offline', text: t('app.switch.offline') },
      testing: { cls: 'probing', text: t('app.switch.probing') },
      idle: { cls: 'idle', text: t('app.switch.idle') },
    }[state] || { cls: 'idle', text: t('app.switch.probing') };
    return h('span', { class: `host-switch-st ${meta.cls}` }, [
      h('i', { class: 'host-switch-dot' }),
      h('span', { text: meta.text }),
    ]);
  }

  function row(host, i, active) {
    const jump = host.jumpHostId
      ? h('span', {
        class: 'host-switch-jump',
        dataset: { tip: tf('app.boot.host-jump-detail', { v1: (host.jumpHostName || host.jumpHostId) }) },
        text: tf('app.boot.host-jump-short', { v1: host.jumpHostName || t('app.boot.jump-fallback') }),
      })
      : null;
    const current = host.id === currentId;
    return h('button', {
      key: host.id,
      class: `host-switch-row${current ? ' current' : ''}${i === active ? ' active' : ''}`,
      type: 'button',
      role: 'option',
      'aria-selected': current ? 'true' : 'false',
      onClick: () => { pick(host).catch((err) => toast(String(err), 'error')); },
      onMouseenter: () => { if (ctl.active.value !== i) ctl.active.next = i; },
    }, [
      h('img', {
        class: 'host-switch-os',
        src: `/assets/images/icon/systems/${osIdOf(host)}.png`,
        alt: '',
      }),
      h('span', { class: 'host-switch-main' }, [
        h('span', { class: 'host-switch-name', text: host.name }),
        h('span', {
          class: 'host-switch-addr',
          text: `${host.user}@${host.address}:${host.port}`,
        }),
      ]),
      jump,
      current ? h('span', { class: 'host-switch-cur', text: t('app.switch.current') }) : null,
      statusBadge(probeOf(host)),
    ].filter(Boolean));
  }

  function SwitcherBody() {
    void ctl.rev.value;
    void ctl.active.value;
    const list = filtered();
    const active = Math.min(ctl.active.value, Math.max(0, list.length - 1));
    return [
      h('div', { class: 'host-switch-search' }, [
        h('span', { class: 'host-switch-search-ic', 'aria-hidden': 'true', html: icon('search', 'qicon qicon-sm') }),
        h('input', {
          ref: (el) => { focusInput.current = el; },
          class: 'host-switch-input',
          type: 'search',
          autocomplete: 'off',
          spellcheck: 'false',
          placeholder: t('app.switch.search'),
          'aria-label': t('app.switch.search'),
          onInput: (e) => {
            ctl.query.next = e.target.value;
            ctl.active.next = 0;
          },
          onKeydown: onKey,
        }),
      ]),
      h('div', {
        class: 'host-switch-list',
        role: 'listbox',
        'aria-label': t('app.switch.list'),
      }, list.length
        ? list.map((host, i) => row(host, i, active))
        : [h('div', { class: 'host-switch-empty', text: t('app.switch.empty') })]),
      h('div', { class: 'host-switch-hint', text: t('app.switch.hint') }),
    ];
  }

  const dlg = dialog({
    title: t('app.switch.title'),
    body: [h(SwitcherBody)],
    actions: [
      h('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        text: t('app.switch.close'),
        onClick: () => close(),
      }),
    ],
    onClose: (reason) => { onClosed?.(reason); },
  });

  function close() {
    dlg.close();
  }

  setTimeout(() => {
    if (focusInput.current) {
      focusInput.current.focus();
      focusInput.current.select();
    }
  }, 60);

  // 打开后先用现有列表探测，同时刷新一次主机清单，只补测新出现的主机
  probeHosts(all.list.slice(0, AUTO_PROBE_MAX));
  loadHosts()
    .then(() => {
      all.list = [...(getState().hosts || [])];
      ctl.rev.next = ctl.rev.value + 1;
      const known = new Set(ctl.probes.value.keys());
      probeHosts(all.list.filter((x) => !known.has(x.id)).slice(0, AUTO_PROBE_MAX));
    })
    .catch((err) => console.warn('[host-switch] 刷新主机列表失败', err));

  return dlg;
}
