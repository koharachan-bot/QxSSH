/**
 * dialect.js —— SQLite 驱动
 *
 * 连接对象是远端主机上的库文件，没有账号口令，因此不需要临时凭据文件；
 * 远端路径支持 ~ 前缀，由远端 shell 展开。结果统一走 sqlite3 -json。
 */

import { isQueryStatement, trimSemicolon } from './engine.js';

function sqlString(value) {
  return "'" + String(value === null || value === undefined ? '' : value).split("'").join("''") + "'";
}

function ident(name) {
  return '"' + String(name || '').split('"').join('""') + '"';
}

function fileOf(env) {
  return String(env.database || '').trim();
}

/** 远端脚本：展开 ~ 前缀后调用 sqlite3，SQL 通过位置参数传入，不参与 shell 解析 */
const CLIENT_SCRIPT = [
  'p="$1"',
  'case "$p" in',
  '  "~") p="$HOME" ;;',
  '  "~/"*) p="$HOME/${p#\~}" ;;',
  'esac',
  '[ -f "$p" ] || { echo "库文件不存在：$p" >&2; exit 3; }',
  'shift',
  'sqlite3 -json "$p" "$@"',
].join('\n');

function plan(env, args, parse, timeout) {
  return {
    argv: ['sh', '-c', CLIENT_SCRIPT, 'sh', fileOf(env)].concat(args),
    stdin: '',
    timeout: timeout || 60,
    parse,
  };
}

function errorResult(r) {
  const message = (r.err || r.out || '').trim();
  return { error: true, message: message || 'sqlite3 返回失败', columns: [], rows: [], affected: null, text: message };
}

/** 解析 -json 输出；非查询语句追加的 changes() 结果会被单独摘出 */
function parseJson(r) {
  if (!r.ok) return errorResult(r);
  let text = String(r.out || '').trim();
  let affected = null;
  const affectedRe = /\[\s*\{\s*"qx_affected"\s*:\s*(-?\d+)\s*\}\s*\]\s*$/;
  const hit = affectedRe.exec(text);
  if (hit) {
    affected = Number(hit[1]);
    text = text.slice(0, hit.index).trim();
  }
  if (!text) {
    return { error: false, columns: [], rows: [], affected, message: affected === null ? '语句已执行' : '' };
  }
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) {
      return { error: false, columns: [], rows: [], affected, text };
    }
    if (!arr.length) return { error: false, columns: [], rows: [], affected, message: '没有返回数据行' };
    if (typeof arr[0] !== 'object' || arr[0] === null) {
      return { error: false, columns: ['值'], rows: arr.map((v) => [v === null ? null : String(v)]), affected };
    }
    const columns = Object.keys(arr[0]);
    const rows = arr.map((obj) => columns.map((key) => (obj[key] === undefined ? null : obj[key] === null ? null : String(obj[key]))));
    return { error: false, columns, rows, affected, message: '' };
  } catch (e) {
    return { error: false, columns: [], rows: [], affected, text };
  }
}

function parseNames(r) {
  const parsed = parseJson(r);
  if (parsed.error) return [];
  if (parsed.rows && parsed.rows.length) {
    return parsed.rows.map((row) => String(row[0])).filter(Boolean);
  }
  return [];
}

export default {
  id: 'sql-sqlite',
  name: 'SQLite',
  kind: 'sql',
  client: 'sqlite3',
  clientLabel: 'SQLite 客户端',
  versionFlag: '--version',
  defaultPort: 0,
  singleStore: true,
  fileTools: true,
  hidePassword: true,

  fields: [
    { key: 'database', label: '库文件', placeholder: '远端绝对路径，如 /var/data/app.db', wide: true },
  ],

  install: {
    apt: 'sudo apt update && sudo apt install -y sqlite3',
    dnf: 'sudo dnf install -y sqlite',
    yum: 'sudo yum install -y sqlite',
    pacman: 'sudo pacman -S --noconfirm sqlite',
    zypper: 'sudo zypper install -y sqlite3',
    apk: 'sudo apk add sqlite',
  },
  installTip: '需要 sqlite3 3.33 及以上版本（-json 输出）；更老的版本请先升级。',

  sqlTemplate: "SELECT sqlite_version() AS version, datetime('now') AS now_time;",
  sqlPlaceholder: '输入 SQL，Ctrl+Enter 执行',

  quoteIdent: ident,

  selectTemplate(db, table) {
    return 'SELECT * FROM ' + ident(table) + ' LIMIT 100;';
  },

  test(env) {
    return plan(env, ['SELECT 1 AS ok'], parseJson, 30);
  },

  listDatabases() {
    return { argv: ['sh', '-c', 'true'], stdin: '', timeout: 10, parse: () => [] };
  },

  listTables(env) {
    const sql = [
      "SELECT name FROM sqlite_master",
      " WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
      ' ORDER BY name',
    ].join('\n');
    return plan(env, [sql], (r) => parseNames(r), 40);
  },

  tableSchema(env) {
    const table = sqlString(env.table);
    const sql = [
      "SELECT 'COL' AS kind, name AS c1, type AS c2,",
      "       CASE WHEN pk > 0 THEN 'PK' ELSE '' END AS c3,",
      "       CASE WHEN \"notnull\" = 0 THEN 'YES' ELSE 'NO' END AS c4",
      '  FROM pragma_table_info(' + table + ')',
      'UNION ALL',
      "SELECT 'IDX', name, '', CASE WHEN \"unique\" = 1 THEN 'UNIQUE' ELSE 'INDEX' END, ''",
      '  FROM pragma_index_list(' + table + ')',
    ].join('\n');
    return plan(env, [sql], (r) => {
      const parsed = parseJson(r);
      if (parsed.error) return { error: true, message: parsed.message, columns: [], indexes: [] };
      const columns = [];
      const indexes = [];
      const data = JSON.parse(String(r.out || '[]'));
      for (const item of data) {
        if (item.kind === 'COL') {
          columns.push({ name: item.c1 || '', type: item.c2 || '', key: item.c3 || '', nullable: item.c4 === 'YES' });
        } else if (item.kind === 'IDX') {
          indexes.push({ name: item.c1 || '', columns: [], unique: item.c3 === 'UNIQUE' });
        }
      }
      return { error: false, columns, indexes };
    }, 45);
  },

  run(env) {
    const sql = trimSemicolon(env.sql);
    const query = isQueryStatement(env.sql);
    const finalSql = query ? sql : sql + ';\nSELECT changes() AS qx_affected;';
    return plan(env, [finalSql], parseJson, 120);
  },
};
