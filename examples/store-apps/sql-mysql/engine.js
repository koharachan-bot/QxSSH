/**
 * engine.js —— 语句分析、危险操作识别、客户端探测与执行调度
 *
 * 所有方言共用这里的文本处理与安全判定；方言自身只负责「怎么连、怎么发、怎么解析」。
 */

import { exec } from './api.js';

/* ------------------------------ 语句文本处理 ------------------------------ */

/**
 * 把注释与字符串/标识符字面量替换为等长空格。
 * 长度保持一致，才能在脱敏文本上定位分号、再回到原文取语句。
 */
export function stripText(input) {
  const s = String(input === null || input === undefined ? '' : input);
  let out = '';
  let i = 0;
  const blanks = (n) => { out += ' '.repeat(n); };
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += ' ';
      i += 1;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '\\' && quote !== '`' && i + 1 < s.length) { blanks(2); i += 2; continue; }
        if (ch === quote) {
          if (s[i + 1] === quote) { blanks(2); i += 2; continue; }
          out += ' ';
          i += 1;
          break;
        }
        blanks(1);
        i += 1;
      }
      continue;
    }
    if (c === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') { blanks(1); i += 1; }
      continue;
    }
    if (c === '#') {
      while (i < s.length && s[i] !== '\n') { blanks(1); i += 1; }
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      blanks(2);
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { blanks(1); i += 1; }
      if (i < s.length) { blanks(2); i += 2; }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 按分号切分语句（忽略字符串与注释里的分号），返回原文片段 */
export function splitStatements(sql) {
  const src = String(sql === null || sql === undefined ? '' : sql);
  const stripped = stripText(src);
  const list = [];
  let start = 0;
  for (let i = 0; i < stripped.length; i += 1) {
    if (stripped[i] !== ';') continue;
    const text = src.slice(start, i).trim();
    if (text) list.push(text);
    start = i + 1;
  }
  const tail = src.slice(start).trim();
  if (tail) list.push(tail);
  return list;
}

/** 取语句首词（小写），用于判断语句类型 */
export function wordOf(stmt) {
  const m = stripText(stmt).trim().match(/^[A-Za-z]+/);
  return m ? m[0].toLowerCase() : '';
}

const QUERY_WORDS = ['select', 'with', 'table', 'values', 'show', 'describe', 'desc', 'explain', 'pragma'];

/** 是否为只读查询类语句 */
export function isQueryStatement(stmt) {
  return QUERY_WORDS.indexOf(wordOf(stmt)) >= 0;
}

/** 整段文本是否「恰好一条查询语句」，只有这种情况才做列名探测 */
export function isSingleQuery(sql) {
  const parts = splitStatements(sql);
  return parts.length === 1 && isQueryStatement(parts[0]);
}

/** 去掉结尾分号，供列名探测包裹使用 */
export function trimSemicolon(sql) {
  return String(sql || '').replace(/;[\s]*$/, '').trim();
}

/**
 * 找出需要二次确认的危险语句。
 * SQL：DROP / TRUNCATE / 无 WHERE 的 DELETE 与 UPDATE / ALTER。
 * Redis：FLUSHALL / FLUSHDB / SHUTDOWN。
 * MongoDB：dropDatabase / dropCollection / drop() / 空条件 deleteMany、deleteOne、remove。
 */
export function dangerList(sql, kind) {
  const src = String(sql === null || sql === undefined ? '' : sql);
  const found = [];
  if (!src.trim()) return found;

  if (kind === 'redis') {
    const cmd = src.trim().split(/\s+/)[0].toUpperCase();
    if (cmd === 'FLUSHALL' || cmd === 'FLUSHDB' || cmd === 'SHUTDOWN') found.push(src.trim());
    return found;
  }

  if (kind === 'mongo') {
    const patterns = [
      /\.dropDatabase\s*\(/i,
      /\.dropCollection\s*\(/i,
      /\.drop\s*\(\s*\)/i,
      /\.deleteMany\s*\(\s*\{\s*\}\s*\)/i,
      /\.deleteOne\s*\(\s*\{\s*\}\s*\)/i,
      /\.remove\s*\(\s*\{\s*\}\s*\)/i,
    ];
    for (const p of patterns) {
      if (p.test(src)) { found.push(src.trim()); break; }
    }
    return found;
  }

  for (const part of splitStatements(src)) {
    const bare = stripText(part).trim().toLowerCase();
    if (!bare) continue;
    const word = wordOf(bare);
    if (word === 'drop' || word === 'truncate' || word === 'alter') {
      found.push(part);
    } else if ((word === 'delete' || word === 'update') && !/\bwhere\b/.test(bare)) {
      found.push(part);
    }
  }
  return found;
}

/* ------------------------------ 客户端探测 ------------------------------ */

/**
 * 检查远端是否装有本插件依赖的命令行客户端。
 * 返回 { installed, version, path, raw }；未安装时由界面给出安装建议。
 */
export async function probeClient(host, dialect) {
  const bin = dialect.client;
  const versionFlag = dialect.versionFlag || '--version';
  const script = [
    'if command -v ' + bin + ' >/dev/null 2>&1; then',
    '  command -v ' + bin,
    '  ' + bin + ' ' + versionFlag + ' 2>&1 | head -n 1',
    'else',
    '  echo __QX_MISSING__',
    'fi',
  ].join('\n');
  const r = await exec({ host, argv: ['sh', '-c', script], timeout: 20 });
  const lines = String(r.out || '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (!lines.length || lines[0] === '__QX_MISSING__' || r.exit === 127) {
    return { installed: false, version: '', path: '', raw: r.err || r.out || '', error: r.err || '' };
  }
  return {
    installed: true,
    path: lines[0],
    version: lines[1] || '',
    raw: String(r.out || ''),
    error: '',
  };
}

/** 探测远端发行版与包管理器，用于生成准确的安装命令 */
export async function probePlatform(host) {
  const script = [
    'cat /etc/os-release 2>/dev/null | head -n 6',
    'echo __QX_PM__',
    'for m in apt-get dnf yum pacman zypper apk; do',
    '  if command -v "$m" >/dev/null 2>&1; then echo "$m"; break; fi',
    'done',
    'echo __QX_END__',
  ].join('\n');
  const r = await exec({ host, argv: ['sh', '-c', script], timeout: 20 });
  const text = String(r.out || '');
  const osNameMatch = /PRETTY_NAME="?([^"]+)"?/.exec(text);
  const pmMatch = /__QX_PM__\s*\n([a-z-]+)/.exec(text);
  return {
    osName: osNameMatch ? osNameMatch[1].trim() : '',
    pm: pmMatch ? pmMatch[1].trim() : '',
    raw: text,
  };
}

/** 按方言与远端包管理器给出安装建议（含通用兜底） */
export function installAdvice(dialect, platform) {
  const p = platform || {};
  const map = dialect.install || {};
  const items = [];
  if (p.pm && map[p.pm]) items.push({ label: p.pm, cmd: map[p.pm] });
  for (const key of Object.keys(map)) {
    if (items.some((x) => x.cmd === map[key])) continue;
    items.push({ label: key, cmd: map[key] });
  }
  return { osName: p.osName || '', items, tip: dialect.installTip || '' };
}

/** 常见客户端缺失/连接失败的补充说明 */
export function explainFailure(r, dialect) {
  const text = ((r && r.err) || '') + '\n' + ((r && r.out) || '');
  if (/not found|No such file|command not found/i.test(text) || (r && r.exit === 127)) {
    return '远端未找到 ' + dialect.client + ' 客户端';
  }
  if (/Access denied|authentication failed|password authentication failed|WRONGPASS|Login failed/i.test(text)) {
    return '认证失败，请检查用户名与密码';
  }
  if (/Can.t connect|Connection refused|could not connect|Connection timed out|No route to host/i.test(text)) {
    return '无法连接到数据库服务，请检查地址、端口与服务状态';
  }
  return '';
}

/* ------------------------------ 执行调度 ------------------------------ */

/** 执行方言给出的计划，返回 { r, ms }；ms 为端到端耗时 */
export async function execute(host, plan) {
  const started = performance.now();
  const r = await exec({ host, argv: plan.argv, stdin: plan.stdin || '', timeout: plan.timeout || 60 });
  const ms = Math.round(performance.now() - started);
  return { r, ms };
}
