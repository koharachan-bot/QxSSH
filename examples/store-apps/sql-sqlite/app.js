/**
 * app.js —— SQL 工作台主程序
 * 界面结构与其余五个数据库插件保持一致，仅按 dialect.kind 切换主区形态：
 * sql（编辑器 + 结果表格）、redis（键浏览器 + 命令控制台）、mongo（集合与文档 JSON 视图）。
 */

import {
  listHosts, loadPrefs, savePrefs, readJSON, writeJSONPrefs,
  remoteList, remoteUpload, remoteDownloadUrl,
} from './api.js';
import {
  el, clear, toast, modal, confirmDanger, copyText, formatDuration, formatBytes,
  renderGrid, renderPre, prettyJSON, debounce,
} from './ui.js';
import {
  dangerList, execute, probeClient, probePlatform, installAdvice, explainFailure,
  isSingleQuery, trimSemicolon,
} from './engine.js';
import dialect from './dialect.js';

const confirmDangerBox = confirmDanger;

const PAGE_SIZES = [50, 100, 200, 500];
const HISTORY_MAX = 30;

const state = {
  hosts: [],
  prefs: {},
  conn: {},
  pass: '',
  db: '',
  connected: false,
  busy: false,
  client: null,
  platform: null,
  dbs: [],
  tables: {},
  open: {},
  loading: {},
  page: 1,
  pageSize: 100,
  result: null,
  history: [],
  sqlDraft: '',
  redis: { pattern: '*', cursor: '0', keys: [], selected: '', output: '' },
  mongo: { expr: '', coll: '' },
};

const $ = (sel) => document.querySelector(sel);

/* ------------------------------ 主题 ------------------------------ */

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.classList.toggle('dark', dark);
}

function detectTheme() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('theme');
    if (fromUrl === 'dark' || fromUrl === 'light') return fromUrl;
  } catch (e) { /* 忽略 */ }
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function bindTheme() {
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.__qx !== true) return;
    if (data.type === 'init' && data.ctx && data.ctx.theme) applyTheme(data.ctx.theme);
    if (data.type === 'theme' && data.theme) applyTheme(data.theme);
  });
}

/* ------------------------------ 状态工具 ------------------------------ */

function defaultConn() {
  const conn = { hostId: '', hostLabel: '本机（QxSSH 所在机器）' };
  for (const f of dialect.fields) {
    if (f.type === 'check') conn[f.key] = f.def === true;
    else conn[f.key] = f.def === undefined ? '' : String(f.def);
  }
  return conn;
}

function currentEnv() {
  const env = { hostId: state.conn.hostId || '', pass: state.pass };
  for (const f of dialect.fields) env[f.key] = state.conn[f.key];
  env.database = state.conn.database || '';
  env.dbName = state.db || env.database || '';
  const hit = state.hosts.find((h) => h.id === (state.conn.hostId || ''));
  env.hostAddr = hit ? hit.address : '127.0.0.1';
  return env;
}

function setBusy(busy) {
  state.busy = !!busy;
  for (const btn of document.querySelectorAll('[data-busy]')) {
    if (busy) btn.setAttribute('disabled', '');
    else btn.removeAttribute('disabled');
  }
}

function setStatus(text, bad) {
  const node = $('#conn-status');
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('qx-bad', !!bad);
}

function updateClientBadge() {
  const badge = $('#client-badge');
  if (!badge) return;
  const c = state.client;
  if (!c) badge.textContent = '未探测';
  else if (!c.installed) badge.textContent = dialect.client + ' 未安装';
  else badge.textContent = (c.version || dialect.client).slice(0, 46);
}

function saveConn() {
  const conn = {};
  for (const key of Object.keys(state.conn)) {
    if (key === 'pass') continue;
    conn[key] = state.conn[key];
  }
  writeJSONPrefs({ conn });
}

const saveSqlDebounced = debounce(() => {
  savePrefs({ sql: state.sqlDraft });
}, 600);

/** 连接参数的写入做防抖：连续输入时不必每个字符都打一次接口 */
const saveConnDebounced = debounce(() => saveConn(), 500);

/* ------------------------------ 安装提示 ------------------------------ */

async function showInstallHelp() {
  if (!state.platform) {
    try { state.platform = await probePlatform(state.conn.hostId || ''); } catch (e) { state.platform = { osName: '', pm: '' }; }
  }
  const advice = installAdvice(dialect, state.platform);
  const box = el('div');
  box.appendChild(el('p', { text: '远端没有找到 ' + dialect.client + ' 客户端，请先安装：' }));
  if (advice.osName) box.appendChild(el('p', { text: '识别到的系统：' + advice.osName }));
  for (const item of advice.items) {
    box.appendChild(el('p', null, el('span', { class: 'qx-badge', text: item.label }), ' ', el('code', { text: item.cmd })));
  }
  if (advice.tip) box.appendChild(el('p', { text: advice.tip }));
  box.appendChild(el('p', { text: '安装完成后再点「连接」即可；本插件不会申请 sudo 权限，安装命令需由你在终端里以管理员身份执行。' }));
  modal({ title: '安装 ' + dialect.clientLabel, body: box, actions: [{ label: '关闭', primary: true }] });
}

/* ------------------------------ 主机与连接 ------------------------------ */

async function loadHosts() {
  state.hosts = await listHosts();
  const sel = $('#host-sel');
  if (!sel) return;
  const keep = state.conn.hostId || '';
  clear(sel);
  sel.appendChild(el('option', { value: '', text: '本机（QxSSH 所在机器）' }));
  for (const h of state.hosts) {
    sel.appendChild(el('option', { value: h.id, text: h.name + ' · ' + h.address + ':' + h.port }));
  }
  sel.value = keep;
  if (sel.value !== keep) { sel.value = ''; state.conn.hostId = ''; }
}

