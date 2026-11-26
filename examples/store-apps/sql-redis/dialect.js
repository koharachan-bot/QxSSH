/**
 * dialect.js —— Redis 驱动
 *
 * 口令经远端临时文件写入 REDISCLI_AUTH 环境变量，argv 里不出现口令；
 * 所有输出使用 redis-cli --no-raw，便于按协议标记解析。
 */

const BS = String.fromCharCode(92);

const CLIENT_SCRIPT = [
  'umask 077',
  'd=$(mktemp -d 2>/dev/null) || exit 1',
  "trap 'rm -rf \"$d\"' EXIT INT TERM",
  'cat > "$d/pa" || exit 1',
  'REDISCLI_AUTH=$(cat "$d/pa") redis-cli --no-raw "$@"',
].join('\n');

/** 键预览脚本：先取类型与 TTL，再按类型取内容；键名走位置参数 */
const DETAIL_SCRIPT = [
  'umask 077',
  'd=$(mktemp -d 2>/dev/null) || exit 1',
  "trap 'rm -rf \"$d\"' EXIT INT TERM",
  'cat > "$d/pa" || exit 1',
  'export REDISCLI_AUTH="$(cat "$d/pa")"',
  'key="$1"',
  'shift',
  't=$(redis-cli --no-raw "$@" TYPE "$key")',
  'echo "__TYPE__$t"',
  'echo "__TTL__$(redis-cli --no-raw "$@" PTTL "$key")"',
  'echo "__VAL__"',
  'case "$t" in',
  '  string) redis-cli --no-raw "$@" GET "$key" ;;',
  '  hash) redis-cli --no-raw "$@" HGETALL "$key" ;;',
  '  list) redis-cli --no-raw "$@" LRANGE "$key" 0 99 ;;',
  '  set) redis-cli --no-raw "$@" SMEMBERS "$key" ;;',
  '  zset) redis-cli --no-raw "$@" ZRANGE "$key" 0 99 WITHSCORES ;;',
  '  stream) redis-cli --no-raw "$@" XRANGE "$key" - + COUNT 20 ;;',
  '  *) echo "（该类型暂不支持预览：$t）" ;;',
  'esac',
].join('\n');

function hostOf(env) {
  return String(env.hostAddress || env.hostAddr || '127.0.0.1');
}

function baseArgs(env) {
  const args = [];
  const socket = String(env.socket || '').trim();
  if (socket) {
    args.push('-s', socket);
  } else {
    args.push('-h', hostOf(env));
    if (env.port) args.push('-p', String(env.port));
  }
  const db = String(env.database === undefined || env.database === null ? '' : env.database).trim();
  if (db && /^\d+$/.test(db)) args.push('-n', db);
  if (env.tls) args.push('--tls');
  return args;
}

function plan(env, args, parse, timeout) {
  return {
    argv: ['sh', '-c', CLIENT_SCRIPT, 'sh'].concat(baseArgs(env), args),
    stdin: String(env.pass === null || env.pass === undefined ? '' : env.pass) + '\n',
    timeout: timeout || 60,
    parse,
  };
}

function detailPlan(env, key) {
  return {
    argv: ['sh', '-c', DETAIL_SCRIPT, 'sh', key].concat(baseArgs(env)),
    stdin: String(env.pass === null || env.pass === undefined ? '' : env.pass) + '\n',
    timeout: 45,
    parse: parseDetail,
  };
}

/* ------------------------------ 解析 ------------------------------ */

function errorResult(r) {
  const message = (r.err || r.out || '').trim();
  return { error: true, message: message || 'redis-cli 返回失败', columns: [], rows: [], affected: null, text: message };
}

/** 去掉 redis 输出里的成对引号与常见转义 */
function unquote(value) {
  let s = String(value === null || value === undefined ? '' : value).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    s = s.slice(1, -1);
    let out = '';
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === BS && i + 1 < s.length) {
        const next = s[i + 1];
        if (next === 'n') { out += '\n'; i += 1; continue; }
        if (next === 't') { out += '\t'; i += 1; continue; }
        if (next === '"' || next === BS) { out += next; i += 1; continue; }
        out += next; i += 1; continue;
      }
      out += ch;
    }
    return out;
  }
  return s;
}

