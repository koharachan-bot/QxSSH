/**
 * api.js —— Docker 交互层
 * 要点：所有命令都以 argv 数组下发（宿主逐项单引号转义，天然免疫 shell 注入），
 * 输出统一走 --format '{{json .}}' 便于解析；需要 root 的操作自动申请 sudo 并缓存提权状态。
 */
import { t } from '/assets/js/core/i18n.js';
import { execRun, execStream, execWSUrl } from '/assets/js/core/qxssh-api.js';
import { isSudoPermError, requestSudoElevation } from '/assets/js/core/sys.js';
import { parseJsonLines, parseInspect, toBase64, shq } from './format.js';

const T_QUERY = 30;
const T_ACTION = 60;
const T_PULL = 300;
const T_WRITE = 60;

/** 已确认可提权的主机，避免每次操作都弹一次授权 */
const elevHosts = new Set();

/** 统一执行结果：{ ok, out, err, exit } */
function normalize(r) {
  const out = r && typeof r.output === 'string' ? r.output : '';
  if (r && r.ok) return { ok: true, out, err: '', exit: 0 };
  const err = (r && (r.error || r.output)) || '';
  return { ok: false, out, err: String(err || out || 'command failed'), exit: (r && r.exit) || 1 };
}

/** 判断输出是否属于“需要提权”的典型错误 */
function needRoot(text) {
  const s = String(text || '').toLowerCase();
  return isSudoPermError(text)
    || s.includes('permission denied while trying to connect to the docker daemon socket')
    || s.includes('got permission denied')
    || s.includes('permission denied')
    || s.includes('are you trying to connect to a tls-enabled daemon')
    || s.includes('must be root')
    || s.includes('access denied')
    || s.includes('operation not permitted');
}

/**
 * 执行 docker 命令。
 * @param {string} host 目标主机（空串表示宿主机本机）
 * @param {string[]} argv 完整命令数组
 * @param {object} [opts] { timeout, elevated, stdin }
 */
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
    return { ok: false, out: '', err: e && e.message ? e.message : String(e), exit: -1, thrown: true };
  }
}

/**
 * 需要 root 的操作：先按普通权限执行，遇到权限错误再申请提权重试一次。
 */
async function runRoot(host, argv, opts) {
  const o = { timeout: T_ACTION, ...(opts || {}) };
  const already = elevHosts.has(host) || !!o.elevated;
  let r = await run(host, argv, { ...o, elevated: already });
  if (r.ok) { if (already) elevHosts.add(host); return r; }
  if (already || !needRoot(r.err + ' ' + r.out)) return r;

  const res = await requestSudoElevation(host, {
    title: t('app.docker.name'),
    reason: t('app.docker.need-sudo'),
  });
  if (!res || !res.ok) {
    return { ok: false, out: '', err: (res && res.error) || t('app.docker.need-sudo'), exit: 1 };
  }
  elevHosts.add(host);
  r = await run(host, argv, { ...o, elevated: true });
  return r;
}

/** 供 UI 判断当前是否已提权 */
export function isElevated(host) {
  return elevHosts.has(host);
}

/** 清除提权缓存（切换主机或用户手动降权时） */
export function forgetElevation(host) {
  if (host) elevHosts.delete(host);
  else elevHosts.clear();
}

/* ------------------------------------------------------------------ *
 * 环境探测
 * ------------------------------------------------------------------ */

/**
 * 探测目标环境的 docker 能力。
 * @returns {Promise<{installed:boolean, client:string, server:string, compose:string, composeV2:boolean, user:string, socketWritable:boolean, rootless:boolean, error:string, raw:string}>}
 */