async function connect() {
  if (state.busy) return;
  setBusy(true);
  try {
    saveConn();
    const env = currentEnv();
    if (!state.client || !state.client.installed) {
      state.client = await probeClient(env.hostId, dialect);
      updateClientBadge();
    }
    if (!state.client.installed) {
      await showInstallHelp();
      throw new Error('远端未安装 ' + dialect.client + ' 客户端');
    }
    const plan = dialect.test(env);
    const { r, ms } = await execute(env.hostId, plan);
    if (!r.ok) {
      const hint = explainFailure(r, dialect);
      throw new Error(hint || (r.err || r.out || '连接失败').trim());
    }
    state.connected = true;
    setStatus('已连接 ' + dialect.name + ' · ' + (state.client.version || dialect.client) + ' · ' + ms + ' ms', false);
    toast('已连接', 'ok');
    await refreshTree();
  } catch (e) {
    state.connected = false;
    setStatus(e.message, true);
    toast(e.message, 'error', 4200);
  } finally {
    setBusy(false);
  }
}

/* ------------------------------ 界面骨架 ------------------------------ */

function field(labelText, input, wide) {
  return el('label', { class: 'qx-field' + (wide ? ' qx-wide' : '') }, el('span', { text: labelText }), input);
}

function buildTopbar() {
  const hostSel = el('select', { id: 'host-sel' });
  hostSel.addEventListener('change', () => {
    state.conn.hostId = hostSel.value;
    const hit = state.hosts.find((h) => h.id === hostSel.value);
    state.conn.hostLabel = hit ? hit.name : '本机（QxSSH 所在机器）';
    state.connected = false;
    state.client = null;
    state.dbs = [];
    state.tables = {};
    state.open = {};
    updateClientBadge();
    clearTree('切换主机后请重新连接');
    saveConn();
  });

  const controls = [field('主机', hostSel)];
  for (const f of dialect.fields) {
    if (f.type === 'check') {
      const input = el('input', { type: 'checkbox', id: 'f-' + f.key });
      input.checked = !!state.conn[f.key];
      input.addEventListener('change', () => { state.conn[f.key] = input.checked; saveConnDebounced(); });
      controls.push(el('label', { class: 'qx-field qx-check' }, input, el('span', { text: f.label })));
      continue;
    }
    const input = el('input', {
      id: 'f-' + f.key,
      type: f.type === 'number' ? 'number' : 'text',
      placeholder: f.placeholder || '',
      value: state.conn[f.key] === undefined || state.conn[f.key] === null ? '' : String(state.conn[f.key]),
    });
    input.addEventListener('input', () => { state.conn[f.key] = input.value; saveConnDebounced(); });
    controls.push(field(f.label, input, !!f.wide));
  }

  if (!dialect.hidePassword) {
    const passInput = el('input', {
      id: 'f-pass', type: 'password', autocomplete: 'new-password',
      placeholder: '口令不写入偏好',
    });
    passInput.value = state.pass;
    passInput.addEventListener('input', () => { state.pass = passInput.value; });
    controls.push(field('密码', passInput));
  }

  const clientBadge = el('div', { class: 'qx-field' },
    el('span', { text: '客户端' }),
    el('div', { id: 'client-badge', class: 'qx-badge', text: '未探测' }));
  controls.push(clientBadge);

  const bar = el('div', { class: 'qx-topbar' }, controls);
  bar.appendChild(el('div', { class: 'qx-status', id: 'conn-status', text: '未连接' }));
  bar.appendChild(el('div', { class: 'qx-flex' }));

  const actions = el('div', { class: 'qx-field' }, el('span', { text: '操作' }));
  const btns = el('div', { class: 'qx-btn-row' });
  btns.appendChild(el('button', { class: 'btn primary', text: '连接', 'data-busy': '', onclick: connect }));
  btns.appendChild(el('button', { class: 'btn ghost', text: '安装帮助', onclick: showInstallHelp }));
  if (dialect.fileTools) {
    btns.appendChild(el('button', { class: 'btn ghost', text: '浏览远端目录', onclick: browseRemote }));
    btns.appendChild(el('button', { class: 'btn ghost', text: '上传库文件', onclick: uploadDatabase }));
    btns.appendChild(el('button', { class: 'btn ghost', text: '下载当前库', onclick: downloadDatabase }));
  }
  actions.appendChild(btns);
  bar.appendChild(actions);
  return bar;
}

function buildSide() {
  const title = dialect.kind === 'redis' ? '键空间' : (dialect.kind === 'mongo' ? '数据库与集合' : '数据库对象');
  const side = el('aside', { class: 'qx-side' },
    el('div', { class: 'qx-side-head' },
      el('span', { class: 'qx-title', text: title }),
      el('button', { class: 'btn ghost small', text: '刷新', onclick: refreshTree })),
    el('div', { class: 'qx-tree', id: 'tree' },
      el('div', { class: 'qx-tree-hint', text: '点击「连接」加载对象' })));
  side.appendChild(el('div', { class: 'qx-schema qx-hidden', id: 'schema-box' }));
  return side;
}

