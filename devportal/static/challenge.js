/**
 * challenge.js —— 浏览器端人机验证（JS 挑战）
 *
 * 流程：向服务端要一个挑战 → 本地找 hash 解 → 提交换取短期通行 Cookie。
 * 用户无感，页面加载时自动完成；脚本批量刷站要付出同样的 CPU 成本。
 */
(function () {
  'use strict';

  var statusEl = document.querySelector('[data-challenge-status]');
  var form = document.querySelector('[data-challenge-form]');
  var retryEl = document.querySelector('[data-challenge-retry]');

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.kind = kind || '';
  }

  function lockForm(lock) {
    if (!form) return;
    Array.prototype.forEach.call(form.querySelectorAll('button[type=submit], input[type=email], input[type=password], input[type=text]'), function (el) {
      el.disabled = lock;
    });
  }

  /** 采集浏览器环境信号：只用于提高机器人成本，不作为唯一判定依据 */
  function collectSignals() {
    var s = {};
    s.webdriver = navigator.webdriver === true;
    s.lang = (navigator.languages || [navigator.language || '']).join(',');
    s.platform = navigator.platform || '';
    s.hardwareConcurrency = navigator.hardwareConcurrency || 0;
    s.deviceMemory = navigator.deviceMemory || 0;
    s.touch = (navigator.maxTouchPoints || 0) > 0;
    s.screen = (screen.width || 0) + 'x' + (screen.height || 0);
    s.colorDepth = screen.colorDepth || 0;
    s.tz = '';
    try { s.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { }
    s.plugins = navigator.plugins ? navigator.plugins.length : 0;
    s.chrome = typeof window.chrome === 'object';
    s.crypto = !!(window.crypto && window.crypto.subtle);
    return s;
  }

  /** SHA-256 → 十六进制串 */
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

  /** 找满足前导零要求的 counter */
  function solve(nonce, difficulty) {
    var want = '0'.repeat(difficulty);
    var counter = 0;
    var deadline = Date.now() + 30000; // 30 秒兜底，避免死循环卡住页面

    function step() {
      if (Date.now() > deadline) {
        return Promise.reject(new Error('计算超时'));
      }
      var batch = [];
      // 每轮并发 32 个，兼顾吞吐与事件循环可交互性
      for (var i = 0; i < 32; i++) {
        batch.push(sha256Hex(nonce + ':' + counter).then(function (h) {
          return { h: h, c: counter };
        }));
        counter++;
      }
      return Promise.all(batch).then(function (results) {
        for (var j = 0; j < results.length; j++) {
          if (results[j].h.indexOf(want) === 0) {
            return results[j].c;
          }
        }
        return step();
      });
    }
    return step();
  }

  function start() {
    if (!window.crypto || !crypto.subtle) {
      setStatus('当前浏览器不支持安全上下文（需要 HTTPS 或 localhost）', 'err');
      if (retryEl) retryEl.hidden = false;
      lockForm(true);
      return;
    }
    lockForm(true);
    setStatus('正在验证浏览器…', 'busy');

    fetch('/challenge', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('获取挑战失败');
        return r.json();
      })
      .then(function (ch) {
        setStatus('正在计算验证…', 'busy');
        return solve(ch.nonce, ch.difficulty).then(function (solution) {
          return { ch: ch, solution: solution };
        });
      })
      .then(function (res) {
        return fetch('/challenge/verify', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: res.ch.id,
            nonce: res.ch.nonce,
            sig: res.ch.sig,
            expires: res.ch.expires,
            difficulty: res.ch.difficulty,
            solution: String(res.solution),
            signals: collectSignals()
          })
        });
      })
      .then(function (r) {
        return r.json().then(function (body) { return { ok: r.ok, body: body }; });
      })
      .then(function (out) {
        if (!out.ok) {
          throw new Error((out.body && out.body.error) || '验证未通过');
        }
        setStatus('验证通过', 'ok');
        lockForm(false);
        if (retryEl) retryEl.hidden = true;
      })
      .catch(function (err) {
        setStatus('验证失败：' + (err && err.message ? err.message : '未知错误'), 'err');
        lockForm(true);
        if (retryEl) retryEl.hidden = false;
      });
  }

  if (retryEl) {
    retryEl.addEventListener('click', function (e) {
      e.preventDefault();
      start();
    });
  }

  if (form) {
    start();
  }
})();