export async function detect(host) {
  const script = [
    'command -v docker >/dev/null 2>&1 && docker --version 2>&1 || echo "NO_DOCKER"',
    'echo "@@SPLIT@@"',
    'docker compose version --short 2>/dev/null || docker-compose --version 2>/dev/null || echo "NO_COMPOSE"',
    'echo "@@SPLIT@@"',
    'docker info --format "{{.ServerVersion}}|{{.OperatingSystem}}|{{.Driver}}|{{.DockerRootDir}}" 2>&1 | head -2',
    'echo "@@SPLIT@@"',
    'id -un 2>/dev/null || echo "?"',
    'echo "@@SPLIT@@"',
    'docker info --format "{{.SecurityOptions}}" 2>/dev/null | head -1',
    'echo "@@SPLIT@@"',
    '( [ -w /var/run/docker.sock ] && echo sock-rw || echo sock-ro )',
  ].join('; ');

  const r = await run(host, ['sh', '-c', script], { timeout: 40 });
  const parts = String(r.out || '').split('@@SPLIT@@').map((x) => x.trim());
  const raw = r.out || r.err || '';

  if (/NO_DOCKER/.test(parts[0] || '') || (r.thrown && !raw)) {
    return {
      installed: false,
      client: '', server: '', compose: '', composeV2: false, user: '', socketWritable: false,
      rootless: false, error: t('app.docker.not-installed'), raw,
    };
  }

  const infoLine = (parts[2] || '').split('\n')[0].trim();
  const infoBits = infoLine.split('|');
  const server = /error|denied|cannot connect/i.test(infoLine) ? '' : (infoBits[0] || '');
  const secOpts = parts[4] || '';

  const composeRaw = parts[1] || '';
  const composeV2 = /^v?2\.|^\d+\.\d+/.test(composeRaw) && !/^docker-compose version/i.test(composeRaw);

  return {
    installed: true,
    client: (parts[0] || '').replace(/^Docker version\s*/i, '').split(',')[0].trim(),
    server,
    os: infoBits[1] || '',
    driver: infoBits[2] || '',
    dataRoot: infoBits[3] || '',
    compose: composeRaw.replace(/^NO_COMPOSE$/,''),
    composeV2: composeRaw && !/NO_COMPOSE/.test(composeRaw) && composeV2,
    user: parts[3] || '',
    rootless: /rootless/i.test(secOpts),
    socketWritable: /sock-rw/.test(parts[5] || ''),
    error: server ? '' : (t('app.docker.daemon-down')),
    raw,
  };
}

/** docker info 全量（含镜像加速站配置） */
export async function daemonInfo(host) {
  const r = await run(host, ['docker', 'info', '--format', '{{json .}}'], { timeout: 40 });
  if (!r.ok) throw new Error(r.err || r.out || 'docker info failed');
  try {
    return JSON.parse(r.out);
  } catch (e) {
    throw new Error('docker info 输出解析失败');
  }
}

/** docker system df 磁盘占用 */
export async function diskUsage(host) {
  const r = await run(host, ['docker', 'system', 'df', '--format', '{{json .}}'], { timeout: 40 });
  if (!r.ok) return [];
  return parseJsonLines(r.out);
}

/* ------------------------------------------------------------------ *
 * 容器
 * ------------------------------------------------------------------ */

/** 容器列表（默认含已停止） */
export async function listContainers(host, { all = true } = {}) {
  const argv = ['docker', 'ps', '--no-trunc', '--format', '{{json .}}'];
  if (all !== false) argv.splice(2, 0, '-a');
  const r = await run(host, argv, { timeout: 40 });
  if (!r.ok) throw new Error(r.err || 'docker ps failed');
  return parseJsonLines(r.out);
}

/** 单个容器 inspect（返回对象） */
export async function inspectContainer(host, id) {
  const r = await run(host, ['docker', 'inspect', id], { timeout: 30 });
  if (!r.ok) throw new Error(r.err || r.out || 'docker inspect failed');
  return parseInspect(r.out);
}

/** 容器生命周期操作：start/stop/restart/pause/unpause/kill/remove */
export async function containerAction(host, id, action) {
  const allowed = ['start', 'stop', 'restart', 'pause', 'unpause', 'kill', 'remove'];
  if (!allowed.includes(action)) throw new Error('不支持的操作：' + action);
  const argv = action === 'remove'
    ? ['docker', 'rm', '-f', id]
    : ['docker', action, id];
  const r = await run(host, argv, { timeout: T_ACTION });
  if (!r.ok) throw new Error(r.err || r.out || ('docker ' + action + ' 失败'));
  return { ok: true, output: r.out };
}

/** 批量容器操作，返回每条结果 */
export async function containerBatch(host, ids, action) {
  const out = [];
  for (const id of ids) {
    try {
      await containerAction(host, id, action);
      out.push({ id, ok: true });
    } catch (e) {
      out.push({ id, ok: false, error: e.message || String(e) });
    }
  }
  return out;
}

/** 容器日志 */
export async function containerLogs(host, id, { tail = 400, timestamps = true, since = '', until = '' } = {}) {
  const argv = ['docker', 'logs', '--tail', String(Math.max(1, Math.min(5000, Number(tail) || 400)))];
  if (timestamps) argv.push('--timestamps');
  if (since) argv.push('--since', String(since));
  if (until) argv.push('--until', String(until));
  argv.push(id);
  const r = await run(host, argv, { timeout: 90 });
  const text = [r.out, r.err].filter(Boolean).join('\n');
  return text.replace(/^\n+/, '');
}

/** 容器资源采样（一次性快照） */
export async function containerStats(host) {
  const r = await run(host, ['docker', 'stats', '--no-stream', '--no-trunc', '--format', '{{json .}}'], { timeout: 60 });
  if (!r.ok) return [];
  return parseJsonLines(r.out);
}

