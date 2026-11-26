/**
 * api.js —— kubectl 交互层
 * 要点：
 *  1. 列表一律用 -o jsonpath 只取必要字段，避免大集群的 -o json 撑爆输出上限（宿主上限 1MB）；
 *  2. 所有命令以 argv 数组下发，宿主逐项单引号转义，天然免疫 shell 注入；
 *  3. 统一附带 --request-timeout，避免不可达集群把应用卡死。
 */
import { t } from '/assets/js/core/i18n.js';
import { execRun } from '/assets/js/core/qxssh-api.js';
import { isSudoPermError, requestSudoElevation } from '/assets/js/core/sys.js';
import { splitCols, readyRatio } from './format.js';

const T_QUERY = 60;
const T_ACTION = 120;
const REQ_TIMEOUT = '--request-timeout=25s';

const elevHosts = new Set();

function normalize(r) {
  const out = r && typeof r.output === 'string' ? r.output : '';
  if (r && r.ok) return { ok: true, out, err: '', exit: 0, truncated: !!r.truncated };
  const err = (r && (r.error || r.output)) || '';
  return { ok: false, out, err: String(err || out || 'command failed'), exit: (r && r.exit) || 1, truncated: !!(r && r.truncated) };
}

function needRoot(text) {
  const s = String(text || '').toLowerCase();
  return isSudoPermError(text) || s.includes('permission denied') || s.includes('must be root');
}

async function run(host, argv, opts) {
  const o = opts || {};
  try {
    const r = await execRun({
      host,
      argv,
      timeout: o.timeout || T_QUERY,
      elevated: !!o.elevated,
      stdin: o.stdin || '',
    });
    return normalize(r);
  } catch (e) {
    return { ok: false, out: '', err: e && e.message ? e.message : String(e), exit: -1, truncated: false, thrown: true };
  }
}

/** 提权重试（kubeconfig 在 root 家目录等场景） */
async function runRoot(host, argv, opts) {
  const o = { timeout: T_ACTION, ...(opts || {}) };
  const already = elevHosts.has(host) || !!o.elevated;
  let r = await run(host, argv, { ...o, elevated: already });
  if (r.ok || already || !needRoot(r.err + ' ' + r.out)) return r;
  const res = await requestSudoElevation(host, { title: t('app.k8s.name'), reason: t('app.k8s.need-sudo') });
  if (!res || !res.ok) return { ok: false, out: '', err: (res && res.error) || t('app.k8s.need-sudo'), exit: 1 };
  elevHosts.add(host);
  return run(host, argv, { ...o, elevated: true });
}

/* ------------------------------------------------------------------ *
 * 环境与上下文
 * ------------------------------------------------------------------ */

/** 探测 kubectl 与集群连通性 */
/**
 * 一键安装 kubectl：按 CPU 架构从官方 release 下载到 /usr/local/bin。
 * 需要 root（先申请 sudo）；无 curl/wget 时给出明确标记，前端据此提示手动安装。
 */
export async function installKubectl(host) {
  const res = await requestSudoElevation(host, {
    title: t('app.k8s.name'),
    reason: t('app.k8s.need-sudo'),
  });
  if (!res || !res.ok) {
    return { ok: false, out: '', err: (res && res.error) || t('app.k8s.need-sudo'), exit: 1 };
  }
  elevHosts.add(host);
  const script = [
    'set -e',
    'ARCH=$(uname -m)',
    'case "$ARCH" in',
    '  x86_64|amd64) A=amd64 ;;',
    '  aarch64|arm64) A=arm64 ;;',
    '  *) echo "QX_UNSUPPORTED_ARCH $ARCH"; exit 8 ;;',
    'esac',
    'if command -v curl >/dev/null 2>&1; then',
    '  V=$(curl -fsSL https://dl.k8s.io/release/stable.txt | tr -d "\r\n")',
    '  curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/$V/bin/linux/$A/kubectl"',
    'elif command -v wget >/dev/null 2>&1; then',
    '  V=$(wget -qO- https://dl.k8s.io/release/stable.txt | tr -d "\r\n")',
    '  wget -qO /usr/local/bin/kubectl "https://dl.k8s.io/release/$V/bin/linux/$A/kubectl"',
    'else',
    '  echo QX_NO_DOWNLOADER',
    '  exit 7',
    'fi',
    'chmod 0755 /usr/local/bin/kubectl',
    '/usr/local/bin/kubectl version --client',
  ].join('\n');
  return run(host, ['sh', '-lc', script], { timeout: 300, elevated: true });
}