function buildSqlMain() {
  const editor = el('textarea', {
    class: 'qx-editor', id: 'sql-edit', spellcheck: 'false',
    placeholder: dialect.sqlPlaceholder || '在此输入 SQL，Ctrl+Enter 执行',
  });
  editor.value = state.sqlDraft;
  editor.addEventListener('input', () => { state.sqlDraft = editor.value; saveSqlDebounced(); });
  editor.addEventListener('keydown', onEditorKey);
  return el('main', { class: 'qx-main' },
    el('div', { class: 'qx-main-split' },
      el('div', { class: 'qx-editor-wrap' },
        el('div', { class: 'qx-toolbar' },
          el('span', { class: 'qx-title', text: 'SQL 编辑器' }),
          el('span', { class: 'qx-flex' }),
          el('span', { class: 'qx-badge', text: dialect.name }),
          el('button', { class: 'btn ghost small', text: '历史语句', onclick: showHistory }),
          el('button', { class: 'btn primary small', text: '执行 (Ctrl+Enter)', 'data-busy': '', onclick: runSql })),
        editor),
      el('div', { class: 'qx-result' },
        el('div', { class: 'qx-result-meta', id: 'result-meta' }, el('span', { text: '尚未执行语句' })),
        el('div', { class: 'qx-result-body', id: 'result-body' },
          el('div', { class: 'qx-empty', text: 'Ctrl+Enter 执行当前编辑内容' })))));
}

function buildRedisMain() {
  const keyList = el('div', { class: 'qx-key-list', id: 'key-list' });
  const pattern = el('input', { id: 'key-pattern', placeholder: '匹配模式，如 user:*', value: state.redis.pattern });
  const value = el('div', { class: 'qx-redis-value', id: 'redis-value' },
    el('div', { class: 'qx-empty', text: '选择左侧的键查看内容' }));
  const input = el('input', { id: 'cmd', placeholder: '输入命令，如 GET user:1', autocomplete: 'off' });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); redisExec(); }
  });
  const out = el('div', { class: 'qx-console-output', id: 'cmd-out' });
  return el('main', { class: 'qx-main' },
    el('div', { class: 'qx-redis' },
      el('div', { class: 'qx-redis-browser' },
        el('div', { class: 'qx-redis-tools' }, pattern,
          el('button', { class: 'btn small', text: '扫描', 'data-busy': '', onclick: () => loadRedisKeys(true) }),
          el('button', { class: 'btn ghost small', text: '更多', 'data-busy': '', onclick: () => loadRedisKeys(false) })),
        keyList),
      el('div', { class: 'qx-redis-main' }, value,
        el('div', { class: 'qx-console' },
          el('div', { class: 'qx-console-bar' },
            el('span', { text: '命令控制台' }),
            el('span', { class: 'qx-flex' }),
            el('span', { class: 'qx-badge', text: 'redis-cli --no-raw' })),
          out,
          el('div', { class: 'qx-console-input' }, input,
            el('button', { class: 'btn primary small', text: '执行', 'data-busy': '', onclick: redisExec }))))));
}

function buildMongoMain() {
  const expr = el('textarea', { class: 'qx-code', id: 'mongo-expr', spellcheck: 'false', rows: '4' });
  expr.value = state.mongo.expr || 'db.getCollection("").find({}).limit(20).toArray()';
  const view = el('div', { class: 'qx-mongo-view', id: 'mongo-view' },
    el('div', { class: 'qx-empty', text: '选择左侧集合，或直接写表达式后执行' }));
  return el('main', { class: 'qx-main' },
    el('div', { class: 'qx-mongo' },
      el('div', { class: 'qx-mongo-bar' },
        field('当前集合', el('div', { class: 'qx-badge', id: 'mongo-coll', text: '未选择' })),
        el('button', { class: 'btn primary small', text: '执行表达式', 'data-busy': '', onclick: runMongoExpr }),
        el('button', { class: 'btn ghost small', text: '重新载入集合列表', onclick: refreshTree })),
      el('div', { class: 'qx-mongo-expr' }, field('JavaScript 表达式（mongosh 语法，可写 find/aggregate）', expr, true)),
      view));
}

function buildMain() {
  if (dialect.kind === 'redis') return buildRedisMain();
  if (dialect.kind === 'mongo') return buildMongoMain();
  return buildSqlMain();
}

function buildShell() {
  const app = document.getElementById('app');
  clear(app);
  app.append(buildTopbar(), el('div', { class: 'qx-body' }, buildSide(), buildMain()));
}

/* ------------------------------ 树 ------------------------------ */

function clearTree(hint) {
  const tree = $('#tree');
  if (!tree) return;
  clear(tree);
  tree.appendChild(el('div', { class: 'qx-tree-hint', text: hint || '暂无对象' }));
  const schema = $('#schema-box');
  if (schema) { schema.classList.add('qx-hidden'); clear(schema); }
}

async function refreshTree() {
  if (!state.connected) { clearTree('点击「连接」加载对象'); return; }
  if (dialect.kind === 'redis') return loadRedisKeys(true);
  if (dialect.kind === 'mongo') return loadMongoRoot();
  return loadSqlRoot();
}

async function loadSqlRoot() {
  const env = currentEnv();
  const tree = $('#tree');
  clear(tree);
  tree.appendChild(el('div', { class: 'qx-tree-hint', text: '正在加载…' }));
  try {
    if (dialect.singleStore) {
      const label = (env.database || '主库').split('/').pop() || '主库';
      state.dbs = [{ name: label }];
      state.open[label] = true;
      state.db = label;
      await loadTables(label);
      renderSqlTree();
      return;
    }
    const plan = dialect.listDatabases(env);
    const { data } = await runPlan(env, plan);
    state.dbs = (data || []).slice(0, 300);
    if (state.db && state.dbs.some((d) => d.name === state.db)) {
      state.open[state.db] = true;
      await loadTables(state.db);
    }
    renderSqlTree();
  } catch (e) {
    clearTree(e.message);
    toast('加载数据库列表失败：' + e.message, 'error', 4200);
  }
}

