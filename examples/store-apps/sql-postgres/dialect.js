/**
 * dialect.js —— PostgreSQL 驱动
 *
 * 安全要点：口令写入远端临时文件（0600），再经 PGPASSWORD 环境变量传给 psql，
 * argv 里没有口令；临时文件随进程退出被清理。
 */

import { isQueryStatement, trimSemicolon } from './engine.js';

const BS = String.fromCharCode(92);

/** 远端执行外壳；requireSsl 为真时强制 SSL */
function clientScript(requireSsl) {
  return [
    'umask 077',
    'd=$(mktemp -d 2>/dev/null) || exit 1',
    "trap 'rm -rf \"$d\"' EXIT INT TERM",
    'cat > "$d/pw" || exit 1',
    'PGPASSWORD=$(cat "$d/pw") PGSSLMODE=' + (requireSsl ? 'require' : 'prefer') + ' psql "$@"',
  ].join('\n');
}

function sqlString(value) {
  return "'" + String(value === null || value === undefined ? '' : value).split("'").join("''") + "'";
}

function ident(name) {
  return '"' + String(name || '').split('"').join('""') + '"';
}

function hostOf(env) {
  return String(env.hostAddress || env.hostAddr || '127.0.0.1');
}

function baseArgs(env, withTuples) {
  const args = ['-A'];
  if (withTuples) args.push('-t');
  args.push('-P', 'null=<<NULL>>');
  const socket = String(env.socket || '').trim();
  args.push('-h', socket || hostOf(env));
  if (!socket && env.port) args.push('-p', String(env.port));
  if (env.user) args.push('-U', String(env.user));
  return args;
}

function plan(env, args, parse, timeout, withTuples) {
  return {
    argv: ['sh', '-c', clientScript(!!env.ssl), 'sh'].concat(baseArgs(env, withTuples !== false), args),
    stdin: String(env.pass === null || env.pass === undefined ? '' : env.pass) + '\n',
    timeout: timeout || 60,
    parse,
  };
}

function databaseOf(env) {
  return String(env.dbName || env.database || 'postgres');
}

/* ------------------------------ 解析 ------------------------------ */

function errorResult(r) {
  const message = (r.err || r.out || '').trim();
  return { error: true, message: message || '客户端返回失败', columns: [], rows: [], affected: null, text: message };
}

function splitLine(line) {
  return line.split('|').map((v) => (v === '<<NULL>>' ? null : v));
}

/** psql 在 -c 下会把命令标签打到 stdout，需要剔除并从标签里取影响行数 */
function isCommandTag(line) {
  return /^[A-Z]+( \d+)?( \d+)?$/.test(line) && line.indexOf('|') < 0;
}