/** 容器内进程 */
export async function containerTop(host, id) {
  const r = await run(host, ['docker', 'top', id], { timeout: 30 });
  return r.out || r.err || '';
}

/** 在容器内执行一次性命令（非交互） */
export async function containerExec(host, id, command, { shell = 'sh' } = {}) {
  if (!command || !String(command).trim()) throw new Error('命令不能为空');
  const r = await run(host, ['docker', 'exec', id, shell, '-c', String(command)], { timeout: 120 });
  return { ok: r.ok, output: [r.out, r.err && r.ok ? '' : r.err].filter(Boolean).join('\n').trim(), exit: r.exit };
}

/** 容器内文件系统差异（相对镜像） */
export async function containerDiff(host, id) {
  const r = await run(host, ['docker', 'diff', id], { timeout: 30 });
  return r.out || '';
}

/** 重命名容器 */
export async function renameContainer(host, id, name) {
  const r = await run(host, ['docker', 'rename', id, name], { timeout: T_ACTION });
  if (!r.ok) throw new Error(r.err || r.out || 'rename failed');
  return true;
}

/** 提交容器为新镜像 */
export async function commitContainer(host, id, ref) {
  const r = await run(host, ['docker', 'commit', id, ref], { timeout: T_ACTION });
  if (!r.ok) throw new Error(r.err || r.out || 'commit failed');
  return r.out.trim();
}

/** 更新容器重启策略 / 资源限制（docker update） */
export async function updateContainer(host, id, { restart = '', memory = '', cpus = '' } = {}) {
  const argv = ['docker', 'update'];
  if (restart) argv.push('--restart', restart);
  if (memory) argv.push('--memory', memory);
  if (cpus) argv.push('--cpus', String(cpus));
  argv.push(id);
  if (argv.length === 3) throw new Error('没有可更新的参数');
  const r = await run(host, argv, { timeout: T_ACTION });
  if (!r.ok) throw new Error(r.err || r.out || 'update failed');
  return true;
}

/**
 * 创建并启动容器（傻瓜模式的一键运行）。
 * @param {object} spec { image, name, ports:[], envs:[], volumes:[], restart, network, command, autoRemove }
 */
export async function runContainer(host, spec) {
  const s = spec || {};
  if (!s.image) throw new Error(t('app.docker.run-need-image'));
  const argv = ['docker', 'run', '-d'];
  if (s.name) argv.push('--name', String(s.name).trim());
  for (const p of (s.ports || [])) {
    const v = String(p).trim();
    if (!/^\d+(:\d+)?(\/(tcp|udp))?$/.test(v)) throw new Error('端口格式不合法：' + v);
    argv.push('-p', v);
  }
  for (const e of (s.envs || [])) {
    const v = String(e).trim();
    if (!v) continue;
    if (!v.includes('=')) throw new Error('环境变量需为 KEY=VALUE：' + v);
    argv.push('-e', v);
  }
  for (const m of (s.volumes || [])) {
    const v = String(m).trim();
    if (!v.includes(':')) throw new Error('挂载需为 宿主目录:容器目录：' + v);
    argv.push('-v', v);
  }
  if (s.network) argv.push('--network', String(s.network));
  if (s.restart) argv.push('--restart', String(s.restart));
  if (s.autoRemove) argv.push('--rm');
  if (s.hostname) argv.push('--hostname', String(s.hostname));
  argv.push(String(s.image).trim());
  if (s.command && String(s.command).trim()) {
    argv.push('sh', '-c', String(s.command));
  }
  const r = await run(host, argv, { timeout: T_ACTION });
  if (!r.ok) throw new Error(r.err || r.out || 'docker run failed');
  return r.out.trim();
}

/* ------------------------------------------------------------------ *
 * 镜像
 * ------------------------------------------------------------------ */

export async function listImages(host) {
  const r = await run(host, ['docker', 'images', '--no-trunc', '--format', '{{json .}}'], { timeout: 45 });
  if (!r.ok) throw new Error(r.err || 'docker images failed');
  return parseJsonLines(r.out);
}

export async function inspectImage(host, ref) {
  const r = await run(host, ['docker', 'inspect', ref], { timeout: 30 });
  if (!r.ok) throw new Error(r.err || r.out || 'inspect failed');
  return parseInspect(r.out);
}

