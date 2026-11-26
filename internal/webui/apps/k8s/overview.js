/**
 * overview.js —— 集群总览（傻瓜模式首页）
 * 设计目标：不要求用户懂 kubectl，直接把“哪里不对、点哪里能看”摆出来：
 * 健康统计 + 需要注意的资源清单 + 一键操作。
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast } from '/assets/js/core/ui.js';
import {
  card, statTile, statusDot, badge, spinner, emptyState, alertBar, progressBar,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import { readyRatio, age, podTone } from './format.js';
import { openPodLogsDialog, openDescribeDialog, openScaleDialog } from './dialogs.js';

export function createOverviewView(deps) {
  const el = document.createElement('div');
  el.className = 'k8s-body';

  const loading = signal(false);
  const snap = signal(null);
  const errorText = signal('');
  const metrics = signal(null);
  const busy = signal('');

  let disposed = false;
  const host = () => deps.host();

  async function load() {
    loading.next = true;
    errorText.next = '';
    try {
      const [nodes, pods, deployments, stsds, namespaces, events] = await Promise.all([
        api.listNodes(host()).catch(() => []),
        api.listPods(host(), { namespace: '*' }).catch(() => []),
        api.listDeployments(host(), { namespace: '*' }).catch(() => []),
        api.listWorkloadOthers(host(), { namespace: '*' }).catch(() => []),
        api.listNamespaces(host()).catch(() => []),
        api.listEvents(host(), { namespace: '*', limit: 40 }).catch(() => []),
      ]);
      if (disposed) return;
      snap.next({ nodes, pods, deployments, workloads: stsds, namespaces, events });
      metrics.next(null);
    } catch (e) {
      if (disposed) return;
      errorText.next = e.message || String(e);
      snap.next(null);
    } finally {
      if (!disposed) loading.next = false;
    }
  }

  async function loadMetrics() {
    busy.next('metrics');
    try {
      const r = await api.topNodes(host());
      metrics.next(r);
      if (!r.available) toast(t('app.k8s.metrics-unavailable'), 'warning');
    } finally {
      busy.next('');
    }
  }

  /** 汇总“需要注意”的资源：不可用 Pod、就绪不足的工作负载、未就绪节点 */
  function attentionList(s) {
    const out = [];
    for (const n of (s.nodes || [])) {
      if (!n.ready) out.push({ kind: 'Node', tone: 'error', name: n.name, namespace: '', reason: t('app.k8s.attn-node-notready'), obj: n });
    }
    for (const p of (s.pods || [])) {
      const phase = String(p.phase || '');
      const bad = phase && phase !== 'Running' && phase !== 'Succeeded';
      const restarting = Number(p.restarts || 0) >= 5;
      if (!bad && !restarting) continue;
      out.push({
        kind: 'Pod',
        tone: bad ? podTone(phase) : 'warn',
        name: p.name,
        namespace: p.namespace,
        reason: bad ? phase : tf('app.k8s.attn-restarts', { v1: String(p.restarts) }),
        obj: p,
      });
    }
    for (const d of (s.deployments || [])) {
      const r = readyRatio(d.ratio);
      if (r.total === 0 || !r.ok) {
        out.push({
          kind: 'Deployment',
          tone: r.ready === 0 ? 'error' : 'warn',
          name: d.name,
          namespace: d.namespace,
          reason: tf('app.k8s.attn-notready', { v1: d.ratio || (d.ready + '/' + d.want) }),
          obj: { ...d, kind: 'Deployment' },
        });
      }
    }
    for (const w of (s.workloads || [])) {
      if (w.kind !== 'StatefulSet') continue;
      const r = readyRatio(w.ratio);
      if (r.total === 0 || !r.ok) {
        out.push({
          kind: w.kind,
          tone: r.ready === 0 ? 'error' : 'warn',
          name: w.name,
          namespace: w.namespace,
          reason: tf('app.k8s.attn-notready', { v1: w.ratio }),
          obj: w,
        });
      }
    }
    return out;
  }

  async function restartWorkload(item) {
    busy.next(item.name);
    try {
      await api.rolloutRestart(host(), item.kind, item.name, item.namespace);
      toast(tf('app.k8s.restart-ok', { v1: item.name }), 'success');
      await load();
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      busy.next('');
    }
  }

  function healthStats(s) {
    const nodesReady = (s.nodes || []).filter((n) => n.ready).length;
    const pods = s.pods || [];
    const running = pods.filter((p) => p.phase === 'Running').length;
    const deployOk = (s.deployments || []).filter((d) => readyRatio(d.ratio).ok).length;

    return h('div', { class: 'k8s-stats' }, [
      statTile(t('app.k8s.stat-nodes'), nodesReady + '/' + (s.nodes || []).length, { kind: nodesReady === (s.nodes || []).length ? 'ok' : 'warn' }),
      statTile(t('app.k8s.stat-namespaces'), String((s.namespaces || []).length)),
      statTile(t('app.k8s.stat-pods'), running + '/' + pods.length, { kind: running === pods.length ? 'ok' : '' }),
      statTile(t('app.k8s.stat-deploy'), deployOk + '/' + (s.deployments || []).length, { kind: deployOk === (s.deployments || []).length ? 'ok' : 'warn' }),
      statTile(t('app.k8s.stat-attention'), String(attentionList(s).length), { kind: attentionList(s).length ? 'warn' : 'ok' }),
    ]);
  }

  function attentionCard(s) {
    const list = attentionList(s);
    if (!list.length) {
      return card(t('app.k8s.attn-title'), h('div', { class: 'k8s-ok-all' }, [
        statusDot('on', ''),
        h('span', { text: t('app.k8s.attn-none') }),
      ]));
    }
    return card(t('app.k8s.attn-title'), h('div', { class: 'k8s-attn' }, list.slice(0, 24).map((it, i) => h('div', {
      key: it.kind + it.namespace + it.name + i,
      class: 'k8s-attn-row',
    }, [
      statusDot(it.tone === 'error' ? 'off' : 'busy', it.reason),
      badge(it.kind, it.tone === 'error' ? 'danger' : 'warn'),
      h('span', { class: 'k8s-attn-name mono', text: it.name }),
      it.namespace ? h('span', { class: 'k8s-dim mono', text: it.namespace }) : null,
      h('span', { class: 'kx-grow qx-grow' }),
      h('span', { class: 'k8s-attn-reason', text: it.reason }),
      h('div', { class: 'k8s-attn-acts' }, [
        it.kind === 'Pod'
          ? h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.act-logs'), onClick: () => openPodLogsDialog(host(), it.obj) })
          : null,
        h('button', {
          class: 'btn btn-sm btn-ghost',
          text: t('app.k8s.act-describe'),
          onClick: () => openDescribeDialog(host(), it.kind, it.name, it.namespace),
        }),
        (it.kind === 'Deployment' || it.kind === 'StatefulSet')
          ? h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.act-restart'), onClick: () => restartWorkload(it) })
          : null,
      ]),
    ]))), {
      tools: h('span', { class: 'qx-count', text: tf('app.k8s.attn-count', { v1: String(list.length) }) }),
    });
  }

  function quickCard(s) {
    const items = [
      { id: 'metrics', icon: 'activity', label: t('app.k8s.quick-metrics'), run: loadMetrics },
      { id: 'pods', icon: 'box', label: t('app.k8s.quick-pods'), run: () => deps.gotoTab('pods') },
      { id: 'workloads', icon: 'layers', label: t('app.k8s.quick-workloads'), run: () => deps.gotoTab('workloads') },
      { id: 'events', icon: 'bell', label: t('app.k8s.quick-events'), run: () => deps.gotoTab('events') },
      { id: 'yaml', icon: 'file-code', label: t('app.k8s.quick-yaml'), run: () => deps.gotoTab('yaml') },
      { id: 'console', icon: 'terminal', label: t('app.k8s.quick-console'), run: () => deps.gotoTab('console') },
    ];
    return card(t('app.k8s.quick-title'), h('div', { class: 'k8s-actions' }, items.map((it) => h('button', {
      key: it.id,
      class: 'k8s-action',
      type: 'button',
      disabled: !!busy.value,
      onClick: it.run,
    }, [
      h('span', { class: 'k8s-action-label', text: it.label }),
    ]))));
  }

  function nodeCard(s) {
    const nodes = s.nodes || [];
    if (!nodes.length) return null;
    const m = metrics.value;
    const mMap = {};
    if (m && m.available) for (const r of m.rows) mMap[r.name] = r;

    return card(t('app.k8s.nodes-title'), h('div', { class: 'k8s-nodes' }, nodes.map((n) => {
      const mr = mMap[n.name];
      const cpuPct = mr ? parseFloat(String(mr.cpuPct || '0')) : null;
      const memPct = mr ? parseFloat(String(mr.memPct || '0')) : null;
      return h('div', { key: n.name, class: 'k8s-node' }, [
        h('div', { class: 'k8s-node-head' }, [
          statusDot(n.ready ? 'on' : 'off', n.ready ? t('app.k8s.node-ready') : t('app.k8s.node-notready')),
          h('span', { class: 'k8s-node-name mono', text: n.name }),
          h('span', { class: 'qx-grow' }),
          h('span', { class: 'k8s-dim mono', text: n.version || '' }),
        ]),
        h('div', { class: 'k8s-node-meta' }, [
          h('span', { text: t('app.k8s.node-cpu') + ' ' + (n.cpu || '-') }),
          h('span', { text: t('app.k8s.node-mem') + ' ' + (n.mem || '-') }),
          h('span', { text: t('app.k8s.node-pods') + ' ' + (n.pods || '-') }),
        ]),
        cpuPct != null ? h('div', { class: 'k8s-node-bars' }, [
          h('span', { class: 'k8s-bar-label', text: 'CPU' }),
          progressBar(cpuPct, { kind: cpuPct > 85 ? 'danger' : (cpuPct > 65 ? 'warn' : '') }),
          h('span', { class: 'k8s-dim', text: String(mr.cpu || '') }),
        ]) : null,
        memPct != null ? h('div', { class: 'k8s-node-bars' }, [
          h('span', { class: 'k8s-bar-label', text: 'MEM' }),
          progressBar(memPct, { kind: memPct > 85 ? 'danger' : (memPct > 65 ? 'warn' : '') }),
          h('span', { class: 'k8s-dim', text: String(mr.mem || '') }),
        ]) : null,
      ]);
    })));
  }

  function eventCard(s) {
    const evs = (s.events || []).slice(0, 20);
    if (!evs.length) return null;
    return card(t('app.k8s.events-title'), h('div', { class: 'k8s-events' }, evs.map((e, i) => h('div', {
      key: i,
      class: 'k8s-event' + (e.type === 'Warning' ? ' warn' : ''),
    }, [
      h('span', { class: 'k8s-event-time mono', text: age(e.time) }),
      badge(e.type === 'Warning' ? t('app.k8s.event-warning') : t('app.k8s.event-normal'), e.type === 'Warning' ? 'warn' : 'default'),
      h('span', { class: 'k8s-event-reason', text: e.reason || '' }),
      h('span', { class: 'k8s-event-msg', text: (e.kind ? e.kind + '/' : '') + (e.name || '') + ' · ' + (e.message || ''), title: e.message || '' }),
    ]))));
  }

  const view = createView(el);
  view.update(() => {
    const s = snap.value;
    const err = errorText.value;
    const kids = [];

    const env = deps.env();
    if (env && !env.installed) kids.push(h('div', { class: 'k8s-banner-slot' }, [alertBar('error', t('app.k8s.not-installed'), t('app.k8s.not-installed-tip'))]));
    else if (env && !env.reachable) kids.push(h('div', { class: 'k8s-banner-slot' }, [alertBar('error', t('app.k8s.unreachable'), env.error || '')]));
    if (err) kids.push(h('div', { class: 'k8s-banner-slot' }, [alertBar('error', t('app.k8s.load-failed'), err)]));

    if (loading.value && !s) {
      kids.push(h('div', { class: 'k8s-loading' }, [spinner(t('app.k8s.loading'))]));
    } else if (s) {
      kids.push(healthStats(s));
      kids.push(h('div', { class: 'k8s-grid2' }, [quickCard(s), eventCard(s)].filter(Boolean)));
      kids.push(attentionCard(s));
      const nc = nodeCard(s);
      if (nc) kids.push(nc);
    }
    return h('div', { class: 'k8s-overview' }, kids);
  });

  return {
    el,
    refresh: load,
    onShow: load,
    statusBits: () => {
      const s = snap.value;
      if (!s) return [];
      return [{ text: tf('app.k8s.status-pods', { v1: String((s.pods || []).length) }) }];
    },
    dispose: () => { disposed = true; view.unmount(); },
  };
}
