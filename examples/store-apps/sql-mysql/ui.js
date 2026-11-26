/**
 * ui.js —— 通用界面组件
 * 约定：所有动态文本一律走 textContent，禁止 innerHTML —— 库里的数据可能含任意字符，
 * 拼字符串会被当成标签执行。
 */

/** 创建元素：el('div', { class: 'x', text: '文案', onclick: fn }, 子节点...) */
export function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  const a = attrs || {};
  for (const key of Object.keys(a)) {
    const v = a[key];
    if (v === undefined || v === null || v === false) continue;
    if (key === 'class') node.className = String(v);
    else if (key === 'text') node.textContent = String(v);
    else if (key === 'dataset') {
      for (const dk of Object.keys(v)) node.dataset[dk] = String(v[dk]);
    } else if (key.slice(0, 2) === 'on' && typeof v === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), v);
    } else if (v === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(v));
    }
  }
  for (const kid of kids) {
    const list = Array.isArray(kid) ? kid : [kid];
    for (const one of list) {
      if (one === null || one === undefined || one === false) continue;
      node.appendChild(one instanceof Node ? one : document.createTextNode(String(one)));
    }
  }
  return node;
}

/** 清空子节点 */
export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

/* ---------------- 轻提示 ---------------- */

let toastHost = null;

function ensureToastHost() {
  if (toastHost && document.body.contains(toastHost)) return toastHost;
  toastHost = el('div', { class: 'qx-toast-host' });
  document.body.appendChild(toastHost);
  return toastHost;
}

/** 右下角浮层提示，kind 取 info / ok / warn / error */
export function toast(message, kind, ms) {
  const host = ensureToastHost();
  const item = el('div', { class: 'qx-toast qx-toast-' + (kind || 'info'), text: String(message || '') });
  host.appendChild(item);
  const life = typeof ms === 'number' ? ms : 2800;
  setTimeout(() => {
    item.classList.add('qx-toast-out');
    setTimeout(() => item.remove(), 220);
  }, life);
}

/* ---------------- 弹窗 ---------------- */

/** 通用模态框，返回 { close } */
export function modal(opts) {
  const o = opts || {};
  const overlay = el('div', { class: 'qx-modal-overlay' });
  const panel = el('div', { class: 'qx-modal ' + (o.wide ? 'qx-modal-wide' : '') });
  const head = el('div', { class: 'qx-modal-head' },
    el('div', { class: 'qx-modal-title', text: o.title || '' }),
    el('button', { class: 'qx-modal-x', text: '×', title: '关闭', onclick: () => close(null) }));
  const body = el('div', { class: 'qx-modal-body' }, o.body || null);
  const foot = el('div', { class: 'qx-modal-foot' });

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(null); }
  }
  function close(result) {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (o.onClose) o.onClose(result);
  }

  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay || e.target.classList.contains('qx-modal-mask')) close(null);
  });

  for (const act of (o.actions || [])) {
    const cls = 'btn ' + (act.primary ? 'primary ' : '') + (act.danger ? 'danger ' : '') + (act.ghost ? 'ghost' : '');
    foot.appendChild(el('button', {
      class: cls.trim(),
      text: act.label,
      onclick: async () => {
        if (act.onClick) {
          const verdict = await act.onClick();
          if (verdict === false) return;
        }
        close(true);
      },
    }));
  }

  panel.append(head, body, foot);
  overlay.append(el('div', { class: 'qx-modal-mask' }), panel);
  document.body.appendChild(overlay);
  return { close };
}

/** 普通确认框，返回 Promise<boolean> */
export function confirmBox(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    modal({
      title: o.title || '请确认',
      body: el('div', { class: 'qx-confirm' },
        el('p', { text: o.message || '' }),
        o.detail ? el('pre', { class: 'qx-pre', text: o.detail }) : null),
      actions: [
        { label: '取消', onClick: () => { finish(false); return true; } },
        { label: o.confirmText || '确认', primary: true, onClick: () => { finish(true); return true; } },
      ],
      onClose: () => finish(false),
    });
  });
}

/**
 * 危险操作二次确认：把将要执行的语句原样展示出来。
 * 返回 Promise<boolean>，只有用户明确点确认才为真。
 */
export function confirmDanger(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const list = el('div', { class: 'qx-danger-list' });
    for (const stmt of (o.statements || [])) {
      list.appendChild(el('pre', { class: 'qx-danger-stmt', text: stmt }));
    }
    modal({
      title: o.title || '危险操作确认',
      body: el('div', { class: 'qx-danger' },
        el('p', { class: 'qx-danger-tip', text: o.message || '该操作可能不可撤销，请核对以下语句后确认。' }),
        list),
      actions: [
        { label: '取消', onClick: () => { finish(false); return true; } },
        { label: o.confirmText || '确认执行', danger: true, primary: true, onClick: () => { finish(true); return true; } },
      ],
      onClose: () => finish(false),
    });
  });
}

