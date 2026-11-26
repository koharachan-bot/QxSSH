/**
 * dialect.js —— MongoDB 驱动
 *
 * 口令只出现在经 stdin 写入远端临时文件的 mongosh 脚本里，argv 中只有脚本路径；
 * 脚本执行完随进程退出被清理。
 */

import { trimSemicolon } from './engine.js';

const CLIENT_SCRIPT = [
  'umask 077',
  'd=$(mktemp -d 2>/dev/null) || exit 1',
  "trap 'rm -rf \"$d\"' EXIT INT TERM",
  'cat > "$d/q.js" || exit 1',
  'mongosh --quiet --nodb --file "$d/q.js"',
].join('\n');

function hostOf(env) {
  return String(env.hostAddress || env.hostAddr || '127.0.0.1');
}

function databaseOf(env) {
  return String(env.dbName || env.database || 'admin');
}

/** 拼装连接串；口令做 URI 编码，避免特殊字符破坏语法 */
function uriOf(env) {
  const host = hostOf(env);
  const port = env.port ? String(env.port) : '27017';
  const dbName = databaseOf(env);
  const authSource = String(env.authSource || 'admin');
  const user = encodeURIComponent(String(env.user || ''));
  const pass = encodeURIComponent(String(env.pass || ''));
  const auth = user ? user + ':' + pass + '@' : '';
  let query = 'authSource=' + encodeURIComponent(authSource);
  if (env.tls) query += '&tls=true&tlsAllowInvalidCertificates=true';
  return 'mongodb://' + auth + host + ':' + port + '/' + encodeURIComponent(dbName) + '?' + query;
}

/** 生成一次性的 mongosh 脚本：连接、切库、执行 body，异常统一转成 __error */
function script(env, body) {
  return [
    'const __uri = ' + JSON.stringify(uriOf(env)) + ';',
    'const __conn = new Mongo(__uri);',
    'globalThis.db = __conn.getDB(' + JSON.stringify(databaseOf(env)) + ');',
    'try {',
    body,
    '} catch (e) {',
    "  print(JSON.stringify({ __error: String((e && e.message) || e) }));",
    '}',
  ].join('\n');
}

function plan(env, body, parse, timeout) {
  return {
    argv: ['sh', '-c', CLIENT_SCRIPT],
    stdin: script(env, body) + '\n',
    timeout: timeout || 60,
    parse,
  };
}

function errorResult(r) {
  const message = (r.err || r.out || '').trim();
  return { error: true, message: message || 'mongosh 返回失败', columns: [], rows: [], affected: null, text: message };
}

/** 统一解析 mongosh 的 JSON 输出 */
function parseOutput(r) {
  if (!r.ok) return errorResult(r);
  const text = String(r.out || '').trim();
  if (!text) return { error: false, docs: [], text: '' };
  if (text.indexOf('"__error"') >= 0) {
    try {
      const obj = JSON.parse(text);
      if (obj && obj.__error) return { error: true, message: String(obj.__error), text };
    } catch (e) { /* 非 JSON，继续按原文处理 */ }
  }
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return { error: false, docs: value, text };
    return { error: false, docs: [], text, message: '' };
  } catch (e) {
    return { error: false, docs: [], text };
  }
}

function parseNameList(r) {
  const parsed = parseOutput(r);
  if (parsed.error) return [];
  if (Array.isArray(parsed.docs)) return parsed.docs.map((name) => ({ name: String(name) }));
  return [];
}

export default {
  id: 'sql-mongo',
  name: 'MongoDB',
  kind: 'mongo',
  client: 'mongosh',
  clientLabel: 'MongoDB Shell',
  versionFlag: '--version',
  defaultPort: 27017,

  fields: [
    { key: 'hostAddress', label: '数据库地址', placeholder: '默认取 SSH 主机地址', wide: true },
    { key: 'port', label: '端口', type: 'number', def: '27017', placeholder: '27017' },
    { key: 'user', label: '用户', placeholder: '可选' },
    { key: 'database', label: '默认库', def: 'admin', placeholder: 'admin' },
    { key: 'authSource', label: '认证库', def: 'admin', placeholder: 'admin' },
    { key: 'tls', label: '启用 TLS', type: 'check' },
  ],

  install: {
    apt: 'sudo apt install -y mongodb-mongosh',
    dnf: 'sudo dnf install -y mongodb-mongosh',
    yum: 'sudo yum install -y mongodb-mongosh',
    pacman: 'sudo pacman -S --noconfirm mongosh',
    zypper: 'sudo zypper install -y mongosh',
    apk: 'sudo apk add mongosh',
  },
  installTip: 'mongosh 不在多数发行版的默认源里，需要先添加 MongoDB 官方仓库，详见 https://www.mongodb.com/docs/mongodb-shell/install/',

  sqlTemplate: '',

  test(env) {
    return plan(env,
      '  print(JSON.stringify({ ok: db.adminCommand({ ping: 1 }).ok }));',
      (r) => {
        const parsed = parseOutput(r);
        if (parsed.error) return parsed;
        return { error: false, message: '连接正常', columns: [], rows: [], affected: null };
      }, 30);
  },

  listDatabases(env) {
    return plan(env,
      '  print(JSON.stringify(db.adminCommand({ listDatabases: 1 }).databases.map(function (d) { return d.name; })));',
      parseNameList, 40);
  },

  listCollections(env) {
    return plan(env,
      '  print(JSON.stringify(db.getCollectionNames().sort()));',
      parseNameList, 40);
  },

  findExpression(db, coll, limit) {
    return 'db.getCollection(' + JSON.stringify(String(coll || '')) + ').find({}).limit(' + (limit || 20) + ').toArray()';
  },

  runEval(env) {
    const expr = trimSemicolon(env.expr);
    const body = '  const __value = (' + expr + ');\n  print(JSON.stringify(__value, null, 2));';
    return plan(env, body, parseOutput, 90);
  },
};