/** 拉取镜像；经国内加速站前缀中转时先拉再打 tag */
export async function pullImage(host, ref, { mirrorPrefix = '' } = {}) {
  const target = String(ref || '').trim();
  if (!target) throw new Error('镜像名不能为空');
  const from = mirrorPrefix ? mirrorPrefix.replace(/\/+$/, '') + '/' + target : target;
  const r = await run(host, ['docker', 'pull', from], { timeout: T_PULL });
  if (!r.ok) throw new Error(r.err || r.out || 'docker pull failed');
  if (mirrorPrefix) {
    const tag = await run(host, ['docker', 'tag', from, target], { timeout: T_ACTION });
    if (!tag.ok) throw new Error('镜像已拉取但打标签失败：' + (tag.err || tag.out));
    return { ok: true, output: r.out.trim(), retagged: true };
  }
  return { ok: true, output: r.out.trim(), retagged: false };
}

export async function removeImage(host, ref, { force = false } = {}) {
  const argv = ['docker', 'rmi'];
  if (force) argv.push('-f');
  argv.push(ref);
  const r = await run(host, argv, { timeout: T_ACTION });
  if (!r.ok) throw new Error(r.err || r.out || 'docker rmi failed');
  return r.out.trim();
}

export async function tagImage(host, source, target) {
  const r = await run(host, ['docker', 'tag', source, target], { timeout: T_ACTION });
  if (!r.ok) throw new Error(r.err || r.out || 'docker tag failed');
  return true;
}

export async function imageHistory(host, ref) {
  const r = await run(host, ['docker', 'history', '--no-trunc', '--format', '{{json .}}', ref], { timeout: 45 });
  if (!r.ok) return [];
  return parseJsonLines(r.out);
}

/* ------------------------------------------------------------------ *
 * 网络与卷
 * ------------------------------------------------------------------ */

export async function listNetworks(host) {
  const r = await run(host, ['docker', 'network', 'ls', '--no-trunc', '--format', '{{json .}}'], { timeout: 40 });
  if (!r.ok) throw new Error(r.err || 'docker network ls failed');
  return parseJsonLines(r.out);
}

export async function inspectNetwork(host, id) {
  const r = await run(host, ['docker', 'network', 'inspect', id], { timeout: 30 });
  if (!r.ok) throw new Error(r.err || r.out || 'network inspect failed');
  return parseInspect(r.out);
}

export async function createNetwork(host, name, { driver = 'bridge' } = {}) {
  if (!name || !String(name).trim()) throw new Error('网络名不能为空');
  const r = await run(host, ['docker', 'network', 'create', '--driver', driver, String(name).trim()], { timeout: T_ACTION });
  if (!r.ok) throw new Error(r.err || r.out || 'network create failed');
  return r.out.trim();
}

export async function removeNetwork(host, id) {
  const r = await run(host, ['docker', 'network', 'rm', id], { timeout: T_ACTION });
  if (!r.ok) throw new Error(r.err || r.out || 'network rm failed');
  return true;
}

export async function listVolumes(host) {
  const r = await run(host, ['docker', 'volume', 'ls', '--format', '{{json .}}'], { timeout: 40 });
  if (!r.ok) throw new Error(r.err || 'docker volume ls failed');
  return parseJsonLines(r.out);
}

export async function inspectVolume(host, name) {
  const r = await run(host, ['docker', 'volume', 'inspect', name], { timeout: 30 });
  if (!r.ok) throw new Error(r.err || r.out || 'volume inspect failed');
  return parseInspect(r.out);
}

export async function createVolume(host, name) {
  if (!name || !String(name).trim()) throw new Error('卷名不能为空');
  const r = await run(host, ['docker', 'volume', 'create', String(name).trim()], { timeout: T_ACTION });
  if (!r.ok) throw new Error(r.err || r.out || 'volume create failed');
  return r.out.trim();
}

export async function removeVolume(host, name) {
  const r = await run(host, ['docker', 'volume', 'rm', name], { timeout: T_ACTION });
  if (!r.ok) throw new Error(r.err || r.out || 'volume rm failed');
  return true;
}

/* ------------------------------------------------------------------ *
 * 清理
 * ------------------------------------------------------------------ */

/**
 * 清理资源。
 * @param {'images'|'volumes'|'networks'|'builder'|'system'|'containers'} kind
 */
export async function prune(host, kind, { all = true, volumes = false } = {}) {
  const map = {
    images: ['docker', 'image', 'prune', all ? '-a' : '', '-f'],
    containers: ['docker', 'container', 'prune', '-f'],
    volumes: ['docker', 'volume', 'prune', '-f'],
    networks: ['docker', 'network', 'prune', '-f'],
    builder: ['docker', 'builder', 'prune', '-f'],
    system: ['docker', 'system', 'prune', '-f', volumes ? '--volumes' : ''],
  };
  const argv = (map[kind] || map.images).filter(Boolean);
  const r = await run(host, argv, { timeout: 180 });
  if (!r.ok) throw new Error(r.err || r.out || 'prune failed');
  return r.out.trim();
}

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

