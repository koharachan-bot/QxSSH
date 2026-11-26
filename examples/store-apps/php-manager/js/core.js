/**
 * core.js —— 基础设施层
 *
 * 三块内容：
 *  1. 宿主桥：从 iframe 的 postMessage 握手拿到会话令牌、目标主机与主题，并支持向宿主申请权限；
 *  2. 宿主 API：/api/v1 下的 exec、sudo、文件端点封装，权限不足时自动申请一次再重试；
 *  3. 输入守卫：域名、版本号、配置键值、路径的命令注入白名单校验，以及 POSIX 单引号转义。
 *
 * 约定：本文件不触碰 DOM，也不含任何面板相关业务判断。
 */
(function () {
  'use strict';

  var PM = (window.PM = window.PM || {});

  /* ================================================================== *
   * 一、宿主桥
   * ================================================================== */

  var bridge = {
    ready: false,
    session: null,
    hostId: '',
    appId: null,
    theme: 'light',
    waiters: [],
    pending: Object.create(null),
    seq: 0
  };

  /** 向父窗口投递消息；不在宿主 iframe 内时安全失败 */
  function post(type, extra) {
    try {
      if (!window.parent || window.parent === window) return false;
      var msg = { __qx: true, type: type };
      if (extra) {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
        }
      }
      window.parent.postMessage(msg, '*');
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 调用宿主提供的 host-call 方法，超时后返回兜底值 */
  function hostCall(method, params, timeout, fallback) {
    return new Promise(function (resolve) {
      var id = 'pm-' + Date.now().toString(36) + '-' + (++bridge.seq);
      var timer = setTimeout(function () {
        delete bridge.pending[id];
        resolve(fallback);
      }, timeout || 10000);
      bridge.pending[id] = { resolve: resolve, timer: timer };
      if (!post('host-call', { reqId: id, method: method, params: params || {} })) {
        clearTimeout(timer);
        delete bridge.pending[id];
        resolve(fallback);
      }
    });
  }

  function applyTheme(name) {
    var dark = name === 'dark';
    bridge.theme = dark ? 'dark' : 'light';
    document.documentElement.classList.toggle('dark', dark);
  }

  window.addEventListener('message', function (e) {
    // 应用处于不透明源，无法按 origin 校验，只接纳来自父窗口的消息。
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.__qx !== true) return;

    if (d.type === 'init') {
      var ctx = d.ctx || {};
      bridge.hostId = ctx.hostId || '';
      bridge.appId = ctx.appId || null;
      if (ctx.session) bridge.session = ctx.session;
      applyTheme(ctx.theme);
      bridge.ready = true;
      var list = bridge.waiters.splice(0);
      for (var i = 0; i < list.length; i++) {
        try { list[i](bridge); } catch (err) { console.error('[php-manager] init 回调异常', err); }
      }
      return;
    }

    if (d.type === 'theme') {
      applyTheme(d.theme);
      return;
    }

    if (d.type === 'host-result') {
      var p = bridge.pending[d.reqId];
      if (!p) return;
      clearTimeout(p.timer);
      delete bridge.pending[d.reqId];
      p.resolve(d.ok === false ? false : d.value);
    }
  });

  /** 等待宿主握手完成 */
  function onReady(fn) {
    if (bridge.ready) {
      try { fn(bridge); } catch (e) { console.error('[php-manager] ready 回调异常', e); }
      return;
    }
    bridge.waiters.push(fn);
  }

  /** 向用户申请本应用缺失的权限，全部获批返回 true */
  function requestPerm(need) {
    var list = (need || []).map(String).filter(Boolean);
    if (!list.length) return Promise.resolve(false);
    return hostCall('perm.request', { need: list }, 300000, false)
      .then(function (v) { return v === true; });
  }

  /* ================================================================== *
   * 二、宿主 HTTP API
   * ================================================================== */

  var API_BASE = '/api/v1';

  function waitSession() {
    if (bridge.session) return Promise.resolve(bridge.session);
    if (bridge.ready) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function () {
        if (settled) return;
        settled = true;
        resolve(bridge.session || null);
      };
      var timer = setTimeout(finish, 4000);
      bridge.waiters.push(function () {
        clearTimeout(timer);
        finish();
      });
    });
  }

  function buildQuery(query) {
    if (!query) return '';
    var parts = [];
    for (var k in query) {
      if (!Object.prototype.hasOwnProperty.call(query, k)) continue;
      var v = query[k];
      if (v === undefined || v === null) continue;
      if (v === true) v = '1';
      if (v === false) v = '';
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  function readJson(res) {
    return res.text().then(function (text) {
      if (!text) return null;
      try { return JSON.parse(text); } catch (e) { return text; }
    });
  }

  function errorFrom(res) {
    return res.text().then(function (text) {
      var msg = 'HTTP ' + res.status;
      var code = '';
      var need = null;
      try {
        var j = JSON.parse(text);
        if (j && typeof j === 'object') {
          if (j.error) msg = String(j.error);
          if (j.code) code = String(j.code);
          if (Array.isArray(j.need)) need = j.need;
        }
      } catch (e) { /* 非 JSON 响应，保留状态码文案 */ }
      var err = new Error(msg);
      err.status = res.status;
      if (code) err.code = code;
      if (need) err.need = need;
      return err;
    });
  }

  function cloneOpts(opts) {
    var out = {};
    for (var k in opts) {
      if (Object.prototype.hasOwnProperty.call(opts, k)) out[k] = opts[k];
    }
    return out;
  }

  /** 带会话令牌的宿主请求；403 且指明缺少权限时先向用户申请再重试一次 */
  function sysFetch(verb, target, opts) {
    opts = opts || {};
    return waitSession().then(function (tok) {
      var url = API_BASE + '/' + target + buildQuery(opts.query);
      var init = { method: verb, headers: {} };
      if (tok) init.headers['X-Qx-Session'] = tok;
      if (opts.body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }

      return fetch(url, init).then(function (res) {
        if (res.ok) return readJson(res);
        return errorFrom(res).then(function (err) {
          var need = err.need;
          if (err.status === 403 && err.code === 'permission' && need && need.length && !opts.retried) {
            return requestPerm(need).then(function (granted) {
              if (!granted) throw err;
              var next = cloneOpts(opts);
              next.retried = true;
              return sysFetch(verb, target, next);
            });
          }
          throw err;
        });
      }, function (e) {
        var err = new Error('宿主接口不可达：' + ((e && e.message) || String(e)));
        err.status = 0;
        throw err;
      });
    });
  }

  function sysGet(target, query) { return sysFetch('GET', target, { query: query }); }
  function sysCall(target, body) { return sysFetch('POST', target, { body: body }); }

  /* ------------------------- 命令执行 ------------------------- */

  /** 已确认可提权的主机，避免每次写操作都重新申请 */
  var elevHosts = Object.create(null);

  function looksLikePerm(text) {
    var s = String(text || '').toLowerCase();
    return s.indexOf('permission denied') >= 0
      || s.indexOf('operation not permitted') >= 0
      || s.indexOf('must be root') >= 0
      || s.indexOf('are you root') >= 0
      || s.indexOf('sudo: a password is required') >= 0
      || s.indexOf('a terminal is required') >= 0
      || s.indexOf('access denied') >= 0;
  }

  /**
   * 执行一次命令，结果统一成 { ok, out, err, exit }。
   * argv 以数组下发，宿主会对每一项做单引号转义，天然免疫 shell 注入。
   */
  function execOnce(argv, opts) {
    opts = opts || {};
    var payload = {
      host: opts.host || '',
      argv: argv,
      timeout: opts.timeout || 30,
      elevated: !!opts.elevated
    };
    if (opts.stdin) payload.stdin = opts.stdin;
    if (opts.cwd) payload.cwd = opts.cwd;

    return sysCall('exec/run', payload).then(function (r) {
      r = r || {};
      var out = typeof r.output === 'string' ? r.output : '';
      return {
        ok: !!r.ok,
        out: out,
        err: r.ok ? '' : String(r.error || out || '命令执行失败'),
        exit: typeof r.exit === 'number' ? r.exit : 0,
        truncated: !!r.truncated
      };
    }, function (e) {
      return {
        ok: false,
        out: '',
        err: (e && e.message) || String(e),
        exit: -1,
        thrown: true,
        status: e && e.status
      };
    });
  }

  /** 探测并申请 sudo（无密码主机直接通过，有密码主机由 UI 弹出输入框） */
  function requestSudoElevation(host, opts) {
    opts = opts || {};
    if (!host) {
      return Promise.resolve({
        ok: false,
        error: '本机执行不支持 sudo 申请流程；如需管理员权限，请在被管主机上通过 SSH 连接后操作'
      });
    }
    return sysCall('sudo/request', { host: host, password: '', submit: false }).then(function (probe) {
      probe = probe || {};
      if (probe.ok) return { ok: true, mode: probe.mode || 'nopass' };
      if (probe.needPass) {
        if (!PM.ui || typeof PM.ui.promptPassword !== 'function') {
          return { ok: false, error: '需要 sudo 密码，但密码输入界面尚未就绪' };
        }
        return PM.ui.promptPassword(host, opts.title || '需要管理员权限', opts.reason || '')
          .then(function (pw) {
            if (!pw) return { ok: false, cancelled: true, error: '已取消提权' };
            return sysCall('sudo/request', { host: host, password: pw, submit: true })
              .then(function (r) {
                r = r || {};
                return r.ok ? { ok: true, mode: r.mode || 'password' } : { ok: false, error: r.error || 'sudo 密码未通过验证' };
              }, function (e) {
                return { ok: false, error: (e && e.message) || String(e) };
              });
          });
      }
      return { ok: false, error: '目标主机未启用 sudo，或当前账号不在 sudoers 中' };
    }, function (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    });
  }

  /**
   * 只读查询：不申请提权，权限不足直接返回失败。
   */
  function execRead(argv, opts) {
    opts = opts || {};
    return execOnce(argv, { host: opts.host, timeout: opts.timeout || 25, stdin: opts.stdin });
  }

  /**
   * 写操作：先按当前权限执行，遇到权限错误才申请提权并重试一次。
   * 返回额外带 elevated 标记，供界面显示实际使用的权限等级。
   */
  function execWrite(argv, opts) {
    opts = opts || {};
    var host = opts.host || '';
    var already = !!elevHosts[host];

    return execOnce(argv, { host: host, timeout: opts.timeout || 60, elevated: already, stdin: opts.stdin })
      .then(function (r) {
        if (r.ok) {
          if (already) elevHosts[host] = true;
          r.elevated = already;
          return r;
        }
        if (already || !looksLikePerm(r.err + ' ' + r.out)) {
          r.elevated = already;
          return r;
        }
        return requestSudoElevation(host, opts).then(function (res) {
          if (!res.ok) {
            return { ok: false, out: r.out, err: res.error || '未取得管理员权限', exit: 1, elevated: false, denied: true };
          }
          elevHosts[host] = true;
          return execOnce(argv, { host: host, timeout: opts.timeout || 60, elevated: true, stdin: opts.stdin })
            .then(function (r2) { r2.elevated = true; return r2; });
        });
      });
  }

  /**
   * 流式执行（exec:stream）：命令产生的标准输出与标准错误边到边交给 onChunk。
   * 与 exec/run 的差别只在于不缓冲整段输出，长任务不会撑爆响应体上限。
   */
  function streamRun(argv, opts) {
    return waitSession().then(function (tok) {
      var init = { method: 'POST', headers: {} };
      if (tok) init.headers['X-Qx-Session'] = tok;
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify({
        host: opts.host || '',
        argv: argv,
        timeout: opts.timeout || 120,
        elevated: !!opts.elevated
      });
      if (opts.signal) init.signal = opts.signal;
      if (opts.stdin) init.body = JSON.stringify({
        host: opts.host || '',
        argv: argv,
        stdin: opts.stdin,
        timeout: opts.timeout || 120,
        elevated: !!opts.elevated
      });
      return fetch(API_BASE + '/exec/stream', init).then(function (res) {
        if (!res.ok) {
          return errorFrom(res).then(function (err) { throw err; });
        }
        if (!res.body || typeof res.body.getReader !== 'function') {
          return res.text().then(function (text) {
            if (opts.onChunk) opts.onChunk(text);
            return { ok: true };
          });
        }
        var reader = res.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var pump = function () {
          return reader.read().then(function (step) {
            if (step.done) return { ok: true };
            var text = decoder.decode(step.value, { stream: true });
            if (text && opts.onChunk) opts.onChunk(text);
            return pump();
          });
        };
        return pump();
      });
    });
  }

  /** 放弃缓存的提权状态 */
  function forgetElevation(host) {
    if (host) delete elevHosts[host];
    else elevHosts = Object.create(null);
  }

  /* ------------------------- 文件通道 ------------------------- */

  /** 列远端目录（server:read） */
  function listFiles(path, elevated) {
    return sysGet('files/list', { host: bridge.hostId, path: path, elevated: !!elevated });
  }

  /** 读取远端文本文件内容：先经 exec 取（无需 SFTP 会话），失败再退回下载通道 */
  function readRemoteText(path, opts) {
    opts = opts || {};
    var cmd = ['sh', '-c', 'test -f ' + shellQuote(path) + ' && cat -- ' + shellQuote(path) + ' || echo __PM_NOFILE__'];
    return execRead(cmd, { host: opts.host, timeout: opts.timeout || 25 }).then(function (r) {
      if (r.ok && r.out.indexOf('__PM_NOFILE__') < 0) return r;
      return r;
    });
  }

  /** 配置文件下载地址（server:download）：供界面导出备份用 */
  function downloadUrl(path) {
    var q = 'host=' + encodeURIComponent(bridge.hostId) + '&path=' + encodeURIComponent(path);
    if (bridge.session) q += '&session=' + encodeURIComponent(bridge.session);
    return API_BASE + '/files/download?' + q;
  }

  /** 上传文件到远端目录（server:upload） */
  function uploadFile(destDir, file) {
    var fd = new FormData();
    fd.append('file', file);
    return waitSession().then(function (tok) {
      var headers = {};
      if (tok) headers['X-Qx-Session'] = tok;
      var q = 'host=' + encodeURIComponent(bridge.hostId) + '&path=' + encodeURIComponent(destDir);
      return fetch(API_BASE + '/files/upload?' + q, { method: 'POST', headers: headers, body: fd })
        .then(function (res) {
          if (res.ok) return readJson(res);
          return errorFrom(res).then(function (err) { throw err; });
        });
    });
  }

  /* ================================================================== *
   * 三、输入守卫
   * ================================================================== */

  /**
   * POSIX 单引号转义：整个参数包进单引号，内部的单引号写成 '\''。
   * 含 NUL、换行、回车一律拒绝——这些字符没有任何合法用途，只会被用来断开命令。
   */
  function shellQuote(value) {
    var s = String(value == null ? '' : value);
    if (s.indexOf('\u0000') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
      throw new Error('参数包含控制字符，已拒绝');
    }
    return "'" + s.split("'").join("'\\''") + "'";
  }

  var RE = {
    /** 域名：小写字母、数字、点、连字符，禁止下划线与前后导连字符 */
    domain: /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/,
    /** 版本号：只允许数字与点，如 7.4、8.3、8.3.12 */
    version: /^[0-9]{1,2}(\.[0-9]{1,2}){0,2}$/,
    /** 宝塔的 PHP 目录短名，如 74、80、803 */
    phpShort: /^[0-9]{2,3}$/,
    /** 允许修改的 php.ini 指令（白名单，不接受任意键名） */
    iniKey: /^(memory_limit|upload_max_filesize|max_execution_time|post_max_size)$/,
    /** 配置值：字母数字点下划线连字符 */
    iniValue: /^[A-Za-z0-9._-]{1,32}$/,
    /** 站点标识（配置文件名去掉扩展名） */
    siteId: /^[A-Za-z0-9._-]{1,96}$/
  };

  function bad(error) { return { ok: false, error: error }; }
  function good(value) { return { ok: true, value: value }; }

  function checkDomain(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return bad('域名不能为空');
    if (s.length > 253) return bad('域名过长');
    if (/\.\./.test(s) || s.charAt(0) === '.' || s.charAt(s.length - 1) === '.') return bad('域名格式不合法');
    if (!RE.domain.test(s)) return bad('域名只允许小写字母、数字、点与连字符');
    return good(s);
  }

  function checkVersion(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return bad('版本号不能为空');
    if (!RE.version.test(s)) return bad('版本号只允许数字与点，如 7.4 或 8.3');
    return good(s);
  }

  function checkPhpShort(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!RE.phpShort.test(s)) return bad('PHP 版本标识只允许 2 到 3 位数字');
    return good(s);
  }

  function checkSiteId(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return bad('站点标识不能为空');
    if (!RE.siteId.test(s)) return bad('站点标识只允许字母、数字、点、下划线与连字符');
    return good(s);
  }

  function checkIniKey(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!RE.iniKey.test(s)) return bad('只允许修改 memory_limit、upload_max_filesize、max_execution_time、post_max_size');
    return good(s);
  }

  /**
   * 配置值校验：先过通用字符集，再按指令收紧。
   * - max_execution_time 必须是纯秒数；
   * - 三个容量类指令必须是数字加可选 K/M/G。
   */
  function checkIniValue(key, raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return bad('配置值不能为空');
    if (!RE.iniValue.test(s)) return bad('配置值只允许字母、数字、点、下划线、连字符');
    if (key === 'max_execution_time') {
      if (!/^[0-9]{1,6}$/.test(s)) return bad('max_execution_time 必须是 0 到 999999 之间的整数秒');
      return good(s);
    }
    if (!/^[0-9]{1,6}[KMG]?$/.test(s)) return bad(key + ' 必须是数字加可选的 K/M/G 单位，例如 256M');
    return good(s);
  }

  function checkPath(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return bad('路径不能为空');
    if (s.length > 512) return bad('路径过长');
    if (/[\u0000\n\r]/.test(s)) return bad('路径包含控制字符');
    if (s.charAt(0) !== '/') return bad('必须是绝对路径');
    if (s.indexOf('..') >= 0) return bad('路径不允许包含 ..');
    return good(s);
  }

  /** 批量校验，任一失败即整体失败 */
  function checkAll(rules) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!r.ok) return r;
    }
    return good(null);
  }

  /* ================================================================== *
   * 四、工具
   * ================================================================== */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function nowStamp() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function nowFull() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' '
      + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /** 建 DOM 节点：el('div', { class: 'x', text: 'y' }, [child]) */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'text') node.textContent = String(v);
        else if (k === 'class') node.className = String(v);
        else if (k === 'html') node.innerHTML = String(v);
        else if (k === 'dataset') {
          for (var dk in v) {
            if (Object.prototype.hasOwnProperty.call(v, dk)) node.dataset[dk] = String(v[dk]);
          }
        } else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else node.setAttribute(k, String(v));
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function clear(node) {
    if (!node) return node;
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  PM.core = {
    bridge: bridge,
    onReady: onReady,
    requestPerm: requestPerm,
    hostCall: hostCall,
    sysFetch: sysFetch,
    sysGet: sysGet,
    sysCall: sysCall,
    execOnce: execOnce,
    execRead: execRead,
    execWrite: execWrite,
    execStream: streamRun,
    streamRun: streamRun,
    requestSudoElevation: requestSudoElevation,
    forgetElevation: forgetElevation,
    listFiles: listFiles,
    readRemoteText: readRemoteText,
    downloadUrl: downloadUrl,
    uploadFile: uploadFile,
    guard: {
      RE: RE,
      checkDomain: checkDomain,
      checkVersion: checkVersion,
      checkPhpShort: checkPhpShort,
      checkSiteId: checkSiteId,
      checkIniKey: checkIniKey,
      checkIniValue: checkIniValue,
      checkPath: checkPath,
      checkAll: checkAll
    },
    shellQuote: shellQuote,
    util: {
      el: el,
      clear: clear,
      nowStamp: nowStamp,
      nowFull: nowFull
    }
  };
})();