function parseScan(r) {
  if (!r.ok) return { error: true, message: (r.err || r.out || '').trim(), cursor: '0', keys: [] };
  const lines = String(r.out || '').replace(/\r\n/g, '\n').split('\n')
    .map((x) => x.trim()).filter(Boolean);
  let cursor = '0';
  const keys = [];
  let first = true;
  for (const line of lines) {
    const item = /^(\d+)\)\s*(.*)$/.exec(line);
    if (item) { keys.push(unquote(item[2])); continue; }
    if (first) { cursor = unquote(line); first = false; continue; }
    keys.push(unquote(line));
  }
  if (!/^\d+$/.test(cursor)) cursor = '0';
  return { error: false, cursor, keys };
}

function parseDetail(r) {
  if (!r.ok) return errorResult(r);
  const lines = String(r.out || '').replace(/\r\n/g, '\n').split('\n');
  let type = '';
  let ttl = '';
  const value = [];
  let inValue = false;
  for (const line of lines) {
    if (line.indexOf('__TYPE__') === 0) { type = unquote(line.slice(8)); inValue = false; continue; }
    if (line.indexOf('__TTL__') === 0) { ttl = unquote(line.slice(7)); inValue = false; continue; }
    if (line === '__VAL__') { inValue = true; continue; }
    if (inValue) value.push(line);
  }
  const text = value.join('\n').trim();
  return { error: false, type, ttl, text, columns: [], rows: [], affected: null };
}

function parseNames(r) {
  if (!r.ok) return [];
  const nums = String(r.out || '').split('\n').map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
  const total = nums.length ? Number(nums[nums.length - 1]) : 16;
  const n = total > 0 && total <= 1024 ? total : 16;
  const list = [];
  for (let i = 0; i < n; i += 1) list.push({ name: String(i) });
  return list;
}

export default {
  id: 'sql-redis',
  name: 'Redis',
  kind: 'redis',
  client: 'redis-cli',
  clientLabel: 'redis-cli',
  versionFlag: '--version',
  defaultPort: 6379,

  fields: [
    { key: 'hostAddress', label: '数据库地址', placeholder: '默认取 SSH 主机地址', wide: true },
    { key: 'port', label: '端口', type: 'number', def: '6379', placeholder: '6379' },
    { key: 'database', label: '库编号', def: '0', placeholder: '0-15' },
    { key: 'tls', label: '启用 TLS', type: 'check' },
    { key: 'socket', label: 'Unix Socket', placeholder: '可选，填写后忽略地址与端口', wide: true },
  ],

  install: {
    apt: 'sudo apt update && sudo apt install -y redis-tools',
    dnf: 'sudo dnf install -y redis',
    yum: 'sudo yum install -y redis',
    pacman: 'sudo pacman -S --noconfirm redis',
    zypper: 'sudo zypper install -y redis',
    apk: 'sudo apk add redis',
  },
  installTip: '只需客户端，不会改动服务端配置；生产环境建议只授予只读账号。',

  sqlTemplate: '',

  test(env) {
    return plan(env, ['PING'], (r) => {
      if (!r.ok) return errorResult(r);
      return { error: false, message: (r.out || '').trim(), columns: [], rows: [], affected: null };
    }, 25);
  },

  listDatabases(env) {
    return plan(env, ['CONFIG', 'GET', 'databases'], parseNames, 25);
  },

  scanKeys(env) {
    const cursor = /^\d+$/.test(String(env.cursor || '')) ? String(env.cursor) : '0';
    const pattern = String(env.pattern || '*');
    return plan(env, ['SCAN', cursor, 'MATCH', pattern, 'COUNT', '200'], parseScan, 40);
  },

  keyDetail(env) {
    return detailPlan(env, String(env.key || ''));
  },

  redisCommand(env) {
    const args = Array.isArray(env.args) ? env.args.map(String) : [];
    return plan(env, args, (r) => {
      if (!r.ok) return errorResult(r);
      return { error: false, message: '', text: String(r.out || '').trim(), columns: [], rows: [], affected: null };
    }, 60);
  },
};