function renderSqlTree() {
  const tree = $('#tree');
  if (!tree) return;
  clear(tree);
  if (!state.dbs.length) {
    tree.appendChild(el('div', { class: 'qx-tree-hint', text: '没有可见的数据库' }));
    return;
  }
  for (const db of state.dbs) {
    const name = String(db.name);
    const open = !!state.open[name];
    const row = el('div', { class: 'qx-tree-row' + (state.db === name ? ' active' : '') },
      el('span', { class: 'qx-caret', text: open ? '▾' : '▸' }),
      el('span', { class: 'qx-name', text: name, title: name }),
      el('span', { class: 'qx-kind', text: '库' }));
    row.addEventListener('click', () => toggleDb(name));
    const node = el('div', { class: 'qx-tree-node' }, row);
    if (open) {
      const kids = el('div', { class: 'qx-tree-kids' });
      if (state.loading[name]) kids.appendChild(el('div', { class: 'qx-tree-hint', text: '加载中…' }));
      else if (!state.tables[name]) kids.appendChild(el('div', { class: 'qx-tree-hint', text: '无表' }));
      else {
        if (!state.tables[name].length) kids.appendChild(el('div', { class: 'qx-tree-hint', text: '无表' }));
        for (const table of state.tables[name]) {
          const trow = el('div', { class: 'qx-tree-row', title: table },
            el('span', { class: 'qx-caret', text: '' }),
            el('span', { class: 'qx-name', text: table }),
            el('span', { class: 'qx-kind', text: '表' }));
          trow.addEventListener('click', () => showSchema(name, table));
          kids.appendChild(trow);
        }
      }
      node.appendChild(kids);
    }
    tree.appendChild(node);
  }
}

async function toggleDb(name) {
  if (state.open[name]) { state.open[name] = false; renderSqlTree(); return; }
  state.open[name] = true;
  state.db = name;
  writeJSONPrefs({ lastDb: name });
  renderSqlTree();
  if (!state.tables[name]) await loadTables(name);
  renderSqlTree();
}

async function loadTables(db) {
  state.loading[db] = true;
  renderSqlTree();
  try {
    const env = currentEnv();
    const plan = dialect.listTables(Object.assign({}, env, { dbName: db }));
    const { data } = await runPlan(env, plan);
    state.tables[db] = (data || []).slice(0, 500);
  } catch (e) {
    state.tables[db] = [];
    toast('加载表失败：' + e.message, 'error', 4200);
  } finally {
    state.loading[db] = false;
  }
}

async function showSchema(db, table) {
  const box = $('#schema-box');
  if (!box) return;
  box.classList.remove('qx-hidden');
  clear(box);
  box.appendChild(el('div', { class: 'qx-tree-hint', text: '正在读取表结构…' }));
  try {
    const env = currentEnv();
    const plan = dialect.tableSchema(Object.assign({}, env, { dbName: db, table }));
    const { data } = await runPlan(env, plan);
    clear(box);
    box.appendChild(el('div', { class: 'qx-side-head qx-schema-head' },
      el('span', { class: 'qx-title', text: db + '.' + table }),
      el('button', { class: 'btn ghost small', text: '查询数据', onclick: () => insertSelect(db, table) })));
    const cols = (data && data.columns) || [];
    if (!cols.length) box.appendChild(el('div', { class: 'qx-tree-hint', text: '没有字段信息' }));
    else {
      const tableEl = el('table');
      tableEl.appendChild(el('thead', null, el('tr', null,
        el('th', { text: '字段' }), el('th', { text: '类型' }), el('th', { text: '键' }), el('th', { text: '可空' }))));
      const body = el('tbody');
      for (const c of cols) {
        body.appendChild(el('tr', null,
          el('td', { text: c.name || '' }),
          el('td', { text: c.type || '' }),
          el('td', { text: c.key || '' }),
          el('td', { text: c.nullable ? '是' : '否' })));
      }
      tableEl.appendChild(body);
      box.appendChild(tableEl);
    }
    const idx = (data && data.indexes) || [];
    if (idx.length) {
      box.appendChild(el('div', { class: 'qx-tree-hint', text: '索引：' + idx.map((x) => x.name + '(' + (x.columns || []).join(',') + ')').join('  ') }));
    }
  } catch (e) {
    clear(box);
    box.appendChild(el('div', { class: 'qx-tree-hint', text: '读取表结构失败：' + e.message }));
  }
}

function quoteIdent(name) {
  return dialect.quoteIdent ? dialect.quoteIdent(name) : name;
}

function insertSelect(db, table) {
  const editor = $('#sql-edit');
  if (!editor) return;
  const sql = dialect.selectTemplate(db, table);
  editor.value = sql;
  state.sqlDraft = sql;
  saveSqlDebounced();
  editor.focus();
}

async function runPlan(env, plan) {
  const { r, ms } = await execute(env.hostId, plan);
  let data = null;
  try { data = plan.parse ? plan.parse(r) : null; } catch (e) { data = null; }
  if (!r.ok && data && data.error === undefined) data = null;
  return { r, ms, data };
}

/* ------------------------------ SQL 执行 ------------------------------ */

function onEditorKey(event) {
  const editor = event.target;
  if (event.key === 'Tab') {
    event.preventDefault();
    const start = editor.selectionStart;
    editor.setRangeText('    ', start, editor.selectionEnd, 'end');
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    runSql();
  }
}

function addHistory(sql) {
  const list = state.history.filter((x) => x !== sql);
  list.unshift(sql);
  state.history = list.slice(0, HISTORY_MAX);
  writeJSONPrefs({ history: state.history });
}

