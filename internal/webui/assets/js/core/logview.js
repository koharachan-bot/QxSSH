/**
 * core/logview.js —— 可复用的彩色日志视图
 * 要点：把原始日志（含 ANSI 转义）解析成带语义色彩的 DOM 行；自带级别过滤、
 *       关键词高亮、行号、自动跟随与渲染上限，供 Docker / Kubernetes 等应用共用。
 *
 * 约定：本模块直接操作 DOM，不经虚拟 DOM diff —— 日志整块重绘比逐节点 diff
 * 更划算，也能避免长列表把渲染器拖慢。
 */

/** 日志级别与严重度排序（数值越大越严重），UI 按此做“至少该级别”过滤 */
export const LEVELS = [
  { id: 'trace', label: 'TRACE', rank: 0 },
  { id: 'debug', label: 'DEBUG', rank: 1 },
  { id: 'info', label: 'INFO', rank: 2 },
  { id: 'warn', label: 'WARN', rank: 3 },
  { id: 'error', label: 'ERROR', rank: 4 },
];

const RANK = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

/** 级别别名归一：一行里出现的单词映射到五个语义级别 */
const LEVEL_ALIAS = {
  trace: 'trace', verbose: 'trace', v: 'trace',
  debug: 'debug', dbg: 'debug', d: 'debug',
  info: 'info', information: 'info', notice: 'info', i: 'info',
  warn: 'warn', warning: 'warn', w: 'warn',
  error: 'error', err: 'error', fatal: 'error', panic: 'error',
  critical: 'error', crit: 'error', severe: 'error', alert: 'error',
  emerg: 'error', emergency: 'error', e: 'error',
};

/* ------------------------------------------------------------------ *
 * ANSI 转义着色
 * ------------------------------------------------------------------ */

