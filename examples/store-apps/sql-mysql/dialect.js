/**
 * dialect.js —— MySQL / MariaDB 驱动
 *
 * 安全要点：口令不经过 argv。客户端在远端把 stdin 写成临时 my.cnf（0600），
 * 由 --defaults-file 读取，进程列表与审计日志里只看到语句与连接参数。
 */

import { isQueryStatement, trimSemicolon } from './engine.js';

const BS = String.fromCharCode(92);

/** 远端执行外壳：读 stdin 到临时凭据文件，再用 --defaults-file 调用客户端 */
const CLIENT_SCRIPT = [
  'umask 077',
  'd=$(mktemp -d 2>/dev/null) || exit 1',
  "trap 'rm -rf \"$d\"' EXIT INT TERM",
  'cat > "$d/c.cnf" || exit 1',
  'mysql --defaults-file="$d/c.cnf" "$@"',
].join('\n');

/** 生成 my.cnf 片段；口令里的反斜杠与双引号按 MySQL 选项文件规则转义 */
function cnfText(pass) {
  let value = '';
  const s = String(pass === null || pass === undefined ? '' : pass);
  for (const ch of s) {
    if (ch === BS || ch === '"') value += BS + ch;
    else if (ch === '\n' || ch === '\r') continue;
    else value += ch;
  }
  return '[client]' + '\n' + 'password="' + value + '"' + '\n';
}

/** 把普通字符串转成 SQL 字符串字面量 */
function sqlString(value) {
  let out = '';
  for (const ch of String(value === null || value === undefined ? '' : value)) {
    if (ch === BS || ch === "'") out += BS + ch;
    else out += ch;
  }
  return "'" + out + "'";
}

/** 反引号标识符 */
function ident(name) {
  return '`' + String(name || '').split('`').join('``') + '`';
}

function hostOf(env) {
  return String(env.hostAddress || env.hostAddr || '127.0.0.1');
}

/** 连接参数（不含口令与语句） */
function baseArgs(env) {
  const args = [];
  const socket = String(env.socket || '').trim();
  if (socket) {
    args.push('--socket=' + socket);
  } else {
    args.push('-h', hostOf(env));
    if (env.port) args.push('-P', String(env.port));
  }
  if (env.user) args.push('-u', String(env.user));
  if (env.ssl) args.push('--ssl');
  return args;
}

function plan(env, args, parse, timeout) {
  return {
    argv: ['sh', '-c', CLIENT_SCRIPT, 'sh'].concat(baseArgs(env), args),
    stdin: cnfText(env.pass),
    timeout: timeout || 60,
    parse,
  };
}

/* ------------------------------ 结果解析 ------------------------------ */

function errorResult(r) {
  const message = (r.err || r.out || '').trim();
  return { error: true, message: message || '客户端返回失败', columns: [], rows: [], affected: null, text: message };
}

