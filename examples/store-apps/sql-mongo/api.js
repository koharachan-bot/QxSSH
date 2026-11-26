/**
 * api.js —— 宿主接口封装层
 *
 * 插件页面运行在宿主桌面的沙箱 iframe 中（不透明源）。宿主对 /api/v1/* 与 /assets/*
 * 回显 CORS 并放行 X-Qx-Session，因此这里直接复用宿主公开的请求层：会话令牌、
 * 权限补授与错误归一都交给宿主，本文件只做字段整理，不重复实现鉴权。
 */

import { sysCall, sysGet, sysPut, sysFetch, sysUrl } from '/assets/js/core/sys.js';

/** 宿主调用失败的统一错误类型 */
export class HostError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'HostError';
    Object.assign(this, extra || {});
  }
}

/** 把 exec/run 的返回归一到固定字段，调用方无需再做空值判断 */
function normalizeExec(r) {
  if (!r || typeof r !== 'object') {
    return { ok: false, out: '', err: '宿主未返回执行结果', exit: -1, truncated: false };
  }
  return {
    ok: r.ok === true,
    out: String(r.output || ''),
    err: String(r.error || ''),
    exit: typeof r.exit === 'number' ? r.exit : (r.ok ? 0 : 1),
    truncated: r.truncated === true,
  };
}

/**
 * 在指定主机上执行一条命令。
 * host 为空串表示「运行 QxSSH 的这台机器」；argv 逐项下发，宿主负责逐项转义，
 * 因此不存在 shell 拼接注入面。密码等秘密一律走 stdin，绝不进 argv。
 */
export async function exec(opts) {
  const o = opts || {};
  try {
    const r = await sysCall('exec/run', {
      host: o.host || '',
      argv: o.argv || [],
      stdin: o.stdin || '',
      timeout: o.timeout || 30,
      elevated: false,
    });
    return normalizeExec(r);
  } catch (e) {
    return {
      ok: false, out: '', err: (e && e.message) ? e.message : String(e),
      exit: -1, truncated: false, thrown: true,
    };
  }
}

/** 读取受管主机清单（仅需 hosts:read） */
export async function listHosts() {
  try {
    const r = await sysGet('hosts/list');
    const list = r && Array.isArray(r.hosts) ? r.hosts : [];
    return list.map((h) => ({
      id: String(h.id || ''),
      name: String(h.name || h.address || h.id || ''),
      address: String(h.address || ''),
      port: Number(h.port) || 22,
      user: String(h.user || ''),
    }));
  } catch (e) {
    throw new HostError('读取主机列表失败：' + ((e && e.message) || e), { cause: e });
  }
}

/** 读取本插件的私有偏好（宿主按应用 id 隔离，值一律为字符串） */
export async function loadPrefs() {
  try {
    const r = await sysGet('prefs/self');
    return r && r.prefs && typeof r.prefs === 'object' ? r.prefs : {};
  } catch (e) {
    return {};
  }
}

/** 写入私有偏好；偏好不是关键路径，失败时静默返回 false */
export async function savePrefs(patch) {
  if (!patch || !Object.keys(patch).length) return false;
  try {
    await sysPut('prefs/self', { prefs: patch });
    return true;
  } catch (e) {
    return false;
  }
}

/** 读取 JSON 形式的偏好项 */
export function readJSON(prefs, key, fallback) {
  const raw = prefs ? prefs[key] : '';
  if (!raw || typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

/** 以 JSON 形式写入若干偏好项 */
export async function writeJSONPrefs(items) {
  const patch = {};
  for (const k of Object.keys(items || {})) patch[k] = JSON.stringify(items[k]);
  return savePrefs(patch);
}

/* ---------------- 远端文件接口（SQLite 插件用来读写库文件） ---------------- */

/** 列出远端目录内容 */
export async function remoteList(host, path) {
  const r = await sysGet('files/list', { host: host || '', path: path || '~' });
  return r && Array.isArray(r.files) ? r.files : [];
}

/** 上传本地文件到远端目录，返回远端落盘路径 */
export async function remoteUpload(host, destDir, file) {
  const form = new FormData();
  form.append('file', file, file.name);
  const r = await sysFetch('POST', 'files/upload', {
    query: { host: host || '', path: destDir || '~' },
    form,
  });
  return r && r.path ? String(r.path) : '';
}

/** 生成远端文件下载地址（宿主会为该地址附加会话凭据） */
export function remoteDownloadUrl(host, path) {
  return sysUrl('files/download', { host: host || '', path: path || '' });
}