/* ---------------- 剪贴板 ---------------- */

/** 复制文本：优先 Clipboard API，沙箱拒绝时退回 execCommand */
export async function copyText(text) {
  const value = String(text === null || text === undefined ? '' : text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (e) {
    /* 无 allow-same-origin 时 Clipboard API 常被拒，继续走兜底 */
  }
  try {
    const ta = el('textarea', { class: 'qx-copy-tmp' });
    ta.value = value;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

/* ---------------- 格式化 ---------------- */

/** 毫秒转可读耗时 */
export function formatDuration(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return n + ' ms';
  return (n / 1000).toFixed(2) + ' s';
}

/** 字节数转可读大小 */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/* ---------------- 结果表格 ---------------- */

/**
 * 渲染结果表格（前端分页）。
 * spec: { columns, rows, page, pageSize, onPageChange, onCopyCell, emptyText }
 * rows 为二维数组，单元格 null 表示数据库 NULL。
 */
export function renderGrid(container, spec) {
  const s = spec || {};
  clear(container);
  const rows = Array.isArray(s.rows) ? s.rows : [];
  const columns = Array.isArray(s.columns) ? s.columns : [];

  if (!rows.length) {
    container.appendChild(el('div', { class: 'qx-empty', text: s.emptyText || '没有返回数据行' }));
    return;
  }

  const pageSize = Math.max(1, Number(s.pageSize) || 100);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(Math.max(1, Number(s.page) || 1), pages);
  const start = (current - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  const cols = columns.length ? columns : slice[0].map((_, i) => '列 ' + (i + 1));

  const table = el('table', { class: 'qx-grid' });
  const headRow = el('tr');
  headRow.appendChild(el('th', { class: 'qx-rownum', text: '#' }));
  for (const col of cols) headRow.appendChild(el('th', { text: String(col) }));
  table.appendChild(el('thead', null, headRow));

  const body = el('tbody');
  slice.forEach((row, idx) => {
    const tr = el('tr');
    tr.appendChild(el('td', { class: 'qx-rownum', text: String(start + idx + 1) }));
    for (let c = 0; c < cols.length; c += 1) {
      const value = row[c];
      const isNull = value === null || value === undefined;
      const text = isNull ? 'NULL' : String(value);
      const cell = el('td', {
        class: isNull ? 'qx-null' : '',
        text,
        title: isNull ? 'NULL' : text,
        onclick: () => { if (s.onCopyCell) s.onCopyCell(isNull ? '' : text); },
      });
      tr.appendChild(cell);
    }
    body.appendChild(tr);
  });
  table.appendChild(body);
  container.appendChild(el('div', { class: 'qx-grid-scroll' }, table));

  const go = (p) => { if (s.onPageChange) s.onPageChange(p); };
  const pager = el('div', { class: 'qx-pager' },
    el('span', { class: 'qx-pager-info', text: '共 ' + rows.length + ' 行 · 第 ' + current + ' / ' + pages + ' 页' }),
    el('button', { class: 'btn ghost', text: '首页', disabled: current <= 1 || undefined, onclick: () => go(1) }),
    el('button', { class: 'btn ghost', text: '上一页', disabled: current <= 1 || undefined, onclick: () => go(current - 1) }),
    el('button', { class: 'btn ghost', text: '下一页', disabled: current >= pages || undefined, onclick: () => go(current + 1) }),
    el('button', { class: 'btn ghost', text: '末页', disabled: current >= pages || undefined, onclick: () => go(pages) }));
  container.appendChild(pager);
}

/** 渲染等宽原始文本（客户端输出、错误信息等） */
export function renderPre(container, text, emptyText) {
  clear(container);
  const value = String(text === null || text === undefined ? '' : text);
  if (!value.trim()) {
    container.appendChild(el('div', { class: 'qx-empty', text: emptyText || '没有输出' }));
    return;
  }
  container.appendChild(el('pre', { class: 'qx-pre', text: value }));
}

/* ---------------- JSON 视图 ---------------- */

/** 把任意值格式化为缩进 JSON 文本，无法序列化时回退为 String */
export function prettyJSON(value, space) {
  try {
    return JSON.stringify(value, null, typeof space === 'number' ? space : 2);
  } catch (e) {
    return String(value);
  }
}


/* ---------------- 帧率无关的节流 ---------------- */

/** 简易防抖，用于把编辑内容延迟写入宿主偏好 */
export function debounce(fn, wait) {
  let timer = 0;
  return function debounced() {
    const args = arguments;
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(null, args), wait || 400);
  };
}