const ANSI_RE = /\u001b\[([0-9;]*)m|\u001b\[[0-9;]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

/** 去掉全部 ANSI 转义（保存/复制时用纯文本） */
export function stripAnsi(s) {
  return String(s == null ? '' : s).replace(ANSI_RE, '');
}

const ANSI_FG = {
  30: 'qv-fg-black', 31: 'qv-fg-red', 32: 'qv-fg-green', 33: 'qv-fg-yellow',
  34: 'qv-fg-blue', 35: 'qv-fg-magenta', 36: 'qv-fg-cyan', 37: 'qv-fg-white',
  90: 'qv-fg-gray', 91: 'qv-fg-red', 92: 'qv-fg-green', 93: 'qv-fg-yellow',
  94: 'qv-fg-blue', 95: 'qv-fg-magenta', 96: 'qv-fg-cyan', 97: 'qv-fg-white',
};

const ANSI_BG = {
  40: 'qv-bg-black', 41: 'qv-bg-red', 42: 'qv-bg-green', 43: 'qv-bg-yellow',
  44: 'qv-bg-blue', 45: 'qv-bg-magenta', 46: 'qv-bg-cyan', 47: 'qv-bg-white',
};

/** 把一段带 ANSI 的文本切成 [{text, cls, style}]，无转义时返回单个片段 */
export function parseAnsi(input) {
  const s = String(input == null ? '' : input);
  if (s.indexOf('\u001b') < 0) return s ? [{ text: s, cls: '', style: null }] : [];

  const out = [];
  let cls = '';
  let style = null;
  let last = 0;
  ANSI_RE.lastIndex = 0;
  let m;
  while ((m = ANSI_RE.exec(s))) {
    if (m.index > last) {
      const seg = s.slice(last, m.index);
      if (seg) out.push({ text: seg, cls, style });
    }
    last = ANSI_RE.lastIndex;
    if (!m[1]) continue; // 非 SGR（光标移动等）直接丢弃

    const codes = m[1] === '' ? [0] : m[1].split(';').filter((x) => x !== '').map(Number);
    for (let i = 0; i < codes.length; i += 1) {
      const c = codes[i];
      if (c === 0) { cls = ''; style = null; continue; }
      if (c === 1) { cls = appendCls(cls, 'qv-bold'); continue; }
      if (c === 2) { cls = appendCls(cls, 'qv-dim'); continue; }
      if (c === 3) { cls = appendCls(cls, 'qv-italic'); continue; }
      if (c === 4) { cls = appendCls(cls, 'qv-underline'); continue; }
      if (c === 7) { cls = appendCls(cls, 'qv-inverse'); continue; }
      if (c === 22 || c === 23 || c === 24 || c === 27) {
        cls = cls.replace(/\s*qv-(bold|dim|italic|underline|inverse)\b/g, '').trim();
        continue;
      }
      if (ANSI_FG[c]) { cls = replaceCls(cls, 'qv-fg-', ANSI_FG[c]); continue; }
      if (ANSI_BG[c]) { cls = replaceCls(cls, 'qv-bg-', ANSI_BG[c]); continue; }
      if (c === 39) { cls = cls.replace(/\bqv-fg-\S+/g, '').trim(); continue; }
      if (c === 49) { cls = cls.replace(/\bqv-bg-\S+/g, '').trim(); continue; }
      if (c === 38 || c === 48) {
        const isFg = c === 38;
        if (codes[i + 1] === 5 && codes[i + 2] != null) {
          style = Object.assign({}, style || {}, { [isFg ? 'color' : 'background']: ansi256(codes[i + 2]) });
          i += 2;
        } else if (codes[i + 1] === 2 && codes[i + 4] != null) {
          style = Object.assign({}, style || {}, {
            [isFg ? 'color' : 'background']: 'rgb(' + codes[i + 2] + ',' + codes[i + 3] + ',' + codes[i + 4] + ')',
          });
          i += 4;
        }
      }
    }
  }
  if (last < s.length) {
    const seg = s.slice(last);
    if (seg) out.push({ text: seg, cls, style });
  }
  return out;
}

function appendCls(cls, add) {
  return cls ? cls + ' ' + add : add;
}

function replaceCls(cls, prefix, want) {
  const kept = cls.split(/\s+/).filter((x) => x && !x.startsWith(prefix));
  kept.push(want);
  return kept.join(' ');
}

/** xterm 256 调色板 → CSS 颜色 */
function ansi256(n) {
  const v = Number(n) || 0;
  if (v < 16) {
    return ['#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
      '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff'][v];
  }
  if (v < 232) {
    const i = v - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return 'rgb(' + steps[Math.floor(i / 36)] + ',' + steps[Math.floor((i % 36) / 6)] + ',' + steps[i % 6] + ')';
  }
  const g = 8 + (v - 232) * 10;
  return 'rgb(' + g + ',' + g + ',' + g + ')';
}

/* ------------------------------------------------------------------ *
 * 日志行语义解析：时间戳 / 级别 / 正文
 * ------------------------------------------------------------------ */

const TS_PATTERNS = [
  // 2024-01-02T03:04:05.123456789Z / 2024-01-02 03:04:05,123 +0800
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)\s*/,
  // Jan  2 03:04:05（syslog / 内核）
  /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s*/,
  // 03:04:05.123
  /^(\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?)\s*/,
];

// level=error / level="warning" 形式（结构化日志）
const KV_LEVEL_RE = /\blevel["']?\s*[=:]\s*["']?([A-Za-z]+)["']?/i;

// [ERROR] / (WARN) / "ERROR:" 等，限制在行首附近查找
const TOKEN_LEVEL_RE = /(?:^|[\s[(|:<])(TRACE|DEBUG|DBG|INFO|NOTICE|WARN(?:ING)?|ERR(?:OR)?|FATAL|PANIC|CRIT(?:ICAL)?|SEVERE|VERBOSE)(?=$|[\s\])|:>,])/i;

/** 归一任意级别单词到五个语义级别，未知返回空串 */
export function normalizeLevel(word) {
  if (!word) return '';
  return LEVEL_ALIAS[String(word).toLowerCase()] || '';
}

/**
 * 解析一行日志：抽出时间戳、级别与正文。
 * @returns {{ time: string, level: string, kind: string, message: string, raw: string }}
 */
export function parseLine(raw) {
  const line = stripAnsi(raw);
  let rest = line;
  let time = '';
  for (const re of TS_PATTERNS) {
    const m = rest.match(re);
    if (m) { time = m[1]; rest = rest.slice(m[0].length); break; }
  }

  let level = '';
  const kv = rest.match(KV_LEVEL_RE);
  if (kv) level = normalizeLevel(kv[1]);
  if (!level) {
    const tm = rest.slice(0, 64).match(TOKEN_LEVEL_RE);
    if (tm) level = normalizeLevel(tm[1]);
  }
  if (!level) {
    const tm = rest.slice(0, 96).match(/\b(FATAL|PANIC|ERROR|CRITICAL|WARN|WARNING)\b/i);
    if (tm) level = normalizeLevel(tm[1]);
  }

  return { time, level, kind: level || '', message: rest, raw: line };
}

/** 该级别是否达到过滤门槛（all 恒为真） */
export function levelPass(kind, minLevel) {
  if (!minLevel || minLevel === 'all') return true;
  const min = RANK[minLevel] == null ? 0 : RANK[minLevel];
  const cur = RANK[kind] == null ? -1 : RANK[kind];
  return cur >= min;
}

/* ------------------------------------------------------------------ *
 * 正文内联高亮
 * ------------------------------------------------------------------ */

// 一次扫描完成分类：URL / IP:port / 引号串 / 带单位数字 / 长十六进制 / 布尔空值 / 状态码
const TOKEN_RE = new RegExp(
  [
    '(https?:\\/\\/[^\\s"\'<>\\\\]+)',
    '(\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d{1,5})?\\b)',
    '("[^"]{0,240}"|\'[^\']{0,240}\')',
    '(\\b\\d+(?:\\.\\d+)?(?:B|KB|KiB|MB|MiB|GB|GiB|TB|TiB|ms|us|ns|s|m|h|%|x)\\b)',
    '(\\b[0-9a-f]{12,64}\\b)',
    '(\\b(?:true|false|null|nil|none|undefined)\\b)',
    '(\\b[45]\\d{2}\\b)',
  ].join('|'),
  'gi'
);

const BAD_WORDS_RE = /\b(failed|failure|refused|denied|timeout|timed out|unreachable|exception|panic|segmentation fault|oom|killed|aborted|no such|not found|connection reset)\b/gi;

/**
 * 把正文切成着色片段，返回 [{ text, cls }]。
 * badTone 为真时把错误强词按错误色强调（行级别已是 error 时不必重复）。
 */
export function tokenize(text, opts) {
  const badTone = !!(opts && opts.badTone);
  const s = String(text == null ? '' : text);
  if (!s) return [];
  const out = [];
  const push = (str, cls) => { if (str) out.push({ text: str, cls }); };

  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(s))) {
    if (m.index > last) push(s.slice(last, m.index), '');
    const cls = m[1] ? 'qv-url'
      : m[2] ? 'qv-ip'
        : m[3] ? 'qv-str'
          : m[4] ? 'qv-num'
            : m[5] ? 'qv-hash'
              : m[6] ? 'qv-kw'
                : 'qv-code';
    push(m[0], cls);
    if (TOKEN_RE.lastIndex === m.index) TOKEN_RE.lastIndex += 1;
    last = TOKEN_RE.lastIndex;
  }
  if (last < s.length) push(s.slice(last), '');

  if (!badTone) return out;

  const out2 = [];
  for (const seg of out) {
    if (seg.cls === 'qv-str' || seg.cls === 'qv-url') { out2.push(seg); continue; }
    let cursor = 0;
    let hit = false;
    BAD_WORDS_RE.lastIndex = 0;
    let bm;
    while ((bm = BAD_WORDS_RE.exec(seg.text))) {
      hit = true;
      if (bm.index > cursor) out2.push({ text: seg.text.slice(cursor, bm.index), cls: seg.cls });
      out2.push({ text: bm[0], cls: appendCls(seg.cls, 'qv-bad') });
      cursor = BAD_WORDS_RE.lastIndex;
    }
    if (!hit) { out2.push(seg); continue; }
    if (cursor < seg.text.length) out2.push({ text: seg.text.slice(cursor), cls: seg.cls });
  }
  return out2;
}