function showHistory() {
  const body = el('div');
  if (!state.history.length) {
    body.appendChild(el('div', { class: 'qx-empty', text: '还没有执行记录' }));
  } else {
    for (const sql of state.history) {
      const item = el('pre', { class: 'qx-danger-stmt', text: sql, title: '点击填入编辑器' });
      item.addEventListener('click', () => {
        const editor = $('#sql-edit');
        if (editor) { editor.value = sql; state.sqlDraft = sql; saveSqlDebounced(); }
        close();
      });
      body.appendChild(item);
    }
  }
  const dialog = modal({ title: '历史语句（点击填入编辑器）', body, wide: true, actions: [{ label: '关闭' }] });
  function close() { dialog.close(); }
}

async function runSql() {
  const editor = $('#sql-edit');
  if (!editor || state.busy) return;
  const sql = editor.value.trim();
  if (!sql) { toast('请先输入语句', 'warn'); return; }

  const dangers = dangerList(sql, dialect.kind);
  if (dangers.length) {
    const ok = await confirmDangerSafely(sql, dangers);
    if (!ok) return;
  }

  addHistory(sql);
  setBusy(true);
  const env = currentEnv();
  const started = performance.now();
  try {
    const plan = dialect.run(Object.assign({}, env, { dbName: state.db, sql }));
    const { r } = await execute(env.hostId, plan);
    const ms = Math.round(performance.now() - started);
    const parsed = plan.parse(r);
    if (!parsed.error && dialect.columns && isSingleQuery(sql) && (!parsed.columns || !parsed.columns.length)) {
      try {
        const probePlan = dialect.columns(Object.assign({}, env, { dbName: state.db, sql }));
        if (probePlan) {
          const probe = await execute(env.hostId, probePlan);
          const cols = probePlan.parse(probe.r);
          if (Array.isArray(cols) && cols.length) parsed.columns = cols;
        }
      } catch (e) { /* 列名探测失败不影响数据展示 */ }
    }
    state.result = Object.assign({}, parsed, { ms, raw: r.out, err: r.err, exit: r.exit, truncated: r.truncated, ok: !parsed.error });
    state.page = 1;
    renderResult();
    if (parsed.error) toast('执行失败：' + (parsed.message || '未知错误'), 'error', 4600);
  } catch (e) {
    state.result = {
      ok: false, columns: [], rows: [], affected: null, message: e.message,
      text: '', raw: '', ms: Math.round(performance.now() - started),
    };
    renderResult();
    toast(e.message, 'error', 4600);
  } finally {
    setBusy(false);
  }
}

async function confirmDangerSafely(sql, dangers) {
  return confirmDangerBox({ statements: dangers });
}

function renderResult() {
  const meta = $('#result-meta');
  const body = $('#result-body');
  if (!meta || !body) return;
  clear(meta);
  clear(body);
  const res = state.result;
  if (!res) {
    meta.appendChild(el('span', { text: '尚未执行语句' }));
    body.appendChild(el('div', { class: 'qx-empty', text: 'Ctrl+Enter 执行当前编辑内容' }));
    return;
  }
  meta.append(
    el('span', { text: res.ok ? '执行成功' : '执行失败' }),
    el('span', { text: '耗时 ' + formatDuration(res.ms) }),
    res.affected === null || res.affected === undefined ? null : el('span', { text: '影响行数 ' + res.affected }),
    res.rows && res.rows.length ? el('span', { text: '结果 ' + res.rows.length + ' 行' }) : null,
    res.truncated ? el('span', { class: 'qx-badge', text: '输出被截断' }) : null,
    el('span', { class: 'qx-flex' }),
    sizePicker(),
    el('button', { class: 'btn ghost small', text: '复制结果', onclick: copyResult }),
    res.raw ? el('button', { class: 'btn ghost small', text: '原始输出', onclick: () => showRaw(res) }) : null);

  if (!res.ok) {
    renderPre(body, res.text || res.raw || '', '无输出');
    if (res.message && res.message !== res.text) body.appendChild(el('div', { class: 'qx-hint' }, el('p', { text: res.message })));
    return;
  }
  if (res.columns && res.rows && res.rows.length) {
    renderGrid(body, {
      columns: res.columns,
      rows: res.rows,
      page: state.page,
      pageSize: state.pageSize,
      onPageChange: (page) => { state.page = page; renderResult(); },
      onCopyCell: (text) => { copyText(text).then((ok) => toast(ok ? '已复制单元格' : '复制失败', ok ? 'ok' : 'error')); },
    });
    if (res.message) body.appendChild(el('div', { class: 'qx-hint' }, el('p', { text: res.message })));
    return;
  }
  if (res.text && res.text.trim()) { renderPre(body, res.text); return; }
  if (res.message) body.appendChild(el('div', { class: 'qx-hint' }, el('p', { text: res.message })));
  else body.appendChild(el('div', { class: 'qx-empty', text: '语句已执行，没有返回数据' }));
}

function sizePicker() {
  const sel = el('select', { class: 'qx-page-size' },
    PAGE_SIZES.map((n) => el('option', { value: String(n), text: n + ' 行/页' })));
  sel.value = String(state.pageSize);
  sel.addEventListener('change', () => {
    state.pageSize = Number(sel.value) || 100;
    state.page = 1;
    savePrefs({ pageSize: String(state.pageSize) });
    renderResult();
  });
  return sel;
}

function copyResult() {
  const res = state.result;
  if (!res) return;
  let text = '';
  if (res.columns && res.rows && res.rows.length) {
    const lines = [res.columns.join('\t')];
    for (const row of res.rows) lines.push(row.map((v) => (v === null || v === undefined ? 'NULL' : String(v))).join('\t'));
    text = lines.join('\n');
  } else {
    text = res.text || res.raw || res.message || '';
  }
  copyText(text).then((ok) => toast(ok ? '已复制结果' : '复制失败', ok ? 'ok' : 'error'));
}