function parseRows(r) {
  if (!r.ok) return errorResult(r);
  const lines = String(r.out || '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const rows = [];
  let affected = null;
  let message = '';
  for (const line of lines) {
    if (isCommandTag(line)) {
      const m = /^(UPDATE|DELETE|INSERT|SELECT|COPY) (\d+)/.exec(line);
      if (m) affected = Number(m[2]);
      message = line;
      continue;
    }
    rows.push(splitLine(line));
  }
  return { error: false, columns: [], rows, affected, message };
}

function parseNames(r) {
  if (!r.ok) return [];
  return String(r.out || '').replace(/\r\n/g, '\n').split('\n')
    .map((x) => x.trim()).filter(Boolean).map((name) => ({ name }));
}

function splitTable(table) {
  const parts = String(table || '').split('.').filter(Boolean);
  if (parts.length > 1) return { schema: parts[0], name: parts[1] };
  return { schema: 'public', name: parts[0] || '' };
}

export default {
  id: 'sql-postgres',
  name: 'PostgreSQL',
  kind: 'sql',
  client: 'psql',
  clientLabel: 'PostgreSQL 客户端',
  versionFlag: '--version',
  defaultPort: 5432,

  fields: [
    { key: 'hostAddress', label: '数据库地址', placeholder: '默认取 SSH 主机地址', wide: true },
    { key: 'port', label: '端口', type: 'number', def: '5432', placeholder: '5432' },
    { key: 'user', label: '用户', def: 'postgres', placeholder: 'postgres' },
    { key: 'database', label: '默认库', placeholder: 'postgres' },
    { key: 'ssl', label: '强制 SSL', type: 'check' },
    { key: 'socket', label: 'Unix Socket', placeholder: '可选，socket 目录，如 /var/run/postgresql', wide: true },
  ],

  install: {
    apt: 'sudo apt update && sudo apt install -y postgresql-client',
    dnf: 'sudo dnf install -y postgresql',
    yum: 'sudo yum install -y postgresql',
    pacman: 'sudo pacman -S --noconfirm postgresql-libs postgresql',
    zypper: 'sudo zypper install -y postgresql',
    apk: 'sudo apk add postgresql-client',
  },
  installTip: '客户端版本建议不低于服务端主版本；Debian 可用 postgresql-client-16 指定版本。',

  sqlTemplate: 'SELECT version() AS version, now() AS now_time;',
  sqlPlaceholder: '输入 SQL，Ctrl+Enter 执行',

  quoteIdent: ident,

  selectTemplate(db, table) {
    const t = splitTable(table);
    return 'SELECT * FROM ' + ident(t.schema) + '.' + ident(t.name) + ' LIMIT 100;';
  },

  test(env) {
    return plan(env, ['-d', databaseOf(env), '-c', 'SELECT 1'], parseRows, 30);
  },

  listDatabases(env) {
    return plan(env, ['-d', databaseOf(env), '-c',
      'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname'], parseNames, 40);
  },

  listTables(env) {
    const sql = [
      "SELECT schemaname || '.' || tablename AS name FROM pg_tables",
      " WHERE schemaname NOT IN ('pg_catalog','information_schema')",
      'UNION ALL',
      "SELECT schemaname || '.' || viewname FROM pg_views",
      " WHERE schemaname NOT IN ('pg_catalog','information_schema')",
      'ORDER BY 1',
    ].join('\n');
    return plan(env, ['-d', databaseOf(env), '-c', sql], (r) => parseNames(r).map((x) => x.name), 40);
  },

  tableSchema(env) {
    const t = splitTable(env.table);
    const sql = [
      "SELECT 'COL', c.column_name, c.data_type,",
      "       CASE WHEN c.is_nullable = 'YES' THEN 'YES' ELSE 'NO' END,",
      "       CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN 'PK' ELSE '' END, '', c.ordinal_position",
      '  FROM information_schema.columns c',
      '  LEFT JOIN information_schema.key_column_usage k',
      '    ON k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = c.column_name',
      '  LEFT JOIN information_schema.table_constraints tc',
      "    ON tc.constraint_name = k.constraint_name AND tc.table_schema = k.table_schema AND tc.constraint_type = 'PRIMARY KEY'",
      ' WHERE c.table_schema = ' + sqlString(t.schema) + ' AND c.table_name = ' + sqlString(t.name),
      'UNION ALL',
      "SELECT 'IDX', indexname, indexdef, '', '', 0 FROM pg_indexes",
      ' WHERE schemaname = ' + sqlString(t.schema) + ' AND tablename = ' + sqlString(t.name),
    ].join('\n');
    return plan(env, ['-d', databaseOf(env), '-c', sql], (r) => {
      if (!r.ok) return { error: true, message: (r.err || r.out || '').trim(), columns: [], indexes: [] };
      const columns = [];
      const indexes = [];
      for (const line of String(r.out || '').split('\n')) {
        const cells = line.split('|');
        if (cells[0] === 'COL') {
          columns.push({ name: cells[1] || '', type: cells[2] || '', key: cells[4] || '', nullable: cells[3] === 'YES' });
        } else if (cells[0] === 'IDX') {
          indexes.push({ name: cells[1] || '', columns: [], unique: /UNIQUE INDEX/.test(cells[2] || '') });
        }
      }
      return { error: false, columns, indexes };
    }, 45);
  },

  run(env) {
    const db = databaseOf(env);
    const sql = trimSemicolon(env.sql);
    return plan(env, ['-d', db, '-c', sql], (r) => {
      const parsed = parseRows(r);
      if (parsed.error) return parsed;
      if (!parsed.rows.length && !parsed.message) parsed.message = '语句已执行';
      if (!parsed.rows.length && parsed.message) parsed.message = parsed.message;
      return parsed;
    }, 120);
  },

  columns(env) {
    const sql = 'SELECT * FROM (' + trimSemicolon(env.sql) + ') AS qx_probe LIMIT 0';
    return plan(env, ['-d', databaseOf(env), '-c', sql], (r) => {
      if (!r.ok) return [];
      const first = String(r.out || '').split('\n')[0];
      if (!first) return [];
      return first.split('|').map((v) => (v === '<<NULL>>' ? 'NULL' : v));
    }, 30, false);
  },
};