/** 最近事件（一次性回放，不阻塞） */
export async function listEvents(host, { since = '1h', limit = 200 } = {}) {
  const until = 'now';
  const r = await run(host, ['sh', '-c',
    'timeout 12 docker events --since ' + shq(since) + ' --until ' + shq(until) + ' --format "{{json .}}" 2>/dev/null | tail -n ' + String(limit)], { timeout: 30 });
  if (!r.ok && !r.out) return [];
  return parseJsonLines(r.out);
}

/* ------------------------------------------------------------------ *
 * Compose
 * ------------------------------------------------------------------ */

/** 列出 compose 项目 */
export async function listComposeProjects(host) {
  const v2 = await run(host, ['docker', 'compose', 'ls', '--format', 'json', '--all'], { timeout: 40 });
  if (v2.ok && String(v2.out).trim()) {
    try {
      const arr = JSON.parse(v2.out);
      if (Array.isArray(arr)) return arr.map((x) => ({ ...x, engine: 'v2' }));
    } catch (e) { /* 落到 v1 */ }
  }
  return [];
}

/**
 * Compose 项目操作。
 * @param {object} p { dir, file, project, action, service }
 */
export async function composeAction(host, p) {
  const { dir = '', file = '', project = '', action = '', service = '' } = p || {};
  const argv = ['docker', 'compose'];
  if (dir) argv.push('--project-directory', dir);
  if (file) argv.push('-f', file);
  if (project) argv.push('-p', project);
  const allowed = ['up', 'down', 'restart', 'stop', 'start', 'pull', 'build'];
  if (!allowed.includes(action)) throw new Error('不支持的 Compose 操作：' + action);
  argv.push(action);
  if (action === 'up' || action === 'down') argv.push('-d');
  if (service) argv.push(service);
  const r = await run(host, argv, { timeout: 300 });
  if (!r.ok) throw new Error(r.err || r.out || ('compose ' + action + ' failed'));
  return r.out.trim();
}

/* ------------------------------------------------------------------ *
 * 守护进程配置（中国网络环境：镜像加速站）
 * ------------------------------------------------------------------ */

const DAEMON_JSON = '/etc/docker/daemon.json';

/** 读取 /etc/docker/daemon.json，返回 { exists, text, json, error } */
export async function readDaemonConfig(host) {
  const r = await run(host, ['sh', '-c',
    'if [ -f ' + DAEMON_JSON + ' ]; then cat ' + DAEMON_JSON + '; else echo "@@NONE@@"; fi'], { timeout: 20 });
  const text = String(r.out || '').trim();
  if (!text || text === '@@NONE@@') return { exists: false, text: '', json: {}, error: '' };
  try {
    const json = JSON.parse(text);
    return { exists: true, text, json: json && typeof json === 'object' ? json : {}, error: '' };
  } catch (e) {
    return { exists: true, text, json: {}, error: 'daemon.json 不是合法 JSON：' + (e.message || e) };
  }
}

/**
 * 写入 daemon.json：先备份原文件，再用 base64 传输，避免引号与换行被 shell 吃掉。
 * 写入失败会尽量回滚到备份。
 */
export async function writeDaemonConfig(host, obj) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  const b64 = toBase64(text);
  const script = [
    'set -e',
    'mkdir -p /etc/docker',
    'ts=$(date +%Y%m%d-%H%M%S)',
    'if [ -f ' + DAEMON_JSON + ' ]; then cp ' + DAEMON_JSON + ' /etc/docker/daemon.json.bak.$ts; fi',
    'echo ' + shq(b64) + ' | base64 -d > /etc/docker/daemon.json.qxsh.tmp',
    'python3 -c "import json,sys;json.load(open(sys.argv[1]))" /etc/docker/daemon.json.qxsh.tmp 2>/dev/null || true',
    'mv /etc/docker/daemon.json.qxsh.tmp ' + DAEMON_JSON,
    'echo WRITTEN:$ts',
  ].join('\n');
  const r = await runRoot(host, ['sh', '-c', script], { timeout: T_WRITE });
  if (!r.ok) throw new Error(r.err || r.out || '写入 daemon.json 失败');
  const m = String(r.out).match(/WRITTEN:(\S+)/);
  return { ok: true, backup: m ? '/etc/docker/daemon.json.bak.' + m[1] : '' };
}

/** 重启 Docker 守护进程使配置生效 */
export async function restartDocker(host) {
  const r = await runRoot(host, ['sh', '-c',
    'systemctl restart docker 2>&1 || service docker restart 2>&1 || systemctl restart docker.socket 2>&1'], { timeout: 180 });
  if (!r.ok) throw new Error(r.err || r.out || '重启 Docker 失败');
  return r.out.trim();
}