/* ------------------------------------------------------------------ *
 * 视图
 * ------------------------------------------------------------------ */

const STYLE_ID = 'qv-logview-style';

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = LOG_VIEW_CSS.join('\n');
  document.head.appendChild(st);
}

const LOG_VIEW_CSS = [
  ".qv-log { position: relative; height: 100%; min-height: 0; overflow: auto; background: rgba(0,0,0,.028); border-radius: 8px; }",
  "html.dark .qv-log { background: rgba(255,255,255,.035); }",
  ".qv-log-body { font-family: ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, \"Liberation Mono\", monospace; font-size: 12px; line-height: 1.62; padding: 8px 10px; }",
  ".qv-line { display: flex; align-items: flex-start; gap: 8px; padding: 1px 4px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }",
  ".qv-line:hover { background: rgba(127,127,127,.10); }",
  ".qv-line.qv-lv-error { background: rgba(255,59,48,.075); }",
  ".qv-line.qv-lv-warn { background: rgba(255,159,10,.075); }",
  ".qv-ln { flex: none; width: 3.2em; text-align: right; color: var(--text-400, #8e8e93); user-select: none; opacity: .65; font-variant-numeric: tabular-nums; }",
  ".qv-ts { flex: none; color: var(--text-400, #8e8e93); }",
  ".qv-badge { flex: none; min-width: 3.6em; text-align: center; padding: 0 5px; border-radius: 4px; font-size: 10.5px; font-weight: 700; letter-spacing: .02em; line-height: 1.55; }",
  ".qv-lv-error .qv-badge { color: #ff3b30; background: rgba(255,59,48,.15); }",
  ".qv-lv-warn .qv-badge { color: #b26a00; background: rgba(255,159,10,.18); }",
  ".qv-lv-info .qv-badge { color: #0a64d6; background: rgba(10,100,214,.13); }",
  ".qv-lv-debug .qv-badge { color: #6e6e73; background: rgba(142,142,147,.16); }",
  ".qv-lv-trace .qv-badge { color: #8e8e93; background: rgba(142,142,147,.12); }",
  "html.dark .qv-lv-error .qv-badge { color: #ff6961; }",
  "html.dark .qv-lv-warn .qv-badge { color: #ffcc66; }",
  "html.dark .qv-lv-info .qv-badge { color: #6cb6ff; }",
  "html.dark .qv-lv-debug .qv-badge { color: #aeaeb2; }",
  ".qv-msg { flex: 1 1 auto; min-width: 0; color: var(--text-800, #1d1d1f); }",
  "html.dark .qv-msg { color: var(--text-100, #e3e3e8); }",
  ".qv-lv-error .qv-msg { color: #c81e13; }",
  "html.dark .qv-lv-error .qv-msg { color: #ff8b82; }",
  ".qv-lv-warn .qv-msg { color: #8a5a00; }",
  "html.dark .qv-lv-warn .qv-msg { color: #ffd479; }",
  ".qv-lv-debug .qv-msg, .qv-lv-trace .qv-msg { opacity: .78; }",
  ".qv-url { color: #0a64d6; text-decoration: underline; text-underline-offset: 2px; }",
  "html.dark .qv-url { color: #6cb6ff; }",
  ".qv-ip { color: #7a4bd0; }",
  "html.dark .qv-ip { color: #c3a5ff; }",
  ".qv-str { color: #0a7d4c; }",
  "html.dark .qv-str { color: #7ee2a8; }",
  ".qv-num { color: #b25000; font-variant-numeric: tabular-nums; }",
  "html.dark .qv-num { color: #ffb86b; }",
  ".qv-hash { color: var(--text-400, #8e8e93); }",
  ".qv-kw { color: #8a5a00; font-weight: 600; }",
  "html.dark .qv-kw { color: #ffd479; }",
  ".qv-code { color: #c4005a; }",
  "html.dark .qv-code { color: #ff9ec0; }",
  ".qv-bad { color: #d1180b; font-weight: 700; }",
  "html.dark .qv-bad { color: #ff6b60; }",
  ".qv-bold { font-weight: 700; }",
  ".qv-dim { opacity: .62; }",
  ".qv-italic { font-style: italic; }",
  ".qv-underline { text-decoration: underline; }",
  ".qv-inverse { background: rgba(127,127,127,.25); border-radius: 3px; }",
  ".qv-fg-black { color: #1d1d1f; } .qv-fg-red { color: #d1180b; } .qv-fg-green { color: #0a7d4c; }",
  ".qv-fg-yellow { color: #8a5a00; } .qv-fg-blue { color: #0a64d6; } .qv-fg-magenta { color: #a12bc4; }",
  ".qv-fg-cyan { color: #0a7d8c; } .qv-fg-white { color: #f5f5f7; } .qv-fg-gray { color: #8e8e93; }",
  "html.dark .qv-fg-black { color: #c7c7cc; } html.dark .qv-fg-red { color: #ff6b60; }",
  "html.dark .qv-fg-green { color: #7ee2a8; } html.dark .qv-fg-yellow { color: #ffd479; }",
  "html.dark .qv-fg-blue { color: #6cb6ff; } html.dark .qv-fg-magenta { color: #e0a0ff; }",
  "html.dark .qv-fg-cyan { color: #6ee7f0; } html.dark .qv-fg-white { color: #f5f5f7; }",
  ".qv-bg-red { background: rgba(255,59,48,.2); } .qv-bg-green { background: rgba(10,125,76,.2); }",
  ".qv-bg-yellow { background: rgba(255,159,10,.22); } .qv-bg-blue { background: rgba(10,100,214,.18); }",
  ".qv-bg-magenta { background: rgba(161,43,196,.18); } .qv-bg-cyan { background: rgba(10,125,140,.18); }",
  ".qv-bg-black { background: rgba(0,0,0,.25); } .qv-bg-white { background: rgba(255,255,255,.4); }",
  ".qv-mark { background: rgba(255,214,10,.45); color: inherit; border-radius: 3px; padding: 0 1px; }",
  "html.dark .qv-mark { background: rgba(255,214,10,.32); }",
  ".qv-more { padding: 6px 8px; font-size: 11.5px; color: var(--text-400, #8e8e93); text-align: center; }",
  ".qv-empty { padding: 28px 12px; text-align: center; color: var(--text-400, #8e8e93); font-size: 12.5px; }",
  ".qv-jump { position: sticky; bottom: 8px; left: 50%; transform: translateX(-50%); display: flex; justify-content: center; pointer-events: none; }",
  ".qv-jump button { pointer-events: auto; border: 1px solid rgba(127,127,127,.3); background: #fff; color: #3c3c43; border-radius: 999px; padding: 3px 12px; font-size: 11.5px; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.12); }",
  "html.dark .qv-jump button { background: #2c2c2e; color: #e3e3e8; }",

];