function showRaw(res) {
  const box = el('div');
  if (res.raw) box.appendChild(el('div', null, el('p', { text: '标准输出' }), el('pre', { class: 'qx-pre', text: res.raw })));
  if (res.err) box.appendChild(el('div', null, el('p', { text: '标准错误' }), el('pre', { class: 'qx-pre', text: res.err })));
  if (!res.raw && !res.err) box.appendChild(el('div', { class: 'qx-empty', text: '没有原始输出' }));
  modal({ title: '原始输出', body: box, wide: true, actions: [{ label: '关闭' }] });
}

/* ------------------------------ Redis ------------------------------ */

function redisTokenize(command) {
  const text = String(command || '').trim();
  const args = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) { quote = ''; continue; }
      current += ch; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (current) { args.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

async function loadRedisKeys(reset) {
  const patternInput = $('#key-pattern');
  const pattern = patternInput ? patternInput.value.trim() || '*' : '*';
  state.redis.pattern = pattern;
  if (!reset && state.redis.cursor === '0') { toast('已经扫描到末尾，点「扫描」重新开始', 'info'); return; }
  if (reset) { state.redis.cursor = '0'; state.redis.keys = []; state.redis.selected = ''; }
  const env = currentEnv();
  try {
    const plan = dialect.scanKeys(Object.assign({}, env, { cursor: state.redis.cursor, pattern }));
    const { data } = await runPlan(env, plan);
    if (data && data.error) throw new Error(data.message || '扫描失败');
    const seen = new Set(state.redis.keys);
    for (const key of (data && data.keys) || []) if (!seen.has(key)) state.redis.keys.push(key);
    state.redis.cursor = (data && data.cursor) || '0';
    renderRedisKeys();
  } catch (e) {
    toast('扫描键失败：' + e.message, 'error', 4200);
  }
}

function renderRedisKeys() {
  const list = $('#key-list');
  if (!list) return;
  clear(list);
  if (!state.redis.keys.length) {
    list.appendChild(el('div', { class: 'qx-empty', text: '没有匹配的键' }));
    return;
  }
  for (const key of state.redis.keys) {
    const row = el('div', { class: 'qx-key-item' + (state.redis.selected === key ? ' active' : ''), text: key, title: key });
    row.addEventListener('click', () => showRedisKey(key));
    list.appendChild(row);
  }
}

async function showRedisKey(key) {
  state.redis.selected = key;
  renderRedisKeys();
  const box = $('#redis-value');
  if (!box) return;
  clear(box);
  box.appendChild(el('div', { class: 'qx-tree-hint', text: '读取中…' }));
  const env = currentEnv();
  try {
    const plan = dialect.keyDetail(Object.assign({}, env, { key }));
    const { data } = await runPlan(env, plan);
    clear(box);
    box.appendChild(el('div', { class: 'qx-console-bar qx-redis-head' },
      el('span', { class: 'qx-badge', text: key }),
      el('span', { class: 'qx-badge', text: '类型 ' + ((data && data.type) || '未知') }),
      el('span', { class: 'qx-badge', text: 'TTL ' + ((data && data.ttl) || '-1') }),
      el('span', { class: 'qx-flex' }),
      el('button', { class: 'btn ghost small', text: '复制', onclick: () => {
        copyText((data && data.text) || '').then((ok) => toast(ok ? '已复制键值' : '复制失败', ok ? 'ok' : 'error'));
      } })));
    const valBox = el('div');
    renderPre(valBox, (data && data.text) || '', '该键没有可显示的值');
    box.appendChild(valBox);
  } catch (e) {
    clear(box);
    box.appendChild(el('div', { class: 'qx-hint', text: '读取键失败：' + e.message }));
  }
}

async function redisExec() {
  const input = $('#cmd');
  const out = $('#cmd-out');
  if (!input || !out) return;
  const command = input.value.trim();
  if (!command) return;
  const dangers = dangerList(command, 'redis');
  if (dangers.length) {
    const ok = await confirmDangerBox({ statements: dangers, message: '该命令会清空数据或关闭服务，请确认。' });
    if (!ok) return;
  }
  const args = redisTokenize(command);
  if (!args.length) return;
  clear(out);
  out.appendChild(el('div', { class: 'qx-tree-hint', text: '执行中…' }));
  const env = currentEnv();
  try {
    const plan = dialect.redisCommand(Object.assign({}, env, { args }));
    const { r, ms } = await execute(env.hostId, plan);
    clear(out);
    out.appendChild(el('div', { class: 'qx-console-bar qx-console-line' },
      el('span', { text: command }),
      el('span', { class: 'qx-flex' }),
      el('span', { class: 'qx-badge', text: formatDuration(ms) })));
    out.appendChild(el('pre', { class: 'qx-pre', text: (r.out || r.err || '').trim() || '（无返回）' }));
    if (!r.ok) toast('命令执行失败', 'error', 3600);
    if (args[0].toUpperCase() === 'SCAN' || args[0].toUpperCase() === 'KEYS') await loadRedisKeys(false);
    input.value = '';
  } catch (e) {
    toast(e.message, 'error', 4200);
  }
}

/* ------------------------------ MongoDB ------------------------------ */

async function loadMongoRoot() {
  const env = currentEnv();
  const tree = $('#tree');
  clear(tree);
  tree.appendChild(el('div', { class: 'qx-tree-hint', text: '正在加载…' }));
  try {
    const plan = dialect.listDatabases(env);
    const { data } = await runPlan(env, plan);
    state.dbs = (data || []).slice(0, 200);
    if (state.db && state.dbs.some((d) => d.name === state.db)) {
      state.open[state.db] = true;
    }
    renderMongoTree();
  } catch (e) {
    clearTree('加载数据库失败：' + e.message);
  }
}

function renderMongoTree() {
  const tree = $('#tree');
  if (!tree) return;
  clear(tree);
  if (!state.dbs.length) { tree.appendChild(el('div', { class: 'qx-tree-hint', text: '没有可见的数据库' })); return; }
  for (const db of state.dbs) {
    const name = String(db.name);
    const open = !!state.open[name];
    const row = el('div', { class: 'qx-tree-row' },
      el('span', { class: 'qx-caret', text: open ? '▾' : '▸' }),
      el('span', { class: 'qx-name', text: name, title: name }),
      el('span', { class: 'qx-kind', text: '库' }));
    row.addEventListener('click', () => toggleMongoDb(name));
    const node = el('div', { class: 'qx-tree-node' }, row);
    if (open) {
      const kids = el('div', { class: 'qx-tree-kids' });
      if (state.loading[name]) kids.appendChild(el('div', { class: 'qx-tree-hint', text: '加载中…' }));
      else if (!state.tables[name] || !state.tables[name].length) kids.appendChild(el('div', { class: 'qx-tree-hint', text: '无集合' }));
      else {
        for (const coll of state.tables[name]) {
          const crow = el('div', { class: 'qx-tree-row', title: coll },
            el('span', { class: 'qx-caret', text: '' }),
            el('span', { class: 'qx-name', text: coll }),
            el('span', { class: 'qx-kind', text: '集合' }));
          crow.addEventListener('click', () => openCollection(name, coll));
          kids.appendChild(crow);
        }
      }
      node.appendChild(kids);
    }
    tree.appendChild(node);
  }
}

async function toggleMongoDb(name) {
  if (state.open[name]) { state.open[name] = false; renderMongoTree(); return; }
  state.open[name] = true;
  writeJSONPrefs({ lastDb: name });
  renderMongoTree();
  if (!state.tables[name]) {
    state.loading[name] = true;
    renderMongoTree();
    try {
      const env = currentEnv();
      const plan = dialect.listCollections(Object.assign({}, env, { db: name }));
      const { data } = await runPlan(env, plan);
      state.tables[name] = (data || []).slice(0, 500);
    } catch (e) {
      state.tables[name] = [];
      toast('加载集合失败：' + e.message, 'error', 4200);
    } finally {
      state.loading[name] = false;
      renderMongoTree();
    }
  }
}

function openCollection(db, coll) {
  state.mongo.coll = coll;
  state.db = db;
  state.mongo.expr = dialect.findExpression(db, coll, 20);
  const expr = $('#mongo-expr');
  if (expr) expr.value = state.mongo.expr;
  const badge = $('#mongo-coll');
  if (badge) badge.textContent = db + '.' + coll;
  runMongoExpr();
}

async function runMongoExpr() {
  const expr = $('#mongo-expr');
  const view = $('#mongo-view');
  if (!expr || !view || state.busy) return;
  const code = expr.value.trim();
  if (!code) { toast('表达式不能为空', 'warn'); return; }
  const dangers = dangerList(code, 'mongo');
  if (dangers.length) {
    const ok = await confirmDangerBox({ statements: dangers, message: '该表达式会删除数据库或集合，请确认。' });
    if (!ok) return;
  }
  setBusy(true);
  clear(view);
  view.appendChild(el('div', { class: 'qx-tree-hint', text: '执行中…' }));
  const env = currentEnv();
  const started = performance.now();
  try {
    const plan = dialect.runEval(Object.assign({}, env, { expr: code }));
    const { r } = await execute(env.hostId, plan);
    const ms = Math.round(performance.now() - started);
    const data = plan.parse(r);
    clear(view);
    view.appendChild(el('div', { class: 'qx-console-bar qx-mongo-head' },
      el('span', { text: data && data.error ? '执行失败' : '执行成功' }),
      el('span', { class: 'qx-badge', text: formatDuration(ms) }),
      el('span', { class: 'qx-flex' }),
      el('button', { class: 'btn ghost small', text: '复制结果', onclick: () => {
        copyText((data && data.text) || '').then((ok) => toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'error'));
      } })));
    if (data && data.error) {
      view.appendChild(el('div', { class: 'qx-hint' }, el('p', { text: data.message || '执行失败' })));
      view.appendChild(el('pre', { class: 'qx-pre', text: (r.err || r.out || '').trim() }));
    } else if (data && data.docs) {
      for (const doc of data.docs) view.appendChild(el('pre', { class: 'qx-doc', text: prettyJSON(doc) }));
      if (!data.docs.length) view.appendChild(el('div', { class: 'qx-empty', text: '没有文档' }));
    } else {
      const textBox = el('div');
      renderPre(textBox, (data && data.text) || '', '没有输出');
      view.appendChild(textBox);
    }
  } catch (e) {
    clear(view);
    view.appendChild(el('div', { class: 'qx-hint', text: '执行失败：' + e.message }));
  } finally {
    setBusy(false);
  }
}