/** 探测镜像站可用性：返回 { ok, status, latencyMs, raw } */
export async function testRegistry(host, baseUrl) {
  const url = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, status: 0, latencyMs: 0, raw: 'URL 需以 http(s):// 开头' };
  const target = url + '/v2/';
  const r = await run(host, ['sh', '-c',
    'command -v curl >/dev/null 2>&1 || { echo "NOCURL"; exit 0; }; '
    + 'curl -sS -m 10 -o /dev/null -w "%{http_code} %{time_total}" ' + shq(target) + ' 2>&1 || echo "FAIL"'], { timeout: 25 });
  const text = String(r.out || '').trim();
  if (/NOCURL/.test(text)) return { ok: false, status: 0, latencyMs: 0, raw: '目标机未安装 curl，无法测试连通性' };
  if (/FAIL|timed out|could not resolve|connection refused/i.test(text)) {
    return { ok: false, status: 0, latencyMs: 0, raw: text };
  }
  const m = text.match(/^(\d{3})\s+([\d.]+)/);
  if (!m) return { ok: false, status: 0, latencyMs: 0, raw: text };
  const status = Number(m[1]);
  // 200/401 都说明 registry v2 可达（401 是需要鉴权的正常响应）
  return { ok: status === 200 || status === 401, status, latencyMs: Math.round(parseFloat(m[2]) * 1000), raw: text };
}

/* ------------------------------------------------------------------ *
 * 专业控制台
 * ------------------------------------------------------------------ */

const SAFE_PREFIX = /^\s*(sudo\s+)?(docker|docker-compose|systemctl|journalctl|ls|cat|df|du|free|uptime|ps|top|stat|time|date|echo)\b/;

/**
 * 直接执行一条命令行（专业模式的控制台）。
 * 仅放行常用运维命令前缀，避免误把任意内容当命令执行。
 */
export async function runCommandLine(host, cmdline) {
  const cmd = String(cmdline || '').trim();
  if (!cmd) throw new Error('命令不能为空');
  if (!SAFE_PREFIX.test(cmd)) {
    throw new Error('为安全起见，仅允许以 docker / docker-compose / systemctl / journalctl 等运维命令开头');
  }
  const r = await run(host, ['sh', '-c', cmd], { timeout: 180 });
  return {
    ok: r.ok,
    output: r.ok ? r.out : ([r.out, r.err].filter(Boolean).join('\n') || r.err),
    exit: r.exit,
  };
}


/* ------------------------------------------------------------------ *
 * 流式执行（实时日志、拉取进度、构建输出、Compose 操作）
 * 与一次性 exec/run 的区别：结果边跑边回传，适合 follow 类命令。
 * ------------------------------------------------------------------ */

/**
 * 以流式方式执行 docker 子命令。
 * @param {string} host
 * @param {string[]} args docker 之后的参数
 * @param {object} streamOpts { signal, onChunk }
 */
async function stream(host, args, streamOpts) {
  const o = streamOpts || {};
  return execStream(
    { host, argv: ['docker', ...args], elevated: elevHosts.has(host) },
    { signal: o.signal, onChunk: o.onChunk },
  );
}

/**
 * 实时日志：docker logs --follow。
 * onChunk 会拿到按块到达的文本（可能不是整行），调用方需自行缓冲。
 */
export async function streamLogs(host, id, opts, streamOpts) {
  const o = opts || {};
  const tail = String(o.tail || 500);
  if (!/^\d{1,5}$/.test(tail)) throw new Error(t('app.docker.bad-tail'));
  const args = ['logs', '--tail', tail];
  if (o.timestamps) args.push('--timestamps');
  if (o.since) {
    if (!/^\d+[smhd]$/.test(String(o.since))) throw new Error(t('app.docker.bad-since'));
    args.push('--since', String(o.since));
  }
  if (o.follow !== false) args.push('--follow');
  args.push(id);
  return stream(host, args, streamOpts);
}

/** 交互式终端：返回可直接 new WebSocket(url) 的地址 */
export function execTermWSUrl(host, id, cols, rows, user) {
  const c = Math.max(1, parseInt(cols, 10) || 80);
  const r = Math.max(1, parseInt(rows, 10) || 24);
  const script = 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi';
  const argv = ['docker', 'exec', '-i', '-t'];
  if (user && user !== 'image' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/.test(user)) argv.push('-u', user);
  argv.push(id, 'sh', '-c', script);
  return execWSUrl({ host, argv, cols: c, rows: r, elevated: elevHosts.has(host) });
}

/** 流式拉取镜像（实时进度） */
export async function pullImageStream(host, ref, streamOpts) {
  const target = String(ref || '').trim();
  if (!target) throw new Error(t('app.docker.run-need-image'));
  if (/[\x00\n\r]/.test(target) || target.startsWith('-')) throw new Error(t('app.docker.bad-ref'));
  return stream(host, ['pull', target], streamOpts);
}