/**
 * 创建彩色日志视图。
 * @param {object} opts
 * @param {string[]} [opts.lines] 初始日志行
 * @param {string} [opts.emptyText] 空态文案
 * @param {number} [opts.maxLines] 内部保留的最大行数（默认 4000）
 * @param {number} [opts.renderLimit] 单次最多渲染的行数（默认 1500）
 * @param {boolean} [opts.showLineNo] 是否显示行号
 * @param {boolean} [opts.follow] 是否自动跟随到底部
 * @param {(following:boolean)=>void} [opts.onFollowChange]
 */
export function createLogView(opts) {
  const o = opts || {};
  const lines = o.lines || [];
  const emptyText = o.emptyText || '暂无日志';
  const maxLines = o.maxLines || 4000;
  const renderLimit = o.renderLimit || 1500;
  const showLineNo = o.showLineNo !== false;
  const onFollowChange = typeof o.onFollowChange === 'function' ? o.onFollowChange : null;

  ensureStyle();

  const el = document.createElement('div');
  el.className = 'qv-log';

  const bodyEl = document.createElement('div');
  bodyEl.className = 'qv-log-body';
  el.appendChild(bodyEl);

  const jumpWrap = document.createElement('div');
  jumpWrap.className = 'qv-jump';

  let all = Array.isArray(lines) ? lines.slice() : [];
  let query = '';
  let minLevel = 'all';
  let following = o.follow !== false;
  let raf = 0;
  let lastRenderKey = '';

  const scrollToBottom = () => { el.scrollTop = el.scrollHeight; };

  el.addEventListener('scroll', () => {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (atBottom !== following) {
      following = atBottom;
      if (onFollowChange) onFollowChange(following);
      paintJump();
    }
  }, { passive: true });

  function paintJump() {
    if (following) { jumpWrap.replaceChildren(); return; }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '↓ 跳到最新';
    btn.addEventListener('click', () => {
      following = true;
      if (onFollowChange) onFollowChange(true);
      paintJump();
      scrollToBottom();
    });
    jumpWrap.replaceChildren(btn);
  }

  /** 把纯文本切成可能含 mark 的 span */
  function textNode(raw, cls, q) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    if (!q) { span.textContent = raw; return span; }
    const lower = raw.toLowerCase();
    const needle = q.toLowerCase();
    let from = 0;
    let idx = lower.indexOf(needle, from);
    if (idx < 0) { span.textContent = raw; return span; }
    const frag = document.createDocumentFragment();
    while (idx >= 0) {
      if (idx > from) frag.appendChild(document.createTextNode(raw.slice(from, idx)));
      const mark = document.createElement('mark');
      mark.className = 'qv-mark';
      mark.textContent = raw.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      from = idx + needle.length;
      idx = lower.indexOf(needle, from);
    }
    if (from < raw.length) frag.appendChild(document.createTextNode(raw.slice(from)));
    span.appendChild(frag);
    return span;
  }

  /** 渲染单行 */
  function renderLine(raw, lineNo) {
    const parsed = parseLine(raw);
    const kind = parsed.kind;
    const row = document.createElement('div');
    row.className = 'qv-line' + (kind ? ' qv-lv-' + kind : '');

    if (showLineNo) {
      const ln = document.createElement('span');
      ln.className = 'qv-ln';
      ln.textContent = String(lineNo);
      row.appendChild(ln);
    }

    if (parsed.time) {
      const ts = document.createElement('span');
      ts.className = 'qv-ts';
      ts.textContent = parsed.time;
      row.appendChild(ts);
    }

    if (kind) {
      const meta = LEVELS.find((x) => x.id === kind);
      const badge = document.createElement('span');
      badge.className = 'qv-badge';
      badge.textContent = meta ? meta.label : kind.toUpperCase();
      row.appendChild(badge);
    }

    const msg = document.createElement('span');
    msg.className = 'qv-msg';
    const ansiSegs = parseAnsi(parsed.message);
    const hasAnsi = ansiSegs.some((s) => s.cls || s.style);
    if (hasAnsi) {
      for (const seg of ansiSegs) {
        const node = textNode(seg.text, seg.cls, query);
        if (seg.style) {
          for (const k of Object.keys(seg.style)) node.style.setProperty(k, seg.style[k]);
        }
        msg.appendChild(node);
      }
    } else {
      const toks = tokenize(parsed.message, { badTone: !kind || kind === 'info' || kind === 'debug' });
      for (const tok of toks) msg.appendChild(textNode(tok.text, tok.cls, query));
    }
    row.appendChild(msg);
    return row;
  }

  function paint() {
    const q = query.trim();
    const visible = [];
    for (let i = 0; i < all.length; i += 1) {
      const raw = all[i];
      const parsed = parseLine(raw);
      if (!levelPass(parsed.kind, minLevel)) continue;
      if (q && stripAnsi(raw).toLowerCase().indexOf(q.toLowerCase()) < 0) continue;
      visible.push({ raw, no: i + 1 });
    }

    const key = [all.length, q, minLevel, visible.length].join('|');
    if (key === lastRenderKey) return;
    lastRenderKey = key;

    const frag = document.createDocumentFragment();

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'qv-empty';
      empty.textContent = all.length ? '没有匹配过滤条件的日志' : emptyText;
      frag.appendChild(empty);
    } else {
      const slice = visible.length > renderLimit ? visible.slice(visible.length - renderLimit) : visible;
      if (visible.length > renderLimit) {
        const more = document.createElement('div');
        more.className = 'qv-more';
        more.textContent = '仅显示最后 ' + renderLimit + ' 行（共 ' + visible.length + ' 行匹配）';
        frag.appendChild(more);
      }
      for (const item of slice) frag.appendChild(renderLine(item.raw, item.no));
    }

    bodyEl.replaceChildren(frag);
    if (jumpWrap.parentNode !== el) el.appendChild(jumpWrap);
    paintJump();
    if (following) scrollToBottom();
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paint();
    });
  }

  paint();

  return {
    el,
    /** 整体替换日志 */
    setLines(next) {
      all = Array.isArray(next) ? next.slice() : [];
      if (all.length > maxLines) all = all.slice(all.length - maxLines);
      lastRenderKey = '';
      schedule();
    },
    /** 追加日志（实时跟随场景） */
    appendLines(next) {
      if (!next || !next.length) return;
      all = all.concat(next);
      if (all.length > maxLines) all = all.slice(all.length - maxLines);
      schedule();
    },
    clear() {
      all = [];
      lastRenderKey = '';
      schedule();
    },
    /** 纯文本导出（去掉 ANSI，供复制/下载） */
    toText() { return all.map((x) => stripAnsi(x)).join('\n'); },
    allLines() { return all.slice(); },
    setQuery(q) { query = String(q || ''); lastRenderKey = ''; schedule(); },
    setLevel(level) { minLevel = level || 'all'; lastRenderKey = ''; schedule(); },
    refresh() { lastRenderKey = ''; schedule(); },
    scrollBottom() { following = true; paintJump(); scrollToBottom(); },
    isFollowing() { return following; },
    /** 各级别行数统计，供工具栏展示 */
    stats() {
      const out = { total: all.length, error: 0, warn: 0, info: 0, debug: 0, trace: 0 };
      for (const raw of all) {
        const k = parseLine(raw).kind;
        if (k && out[k] != null) out[k] += 1;
      }
      return out;
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      el.remove();
    },
  };
}