/* ------------------------------ SQLite 文件工具 ------------------------------ */

function currentDatabaseFile() {
  return String(state.conn.database || '').trim();
}

async function browseRemote() {
  const start = currentDatabaseFile();
  const dir = start && start.indexOf('/') >= 0 ? start.slice(0, start.lastIndexOf('/')) || '/' : '~';
  openRemoteBrowser(dir);
}

function openRemoteBrowser(initial) {
  const body = el('div');
  const pathInput = el('input', { type: 'text', value: initial || '~' });
  const listBox = el('div', { class: 'qx-remote-list' });
  const status = el('div', { class: 'qx-tree-hint', text: '' });
  let current = initial || '~';

  async function load(path) {
    clear(listBox);
    listBox.appendChild(el('div', { class: 'qx-tree-hint', text: '读取中…' }));
    try {
      const files = await remoteList(state.conn.hostId || '', path);
      clear(listBox);
      current = path;
      pathInput.value = path;
      if (!files.length) listBox.appendChild(el('div', { class: 'qx-tree-hint', text: '空目录' }));
      if (path !== '/') {
        const up = el('div', { class: 'qx-tree-row qx-plain-row' }, el('span', { class: 'qx-name', text: '..' }));
        up.addEventListener('click', () => {
          const parent = path.replace(/\/+$/, '');
          const cut = parent.lastIndexOf('/');
          load(cut <= 0 ? '/' : parent.slice(0, cut));
        });
        listBox.appendChild(up);
      }
      for (const f of files) {
        const row = el('div', { class: 'qx-tree-row' },
          el('span', { class: 'qx-name', text: f.name + (f.isDir ? '/' : '') }),
          el('span', { class: 'qx-kind', text: f.isDir ? '目录' : formatBytes(f.size) }));
        row.addEventListener('click', () => {
          const next = (current.replace(/\/+$/, '') || '') + '/' + f.name;
          if (f.isDir) load(next);
          else {
            state.conn.database = next;
            const input = $('#f-database');
            if (input) input.value = next;
            saveConn();
            closeBrowser();
            toast('已选择 ' + next, 'ok');
          }
        });
        listBox.appendChild(row);
      }
    } catch (e) {
      clear(listBox);
      listBox.appendChild(el('div', { class: 'qx-tree-hint', text: '读取失败：' + e.message }));
    }
  }

  let dialog = null;
  function closeBrowser() { if (dialog) dialog.close(); }
  body.append(
    el('div', { class: 'qx-remote-bar' }, pathInput,
      el('button', { class: 'btn small', text: '转到', onclick: () => load(pathInput.value.trim() || '~') })),
    listBox, status);
  dialog = modal({ title: '远端目录（点击 .db 文件选中）', body, wide: true, actions: [{ label: '关闭' }] });
  load(current);
}

