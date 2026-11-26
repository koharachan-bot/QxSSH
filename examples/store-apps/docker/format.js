/**
 * format.js —— Docker 数据格式化与安全转义工具
 * 只做纯函数转换，不触碰 DOM 与网络，便于单测与复用。
 */

/** 把 --format '{{json .}}' 的多行输出解析成对象数组，坏行跳过 */
export function parseJsonLines(text) {
  const out = [];
  for (const raw of String(text == null ? '' : text).split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch (e) { /* 半行/告警行直接跳过 */ }
  }
  return out;
}

/** 解析 docker inspect 的数组输出，失败返回 null */
export function parseInspect(text) {
  try {
    const v = JSON.parse(String(text || ''));
    return Array.isArray(v) ? (v[0] || null) : v;
  } catch (e) {
    return null;
  }
}

/** 容器/镜像 ID 显示用短 ID */
export function shortId(id, len) {
  const s = String(id || '').replace(/^sha256:/, '');
  return s.slice(0, len || 12);
}

/** 去掉镜像引用里的 digest 与默认 tag，得到人类可读名字 */
export function imageRef(image) {
  const s = String(image || '');
  const noDigest = s.split('@')[0];
  return noDigest === '<none>:<none>' ? '<none>' : noDigest;
}

/** 字节数 → 人类可读（1024 进制） */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return (i === 0 ? String(Math.round(x)) : x.toFixed(x >= 100 ? 0 : (x >= 10 ? 1 : 2))) + ' ' + units[i];
}

/** Docker 自己的尺寸串（如 "1.2GB" / "512MB" / "10.5kB"）转字节，用于排序与汇总 */
export function dockerSizeToBytes(text) {
  const m = String(text || '').match(/([\d.]+)\s*([kKmMgGtTpP]?)(?:i?B)/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5 };
  return Math.round(n * (mult[m[2].toLowerCase()] || 1));
}

/** 百分比串（"12.34%"）→ 数字 */
export function parsePercent(text) {
  const m = String(text || '').match(/([\d.]+)\s*%/);
  return m ? parseFloat(m[1]) : 0;
}

/** "1.2MiB / 2GiB" → {used, limit, pct} */
export function parseMemPair(text) {
  const m = String(text || '').match(/([\d.]+\s*\w+)\s*\/\s*([\d.]+\s*\w+)/);
  if (!m) return { used: 0, limit: 0, pct: 0, text: String(text || '') };
  const used = dockerSizeToBytes(m[1]);
  const limit = dockerSizeToBytes(m[2]);
  return { used, limit, pct: limit ? (used / limit) * 100 : 0, text: String(text || '') };
}

/**
 * 解析 docker ps 的 Ports 列。
 * 形如 "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp"
 * @returns {Array<{hostIp:string, hostPort:string, containerPort:string, proto:string, exposed:boolean}>}
 */
export function parsePorts(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const m = seg.match(/^(?:([\d.]+|::|\[?[0-9a-f:]*\]?):)?(\d+)->(\d+)\/(\w+)$/);
    if (m) {
      out.push({
        hostIp: m[1] || '0.0.0.0',
        hostPort: m[2],
        containerPort: m[3],
        proto: m[4],
        exposed: false,
      });
      continue;
    }
    const e = seg.match(/^(\d+)\/(\w+)$/);
    if (e) {
      out.push({ hostIp: '', hostPort: '', containerPort: e[1], proto: e[2], exposed: true });
    }
  }
  return out;
}

/** 端口串 → 去重后的 "8080→80/tcp" 摘要，最多取前 n 个 */
export function portsSummary(text, n) {
  const list = parsePorts(text).filter((p) => !p.exposed);
  const shown = list.slice(0, n || 3).map((p) => p.hostPort + '→' + p.containerPort + '/' + p.proto);
  if (list.length > (n || 3)) shown.push('+' + (list.length - (n || 3)));
  return shown;
}

/** 容器状态 → 语义色调 id（running/stopped/paused/restarting/created/dead/other） */
export function stateKind(state) {
  const s = String(state || '').toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'exited' || s === 'stopped') return 'stopped';
  if (s === 'paused') return 'paused';
  if (s === 'restarting') return 'restarting';
  if (s === 'created') return 'created';
  if (s === 'removing') return 'restarting';
  if (s === 'dead') return 'dead';
  return 'other';
}

/** 镜像尺寸串 → 数字（排序用），已是数字时原样返回 */
export function sizeValue(size) {
  if (typeof size === 'number') return size;
  return dockerSizeToBytes(size);
}

/** 生成下载文本文件（UTF-8），返回是否成功 */
export function downloadText(filename, text) {
  try {
    const blob = new Blob([String(text == null ? '' : text)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch (e) {
    return false;
  }
}

/** UTF-8 安全的 base64 编码（远端写文件时避开 stdin 与引号问题） */
export function toBase64(text) {
  const bytes = new TextEncoder().encode(String(text == null ? '' : text));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** 单引号转义，供 sh -c 拼接动态值（与宿主 shellQuote 一致） */
export function shq(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "'\\''") + "'";
}

/** 从完整 JSON 里安全取深层字段，缺失返回兜底值 */
export function pick(obj, path, fallback) {
  let cur = obj;
  for (const key of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return fallback;
    cur = cur[key];
  }
  return cur === undefined || cur === null ? fallback : cur;
}

/** 时间戳（ISO 或 Unix 秒）→ 本地可读串 */
export function formatTime(value) {
  if (!value) return '';
  let d;
  if (typeof value === 'number') d = new Date(value > 1e12 ? value : value * 1000);
  else d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/** 相对时间："3 分钟前" */
export function timeAgo(value) {
  const d = value instanceof Date ? value : new Date(typeof value === 'number' ? (value > 1e12 ? value : value * 1000) : value);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Math.max(0, Date.now() - d.getTime()) / 1000;
  if (diff < 60) return Math.round(diff) + ' 秒前';
  if (diff < 3600) return Math.round(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.round(diff / 3600) + ' 小时前';
  if (diff < 86400 * 30) return Math.round(diff / 86400) + ' 天前';
  return formatTime(d);
}

/** 把 shell 风格的 KEY=VALUE 列表解析为对象，坏项跳过 */
export function parseEnvList(list) {
  const out = {};
  for (const item of (Array.isArray(list) ? list : [])) {
    const s = String(item || '');
    const i = s.indexOf('=');
    if (i <= 0) continue;
    out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

/** 文本按行切分并去掉尾部空行 */
export function lines(text) {
  const arr = String(text == null ? '' : text).split('\n');
  while (arr.length && !arr[arr.length - 1].trim()) arr.pop();
  return arr;
}

/** 两段文本做简易差异标记：返回 [{text, kind:'same'|'add'|'del'}]（按行比较，够用于确认变更） */
export function diffLines(before, after) {
  const a = lines(before);
  const b = lines(after);
  const setA = new Set(a);
  const setB = new Set(b);
  const out = [];
  for (const l of a) if (!setB.has(l)) out.push({ text: l, kind: 'del' });
  for (const l of b) if (!setA.has(l)) out.push({ text: l, kind: 'add' });
  return out;
}
