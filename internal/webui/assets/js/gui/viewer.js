/**
 * gui/viewer.js —— Linux 图形应用视图
 * 要点：在宿主窗口里渲染远端 X 显示（WebCodecs 解 H.264，JPEG 兜底），
 * 并把键鼠与剪贴板回传给目标主机上的输入代理。画面走自有帧协议而不是 VNC：
 * 会话常驻、断线可重连、缩放与编码解耦，交互尽量贴近远程桌面。
 */
import { guiList, guiStart, guiStop, guiWsUrl, listHosts } from '../core/qxssh-api.js';
import { t } from '../core/i18n.js';
import { toast } from '../core/ui.js';

const STYLE_ID = 'qx-gui-style';

/** 注入一次样式，多个图形窗口共用 */
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.qx-gui { display: flex; flex-direction: column; height: 100%; min-height: 0; background: #101012; color: var(--text-1, #e6e6e6); }
.qx-gui-bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--line, rgba(255,255,255,.08)); background: var(--bg-2, #17171a); flex: none; }
.qx-gui-select, .qx-gui-btn { font: inherit; font-size: 12px; color: inherit; background: var(--bg-3, #202024); border: 1px solid var(--line, rgba(255,255,255,.1)); border-radius: 6px; padding: 4px 8px; cursor: pointer; }
.qx-gui-btn:hover { background: var(--bg-4, #2a2a30); }
.qx-gui-btn:disabled { opacity: .5; cursor: default; }
.qx-gui-status { font-size: 12px; opacity: .8; }
.qx-gui-status[data-state="live"] { color: #4ade80; }
.qx-gui-status[data-state="error"] { color: #f87171; }
.qx-gui-meta { font-size: 12px; opacity: .55; font-variant-numeric: tabular-nums; }
.qx-gui-spacer { flex: 1; }
.qx-gui-stage { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #0b0b0d; }
.qx-gui-canvas { max-width: 100%; max-height: 100%; width: auto; height: auto; outline: none; display: block; cursor: default; background: #000; }
.qx-gui-overlay { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); padding: 6px 12px; border-radius: 8px; background: rgba(0,0,0,.6); font-size: 12px; pointer-events: none; }
.qx-gui-hint { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); max-width: 80%; padding: 12px 16px; border-radius: 10px; background: rgba(20,20,24,.92); border: 1px solid rgba(255,255,255,.1); font-size: 12px; line-height: 1.6; white-space: pre-wrap; display: none; }
.qx-gui-hint.is-error { color: #fca5a5; display: block; }
`;
  document.head.appendChild(style);
}

// 物理键位 → X11 keysym：Shift 等修饰键单独下发，普通键只发基础键位，
// 这样远端按自身键盘布局产生字符，与本地输入法互不干扰。
const CODE_KEYSYM = {
  Minus: 'minus', Equal: 'equal', BracketLeft: 'bracketleft', BracketRight: 'bracketright',
  Backslash: 'backslash', Semicolon: 'semicolon', Quote: 'apostrophe', Backquote: 'grave',
  Comma: 'comma', Period: 'period', Slash: 'slash',
  Space: 'space', Enter: 'Return', Tab: 'Tab', Backspace: 'BackSpace', Escape: 'Escape',
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  CapsLock: 'Caps_Lock', ShiftLeft: 'Shift_L', ShiftRight: 'Shift_R',
  ControlLeft: 'Control_L', ControlRight: 'Control_R',
  AltLeft: 'Alt_L', AltRight: 'Alt_R', MetaLeft: 'Super_L', MetaRight: 'Super_R',
  ContextMenu: 'Menu', Pause: 'Pause', ScrollLock: 'Scroll_Lock', NumLock: 'Num_Lock',
  NumpadAdd: 'KP_Add', NumpadSubtract: 'KP_Subtract', NumpadMultiply: 'KP_Multiply',
  NumpadDivide: 'KP_Divide', NumpadEnter: 'KP_Enter', NumpadDecimal: 'KP_Decimal',
};

function codeToKeysym(code) {
  if (!code) return '';
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad') && /^[0-9]$/.test(code.slice(6))) return 'KP_' + code.slice(6);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_KEYSYM[code] || '';
}

function b64ToBytes(text) {
  if (!text) return new Uint8Array(0);
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function mouseButton(b) {
  if (b === 1) return 2;
  if (b === 2) return 3;
  return 1;
}

/**
 * 挂载图形应用视图。
 * @param {HTMLElement} el 窗口内容容器
 * @param {object} app 应用清单（含 id/runtime）
 * @param {object} opts 宿主传入的 { hostId, win, ... }
 * @returns {() => void} 清理函数
 */
export function mountGuiApp(el, app, opts = {}) {
  ensureStyle();

  let session = null;
  let ws = null;
  let decoder = null;
  let codec = '';
  let frameW = 0;
  let frameH = 0;
  let ts = 0;
  let busy = false;
  let disposed = false;
  let jpegBusy = false;
  let lastMoveAt = 0;

  const root = document.createElement('div');
  root.className = 'qx-gui';

  const bar = document.createElement('div');
  bar.className = 'qx-gui-bar';

  const hostSel = document.createElement('select');
  hostSel.className = 'qx-gui-select';
  hostSel.title = t('core.gui.host');

  const startBtn = mkBtn('core.gui.start', () => start());
  const statusEl = document.createElement('span');
  statusEl.className = 'qx-gui-status';
  statusEl.textContent = t('core.gui.status.idle');
  statusEl.dataset.state = 'idle';
  const sizeEl = document.createElement('span');
  sizeEl.className = 'qx-gui-meta';
  const spacer = document.createElement('div');
  spacer.className = 'qx-gui-spacer';

  const stage = document.createElement('div');
  stage.className = 'qx-gui-stage';
  const canvas = document.createElement('canvas');
  canvas.className = 'qx-gui-canvas';
  canvas.tabIndex = 0;
  const overlay = document.createElement('div');
  overlay.className = 'qx-gui-overlay';
  overlay.textContent = t('core.gui.click-to-focus');
  const hint = document.createElement('div');
  hint.className = 'qx-gui-hint';
  stage.append(canvas, overlay, hint);

  bar.append(
    hostSel, startBtn, statusEl, sizeEl, spacer,
    mkBtn('core.gui.keyboard', () => canvas.focus()),
    mkBtn('core.gui.copy', () => send({ t: 'cbget' })),
    mkBtn('core.gui.paste', () => pasteToRemote()),
    mkBtn('core.gui.fullscreen', () => toggleFullscreen()),
    mkBtn('core.gui.stop', () => stopSession()),
  );
  root.append(bar, stage);
  el.appendChild(root);

  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  const pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) send({ t: 'ping' });
  }, 20000);

  bindInput();
  void loadHostList().then(() => {
    if (disposed) return;
    if (opts.autoStart !== false && hostSel.value !== '') void start();
  });

  return () => {
    disposed = true;
    clearInterval(pingTimer);
    closeSocket();
    closeDecoder();
    root.remove();
  };

  // ---- 内部实现 ----

  function mkBtn(key, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'qx-gui-btn';
    b.textContent = t(key);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    return b;
  }

  function setStatus(kind, text) {
    statusEl.dataset.state = kind;
    statusEl.textContent = text || t('core.gui.status.' + kind);
  }

  function showError(message) {
    setStatus('error');
    hint.textContent = String(message || '');
    hint.classList.add('is-error');
    hint.style.display = 'block';
  }

  function clearError() {
    hint.classList.remove('is-error');
    hint.style.display = 'none';
  }

  async function loadHostList() {
    try {
      const resp = await listHosts();
      const list = Array.isArray(resp) ? resp : (resp && resp.hosts) || [];
      hostSel.textContent = '';
      const localOpt = document.createElement('option');
      localOpt.value = '';
      localOpt.textContent = t('core.gui.host-local');
      hostSel.appendChild(localOpt);
      for (const h of list) {
        const o = document.createElement('option');
        o.value = h.id;
        o.textContent = h.name || h.host || h.id;
        hostSel.appendChild(o);
      }
      const pref = opts.hostId || opts.host || '';
      if (pref && Array.from(hostSel.options).some((o) => o.value === pref)) hostSel.value = pref;
      else if (list.length === 1) hostSel.value = list[0].id;
    } catch (err) {
      console.warn('[gui] 读取主机列表失败', err);
    }
  }

  async function findSession(appId, hostId) {
    try {
      const resp = await guiList();
      const list = Array.isArray(resp) ? resp : (resp && resp.sessions) || [];
      return list.find((s) => s.appId === appId && (s.host || '') === (hostId || '') && s.running) || null;
    } catch {
      return null;
    }
  }

  async function start() {
    if (busy) return;
    busy = true;
    clearError();
    setStatus('starting');
    try {
      const hostId = hostSel.value;
      session = await findSession(app.id, hostId);
      if (!session) {
        const resp = await guiStart({ app: app.id, host: hostId });
        session = (resp && resp.session) || resp;
      }
      await connect();
    } catch (err) {
      showError((err && err.message) || String(err));
    } finally {
      busy = false;
    }
  }

  function connect() {
    closeSocket();
    closeDecoder();
    setStatus('connecting');
    codec = typeof window.VideoDecoder === 'function' ? 'h264' : 'jpeg';
    const url = guiWsUrl(session.id, codec);
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (ev) => {
      if (!disposed) onMessage(ev);
    };
    ws.onclose = () => {
      if (!disposed && session) setStatus('idle', t('core.gui.session-lost'));
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t('core.gui.connect-timeout'))), 15000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(t('core.gui.ws-failed')));
      }, { once: true });
    });
  }

  function closeSocket() {
    if (!ws) return;
    try {
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
    } catch { }
    ws = null;
  }

  function closeDecoder() {
    if (!decoder) return;
    try {
      decoder.close();
    } catch { }
    decoder = null;
  }

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch { }
  }

  function onMessage(ev) {
    if (typeof ev.data === 'string') {
      let msg = null;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg) onControl(msg);
      return;
    }
    const buf = new Uint8Array(ev.data);
    if (buf.length < 2) return;
    const kind = buf[0];
    const data = buf.subarray(1);
    if (kind === 3) {
      drawJPEG(data);
      return;
    }
    if (!decoder) return;
    try {
      decoder.decode(new EncodedVideoChunk({
        type: kind === 1 ? 'key' : 'delta',
        timestamp: ts,
        data,
      }));
      ts += Math.round(1000000 / ((session && session.fps) || 30));
    } catch (err) {
      console.warn('[gui] 解码失败', err);
    }
  }

  function onControl(msg) {
    switch (msg.t) {
      case 'hello': {
        const s = msg.session || {};
        frameW = s.width || 0;
        frameH = s.height || 0;
        applySize();
        setStatus('live');
        break;
      }
      case 'config':
        setupDecoder(msg);
        break;
      case 'ready':
        if (msg.width && msg.height) {
          frameW = msg.width;
          frameH = msg.height;
          applySize();
        }
        break;
      case 'cb':
        copyToLocal(msg.text || '');
        break;
      case 'error':
        showError(msg.message || 'error');
        break;
      case 'warn':
        console.warn('[gui]', msg.message);
        break;
      default:
        break;
    }
  }

  function applySize() {
    if (!frameW || !frameH) return;
    if (canvas.width !== frameW || canvas.height !== frameH) {
      canvas.width = frameW;
      canvas.height = frameH;
    }
    sizeEl.textContent = frameW + '×' + frameH;
  }

  function setupDecoder(msg) {
    if (typeof window.VideoDecoder !== 'function') return;
    closeDecoder();
    try {
      decoder = new VideoDecoder({
        output: (frame) => {
          drawFrame(frame);
          frame.close();
        },
        error: (err) => console.warn('[gui] decoder error', err),
      });
      const desc = b64ToBytes(msg.description || '');
      const cfg = { codec: msg.codec || 'avc1.42E01E', optimizeForLatency: true };
      if (desc.length) cfg.description = desc;
      decoder.configure(cfg);
      clearError();
    } catch (err) {
      showError(t('core.gui.decoder-failed') + ' ' + ((err && err.message) || err));
    }
  }

  function drawFrame(frame) {
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;
    if (!w || !h || !ctx) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      frameW = w;
      frameH = h;
      sizeEl.textContent = w + '×' + h;
    }
    ctx.drawImage(frame, 0, 0, w, h);
  }

  function drawJPEG(data) {
    if (jpegBusy || !ctx) return;
    jpegBusy = true;
    const blob = new Blob([data], { type: 'image/jpeg' });
    createImageBitmap(blob).then((bmp) => {
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
    }).catch(() => { }).finally(() => {
      jpegBusy = false;
    });
  }

  function mapPoint(e) {
    const rect = canvas.getBoundingClientRect();
    const w = canvas.width || frameW || 1;
    const h = canvas.height || frameH || 1;
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * w),
      y: Math.round(((e.clientY - rect.top) / rect.height) * h),
    };
  }

  function bindInput() {
    canvas.addEventListener('pointerdown', (e) => {
      canvas.focus();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch { }
      const p = mapPoint(e);
      send({ t: 'm', x: p.x, y: p.y });
      send({ t: 'b', b: mouseButton(e.button), d: true });
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!frameW || !frameH) return;
      const now = performance.now();
      if (now - lastMoveAt < 16) return;
      lastMoveAt = now;
      const p = mapPoint(e);
      send({ t: 'm', x: p.x, y: p.y });
    });
    canvas.addEventListener('pointerup', (e) => {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch { }
      send({ t: 'b', b: mouseButton(e.button), d: false });
      e.preventDefault();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      send({ t: 'w', dy: e.deltaY > 0 ? 3 : -3 });
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('keydown', (e) => onKey(e, true));
    canvas.addEventListener('keyup', (e) => onKey(e, false));
    canvas.addEventListener('focus', () => {
      overlay.style.display = 'none';
    });
    canvas.addEventListener('blur', () => {
      overlay.style.display = '';
    });
  }

  function onKey(e, down) {
    const k = codeToKeysym(e.code);
    if (!k) return;
    e.preventDefault();
    send({ t: 'k', k, d: down });
  }

  async function pasteToRemote() {
    try {
      const text = await navigator.clipboard.readText();
      send({ t: 'cb', text: String(text || '') });
      toast(t('core.gui.clipboard-sent'), 'success');
    } catch {
      toast(t('core.gui.clipboard-denied'), 'error');
    }
  }

  function copyToLocal(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        toast(t('core.gui.clipboard-copied'), 'success');
      }).catch(() => { });
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => { });
      return;
    }
    if (stage.requestFullscreen) stage.requestFullscreen().catch(() => { });
  }

  async function stopSession() {
    const id = session && session.id;
    session = null;
    closeSocket();
    closeDecoder();
    setStatus('idle');
    clearError();
    canvas.width = 0;
    canvas.height = 0;
    sizeEl.textContent = '';
    if (!id) return;
    try {
      await guiStop(id);
    } catch (err) {
      toast((err && err.message) || String(err), 'error');
    }
  }
}
