/**
 * format.js —— Kubernetes 数据格式化与安全转义工具
 * 只做纯函数转换，便于测试与复用。
 */

/** 按 \t 拆列；列数不足时补空串，超出部分并回最后一列 */
export function splitCols(line, count) {
  const parts = String(line == null ? '' : line).split('\t');
  const out = [];
  for (let i = 0; i < count; i += 1) out.push((parts[i] == null ? '' : parts[i]).trim());
  if (parts.length > count) out[count - 1] = parts.slice(count - 1).join(' ').trim();
  return out;
}

/** kubectl 输出 → 对象数组；自动跳过尾部提示行 */
export function parseRows(text, count, { skipEmpty = true } = {}) {
  const rows = [];
  for (const raw of String(text == null ? '' : text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (skipEmpty && /^no resources found|^No resources found/i.test(line)) continue;
    const cols = splitCols(line, count);
    if (cols.every((c) => !c)) continue;
    rows.push(cols);
  }
  return rows;
}

/** "2/3" → { ready: 2, total: 3, pct: 66, ok: false } */
export function readyRatio(text) {
  const m = String(text || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return { ready: 0, total: 0, pct: 0, ok: false };
  const ready = Number(m[1]);
  const total = Number(m[2]);
  return { ready, total, pct: total ? Math.round((ready / total) * 100) : 0, ok: total > 0 && ready >= total };
}

/** Pod 阶段 / 就绪状态 → 语义色调 */
export function podTone(phase) {
  const p = String(phase || '').toLowerCase();
  if (p === 'running') return 'ok';
  if (p === 'succeeded' || p === 'completed') return 'ok';
  if (p === 'pending') return 'warn';
  if (p === 'unknown') return 'warn';
  if (p === 'failed' || p === 'error' || p === 'crashloopbackoff' || p === 'evicted' || p === 'oomkilled') return 'error';
  return 'idle';
}

/** 资源状态归一：Running / CrashLoopBackOff / 0/1 等混在一起时给出统一的语义 */
export function workloadTone(statusText, readyText) {
  const s = String(statusText || '').toLowerCase();
  if (/crashloop|error|failed|backoff|evicted|invalid/.test(s)) return 'error';
  if (readyText) {
    const r = readyRatio(readyText);
    if (r.total === 0 || r.ready === 0) return 'error';
    if (!r.ok) return 'warn';
    return 'ok';
  }
  if (/running|active|ready/.test(s)) return 'ok';
  if (/pending|progressing|unknown/.test(s)) return 'warn';
  return 'idle';
}

/** ISO 时间 → "3d" / "5h" / "12m" / "40s" 形式的年龄 */
export function age(iso) {
  if (!iso) return '-';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso);
  const diff = Math.max(0, Date.now() - t) / 1000;
  if (diff < 60) return Math.round(diff) + 's';
  if (diff < 3600) return Math.round(diff / 60) + 'm';
  if (diff < 86400) return Math.round(diff / 3600) + 'h';
  if (diff < 86400 * 365) return Math.round(diff / 86400) + 'd';
  return Math.round(diff / (86400 * 365)) + 'y';
}

/** Kubernetes CPU 数量（"1000m" / "2" / "250m"）→ 核数 */
export function parseCpu(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  if (s.endsWith('m')) return (parseFloat(s.slice(0, -1)) || 0) / 1000;
  if (s.endsWith('n')) return (parseFloat(s.slice(0, -1)) || 0) / 1e9;
  return parseFloat(s) || 0;
}

/** Kubernetes 内存数量（"2048Ki" / "1Gi" / "512M"）→ 字节 */
export function parseMem(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  const m = s.match(/^([\d.]+)\s*([KMGTP]i?)?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = (m[2] || '').toUpperCase();
  const mult = {
    '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
    KI: 1024, MI: 1024 ** 2, GI: 1024 ** 3, TI: 1024 ** 4, PI: 1024 ** 5,
  }[unit] || 1;
  return Math.round(n * mult);
}

/** 字节 → 人类可读 */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return (i === 0 ? Math.round(x) : x.toFixed(x >= 100 ? 0 : 1)) + ' ' + units[i];
}

/** 核数 → 毫核字符串（供 top 输出归一） */
export function formatCpu(cores) {
  const c = Number(cores) || 0;
  if (c >= 1) return c.toFixed(2).replace(/\.00$/, '') + ' 核';
  return Math.round(c * 1000) + 'm';
}

/** 解析 kubectl top 的资源列（"123m" / "45Mi"） */
export function parseTopCpu(v) { return parseCpu(v); }
export function parseTopMem(v) { return parseMem(v); }

/** 容器名去前缀（kubectl logs 的 container 名） */
export function shortContainerName(name, pod) {
  const n = String(name || '');
  const p = String(pod || '');
  if (p && n.startsWith(p + '-')) return n.slice(p.length + 1);
  return n;
}

/** UTF-8 安全 base64（写远端文件时避开引号问题） */
export function toBase64(text) {
  const bytes = new TextEncoder().encode(String(text == null ? '' : text));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** 单引号转义，供 sh -c 拼接动态值 */
export function shq(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "'\\''") + "'";
}

/** 生成下载文本文件 */
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

/** 文本按行切分并去掉尾部空行 */
export function lines(text) {
  const arr = String(text == null ? '' : text).split('\n');
  while (arr.length && !arr[arr.length - 1].trim()) arr.pop();
  return arr;
}

/** 粗略 YAML 校验：返回 { ok, reason }（只做结构层面的明显错误提示） */
export function roughYamlCheck(text) {
  const s = String(text || '');
  if (!s.trim()) return { ok: false, reason: '内容为空' };
  if (/\t/.test(s)) return { ok: false, reason: 'YAML 不允许制表符缩进，请改用空格' };
  const hasKind = /^kind:\s*\S+/m.test(s);
  const hasMeta = /^metadata:\s*$/m.test(s) || /^metadata:\s*\{/m.test(s);
  if (!hasKind) return { ok: false, reason: '缺少 kind 字段' };
  if (!hasMeta) return { ok: false, reason: '缺少 metadata 字段' };
  return { ok: true, reason: '' };
}
