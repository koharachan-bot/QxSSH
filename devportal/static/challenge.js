/**
 * challenge.js —— interstitial 人机验证
 *
 * 目标不是"绝对证明对面是人"（纯客户端做不到），而是把绕过成本从
 * 「几行 curl」抬到「必须真实浏览器 + 模拟指针轨迹 + 等够时间」。
 *
 * 采集三类证据：
 *   - PoW：算 SHA-256 前导零，消耗 CPU；
 *   - 指针轨迹：真实鼠标/触摸会产生非直线的连续位移，脚本客户端通常没有；
 *   - 交互时长：人类从看到页面到操作完不可能快于 1.2 秒。
 */
(function () {
  'use strict';

  var statusEl = document.querySelector('[data-chal-status]');
  var barEl = document.querySelector('[data-chal-bar]');
  var stageEl = document.querySelector('[data-chal-stage]');
  var retryBtn = document.querySelector('[data-chal-retry]');
  // 回跳目标来自服务端渲染的挑战页；原地拦截模式下它就是用户原本要访问的地址。
  var nextHost = document.querySelector('[data-chal-target]') || document.querySelector('[data-next]');
  var nextUrl = (nextHost && (nextHost.getAttribute('data-chal-target') || nextHost.getAttribute('data-next'))) || '/';
  // 只接受站内相对路径，和服务端的校验保持一致，避免开放重定向。
  if (nextUrl.charAt(0) !== '/' || nextUrl.indexOf('//') === 0) nextUrl = '/dashboard';

  var points = [];
  var clicks = [];
  var keyEvents = 0;
  var startedAt = Date.now();
  var challenge = null;
  var solved = -1;
  var finished = false;

  function setStatus(text, kind) {
    if (statusEl) {
      statusEl.textContent = text;
      statusEl.dataset.kind = kind || '';
    }
    if (barEl) {
      barEl.dataset.kind = kind || '';
    }
  }

  function pushPoint(x, y) {
    if (finished) return;
    var last = points[points.length - 1];
    // 过滤重复点，避免静止时刷满数组
    if (last && Math.abs(last[0] - x) < 2 && Math.abs(last[1] - y) < 2) return;
    points.push([x, y]);
    if (points.length > 600) points.shift();
  }

  function attachCollectors() {
    var target = stageEl || window;
    var onMove = function (e) {
      var x = e.clientX, y = e.clientY;
      if (typeof x !== 'number') return;
      pushPoint(Math.round(x), Math.round(y));
    };
    if (target === window) {
      window.addEventListener('mousemove', onMove, { passive: true });
      window.addEventListener('touchmove', function (e) {
        var t = e.touches && e.touches[0];
        if (t) pushPoint(Math.round(t.clientX), Math.round(t.clientY));
      }, { passive: true });
    } else {
      target.addEventListener('mousemove', onMove, { passive: true });
      target.addEventListener('touchmove', function (e) {
        var t = e.touches && e.touches[0];
        if (t) pushPoint(Math.round(t.clientX), Math.round(t.clientY));
      }, { passive: true });
    }
    window.addEventListener('mousedown', function (e) {
      clicks.push([Math.round(e.clientX), Math.round(e.clientY)]);
    }, { passive: true });
    window.addEventListener('keydown', function () { keyEvents++; }, { passive: true });
  }

  function sha256Hex(text) {
    var buf = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', buf).then(function (digest) {
      var bytes = new Uint8Array(digest);
      var out = '';
      for (var i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
      }
      return out;
    });
  }

  function solve(nonce, difficulty) {
    var want = '0'.repeat(difficulty);
    var counter = 0;
    var deadline = Date.now() + 25000;

    function step() {
      if (Date.now() > deadline) {
        return Promise.reject(new Error('计算超时'));
      }
      var start = counter;
      var batch = [];
      for (var i = 0; i < 32; i++) {
        var c = start + i;
        batch.push(sha256Hex(nonce + ':' + c).then(function (h) {
          return { h: h, c: c };
        }));
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
    var s = {};
    s.webdriver = navigator.webdriver === true;
    s.lang = (navigator.languages || [navigator.language || '']).join(',');
    s.platform = navigator.platform || '';
    s.cores = navigator.hardwareConcurrency || 0;
    s.memory = navigator.deviceMemory || 0;
    s.touch = (navigator.maxTouchPoints || 0) > 0;
    s.screen = (screen.width || 0) + 'x' + (screen.height || 0);
    s.depth = screen.colorDepth || 0;
    s.plugins = navigator.plugins ? navigator.plugins.length : 0;
    s.ua = navigator.userAgent;
    try { s.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { }
    return s;
  }

  /** 证据不足时给出可操作的提示，而不是一律"失败" */
  function describeGap(ev) {
    if (ev.durationMs < 1200) return '操作过快，请稍候重试';
    if (ev.points.length < 10) return '请把鼠标在方框内移动一下';
    var path = 0;
    for (var i = 1; i < ev.points.length; i++) {
      var dx = ev.points[i][0] - ev.points[i - 1][0];
      var dy = ev.points[i][1] - ev.points[i - 1][1];
      path += Math.sqrt(dx * dx + dy * dy);
    }
    if (path < 220) return '请多移动几下鼠标';
    return '';
  }

  function finishFail(msg) {
    if (finished) return;
    finished = true;
    setStatus('验证失败：' + msg + '，请点击重试', 'err');
    if (retryBtn) retryBtn.hidden = false;
  }

  function submit() {
    var ev = {
      durationMs: Date.now() - startedAt,
      points: points,
      clicks: clicks,
      keyEvents: keyEvents,
      signals: collectSignals()
    };
    var gap = describeGap(ev);
    if (gap) {
      // 证据不足先不算失败：提示用户操作后自动重试
      setStatus(gap, 'busy');
      setTimeout(submit, 800);
      return;
    }
    setStatus('正在确认…', 'busy');
    fetch('/challenge/verify', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: challenge.id,
        solution: String(solved),
        evidence: {
          durationMs: ev.durationMs,
          points: ev.points,
          clicks: ev.clicks,
          keyEvents: ev.keyEvents
        },
        signals: ev.signals
      })
    }).then(function (r) {
      return r.json().then(function (b) { return { ok: r.ok, body: b }; });
    }).then(function (out) {
      if (!out.ok) throw new Error((out.body && out.body.error) || '验证未通过');
      finished = true;
      setStatus('验证成功。正在等待页面响应…', 'ok');
      var bar = document.querySelector('[data-chal-progress]');
      if (bar) bar.style.width = '100%';
      setTimeout(function () { location.replace(nextUrl); }, 260);
    }).catch(function (err) {
      finishFail(err && err.message ? err.message : '未知错误');
    });
  }

  function run() {
    if (!window.crypto || !crypto.subtle) {
      finishFail('当前浏览器不支持安全上下文（需要 HTTPS 或 localhost）');
      return;
    }
    retryBtn && (retryBtn.hidden = true);
    finished = false;
    solved = -1;
    points = [];
    clicks = [];
    keyEvents = 0;
    startedAt = Date.now();

    setStatus('正在校验浏览器…', 'busy');
    fetch('/challenge', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('无法获取验证挑战');
        return r.json();
      })
      .then(function (ch) {
        challenge = ch;
        setStatus('正在计算工作量证明…', 'busy');
        return solve(ch.nonce, ch.difficulty);
      })
      .then(function (counter) {
        solved = counter;
        setStatus('请在此区域移动鼠标，完成人机验证', 'busy');
        submit();
      })
      .catch(function (err) {
        finishFail(err && err.message ? err.message : '未知错误');
      });
  }

  attachCollectors();
  if (retryBtn) {
    retryBtn.addEventListener('click', function (e) {
      e.preventDefault();
      run();
    });
  }
  run();
})();
