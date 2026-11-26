/**
 * mirrors.js —— 国内镜像加速站配置（中国网络环境专用）
 * 能力：读取现有 daemon.json → 勾选加速站/日志轮转/并发调优 → 实时预览 JSON 与差异
 * → 备份写入 → 可选重启 Docker；并对每个站点做真实的连通性测试（/v2/ 探活）。
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, confirmAction } from '/assets/js/core/ui.js';
import { dom } from '/assets/js/core/vdom.js';
import {
  card, badge, segmented, codeBlock, spinner, alertBar, Collapsible, copyButton,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import { MIRRORS, REGISTRY_PROXIES, DAEMON_PRESETS, buildDaemonJson, applyProxy, pullHint } from './mirrors-data.js';
import { diffLines, downloadText } from './format.js';

/** 把相对时间/状态渲染成小徽标 */
function statusBadge(status) {
  if (status === 'active') return badge(t('app.docker.mirror-active'), 'success');
  if (status === 'legacy') return badge(t('app.docker.mirror-legacy'), 'warn');
  if (status === 'vendor') return badge(t('app.docker.mirror-vendor'), 'default');
  return badge(t('app.docker.mirror-private'), 'default');
}

export function createMirrorsView(deps) {
  const el = document.createElement('div');
  el.className = 'dk-body';

  const loading = signal(true);
  const busy = signal('');
  const daemon = signal({ exists: false, text: '', json: {}, error: '' });
  const picked = signal(new Set());
  const customUrl = signal('');
  const preset = signal('recommended');
  const dataRoot = signal('');
  const insecure = signal('');
  const tests = signal(new Map());
  const info = signal(null);

  let disposed = false;
  const host = () => deps.host();

  function planFromState() {
    const p = DAEMON_PRESETS.find((x) => x.id === preset.value) || DAEMON_PRESETS[1];
    const urls = [];
    for (const m of MIRRORS) {
      if (!picked.value.has(m.id)) continue;
      if (m.id === 'aliyun') {
        const v = String(customUrl.value || '').trim();
        if (v) urls.push(v);
        continue;
      }
      urls.push(m.url);
    }
    return {
      mirrors: urls,
      logRotate: !!p.opts.logRotate,
      liveRestore: !!p.opts.liveRestore,
      throughput: !!p.opts.throughput,
      dataRoot: dataRoot.value,
      insecure: String(insecure.value || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean),
    };
  }

  function previewJson() {
    return buildDaemonJson(daemon.value.json || {}, planFromState());
  }

  async function load() {
    loading.next = true;
    try {
      const cfg = await api.readDaemonConfig(host());
      if (disposed) return;
      daemon.next(cfg);

      // 用现有配置回填勾选与高级项，避免用户改动被“重置”
      const cur = Array.isArray(cfg.json['registry-mirrors']) ? cfg.json['registry-mirrors'] : [];
      const set = new Set();
      for (const m of MIRRORS) {
        if (cur.some((u) => String(u).replace(/\/+$/, '') === m.url.replace(/\/+$/, ''))) set.add(m.id);
      }
      if (!set.size) {
        // 首次配置：默认勾上社区常用且未标历史的几项
        for (const m of MIRRORS) if (m.status === 'active') set.add(m.id);
      }
      picked.next(set);
      if (cfg.json['data-root']) dataRoot.next(String(cfg.json['data-root']));
      if (Array.isArray(cfg.json['insecure-registries'])) insecure.next(cfg.json['insecure-registries'].join(', '));

      api.daemonInfo(host()).then((d) => { if (!disposed) info.next(d); }).catch(() => { });
    } catch (e) {
      if (!disposed) daemon.next({ exists: false, text: '', json: {}, error: e.message || String(e) });
    } finally {
      if (!disposed) loading.next = false;
    }
  }

  function togglePick(id, on) {
    const next = new Set(picked.value);
    if (on) next.add(id); else next.delete(id);
    picked.next(next);
  }

  async function testOne(url) {
    const next = new Map(tests.value);
    next.set(url, { running: true });
    tests.next(next);
    try {
      const r = await api.testRegistry(host(), url);
      const m2 = new Map(tests.value);
      m2.set(url, { running: false, ...r });
      tests.next(m2);
      return r;
    } catch (e) {
      const m2 = new Map(tests.value);
      m2.set(url, { running: false, ok: false, raw: e.message || String(e) });
      tests.next(m2);
      return null;
    }
  }

  async function testAll() {
    busy.next('test');
    const urls = [];
    for (const m of MIRRORS) {
      if (!picked.value.has(m.id)) continue;
      if (m.id === 'aliyun') {
        const v = String(customUrl.value || '').trim();
        if (v) urls.push(v);
      } else urls.push(m.url);
    }
    try {
      for (const u of urls) await testOne(u);
      const ok = [...tests.value.values()].filter((x) => x && x.ok).length;
      toast(tf('app.docker.test-done', { v1: String(ok), v2: String(urls.length) }), ok ? 'success' : 'warning');
    } finally {
      busy.next('');
    }
  }

  async function save(restart) {
    const obj = previewJson();
    busy.next(restart ? 'save-restart' : 'save');
    try {
      const res = await api.writeDaemonConfig(host(), obj);
      toast(res.backup ? tf('app.docker.save-ok-backup', { v1: res.backup }) : t('app.docker.save-ok'), 'success');
      if (restart) {
        const okRestart = await confirmAction(t('app.docker.restart-title'), t('app.docker.restart-desc'), {
          okText: t('app.docker.restart-daemon'),
          danger: false,
        });
        if (okRestart) {
          await api.restartDocker(host());
          toast(t('app.docker.restart-daemon-done'), 'success');
          deps.refreshEnv?.();
        }
      }
      await load();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      busy.next('');
    }
  }

  function mirrorRow(m) {
    const isPicked = picked.value.has(m.id);
    const url = m.id === 'aliyun' ? (String(customUrl.value || '').trim() || m.url) : m.url;
    const tr = tests.value.get(url);
    const isVendor = m.status === 'vendor';

    return h('div', { key: m.id, class: 'dk-mirror' + (isPicked ? ' is-on' : '') + (isVendor ? ' is-vendor' : '') }, [
      h('label', { class: 'dk-mirror-check' }, [
        dom('input', {
          type: 'checkbox',
          checked: isPicked,
          onChange: (e) => togglePick(m.id, e.target.checked),
        }),
      ]),
      h('div', { class: 'dk-mirror-main' }, [
        h('div', { class: 'dk-mirror-top' }, [
          h('span', { class: 'dk-mirror-name', text: m.name }),
          statusBadge(m.status),
          m.url.includes('<') && !isVendor ? null : null,
        ]),
        m.id === 'aliyun'
          ? dom('input', {
            class: 'input mono dk-mirror-input',
            type: 'text',
            placeholder: 'https://xxxxxxxx.mirror.aliyuncs.com',
            value: customUrl.value,
            onInput: (e) => { customUrl.next = e.target.value.trim(); },
          })
          : h('div', { class: 'dk-mirror-url mono', text: m.url }),
        h('div', { class: 'dk-mirror-note', text: m.note }),
      ]),
      h('div', { class: 'dk-mirror-side' }, [
        tr && tr.running ? spinner(t('app.docker.testing')) : null,
        tr && !tr.running
          ? h('span', {
            class: 'dk-test-result ' + (tr.ok ? 'ok' : 'bad'),
            text: tr.ok ? tf('app.docker.test-ok', { v1: String(tr.latencyMs) }) : t('app.docker.test-fail'),
            title: tr.raw || '',
          })
          : null,
        h('button', {
          class: 'btn btn-sm btn-ghost',
          text: t('app.docker.test-one'),
          disabled: !!tr && tr.running,
          onClick: () => testOne(url),
        }),
      ]),
    ]);
  }

  function currentCard() {
    const cfg = daemon.value;
    if (cfg.error) return alertBar('error', t('app.docker.daemon-json-invalid'), cfg.error);
    const cur = Array.isArray(cfg.json['registry-mirrors']) ? cfg.json['registry-mirrors'] : [];
    const logOpts = cfg.json['log-opts'] || {};
    const bits = [
      { k: t('app.docker.cur-file'), v: cfg.exists ? '/etc/docker/daemon.json' : t('app.docker.cur-missing') },
      { k: t('app.docker.cur-mirrors'), v: cur.length ? cur.join('  ') : t('app.docker.cur-none') },
      { k: t('app.docker.cur-log'), v: cfg.json['log-driver'] ? String(cfg.json['log-driver']) + ' ' + JSON.stringify(logOpts) : t('app.docker.cur-default') },
      { k: t('app.docker.cur-live'), v: cfg.json['live-restore'] ? 'on' : 'off' },
    ];
    if (info.value) {
      bits.push({ k: t('app.docker.cur-server'), v: String(info.value.ServerVersion || '-') });
      bits.push({ k: t('app.docker.cur-root'), v: String(info.value.DockerRootDir || '-') });
    }
    return h('div', { class: 'dk-kv-grid' }, bits.map((b) => h('div', { key: b.k, class: 'dk-kv' }, [
      h('span', { class: 'dk-kv-k', text: b.k }),
      h('span', { class: 'dk-kv-v mono', text: b.v, title: b.v }),
    ])));
  }

  function previewCard() {
    const obj = previewJson();
    const jsonText = JSON.stringify(obj, null, 2);
    const changes = diffLines(daemon.value.text || '', jsonText);
    return card(t('app.docker.preview-title'), [
      h('div', { class: 'dk-preview-bar' }, [
        h('span', { class: 'dk-dim-text', text: tf('app.docker.preview-mirror-count', { v1: String((obj['registry-mirrors'] || []).length) }) }),
        h('span', { class: 'qx-grow' }),
        copyButton(jsonText, { tip: t('app.docker.copy-json') }),
        h('button', {
          class: 'btn btn-sm btn-ghost',
          text: t('app.docker.download'),
          onClick: () => downloadText('daemon.json', jsonText),
        }),
      ]),
      h('div', { class: 'dk-preview-grid' }, [
        h('div', null, [
          h('div', { class: 'cmp-section-title', text: t('app.docker.preview-json') }),
          codeBlock(jsonText, { cls: 'mono dk-pre' }),
        ]),
        h('div', null, [
          h('div', { class: 'cmp-section-title', text: t('app.docker.preview-diff') }),
          changes.length
            ? h('div', { class: 'dk-diff mono' }, changes.map((c, i) => h('div', {
              key: i,
              class: 'dk-diff-row ' + c.kind,
              text: (c.kind === 'add' ? '+ ' : '- ') + c.text,
            })))
            : h('div', { class: 'dk-dim-text', text: t('app.docker.preview-nochange') }),
        ]),
      ]),
    ], { fill: true });
  }

  function proxyCard() {
    return card(t('app.docker.proxy-title'), [
      h('div', { class: 'dk-dim-text', text: t('app.docker.proxy-desc') }),
      h('table', { class: 'qx-table dk-proxy-table' }, [
        h('thead', null, h('tr', null, [
          h('th', { text: t('app.docker.col-from') }),
          h('th', { text: t('app.docker.col-to') }),
          h('th', { text: t('app.docker.col-note') }),
          h('th', { text: '' }),
        ])),
        h('tbody', null, REGISTRY_PROXIES.map((p) => h('tr', { key: p.from }, [
          h('td', { class: 'mono', text: p.from }),
          h('td', { class: 'mono dk-cell-dim', text: p.to }),
          h('td', { class: 'dk-cell-dim', text: p.note }),
          h('td', null, copyButton('docker pull ' + applyProxy('library/nginx:latest', [p]), {
            tip: t('app.docker.copy-cmd'),
          })),
        ]))),
      ]),
    ]);
  }

  const view = createView(el);
  view.update(() => {
    if (loading.value) return h('div', { class: 'dk-loading' }, [spinner(t('app.docker.loading'))]);

    const presetItems = DAEMON_PRESETS.map((p) => ({ value: p.id, label: p.name }));
    const presetDesc = (DAEMON_PRESETS.find((p) => p.id === preset.value) || {}).desc || '';

    const kids = [];

    if (!deps.env() || !deps.env().installed) {
      kids.push(alertBar('warning', t('app.docker.not-installed'), t('app.docker.not-installed-tip')));
    } else if (daemon.value.error) {
      kids.push(alertBar('error', t('app.docker.daemon-json-invalid'), daemon.value.error));
    }

    kids.push(card(t('app.docker.cur-title'), currentCard()));

    kids.push(card(t('app.docker.mirror-title'), [
      h('div', { class: 'dk-dim-text dk-mt8', text: t('app.docker.mirror-note') }),
      h('div', { class: 'dk-mirrors' }, MIRRORS.map((m) => mirrorRow(m))),
      h('div', { class: 'dk-toolbar dk-mt12' }, [
        h('span', { class: 'qx-grow' }),
        h('button', { class: 'btn btn-sm btn-outline', text: t('app.docker.test-all'), disabled: busy.value === 'test', onClick: testAll }),
        h('button', { class: 'btn btn-sm btn-ghost', text: t('app.docker.reload'), onClick: load }),
      ]),
    ]));

    kids.push(card(t('app.docker.preset-title'), [
      segmented(presetItems, preset.value, (v) => { preset.next = v; }),
      h('div', { class: 'dk-dim-text dk-mt8', text: presetDesc }),
      h('div', { class: 'dk-adv' }, [
        Collapsible({
          title: t('app.docker.advanced-title'),
          open: false,
          body: [
            h('label', { class: 'dk-field' }, [
              h('span', { class: 'dk-field-label', text: t('app.docker.adv-dataroot') }),
              dom('input', {
                class: 'input mono',
                type: 'text',
                value: dataRoot.value,
                placeholder: '/var/lib/docker',
                onInput: (e) => { dataRoot.next = e.target.value.trim(); },
              }),
              h('span', { class: 'dk-field-hint', text: t('app.docker.adv-dataroot-hint') }),
            ]),
            h('label', { class: 'dk-field' }, [
              h('span', { class: 'dk-field-label', text: t('app.docker.adv-insecure') }),
              dom('input', {
                class: 'input mono',
                type: 'text',
                value: insecure.value,
                placeholder: '10.0.0.5:5000',
                onInput: (e) => { insecure.next = e.target.value; },
              }),
              h('span', { class: 'dk-field-hint', text: t('app.docker.adv-insecure-hint') }),
            ]),
          ],
        }),
      ]),
    ]));

    kids.push(previewCard());

    kids.push(h('div', { class: 'dk-toolbar dk-save-bar' }, [
      h('span', { class: 'dk-dim-text', text: t('app.docker.save-hint') }),
      h('span', { class: 'qx-grow' }),
      h('button', {
        class: 'btn btn-sm btn-outline',
        text: t('app.docker.save-only'),
        disabled: !!busy.value,
        onClick: () => save(false),
      }),
      h('button', {
        class: 'btn btn-sm btn-primary',
        text: t('app.docker.save-restart'),
        disabled: !!busy.value,
        onClick: () => save(true),
      }),
    ]));

    kids.push(proxyCard());

    return h('div', { class: 'dk-mirror-view' }, kids);
  });

  return {
    el,
    refresh: load,
    onShow: () => { if (daemon.value && !daemon.value.exists && !daemon.value.error) load(); },
    statusBits: () => {
      const cur = Array.isArray(daemon.value.json['registry-mirrors']) ? daemon.value.json['registry-mirrors'] : [];
      return [{ text: tf('app.docker.status-mirrors', { v1: String(cur.length) }) }];
    },
    dispose: () => { disposed = true; view.unmount(); },
  };
}