/** 流式构建镜像 */
export async function buildImageStream(host, dir, tag, streamOpts) {
  const d = String(dir || '').trim();
  if (!d) throw new Error(t('app.docker.build-need-dir'));
  const args = ['build'];
  if (tag) {
    const tg = String(tag).trim();
    if (/[\x00\n\r]/.test(tg)) throw new Error(t('app.docker.bad-ref'));
    args.push('-t', tg);
  }
  args.push(d);
  return stream(host, args, streamOpts);
}

/* ------------------------------------------------------------------ *
 * Compose 文件读写
 * ------------------------------------------------------------------ */

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/** 在目录里定位 compose 文件，返回绝对路径；找不到返回 '' */
export async function detectComposePath(host, dir) {
  const d = String(dir || '').trim();
  if (!d) return '';
  const script = COMPOSE_FILES.map((f) => 'if [ -f ' + shq(d + '/' + f) + ' ]; then echo ' + shq(d + '/' + f) + '; exit 0; fi').join('; ');
  const r = await run(host, ['sh', '-c', script], { timeout: 20 });
  return String(r.out || '').trim().split('\n')[0] || '';
}

/** 读取 compose 文件内容 */
export async function readComposeFile(host, dir) {
  const file = await detectComposePath(host, dir);
  if (!file) throw new Error(t('app.docker.compose-no-file'));
  const r = await run(host, ['cat', '--', file], { timeout: 30 });
  if (!r.ok) throw new Error(r.err || t('app.docker.compose-read-failed'));
  return { path: file, content: r.out };
}

/** 保存 compose 文件（stdin 传入，避免引号问题） */
export async function saveComposeFile(host, dir, content) {
  const file = await detectComposePath(host, dir);
  if (!file) throw new Error(t('app.docker.compose-no-file'));
  const body = String(content || '');
  if (body.includes('\u0000')) throw new Error(t('app.docker.compose-nul-byte'));
  const r = await run(host, ['sh', '-c', 'cat > ' + shq(file)], { timeout: 60, stdin: body });
  if (!r.ok) throw new Error(r.err || t('app.docker.compose-write-failed'));
  return { ok: true, path: file };
}

/** 流式执行 compose 动作（up/down/pull/build 的进度可见） */
export async function composeActionStream(host, p, streamOpts) {
  const { dir = '', file = '', project = '', action = '', service = '' } = p || {};
  const allowed = ['up', 'down', 'restart', 'stop', 'start', 'pull', 'build'];
  if (!allowed.includes(action)) throw new Error('不支持的 Compose 操作：' + action);
  const args = ['compose'];
  if (dir) args.push('--project-directory', dir);
  if (file) args.push('-f', file);
  if (project) args.push('-p', project);
  args.push(action);
  if (action === 'up' || action === 'down') args.push('-d');
  if (service) args.push(service);
  return stream(host, args, streamOpts);
}

/** 流式查看 compose 项目日志 */
export async function composeLogsStream(host, p, streamOpts) {
  const { dir = '', file = '', project = '', tail = 200 } = p || {};
  const args = ['compose'];
  if (dir) args.push('--project-directory', dir);
  if (file) args.push('-f', file);
  if (project) args.push('-p', project);
  args.push('logs', '--tail', String(Math.max(1, Math.min(2000, Number(tail) || 200))), '--follow', '--no-log-prefix');
  return stream(host, args, streamOpts);
}

/* ------------------------------------------------------------------ *
 * 容器重建（改配置后按原参数重建一个新容器）
 * ------------------------------------------------------------------ */

