/**
 * yaml.js —— YAML 编辑页
 * 支持：按 kind/name/namespace 载入 → 编辑 → 干跑 → 应用；也可从模板新建资源。
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView, dom } from '/assets/js/core/vdom.js';
import { toast } from '/assets/js/core/ui.js';
import { card, copyButton } from '/assets/js/core/components.js';

import * as api from './api.js';
import { roughYamlCheck, downloadText } from './format.js';

const TEMPLATES = {
  deployment: [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: demo-app',
    '  namespace: default',
    'spec:',
    '  replicas: 1',
    '  selector:',
    '    matchLabels:',
    '      app: demo-app',
    '  template:',
    '    metadata:',
    '      labels:',
    '        app: demo-app',
    '    spec:',
    '      containers:',
    '        - name: app',
    '          image: nginx:1.27',
    '          ports:',
    '            - containerPort: 80',
  ].join('\n'),
  service: [
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    '  name: demo-svc',
    '  namespace: default',
    'spec:',
    '  selector:',
    '    app: demo-app',
    '  ports:',
    '    - port: 80',
    '      targetPort: 80',
    '  type: ClusterIP',
  ].join('\n'),
  configmap: [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: demo-config',
    '  namespace: default',
    'data:',
    '  KEY: value',
  ].join('\n'),
  ingress: [
    'apiVersion: networking.k8s.io/v1',
    'kind: Ingress',
    'metadata:',
    '  name: demo-ing',
    '  namespace: default',
    'spec:',
    '  rules:',
    '    - host: demo.example.com',
    '      http:',
    '        paths:',
    '          - path: /',
    '            pathType: Prefix',
    '            backend:',
    '              service:',
    '                name: demo-svc',
    '                port:',
    '                  number: 80',
  ].join('\n'),
};

export function createYamlView(deps) {
  const el = document.createElement('div');
  el.className = 'k8s-body';

  const host = () => deps.host();

  const kinds = ['pod', 'deploy', 'sts', 'ds', 'svc', 'ing', 'cm', 'secret', 'job', 'cronjob', 'ns'];
  const state = { kind: 'deploy', name: '', namespace: '' };

  const kindSelect = dom('select', {
    class: 'select k8s-mini',
    onChange: (e) => { state.kind = e.target.value; },
  }, kinds.map((k) => dom('option', { value: k, text: k })));
  const nameInput = dom('input', { class: 'input k8s-mini', type: 'text', placeholder: 'my-deploy', onInput: (e) => { state.name = e.target.value.trim(); } });
  const nsInput = dom('input', { class: 'input k8s-mini', type: 'text', placeholder: 'default', onInput: (e) => { state.namespace = e.target.value.trim(); } });

  const ta = dom('textarea', { class: 'input mono k8s-yaml-editor', rows: '20', spellcheck: 'false' });
  const status = dom('pre', { class: 'k8s-apply-out mono', text: t('app.k8s.yaml-hint') });

  async function loadResource() {
    if (!state.name) { toast(t('app.k8s.yaml-need-name'), 'warning'); nameInput.focus(); return; }
    status.textContent = t('app.k8s.loading');
    try {
      ta.value = await api.getYaml(host(), state.kind, state.name, state.namespace);
      status.textContent = t('app.k8s.yaml-loaded-ok');
    } catch (e) {
      status.textContent = e.message || String(e);
    }
  }

  async function apply(dryRun) {
    const text = String(ta.value || '');
    const chk = roughYamlCheck(text);
    if (!chk.ok) { toast(tf('app.k8s.yaml-invalid', { v1: chk.reason }), 'warning'); return; }
    status.textContent = t('app.k8s.yaml-applying');
    try {
      const r = await api.applyYaml(host(), text, { dryRun });
      status.textContent = (dryRun ? t('app.k8s.yaml-dryrun-prefix') : '') + (r.output || '');
      toast(r.ok ? t('app.k8s.yaml-applied') : t('app.k8s.yaml-apply-failed'), r.ok ? 'success' : 'danger');
      deps.onChanged?.();
    } catch (e) {
      status.textContent = e.message || String(e);
      toast(e.message || String(e), 'danger');
    }
  }

  async function removeYaml() {
    const text = String(ta.value || '');
    const chk = roughYamlCheck(text);
    if (!chk.ok) { toast(tf('app.k8s.yaml-invalid', { v1: chk.reason }), 'warning'); return; }
    status.textContent = t('app.k8s.yaml-deleting');
    try {
      const r = await api.deleteYaml(host(), text);
      status.textContent = r.output || '';
      toast(r.ok ? t('app.k8s.yaml-deleted') : t('app.k8s.yaml-apply-failed'), r.ok ? 'success' : 'danger');
      deps.onChanged?.();
    } catch (e) {
      status.textContent = e.message || String(e);
    }
  }

  function setTemplate(name) {
    if (!TEMPLATES[name]) return;
    ta.value = TEMPLATES[name];
    status.textContent = tf('app.k8s.yaml-template-loaded', { v1: name });
  }

  const bar = h('div', { class: 'k8s-toolbar' }, [
    kindSelect, nameInput, nsInput,
    h('button', { class: 'btn btn-sm btn-outline', text: t('app.k8s.yaml-load'), onClick: loadResource }),
    h('span', { class: 'qx-grow' }),
    h('div', { class: 'k8s-chips' }, [
      { id: 'deployment', label: 'Deployment' },
      { id: 'service', label: 'Service' },
      { id: 'configmap', label: 'ConfigMap' },
      { id: 'ingress', label: 'Ingress' },
    ].map((it) => h('button', {
      key: it.id,
      class: 'k8s-chip',
      type: 'button',
      text: tf('app.k8s.yaml-template', { v1: it.label }),
      onClick: () => setTemplate(it.id),
    }))),
  ]);

  const actions = h('div', { class: 'k8s-toolbar' }, [
    h('span', { class: 'k8s-dim', text: t('app.k8s.yaml-actions-hint') }),
    h('span', { class: 'qx-grow' }),
    copyButton(() => String(ta.value || ''), { tip: t('app.k8s.copy') }),
    h('button', {
      class: 'btn btn-sm btn-ghost',
      text: t('app.k8s.download'),
      onClick: () => downloadText('resource.yaml', String(ta.value || '')),
    }),
    h('button', { class: 'btn btn-sm btn-ghost', text: t('app.k8s.yaml-clear'), onClick: () => { ta.value = ''; status.textContent = ''; } }),
    h('button', { class: 'btn btn-sm btn-outline', text: t('app.k8s.yaml-dryrun'), onClick: () => apply('server') }),
    h('button', { class: 'btn btn-sm btn-danger k8s-danger', text: t('app.k8s.yaml-delete'), onClick: removeYaml }),
    h('button', { class: 'btn btn-sm btn-primary', text: t('app.k8s.yaml-apply'), onClick: () => apply('') }),
  ]);

  const editor = h('div', { class: 'k8s-yaml-wrap' }, [ta]);
  const out = h('div', { class: 'k8s-apply-wrap' }, [status]);

  const view = createView(el);
  view.update(() => h('div', { class: 'k8s-yaml-page' }, [
    card(t('app.k8s.yaml-panel-title'), [bar]),
    card(t('app.k8s.yaml-editor-title'), [editor, actions], { fill: true }),
    card(t('app.k8s.yaml-output-title'), [out]),
  ]));

  return {
    el,
    refresh: () => { },
    onShow: () => { setTimeout(() => ta.focus(), 60); },
    statusBits: () => [{ text: t('app.k8s.yaml-status') }],
    dispose: () => { view.unmount(); },
  };
}
