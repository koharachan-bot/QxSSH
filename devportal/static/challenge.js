/**
 * challenge.js —— Turnstile 风格人机验证挂件
 *
 * 挂件形态对齐 Cloudflare Turnstile：左侧绿色转圈 + "正在验证..."，右侧品牌。
 * 页面加载即自动开始，用户无需操作；若证据不足会提示"请移动鼠标"，
 * 用户随便动一下鼠标或敲几个键即可完成。
 */
(function () {
  'use strict';

  var widget = document.querySelector('[data-chal-widget]');
  var textEl = document.querySelector('[data-chal-text]');
  var form = document.querySelector('form');
  var submitBtn = form ? form.querySelector('button[type=submit]') : null;

  var points = [];
  var clicks = [];
  var keyEvents = 0;
  var startedAt = Date.now();
  var solved = -1;
  var challenge = null;
  var done = false;

  function setState(state, text) {
    if (widget) widget.dataset.state = state;
    if (textEl && text) textEl.textContent = text;
    if (submitBtn) submitBtn.disabled = state !== 'ok';
  }

  // 验证完成前禁止提交，避免用户抢跑撞上 403。
  if (submitBtn) submitBtn.disabled = true;

  function recordPointer(x, y) {
    if (done || typeof x !== 'number') return;
    var last = points[points.length - 1];
    if (last && Math.abs(last[0] - x) < 2 && Math.abs(last[1] - y) < 2) return;
    points.push([Math.round(x), Math.round(y)]);
    if (points.length > 400) points.shift();
  }

  window.addEventListener('mousemove', function (e) { recordPointer(e.clientX, e.clientY); }, { passive: true });
  window.addEventListener('touchmove', function (e) {
    var t = e.touches && e.touches[0];
    if (t) recordPointer(t.clientX, t.clientY);
  }, { passive: true });
  window.addEventListener('mousedown', function (e) {
    clicks.push([Math.round(e.clientX), Math.round(e.clientY)]);
  }, { passive: true });
  window.addEventListener('keydown', function () { keyEvents++; }, { passive: true });

  function sha256Hex(text) {
    var buf = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', buf).then(function (d) {
      var bytes = new Uint8Array(d);
      var out = '';
      for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
      return out;
    });
  }

  function solve(nonce, difficulty) {
    var want = '0'.repeat(difficulty);
    var counter = 0;
    var deadline = Date.now() + 25000;
    function step() {
      if (Date.now() > deadline) return Promise.reject(new Error('计算超时'));
      var start = counter;
      var batch = [];
      for (var i = 0; i < 32; i++) {
        var c = start + i;
        batch.push(sha256Hex(nonce + ':' + c).then(function (h) { return { h: h, c: c }; }));
      }
      counter = start + 32;
      return Promise.all(batch).then(function (res) {
        for (var j = 0; j < res.length; j++) {
          if (res[j].h.indexOf(want) === 0) return res[j].c;
        }
        return step();
      });
    }
    return step();
  }

  function collectSignals() {
    var s = { webdriver: navigator.webdriver === true };
    s.lang = (navigator.languages || [navigator.language || '']).join(',');
    s.platform = navigator.platform || '';
    s.cores = navigator.hardwareConcurrency || 0;
    s.memory = navigator.deviceMemory || 0;
    s.touch = (navigator.maxTouchPoints || 0) > 0;
    s.screen = (screen.width || 0) + 'x' + (screen.height || 0);
    s.plugins = navigator.plugins ? navigator.plugins.length : 0;
    try { s.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { }
    return s;
  }

  /** 与 Turnstile 一致：用户无需操作，等够最短时长、PoW 算完即可提交。
   *  指针轨迹作为加分证据一起上送，由服务端按可信度决定是否强制要求。 */
  function submit() {
    if (Date.now() - startedAt < 1000) {
      setTimeout(submit, 300);
      return;
    }
    setState('running', '正在确认…');
    fetch('/challenge/verify', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: challenge.id,
        solution: String(solved),
        evidence: {
          durationMs: Date.now() - startedAt,
          points: points,
          clicks: clicks,
          keyEvents: keyEvents
        },
        signals: collectSignals()
      })
    }).then(function (r) {
      return r.json().then(function (b) { return { ok: r.ok, body: b }; });
    }).then(function (out) {
      if (!out.ok) throw new Error((out.body && out.body.error) || '验证未通过');
      done = true;
      setState('ok', '成功！');
    }).catch(function (err) {
      var msg = (err && err.message) ? err.message : '验证失败';
      if (widget) widget.setAttribute('data-last-error', msg);
      msg = msg.replace(/[，,。].*$/, '');
      setState('error', msg);
      if (widget) {
        widget.style.cursor = 'pointer';
        widget.addEventListener('click', function () { location.reload(); }, { once: true });
      }
    });
  }

  function run() {
    if (!widget) return;
    if (!window.crypto || !crypto.subtle) {
      setState('error', '当前环境不支持安全验证（需 HTTPS）');
      return;
    }
    setState('running', '正在验证...');
    fetch('/challenge', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('无法获取验证挑战');
        return r.json();
      })
      .then(function (ch) {
        challenge = ch;
        return solve(ch.nonce, ch.difficulty);
      })
      .then(function (counter) {
        solved = counter;
        submit();
      })
      .catch(function (err) {
        setState('error', (err && err.message ? err.message : '验证失败') + '，点击重试');
      });
  }

  run();
})();