/** 从 inspect 文档推导 docker run 参数 */
export function recreateArgs(doc) {
  const cfg = doc.Config || {};
  const hc = doc.HostConfig || {};
  const image = cfg.Image || '';
  if (!image) throw new Error(t('app.docker.rebuild-no-image'));
  const name = String(doc.Name || '').replace(/^\//, '');
  if (!name) throw new Error(t('app.docker.rebuild-no-name'));

  const warnings = [];
  const extras = [];
  const runArgs = ['run', '-d', '--name', name];

  const entry = cfg.Entrypoint || [];
  let positional = (cfg.Cmd || []).slice();
  if (entry.length) {
    if (entry[0] === '') warnings.push(t('app.docker.entrypoint-default'));
    else {
      runArgs.push('--entrypoint', entry[0]);
      positional = [...entry.slice(1), ...positional];
    }
  }
  for (const e of cfg.Env || []) runArgs.push('-e', e);
  for (const b of hc.Binds || []) runArgs.push('-v', b);
  for (const [port, binds] of Object.entries(hc.PortBindings || {})) {
    const slash = port.indexOf('/');
    const base = slash >= 0 ? port.slice(0, slash) : port;
    const proto = slash >= 0 ? port.slice(slash + 1) : '';
    for (const bp of binds || []) {
      let spec = base;
      if (bp.HostPort && bp.HostIp) spec = bp.HostIp + ':' + bp.HostPort + ':' + base;
      else if (bp.HostPort) spec = bp.HostPort + ':' + base;
      else if (bp.HostIp) spec = bp.HostIp + '::' + base;
      if (proto) spec += '/' + proto;
      runArgs.push('-p', spec);
    }
  }
  for (const port of Object.keys(cfg.ExposedPorts || {})) runArgs.push('--expose', port);
  for (const [k, v] of Object.entries(cfg.Labels || {})) runArgs.push('-l', k + '=' + v);
  const pol = (hc.RestartPolicy || {}).Name || '';
  if (pol && pol !== 'no') runArgs.push('--restart', pol);
  if (hc.Privileged) runArgs.push('--privileged');
  if (hc.ReadonlyRootfs) runArgs.push('--read-only');
  for (const c of hc.CapAdd || []) runArgs.push('--cap-add', c);
  for (const h of hc.AddHost || []) runArgs.push('--add-host', h);
  for (const l of hc.Links || []) runArgs.push('--link', l);
  if (cfg.WorkingDir) runArgs.push('-w', cfg.WorkingDir);
  if (cfg.User) runArgs.push('-u', cfg.User);

  const nets = (doc.NetworkSettings || {}).Networks || {};
  const names = Object.keys(nets).sort();
  const mode = hc.NetworkMode || '';
  let primary = '';
  if (mode && mode !== 'default') primary = mode;
  else if (names.length) primary = names[0];
  if (primary) {
    runArgs.push('--network', primary);
    for (const al of (nets[primary] || {}).Aliases || []) {
      if (al !== name) runArgs.push('--network-alias', al);
    }
  }
  for (const n of names) {
    if (n === primary) continue;
    extras.push({ name: n, aliases: (nets[n] || {}).Aliases || [] });
  }
  runArgs.push(image, ...positional);
  return { runArgs, extras, warnings };
}

/**
 * 重建容器：停旧 → 改名占位 → 用原参数跑新容器 → 删旧容器。
 * 任一步失败都会尽量回滚，避免把用户容器弄丢。
 */
export async function recreateContainer(host, id) {
  const insp = await run(host, ['docker', 'inspect', id], { timeout: 30 });
  if (!insp.ok) throw new Error(insp.err || 'inspect failed');
  let arr;
  try { arr = JSON.parse(insp.out); } catch (e) { throw new Error(t('app.docker.inspect-unparsable')); }
  if (!Array.isArray(arr) || !arr.length) throw new Error(t('app.docker.inspect-unparsable'));
  const doc = arr[0];
  const oldName = String(doc.Name || '').replace(/^\//, '');
  const { runArgs, extras, warnings } = recreateArgs(doc);
  const wasRunning = !!(doc.State || {}).Running;

  if (wasRunning) await run(host, ['docker', 'stop', '-t', '10', id], { timeout: 60 });
  const tmpName = oldName + '.qxold-' + (Date.now() % 100000000);
  const ren = await run(host, ['docker', 'rename', id, tmpName], { timeout: 60 });
  if (!ren.ok) {
    if (wasRunning) await run(host, ['docker', 'start', id], { timeout: 60 });
    throw new Error(ren.err || 'rename failed');
  }

  const rollback = async () => {
    await run(host, ['docker', 'rename', tmpName, oldName], { timeout: 60 });
    if (wasRunning) await run(host, ['docker', 'start', oldName], { timeout: 60 });
  };

  const created = await run(host, ['docker', ...runArgs], { timeout: 120 });
  if (!created.ok) {
    await rollback();
    throw new Error(created.err || created.out || 'recreate failed');
  }
  const newId = String(created.out || '').trim().split('\n')[0];

  for (const n of extras) {
    const cargs = ['docker', 'network', 'connect'];
    for (const al of n.aliases) cargs.push('--alias', al);
    cargs.push(n.name, newId);
    const r = await run(host, cargs, { timeout: 60 });
    if (!r.ok) warnings.push(tf('app.docker.network-attach-failed', { v1: n.name, v2: firstLine(r.err) }));
  }

  const rm = await run(host, ['docker', 'rm', '-f', id], { timeout: 60 });
  if (!rm.ok) warnings.push(tf('app.docker.cleanup-failed', { v1: tmpName, v2: firstLine(rm.err) }));

  return { ok: true, id: newId, name: oldName, warnings };
}

function firstLine(s) {
  const text = String(s || '').trim();
  const i = text.indexOf('\n');
  return i < 0 ? text : text.slice(0, i);
}