async function uploadDatabase() {
  const input = el('input', { type: 'file', accept: '.db,.sqlite,.sqlite3,.db3' });
  const dest = el('input', { type: 'text', value: '~', placeholder: '远端目录，如 /tmp 或 ~' });
  let dialog = null;
  const box = el('div',
    el('p', { text: '选择本机数据库文件，上传到远端目录后即可直接作为库文件使用。' }),
    field('本地文件', input),
    field('远端目录', dest),
    el('p', { class: 'qx-tree-hint', text: '上传后会自动把远端路径填入连接参数。' }));
  dialog = modal({
    title: '上传本地数据库文件',
    body: box,
    actions: [
      { label: '取消' },
      {
        label: '上传', primary: true,
        onClick: async () => {
          const file = input.files && input.files[0];
          if (!file) { toast('请先选择文件', 'warn'); return false; }
          try {
            const path = await remoteUpload(state.conn.hostId || '', dest.value.trim() || '~', file);
            if (!path) throw new Error('宿主要求上传失败，未返回落盘路径');
            state.conn.database = path;
            const dbInput = $('#f-database');
            if (dbInput) dbInput.value = path;
            saveConn();
            toast('已上传到 ' + path, 'ok', 3600);
            return true;
          } catch (e) {
            toast('上传失败：' + e.message, 'error', 4600);
            return false;
          }
        },
      },
    ],
  });
  return dialog;
}

function downloadDatabase() {
  const path = currentDatabaseFile();
  if (!path) { toast('请先在「库文件」里填写远端数据库路径', 'warn'); return; }
  try {
    const url = remoteDownloadUrl(state.conn.hostId || '', path);
    const name = path.split('/').pop() || 'database.db';
    const a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('已开始下载 ' + name, 'ok');
  } catch (e) {
    toast('下载失败：' + e.message, 'error', 4200);
  }
}

/* ------------------------------ 启动 ------------------------------ */

function bindGlobalKeys() {
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
      event.preventDefault();
      const input = $('#cmd');
      if (input) input.focus();
    }
  });
}

async function boot() {
  applyTheme(detectTheme());
  bindTheme();
  state.prefs = await loadPrefs();
  state.conn = Object.assign(defaultConn(), readJSON(state.prefs, 'conn', {}));
  state.history = readJSON(state.prefs, 'history', []);
  const lastDb = readJSON(state.prefs, 'lastDb', '');
  state.db = typeof lastDb === 'string' ? lastDb : '';
  state.redis.pattern = typeof state.prefs.redisPattern === 'string' ? state.prefs.redisPattern : '*';
  state.mongo.expr = typeof state.prefs.mongoExpr === 'string' ? state.prefs.mongoExpr : '';
  const pageSize = Number(state.prefs.pageSize);
  if (PAGE_SIZES.indexOf(pageSize) >= 0) state.pageSize = pageSize;
  const saved = typeof state.prefs.sql === 'string' ? state.prefs.sql : '';
  state.sqlDraft = saved || dialect.sqlTemplate || '';

  buildShell();
  try {
    await loadHosts();
  } catch (e) {
    toast(e.message, 'error', 5000);
  }
  const pathInput = $('#f-database');
  if (pathInput && dialect.fileTools && !pathInput.value) {
    pathInput.placeholder = '远端库文件路径，如 /var/data/app.db';
  }
  bindGlobalKeys();
  setStatus('未连接', false);
  updateClientBadge();
  probeClient(state.conn.hostId || '', dialect).then((info) => {
    state.client = info;
    updateClientBadge();
  }).catch(() => {});
}

boot().catch((e) => {
  const root = document.getElementById('app');
  if (root) {
    clear(root);
    root.appendChild(el('div', { class: 'qx-hint' }, el('p', { text: '初始化失败：' + (e && e.message ? e.message : e) })));
  }
});