export async function detect(host) {
  const script = [
    'command -v kubectl >/dev/null 2>&1 && kubectl version --client -o json 2>/dev/null | head -c 400 || echo NO_KUBECTL',
    'echo "@@S@@"',
    'kubectl config current-context 2>&1 | head -1',
    'echo "@@S@@"',
    'kubectl get ns ' + '--request-timeout=8s -o name 2>&1 | head -3',
    'echo "@@S@@"',
    '( test -r "$HOME/.kube/config" && echo kubeconfig-ok || echo kubeconfig-missing )',
  ].join('; ');

  const r = await run(host, ['sh', '-c', script], { timeout: 40 });
  const parts = String(r.out || '').split('@@S@@').map((x) => x.trim());
  const raw = r.out || r.err || '';

  if (/NO_KUBECTL/.test(parts[0] || '') || !parts.length) {
    return { installed: false, client: '', context: '', reachable: false, error: t('app.k8s.not-installed'), raw, kubeconfig: false };
  }

  let client = '';
  try {
    const j = JSON.parse((parts[0] || '').replace(/^[^{]*/, ''));
    client = j.clientVersion ? j.clientVersion.gitVersion : '';
  } catch (e) {
    const m = (parts[0] || '').match(/v\d+\.\d+\.\d+/);
    if (m) client = m[0];
  }

  const context = (parts[1] || '').split('\n')[0].trim();
  const nsOut = parts[2] || '';
  const reachable = /^namespace\//m.test(nsOut) || /^namespace\//i.test(nsOut);

  return {
    installed: true,
    client,
    context,
    reachable,
    kubeconfig: /kubeconfig-ok/.test(parts[3] || ''),
    error: reachable ? '' : (nsOut.split('\n')[0] || t('app.k8s.unreachable')),
    raw,
  };
}

/** 当前上下文与集群地址 */
export async function contextInfo(host) {
  const r = await run(host, ['kubectl', 'config', 'view', '--minify', '-o', 'json'], { timeout: 30 });
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.out);
    return {
      name: j['current-context'] || '',
      cluster: j.contexts && j.contexts[0] ? j.contexts[0].context.cluster : '',
      user: j.contexts && j.contexts[0] ? j.contexts[0].context.user : '',
      namespace: j.contexts && j.contexts[0] ? (j.contexts[0].context.namespace || 'default') : 'default',
      server: j.clusters && j.clusters[0] ? j.clusters[0].cluster.server : '',
    };
  } catch (e) {
    return null;
  }
}

/** 全部上下文名 */
export async function listContexts(host) {
  const r = await run(host, ['kubectl', 'config', 'get-contexts', '-o', 'name'], { timeout: 30 });
  if (!r.ok) return [];
  return r.out.split('\n').map((x) => x.trim()).filter(Boolean);
}