/** 按 -N -B 的制表符格式解析数据 */
function parseRows(r) {
  if (!r.ok) return errorResult(r);
  const text = String(r.out || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const rows = lines.map((line) => line.split('\t').map((v) => (v === 'NULL' ? null : v)));
  return { error: false, columns: [], rows, affected: null, message: '' };
}

/** 逐行取单列结果 */
function parseNames(r) {
  if (!r.ok) return [];
  return String(r.out || '').replace(/\r\n/g, '\n').split('\n')
    .map((x) => x.trim()).filter(Boolean).map((name) => ({ name }));
}

/* ------------------------------ 方言接口 ------------------------------ */

export default {
  id: 'sql-mysql',
  name: 'MySQL',
  kind: 'sql',
  client: 'mysql',
  clientLabel: 'MySQL 客户端',
  versionFlag: '--version',
  defaultPort: 3306,

  fields: [
    { key: 'hostAddress', label: '数据库地址', placeholder: '默认取 SSH 主机地址', wide: true },
    { key: 'port', label: '端口', type: 'number', def: '3306', placeholder: '3306' },
    { key: 'user', label: '用户', def: 'root', placeholder: 'root' },
    { key: 'database', label: '默认库', placeholder: '可选，如 app' },
    { key: 'ssl', label: '启用 SSL', type: 'check' },
    { key: 'socket', label: 'Unix Socket', placeholder: '可选，填写后忽略地址与端口', wide: true },
  ],

  install: {
    apt: 'sudo apt update && sudo apt install -y default-mysql-client',
    dnf: 'sudo dnf install -y mariadb',
    yum: 'sudo yum install -y mariadb',
    pacman: 'sudo pacman -S --noconfirm mariadb-clients',
    zypper: 'sudo zypper install -y mariadb-client',
    apk: 'sudo apk add mariadb-client',
  },
  installTip: 'Debian/Ubuntu 上 MariaDB 客户端也能连 MySQL；企业环境可用 mysql-client 包。',

  sqlTemplate: 'SELECT VERSION() AS version, NOW() AS now_time;',
  sqlPlaceholder: '输入 SQL，Ctrl+Enter 执行；选中部分暂不支持，整段内容会一次性下发',

  quoteIdent: ident,

  selectTemplate(db, table) {
    const parts = String(table || '').split('.').filter(Boolean);
    if (parts.length > 1) return 'SELECT * FROM ' + ident(parts[0]) + '.' + ident(parts[1]) + ' LIMIT 100;';
    const prefix = db ? ident(db) + '.' : '';
    return 'SELECT * FROM ' + prefix + ident(table || '') + ' LIMIT 100;';
  },

  test(env) {
    const db = String(env.dbName || env.database || '');
    const argv = ['-e', 'SELECT 1'];
    if (db) argv.push(db);
    return plan(env, argv, parseRows, 30);
  },

  listDatabases(env) {
    return plan(env, ['-N', '-B', '-e', 'SHOW DATABASES'], (r) => parseNames(r), 40);
  },

  listTables(env) {
    const db = String(env.dbName || env.database || '');
    const argv = ['-N', '-B', '-e', 'SHOW TABLES'];
    if (db) argv.push(db);
    return plan(env, argv, (r) => parseNames(r).map((x) => x.name), 40);
  },

  tableSchema(env) {
    const parts = String(env.table || '').split('.').filter(Boolean);
    const table = parts[parts.length - 1];
    const sql = [
      "SELECT 'COL' AS kind, COLUMN_NAME AS c1, COLUMN_TYPE AS c2, COLUMN_KEY AS c3,",
      "       CASE WHEN IS_NULLABLE = 'YES' THEN 'YES' ELSE 'NO' END AS c4, '' AS c5, ORDINAL_POSITION AS c6",
      '  FROM information_schema.COLUMNS',
      ' WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ' + sqlString(table),
      'UNION ALL',
      "SELECT 'IDX', INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX),",
      "       CASE WHEN NON_UNIQUE = 0 THEN 'UNIQUE' ELSE 'INDEX' END, '', '', MIN(SEQ_IN_INDEX)",
      '  FROM information_schema.STATISTICS',
      ' WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ' + sqlString(table),
      ' GROUP BY INDEX_NAME, NON_UNIQUE',
    ].join('\n');
    const db = String(env.dbName || env.database || '');
    const argv = ['-N', '-B', '-e', sql];
    if (db) argv.push(db);
    return plan(env, argv, (r) => {
      if (!r.ok) return { error: true, message: (r.err || r.out || '').trim(), columns: [], indexes: [] };
      const columns = [];
      const indexes = [];
      for (const line of String(r.out || '').split('\n')) {
        const cells = line.split('\t');
        if (cells[0] === 'COL') {
          columns.push({ name: cells[1] || '', type: cells[2] || '', key: cells[3] || '', nullable: cells[4] === 'YES' });
        } else if (cells[0] === 'IDX') {
          indexes.push({ name: cells[1] || '', columns: (cells[2] || '').split(',').filter(Boolean), unique: cells[3] === 'UNIQUE' });
        }
      }
      return { error: false, columns, indexes };
    }, 45);
  },

  run(env) {
    const sql = trimSemicolon(env.sql);
    const query = isQueryStatement(env.sql);
    const finalSql = query ? sql : sql + ';\nSELECT ROW_COUNT() AS qx_affected;';
    const db = String(env.dbName || env.database || '');
    const argv = ['-N', '-B', '-e', finalSql];
    if (db) argv.push(db);
    return plan(env, argv, (r) => {
      const parsed = parseRows(r);
      if (parsed.error || query) return parsed;
      const rows = parsed.rows;
      if (rows.length) {
        const last = rows[rows.length - 1];
        if (last.length === 1 && /^-?\d+$/.test(String(last[0]))) {
          parsed.affected = Number(last[0]);
          parsed.rows = rows.slice(0, -1);
        }
      }
      if (!parsed.rows.length) parsed.message = '语句已执行';
      return parsed;
    }, 120);
  },

  columns(env) {
    const sql = 'SELECT * FROM (' + trimSemicolon(env.sql) + ') AS qx_probe LIMIT 0';
    const db = String(env.dbName || env.database || '');
    const argv = ['-B', '-e', sql];
    if (db) argv.push(db);
    return plan(env, argv, (r) => {
      if (!r.ok) return [];
      const first = String(r.out || '').split('\n')[0];
      if (!first) return [];
      return first.split('\t');
    }, 30);
  },
};
