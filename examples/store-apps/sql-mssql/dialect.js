/**
 * dialect.js —— Microsoft SQL Server 驱动
 *
 * 口令经远端临时文件写入 SQLCMDPASSWORD 环境变量，argv 中不出现口令；
 * 数据通道固定 -h -1 -W -s "|"，列名单独用 sys.dm_exec_describe_first_result_set 探测。
 */

import { trimSemicolon } from './engine.js';

const CLIENT_SCRIPT = [
  'umask 077',
  'd=$(mktemp -d 2>/dev/null) || exit 1',
  "trap 'rm -rf \"$d\"' EXIT INT TERM",
  'cat > "$d/pw" || exit 1',
  'SQLCMDPASSWORD=$(cat "$d/pw") sqlcmd "$@"',
].join('\n');

function hostOf(env) {
  return String(env.hostAddress || env.hostAddr || '127.0.0.1');
}

function sqlString(value) {
  return "'" + String(value === null || value === undefined ? '' : value).split("'").join("''") + "'";
}

function ident(name) {
  return '[' + String(name || '').split(']').join(']]') + ']';
}

function serverOf(env) {
  const port = String(env.port || '').trim();
  return port ? hostOf(env) + ',' + port : hostOf(env);
}

function baseArgs(env, db) {
  const args = ['-S', serverOf(env)];
  if (env.user) args.push('-U', String(env.user));
  const database = String(db || env.dbName || env.database || '').trim();
  if (database) args.push('-d', database);
  args.push('-N', env.ssl ? 'm' : 'o');
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

function errorResult(r) {
  const message = (r.err || r.out || '').trim();
  return { error: true, message: message || 'sqlcmd 返回失败', columns: [], rows: [], affected: null, text: message };
}

function cleanLines(text) {
  return String(text || '').replace(/\r\n/g, '\n').split('\n').map((line) => line.replace(/\s+$/, ''));
}

/** 解析数据行，同时把 (N rows affected) 折算成影响行数 */
function parseRows(r) {
  if (!r.ok) return errorResult(r);
  const rows = [];
  let affected = null;
  for (const line of cleanLines(r.out)) {
    if (!line.trim()) continue;
    const hit = /^\((\d+) rows? affected\)$/.exec(line.trim());
    if (hit) { affected = Number(hit[1]); continue; }
    rows.push(line.split('|').map((v) => (v === '' ? null : v)));
  }
  return { error: false, columns: [], rows, affected, message: '' };
}

function parseNames(r) {
  if (!r.ok) return [];
  return cleanLines(r.out).map((x) => x.trim()).filter(Boolean).map((name) => ({ name }));
}

function splitTable(table) {
  const parts = String(table || '').split('.').filter(Boolean);
  if (parts.length > 1) return { schema: parts[0], name: parts[1] };
  return { schema: 'dbo', name: parts[0] || '' };
}

export default {
  id: 'sql-mssql',
  name: 'SQL Server',
  kind: 'sql',
  client: 'sqlcmd',
  clientLabel: 'SQL Server 命令行工具',
  versionFlag: '-?',
  defaultPort: 1433,

  fields: [
    { key: 'hostAddress', label: '数据库地址', placeholder: '默认取 SSH 主机地址', wide: true },
    { key: 'port', label: '端口', type: 'number', def: '1433', placeholder: '1433' },
    { key: 'user', label: '用户', def: 'sa', placeholder: 'sa' },
    { key: 'database', label: '默认库', placeholder: 'master' },
    { key: 'ssl', label: '强制加密', type: 'check' },
  ],

  install: {
    apt: 'sudo apt install -y mssql-tools18 unixodbc-dev',
    dnf: 'sudo dnf install -y mssql-tools18 unixODBC-devel',
    yum: 'sudo yum install -y mssql-tools18 unixODBC-devel',
    zypper: 'sudo zypper install -y mssql-tools18 unixODBC-devel',
    pacman: 'sudo pacman -S --noconfirm unixodbc',
    apk: 'sudo apk add unixodbc',
  },
  installTip: 'mssql-tools18 需要先添加 Microsoft 软件源；安装后把 /opt/mssql-tools18/bin 加入 PATH。若服务端使用自签证书，请关闭「强制加密」或改用 mssql-tools17。',

  sqlTemplate: 'SELECT @@VERSION AS version, GETDATE() AS now_time;',
  sqlPlaceholder: '输入 T-SQL，Ctrl+Enter 执行',

  quoteIdent: ident,

  selectTemplate(db, table) {
    const t = splitTable(table);
    return 'SELECT TOP 100 * FROM ' + ident(t.schema) + '.' + ident(t.name) + ';';
  },

  test(env) {
    return plan(env, ['-h', '-1', '-W', '-s', '|', '-Q', 'SET NOCOUNT ON; SELECT 1 AS ok'], parseRows, 30);
  },

  listDatabases(env) {
    return plan(env, ['-h', '-1', '-W', '-s', '|', '-Q', 'SET NOCOUNT ON; SELECT name FROM sys.databases ORDER BY name'], parseNames, 40);
  },

  listTables(env) {
    const sql = [
      'SET NOCOUNT ON;',
      "SELECT s.name + '.' + t.name FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id",
      'UNION ALL',
      "SELECT s.name + '.' + v.name FROM sys.views v JOIN sys.schemas s ON v.schema_id = s.schema_id",
      'ORDER BY 1',
    ].join(' ');
    return plan(env, ['-h', '-1', '-W', '-s', '|', '-Q', sql], (r) => parseNames(r).map((x) => x.name), 40);
  },

  tableSchema(env) {
    const t = splitTable(env.table);
    const objectName = sqlString(t.schema + '.' + t.name);
    const sql = [
      'SET NOCOUNT ON;',
      "SELECT 'COL', c.name, ty.name,",
      "       CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END,",
      "       CASE WHEN pk.column_id IS NULL THEN '' ELSE 'PK' END",
      '  FROM sys.columns c',
      '  JOIN sys.types ty ON c.user_type_id = ty.user_type_id',
      '  LEFT JOIN (SELECT ic.object_id, ic.column_id FROM sys.indexes i',
      '             JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id',
      '             WHERE i.is_primary_key = 1) pk',
      '    ON pk.object_id = c.object_id AND pk.column_id = c.column_id',
      ' WHERE c.object_id = OBJECT_ID(' + objectName + ')',
      'UNION ALL',
      "SELECT 'IDX', i.name, '', CASE WHEN i.is_unique = 1 THEN 'UNIQUE' ELSE 'INDEX' END, ''",
      '  FROM sys.indexes i',
      ' WHERE i.object_id = OBJECT_ID(' + objectName + ') AND i.name IS NOT NULL;',
    ].join('\n');
    return plan(env, ['-h', '-1', '-W', '-s', '|', '-Q', sql], (r) => {
      if (!r.ok) return { error: true, message: (r.err || r.out || '').trim(), columns: [], indexes: [] };
      const columns = [];
      const indexes = [];
      for (const line of cleanLines(r.out)) {
        if (!line.trim()) continue;
        const cells = line.split('|');
        if (cells[0] === 'COL') {
          columns.push({ name: cells[1] || '', type: cells[2] || '', key: cells[4] || '', nullable: cells[3] === 'YES' });
        } else if (cells[0] === 'IDX') {
          indexes.push({ name: cells[1] || '', columns: [], unique: cells[3] === 'UNIQUE' });
        }
      }
      return { error: false, columns, indexes };
    }, 45);
  },

  run(env) {
    const sql = 'SET NOCOUNT ON;\n' + trimSemicolon(env.sql);
    return plan(env, ['-h', '-1', '-W', '-s', '|', '-Q', sql], (r) => {
      const parsed = parseRows(r);
      if (parsed.error) return parsed;
      if (!parsed.rows.length && parsed.affected === null) parsed.message = '语句已执行';
      return parsed;
    }, 120);
  },

  columns(env) {
    const inner = trimSemicolon(env.sql).split("'").join("''");
    const sql = "SET NOCOUNT ON; SELECT name FROM sys.dm_exec_describe_first_result_set(N'" + inner + "', NULL, 0) ORDER BY column_ordinal";
    return plan(env, ['-h', '-1', '-W', '-s', '|', '-Q', sql], (r) => {
      if (!r.ok) return [];
      return cleanLines(r.out).map((x) => x.trim()).filter(Boolean);
    }, 30);
  },
};