/** 切换上下文 */
export async function useContext(host, name, namespace) {
  const argv = ['kubectl', 'config', 'use-context', name];
  const r = await run(host, argv, { timeout: 30 });
  if (!r.ok) throw new Error(r.err || r.out || 'use-context failed');
  if (namespace) {
    const r2 = await run(host, ['kubectl', 'config', 'set-context', '--current', '--namespace', namespace], { timeout: 30 });
    if (!r2.ok) throw new Error(r2.err || r2.out || 'set-context failed');
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 列表查询（jsonpath 精简输出）
 * ------------------------------------------------------------------ */

const JP = (body) => 'jsonpath={range .items[*]}' + body + '{"\\n"}{end}';

/** 命名空间列表 */
export async function listNamespaces(host) {
  const jp = JP('{.metadata.name}{"\\t"}{.status.phase}{"\\t"}{.metadata.creationTimestamp}');
  const r = await run(host, ['kubectl', 'get', 'ns', '-o', jp, REQ_TIMEOUT], { timeout: T_QUERY });
  if (!r.ok) throw new Error(firstLine(r));
  return r.out.split('\n').filter(Boolean).map((line) => {
    const [name, phase, created] = splitCols(line, 3);
    return { name, phase: phase || 'Active', created };
  });
}

/** Pod 列表（含就绪与重启次数） */
export async function listPods(host, { namespace = '' } = {}) {
  const jp = JP('{.metadata.namespace}{"\\t"}{.metadata.name}{"\\t"}{.status.phase}{"\\t"}{.spec.nodeName}{"\\t"}'
    + '{.status.podIP}{"\\t"}{.status.containerStatuses[*].ready}{"\\t"}{.status.containerStatuses[*].restartCount}{"\\t"}'
    + '{.status.startTime}{"\\t"}{.spec.containers[*].name}{"\\t"}{.spec.containers[0].image}');
  const argv = namespace && namespace !== '*'
    ? ['kubectl', 'get', 'pods', '-n', namespace, '-o', jp, REQ_TIMEOUT]
    : ['kubectl', 'get', 'pods', '-A', '-o', jp, REQ_TIMEOUT];
  const r = await run(host, argv, { timeout: T_QUERY });
  if (!r.ok) throw new Error(firstLine(r));
  return r.out.split('\n').filter(Boolean).map((line) => {
    const c = splitCols(line, 10);
    const readyTxt = c[5] || '';
    const readyFlags = readyTxt ? readyTxt.split(/\s+/).filter(Boolean) : [];
    const readyCount = readyFlags.filter((x) => x === 'true').length;
    const total = readyFlags.length || (c[8] ? c[8].split(/\s+/).filter(Boolean).length : 0);
    const restarts = (c[6] || '').split(/\s+/).filter(Boolean).reduce((a, x) => a + (Number(x) || 0), 0);
    return {
      namespace: c[0],
      name: c[1],
      phase: c[2] || 'Unknown',
      node: c[3],
      ip: c[4],
      ready: total ? readyCount + '/' + total : '-',
      restarts,
      started: c[7],
      containers: c[8] ? c[8].split(/\s+/).filter(Boolean) : [],
      image: c[9],
      kind: 'Pod',
    };
  });
}

/** Deployment 列表 */
export async function listDeployments(host, { namespace = '' } = {}) {
  const jp = JP('{.metadata.namespace}{"\\t"}{.metadata.name}{"\\t"}{.spec.replicas}{"\\t"}{.status.readyReplicas}{"\\t"}'
    + '{.status.updatedReplicas}{"\\t"}{.status.availableReplicas}{"\\t"}{.metadata.creationTimestamp}{"\\t"}'
    + '{.spec.template.spec.containers[0].image}');
  const argv = namespace && namespace !== '*'
    ? ['kubectl', 'get', 'deploy', '-n', namespace, '-o', jp, REQ_TIMEOUT]
    : ['kubectl', 'get', 'deploy', '-A', '-o', jp, REQ_TIMEOUT];
  const r = await run(host, argv, { timeout: T_QUERY });
  if (!r.ok) throw new Error(firstLine(r));
  return r.out.split('\n').filter(Boolean).map((line) => {
    const c = splitCols(line, 8);
    const want = Number(c[2] || 0) || 1;
    const ready = Number(c[3] || 0);
    return {
      kind: 'Deployment',
      namespace: c[0],
      name: c[1],
      want,
      ready,
      updated: Number(c[4] || 0),
      available: Number(c[5] || 0),
      created: c[6],
      image: c[7],
      ratio: ready + '/' + want,
    };
  });
}

/** StatefulSet / DaemonSet 列表（一次拿两种） */
export async function listWorkloadOthers(host, { namespace = '' } = {}) {
  const scope = namespace && namespace !== '*' ? ['-n', namespace] : ['-A'];
  const jpSts = JP('{.metadata.namespace}{"\\t"}{.metadata.name}{"\\t"}{.spec.replicas}{"\\t"}{.status.readyReplicas}{"\\t"}{.metadata.creationTimestamp}{"\\t"}{.spec.template.spec.containers[0].image}');
  const jpDs = JP('{.metadata.namespace}{"\\t"}{.metadata.name}{"\\t"}{.status.desiredNumberScheduled}{"\\t"}{.status.numberReady}{"\\t"}{.metadata.creationTimestamp}{"\\t"}{.spec.template.spec.containers[0].image}');

  const [sts, ds] = await Promise.all([
    run(host, ['kubectl', 'get', 'sts', ...scope, '-o', jpSts, REQ_TIMEOUT], { timeout: T_QUERY }),
    run(host, ['kubectl', 'get', 'ds', ...scope, '-o', jpDs, REQ_TIMEOUT], { timeout: T_QUERY }),
  ]);

  const out = [];
  if (sts.ok) {
    for (const line of sts.out.split('\n').filter(Boolean)) {
      const c = splitCols(line, 6);
      const want = Number(c[2] || 0) || 1;
      const ready = Number(c[3] || 0);
      out.push({ kind: 'StatefulSet', namespace: c[0], name: c[1], want, ready, created: c[4], image: c[5], ratio: ready + '/' + want });
    }
  }
  if (ds.ok) {
    for (const line of ds.out.split('\n').filter(Boolean)) {
      const c = splitCols(line, 6);
      const want = Number(c[2] || 0);
      const ready = Number(c[3] || 0);
      out.push({ kind: 'DaemonSet', namespace: c[0], name: c[1], want, ready, created: c[4], image: c[5], ratio: ready + '/' + want });
    }
  }
  return out;
}

/** Service 列表 */
export async function listServices(host, { namespace = '' } = {}) {
  const jp = JP('{.metadata.namespace}{"\\t"}{.metadata.name}{"\\t"}{.spec.type}{"\\t"}{.spec.clusterIP}{"\\t"}'
    + '{.spec.ports[0].port}{"\\t"}{.spec.ports[0].targetPort}{"\\t"}{.spec.ports[0].nodePort}{"\\t"}'
    + '{.metadata.creationTimestamp}{"\\t"}{.spec.externalIPs[*]}');
  const argv = namespace && namespace !== '*'
    ? ['kubectl', 'get', 'svc', '-n', namespace, '-o', jp, REQ_TIMEOUT]
    : ['kubectl', 'get', 'svc', '-A', '-o', jp, REQ_TIMEOUT];
  const r = await run(host, argv, { timeout: T_QUERY });
  if (!r.ok) throw new Error(firstLine(r));
  return r.out.split('\n').filter(Boolean).map((line) => {
    const c = splitCols(line, 9);
    return {
      kind: 'Service',
      namespace: c[0],
      name: c[1],
      type: c[2] || 'ClusterIP',
      clusterIP: c[3],
      port: c[4],
      targetPort: c[5],
      nodePort: c[6],
      created: c[7],
      externalIPs: c[8],
    };
  });
}

/** Ingress 列表 */
export async function listIngresses(host, { namespace = '' } = {}) {
  const jp = JP('{.metadata.namespace}{"\\t"}{.metadata.name}{"\\t"}{.spec.ingressClassName}{"\\t"}'
    + '{.spec.rules[0].host}{"\\t"}{.status.loadBalancer.ingress[0].ip}{"\\t"}{.metadata.creationTimestamp}');
  const argv = namespace && namespace !== '*'
    ? ['kubectl', 'get', 'ing', '-n', namespace, '-o', jp, REQ_TIMEOUT]
    : ['kubectl', 'get', 'ing', '-A', '-o', jp, REQ_TIMEOUT];
  const r = await run(host, argv, { timeout: T_QUERY });
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map((line) => {
    const c = splitCols(line, 6);
    return {
      kind: 'Ingress',
      namespace: c[0],
      name: c[1],
      className: c[2],
      host: c[3],
      address: c[4],
      created: c[5],
    };
  });
}

/** 节点列表 */
export async function listNodes(host) {
  const jp = JP('{.metadata.name}{"\\t"}{.status.conditions[?(@.type=="Ready")].status}{"\\t"}'
    + '{.status.nodeInfo.kubeletVersion}{"\\t"}{.status.nodeInfo.osImage}{"\\t"}'
    + '{.status.capacity.cpu}{"\\t"}{.status.capacity.memory}{"\\t"}{.status.allocatable.pods}{"\\t"}'
    + '{.metadata.creationTimestamp}');
  const r = await run(host, ['kubectl', 'get', 'nodes', '-o', jp, REQ_TIMEOUT], { timeout: T_QUERY });
  if (!r.ok) throw new Error(firstLine(r));
  return r.out.split('\n').filter(Boolean).map((line) => {
    const c = splitCols(line, 8);
    return {
      name: c[0],
      ready: String(c[1] || '').toLowerCase() === 'true',
      readyRaw: c[1],
      version: c[2],
      os: c[3],
      cpu: c[4],
      mem: c[5],
      pods: c[6],
      created: c[7],
    };
  });
}

/** 事件列表 */
export async function listEvents(host, { namespace = '', limit = 300 } = {}) {
  const jp = JP('{.lastTimestamp}{"\\t"}{.type}{"\\t"}{.reason}{"\\t"}{.metadata.namespace}{"\\t"}'
    + '{.involvedObject.kind}{"\\t"}{.involvedObject.name}{"\\t"}{.count}{"\\t"}{.message}');
  const scope = namespace && namespace !== '*' ? ['-n', namespace] : ['-A'];
  const r = await run(host, ['kubectl', 'get', 'events', ...scope, '--sort-by=.lastTimestamp', '-o', jp, REQ_TIMEOUT], { timeout: T_QUERY });
  if (!r.ok) throw new Error(firstLine(r));
  const rows = r.out.split('\n').filter(Boolean).map((line) => {
    const c = splitCols(line, 8);
    return {
      time: c[0],
      type: c[1] || 'Normal',
      reason: c[2],
      namespace: c[3],
      kind: c[4],
      name: c[5],
      count: Number(c[6] || 1),
      message: c[7],
    };
  });
  return rows.slice(-limit).reverse();
}

/* ------------------------------------------------------------------ *
 * 详情与操作
 * ------------------------------------------------------------------ */

export async function describe(host, kind, name, namespace) {
  const argv = ['kubectl', 'describe', kind.toLowerCase(), name];
  if (namespace) argv.push('-n', namespace);
  const r = await run(host, argv, { timeout: T_ACTION });
  return [r.out, r.err].filter(Boolean).join('\n').trim();
}

export async function getYaml(host, kind, name, namespace) {
  const argv = ['kubectl', 'get', kind.toLowerCase(), name, '-o', 'yaml'];
  if (namespace) argv.push('-n', namespace);
  const r = await run(host, argv, { timeout: T_ACTION });
  if (!r.ok) throw new Error(firstLine(r));
  return r.out;
}

/** 删除资源 */
export async function removeResource(host, kind, name, namespace, { force = false } = {}) {
  const argv = ['kubectl', 'delete', kind.toLowerCase(), name];
  if (namespace) argv.push('-n', namespace);
  if (force) argv.push('--force', '--grace-period=0');
  const r = await runRoot(host, argv, { timeout: T_ACTION });
  if (!r.ok) throw new Error(firstLine(r));
  return r.out.trim();
}

/** 扩缩容（Deployment / StatefulSet） */
export async function scale(host, kind, name, namespace, replicas) {
  const n = Number(replicas);
  if (!Number.isFinite(n) || n < 0) throw new Error(t('app.k8s.scale-invalid'));
  const argv = ['kubectl', 'scale', kind.toLowerCase(), name, '--replicas=' + String(Math.round(n))];
  if (namespace) argv.push('-n', namespace);
  const r = await runRoot(host, argv, { timeout: T_ACTION });
  if (!r.ok) throw new Error(firstLine(r));
  return r.out.trim();
}

/** 滚动重启 */
export async function rolloutRestart(host, kind, name, namespace) {
  const argv = ['kubectl', 'rollout', 'restart', kind.toLowerCase() + '/' + name];
  if (namespace) argv.push('-n', namespace);
  const r = await runRoot(host, argv, { timeout: T_ACTION });
  if (!r.ok) throw new Error(firstLine(r));
  return r.out.trim();
}

/** 滚动状态 */
export async function rolloutStatus(host, kind, name, namespace) {
  const argv = ['kubectl', 'rollout', 'status', kind.toLowerCase() + '/' + name];
  if (namespace) argv.push('-n', namespace);
  const r = await run(host, argv, { timeout: T_ACTION });
  return { ok: r.ok, output: [r.out, r.err].filter(Boolean).join('\n').trim() };
}

/** 应用 YAML（stdin 传入） */
export async function applyYaml(host, yaml, { dryRun = '' } = {}) {
  const argv = ['kubectl', 'apply', '-f', '-'];
  if (dryRun) argv.push('--dry-run=' + dryRun);
  const r = await runRoot(host, argv, { timeout: T_ACTION, stdin: String(yaml || '') });
  return {
    ok: r.ok,
    output: [r.out, r.err].filter(Boolean).join('\n').trim(),
    exit: r.exit,
  };
}

/** 删除 YAML 中描述的资源（kubectl delete -f -） */
export async function deleteYaml(host, yaml) {
  const r = await runRoot(host, ['kubectl', 'delete', '-f', '-'], { timeout: T_ACTION, stdin: String(yaml || '') });
  return { ok: r.ok, output: [r.out, r.err].filter(Boolean).join('\n').trim() };
}

/** Pod 日志 */
export async function podLogs(host, pod, { namespace = 'default', container = '', tail = 400, timestamps = true, previous = false } = {}) {
  const argv = ['kubectl', 'logs', pod, '-n', namespace, '--tail', String(Math.max(1, Math.min(5000, Number(tail) || 400)))];
  if (container) argv.push('-c', container);
  if (timestamps) argv.push('--timestamps');
  if (previous) argv.push('--previous');
  const r = await run(host, argv, { timeout: T_ACTION });
  const text = [r.out, r.err].filter(Boolean).join('\n');
  return text.replace(/^\n+/, '');
}

/** 在 Pod 内执行命令 */
export async function execPod(host, pod, command, { namespace = 'default', container = '', shell = 'sh' } = {}) {
  if (!String(command || '').trim()) throw new Error(t('app.k8s.exec-empty'));
  const argv = ['kubectl', 'exec', pod, '-n', namespace];
  if (container) argv.push('-c', container);
  argv.push('--', shell, '-c', String(command));
  const r = await run(host, argv, { timeout: T_ACTION });
  return {
    ok: r.ok,
    output: [r.out, r.err].filter(Boolean).join('\n').trim(),
    exit: r.exit,
  };
}

/** 节点资源使用（metrics-server 缺失时返回 available:false） */
export async function topNodes(host) {
  const r = await run(host, ['kubectl', 'top', 'nodes', '--no-headers'], { timeout: 30 });
  if (!r.ok) return { available: false, rows: [], error: firstLine(r) };
  const rows = r.out.split('\n').filter(Boolean).map((line) => {
    const c = line.trim().split(/\s+/);
    return { name: c[0], cpu: c[1], cpuPct: c[2], mem: c[3], memPct: c[4] };
  });
  return { available: true, rows, error: '' };
}

/** Pod 资源使用 */
export async function topPods(host, namespace) {
  const argv = ['kubectl', 'top', 'pods', '--no-headers'];
  if (namespace && namespace !== '*') argv.push('-n', namespace);
  else argv.push('-A');
  const r = await run(host, argv, { timeout: 30 });
  if (!r.ok) return { available: false, rows: [], error: firstLine(r) };
  const rows = r.out.split('\n').filter(Boolean).map((line) => {
    const c = line.trim().split(/\s+/);
    return namespace === '*' ? { namespace: c[0], name: c[1], cpu: c[2], mem: c[3] } : { name: c[0], cpu: c[1], mem: c[2] };
  });
  return { available: true, rows, error: '' };
}

/* ------------------------------------------------------------------ *
 * 专业控制台
 * ------------------------------------------------------------------ */

const SAFE_PREFIX = /^\s*(sudo\s+)?(kubectl|helm|kustomize|kubectx|kubens|docker|systemctl|journalctl|ls|cat)\b/;

/** 直接执行一条命令行（专业模式控制台） */
export async function runCommandLine(host, cmdline) {
  const cmd = String(cmdline || '').trim();
  if (!cmd) throw new Error(t('app.k8s.console-empty-cmd'));
  if (!SAFE_PREFIX.test(cmd)) {
    throw new Error(t('app.k8s.console-blocked'));
  }
  const r = await run(host, ['sh', '-c', cmd], { timeout: 180 });
  return {
    ok: r.ok,
    output: r.ok ? r.out : ([r.out, r.err].filter(Boolean).join('\n') || r.err),
    exit: r.exit,
  };
}

function firstLine(r) {
  const text = [r.err, r.out].filter(Boolean).join('\n').trim();
  const line = text.split('\n').find((x) => x.trim()) || 'kubectl failed';
  return line.trim();
}
