/**
 * probe.js —— 只读探测层
 *
 * 负责三件事：
 *  1. 识别被管主机上装的是宝塔、1Panel、两者都装，还是都没装；
 *  2. 列出 PHP 版本及其 FPM 运行状态与配置路径；
 *  3. 解析站点清单（域名、根目录、PHP 版本、证书到期）。
 *
 * 全部通过 exec/run 下发只读命令（argv 数组，宿主逐项转义），不做任何写操作。
 */
(function () {
  'use strict';

  var PM = (window.PM = window.PM || {});
  var core = PM.core;

  /* ================================================================== *
   * 常量：两套面板各自的固定路径
   * ================================================================== */

  var BAOTA = {
    dir: '/www/server/panel',
    portFile: '/www/server/panel/data/port.pl',
    entryFile: '/www/server/panel/data/admin_path.pl',
    versionFile: '/www/server/panel/data/version.pl',
    phpRoot: '/www/server/php',
    vhostDir: '/www/server/panel/vhost/nginx',
    certDir: '/www/server/panel/vhost/cert',
    nginxBin: '/www/server/nginx/sbin/nginx'
  };

  var ONEPANEL = {
    dir: '/opt/1panel',
    confFile: '/opt/1panel/conf/app.yaml',
    phpRoot: '/opt/1panel/apps/php',
    siteConfDirs: [
      '/opt/1panel/apps/openresty/openresty/conf/conf.d',
      '/opt/1panel/apps/nginx/nginx/conf/conf.d',
      '/opt/1panel/www/conf.d'
    ],
    siteRoot: '/opt/1panel/www/sites'
  };

  /** 探测脚本输出的行前缀 */
  var TAG = 'PM';

  function scriptPrelude() {
    return 'p(){ printf "' + TAG + '_%s=%s\\n" "$1" "$2"; }; ';
  }

  /* ================================================================== *
   * 一、环境识别
   * ================================================================== */

  /**
   * 探测面板与服务。一次往返拿全部信息，避免逐项探测造成的等待。
   * @param {string} host 目标主机（空串表示宿主本机）
   * @returns {Promise<{ok:boolean, error:string, env:object}>}
   */
  function probeEnvironment(host) {
    var script = [
      'p UNAME "$(uname -s 2>/dev/null | tr -d \'\\n\')"',
      'p UID "$(id -u 2>/dev/null | tr -d \'\\n\')"',
      'p WHOMI "$(id -un 2>/dev/null | tr -d \'\\n\')"',
      'if [ -d ' + BAOTA.dir + ' ]; then p BT_DIR 1; else p BT_DIR 0; fi',
      'if command -v bt >/dev/null 2>&1; then p BT_CLI 1; else p BT_CLI 0; fi',
      'p BT_PORT "$(cat ' + BAOTA.portFile + ' 2>/dev/null | tr -dc \'0-9\' | head -c 6)"',
      'p BT_ENTRY "$(cat ' + BAOTA.entryFile + ' 2>/dev/null | tr -d \' \\t\\r\\n\' | head -c 96)"',
      'p BT_VER "$(cat ' + BAOTA.versionFile + ' 2>/dev/null | tr -d \' \\t\\r\\n\' | head -c 32)"',
      'if [ -d ' + ONEPANEL.dir + ' ]; then p OP_DIR 1; else p OP_DIR 0; fi',
      'if command -v 1pctl >/dev/null 2>&1; then p OP_CLI 1; else p OP_CLI 0; fi',
      'if [ -r ' + ONEPANEL.confFile + ' ]; then p OP_CONF 1; else p OP_CONF 0; fi',
      'p OP_PORTS "$(grep -Eoi \'[a-z_]*port[a-z_]*[[:space:]]*:[[:space:]]*[0-9]+\' ' + ONEPANEL.confFile + ' 2>/dev/null | grep -Eo \'[0-9]+\' | head -4 | tr \'\\n\' \',\')"',
      'if command -v systemctl >/dev/null 2>&1; then p SVC_CTL 1; else p SVC_CTL 0; fi',
      'p BT_RUN "$(systemctl is-active bt 2>/dev/null | tr -d \'\\n\')"',
      'p OP_RUN "$(systemctl is-active 1panel 2>/dev/null | tr -d \'\\n\')"',
      'p NGINX_RUN "$(systemctl is-active nginx 2>/dev/null | tr -d \'\\n\')$(systemctl is-active openresty 2>/dev/null | tr -d \'\\n\')"',
      'for f in ' + BAOTA.nginxBin + ' /usr/local/nginx/sbin/nginx /usr/sbin/nginx /usr/bin/nginx; do if [ -x "$f" ]; then p NGINX_BIN "$f"; break; fi; done',
      'if command -v docker >/dev/null 2>&1; then p DOCKER 1; else p DOCKER 0; fi',
      'if command -v openssl >/dev/null 2>&1; then p OPENSSL 1; else p OPENSSL 0; fi',
      'for f in /root/.acme.sh/acme.sh /www/server/panel/plugin/acme/acme.sh; do if [ -x "$f" ]; then p ACME "$f"; break; fi; done'
    ].join('; ');

    var argv = ['sh', '-c', scriptPrelude() + script];

    return core.execRead(argv, { host: host, timeout: 30 }).then(function (r) {
      if (!r.ok && !r.out) {
        return { ok: false, error: r.err || '无法执行探测命令', env: null };
      }
      var kv = parseKeyed(String(r.out || ''));
      return { ok: true, error: '', env: buildEnv(kv, r) };
    });
  }

  /** 解析 PM_KEY=VALUE 行 */
  function parseKeyed(text) {
    var out = {};
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\r$/, '');
      var idx = line.indexOf('=');
      if (idx < 0) continue;
      if (line.slice(0, TAG.length + 1) !== TAG + '_') continue;
      var key = line.slice(TAG.length + 1, idx);
      var value = line.slice(idx + 1).trim();
      if (!Object.prototype.hasOwnProperty.call(out, key) || value !== '') out[key] = value;
    }
    return out;
  }

  function truthy(v) { return v === '1' || v === 'true' || v === 'yes'; }

  function buildEnv(kv, raw) {
    var btPresent = truthy(kv.BT_DIR);
    var opPresent = truthy(kv.OP_DIR);
    var kind = 'none';
    if (btPresent && opPresent) kind = 'both';
    else if (btPresent) kind = 'baota';
    else if (opPresent) kind = '1panel';

    var uid = Number(kv.UID || -1);
    var ports = String(kv.OP_PORTS || '').split(',').filter(Boolean);

    return {
      kind: kind,
      raw: raw,
      os: {
        uname: kv.UNAME || '',
        uid: uid,
        user: kv.WHOMI || '',
        isRoot: uid === 0
      },
      hasSystemctl: truthy(kv.SVC_CTL),
      hasDocker: truthy(kv.DOCKER),
      hasOpenssl: truthy(kv.OPENSSL),
      nginxBin: kv.NGINX_BIN || '',
      nginxRunning: /active/.test(kv.NGINX_RUN || ''),
      acmePath: kv.ACME || '',
      baota: {
        present: btPresent,
        cli: truthy(kv.BT_CLI),
        dir: BAOTA.dir,
        port: kv.BT_PORT || '',
        entry: kv.BT_ENTRY || '',
        version: kv.BT_VER || '',
        running: /active|unknown/.test(kv.BT_RUN || ''),
        phpRoot: BAOTA.phpRoot,
        vhostDir: BAOTA.vhostDir
      },
      onepanel: {
        present: opPresent,
        cli: truthy(kv.OP_CLI),
        dir: ONEPANEL.dir,
        conf: truthy(kv.OP_CONF),
        version: kv.OP_VER || '',
        ports: ports,
        running: /active|unknown/.test(kv.OP_RUN || ''),
        phpRoot: ONEPANEL.phpRoot,
        siteConfDirs: ONEPANEL.siteConfDirs
      }
    };
  }

  /* ================================================================== *
   * 二、PHP 版本与 FPM 状态
   * ================================================================== */

  /**
   * 宝塔：/www/server/php 下每个数字目录是一个版本，
   * FPM 主进程由启动参数里的配置路径识别，pid 为空即视为未运行。
   */
  function probePhpBaota(host) {
    var script = [
      'root=' + BAOTA.phpRoot,
      '[ -d "$root" ] || { echo PM_NO_PHP; exit 0; }',
      'for d in "$root"/*; do',
      '  [ -d "$d" ] || continue',
      '  v=$(basename "$d")',
      '  case "$v" in *[!0-9]*) continue;; esac',
      '  conf="$d/etc/php-fpm.conf"',
      '  ini="$d/etc/php.ini"',
      '  pid=$(ps -eo pid,args 2>/dev/null | grep -F "php-fpm: master process ($conf)" | grep -v grep | awk \'NR==1{print $1}\')',
      '  printf "PHP|%s|%s|%s|%s\\n" "$v" "$pid" "$conf" "$ini"',
      'done',
      'for s in /etc/init.d/php-fpm-*; do [ -x "$s" ] && printf "INIT|%s\\n" "$s"; done'
    ].join('\n');

    return core.execRead(['sh', '-c', script], { host: host, timeout: 30 }).then(function (r) {
      return { ok: r.ok, error: r.ok ? '' : r.err, versions: parsePhpLines(r.out, 'baota') };
    });
  }

  /** 1Panel：PHP 以容器运行时为主，兼容少见的目录安装方式 */
  function probePhp1Panel(host) {
    var script = [
      'for d in ' + ONEPANEL.phpRoot + '/*; do',
      '  [ -d "$d" ] || continue',
      '  v=$(basename "$d")',
      '  printf "PHPDIR|%s|%s\\n" "$v" "$d"',
      'done',
      'if command -v docker >/dev/null 2>&1; then',
      '  docker ps --format "{{.Names}}|{{.Status}}|{{.Image}}" 2>/dev/null | grep -i php | while IFS="|" read -r n s i; do',
      '    printf "PHPDOCKER|%s|%s|%s\\n" "$n" "$s" "$i"',
      '  done',
      'fi'
    ].join('\n');

    return core.execRead(['sh', '-c', script], { host: host, timeout: 40 }).then(function (r) {
      return { ok: r.ok, error: r.ok ? '' : r.err, versions: parsePhpLines(r.out, '1panel') };
    });
  }

  function parsePhpLines(text) {
    var out = [];
    var lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\r$/, '');
      if (line.indexOf('PHP|') === 0) {
        var p = line.split('|');
        out.push({
          source: 'baota',
          short: p[1] || '',
          version: shortToVersion(p[1] || ''),
          pid: p[2] || '',
          running: !!p[2],
          fpmConf: p[3] || '',
          iniPath: p[4] || '',
          container: '',
          label: ''
        });
      } else if (line.indexOf('PHPDOCKER|') === 0) {
        var q = line.split('|');
        var name = q[1] || '';
        var status = q[2] || '';
        var image = q[3] || '';
        out.push({
          source: '1panel',
          short: '',
          version: versionFromName(name + ' ' + image),
          pid: '',
          running: /up/i.test(status),
          fpmConf: '',
          iniPath: '',
          container: name,
          status: status,
          image: image,
          label: name
        });
      } else if (line.indexOf('PHPDIR|') === 0) {
        var d = line.split('|');
        out.push({
          source: '1panel',
          short: d[1] || '',
          version: shortToVersion(d[1] || ''),
          pid: '',
          running: false,
          fpmConf: (d[2] || '') + '/conf/php-fpm.conf',
          iniPath: (d[2] || '') + '/conf/php.ini',
          container: '',
          label: d[1] || ''
        });
      }
    }
    out.sort(function (a, b) { return cmpVersion(a.version, b.version); });
    return out;
  }

  /** 宝塔目录名转版本号：74 → 7.4，803 → 8.03 */
  function shortToVersion(short) {
    var s = String(short || '').replace(/[^0-9]/g, '');
    if (s.length === 2) return s.charAt(0) + '.' + s.charAt(1);
    if (s.length === 3) return s.charAt(0) + '.' + s.slice(1);
    if (s.length === 4) return s.slice(0, 2) + '.' + s.slice(2);
    return s;
  }

  /** 从容器名或镜像名里抽版本：php8.2 / 1panel-php-83 / php:8.2-fpm */
  function versionFromName(text) {
    var s = String(text || '');
    var m = /php[^0-9]{0,4}([78])[._:-]?([0-9])(?![0-9])/i.exec(s);
    if (m) return m[1] + '.' + m[2];
    var m2 = /([78])\.([0-9])/.exec(s);
    if (m2) return m2[1] + '.' + m2[2];
    return '';
  }

  function cmpVersion(a, b) {
    var pa = String(a || '').split('.').map(Number);
    var pb = String(b || '').split('.').map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0;
      var y = pb[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  /* ================================================================== *
   * 三、站点清单
   * ================================================================== */

  /**
   * 宝塔站点：直接读 vhost/nginx 下的配置文件。
   * 拿到的是 nginx 实际加载的内容，比读面板数据库更贴近真实生效状态。
   */
  function probeSitesBaota(host) {
    var script = [
      'dir=' + BAOTA.vhostDir,
      '[ -d "$dir" ] || { echo PM_NO_VHOST; exit 0; }',
      'for f in "$dir"/*; do',
      '  [ -f "$f" ] || continue',
      '  case "$f" in',
      '    *.conf.disabled) printf "SITEFILE|%s|1\\n" "$f";;',
      '    *.conf) printf "SITEFILE|%s|0\\n" "$f";;',
      '    *) continue;;',
      '  esac',
      '  sed -e "s/\\r$//" "$f" 2>/dev/null',
      '  printf "ENDSITE\\n"',
      'done'
    ].join('\n');

    return core.execRead(['sh', '-c', script], { host: host, timeout: 30 }).then(function (r) {
      return { ok: r.ok, error: r.ok ? '' : r.err, sites: parseSiteBlocks(r.out, 'baota') };
    });
  }

  /** 1Panel 站点：遍历候选 conf.d 目录 */
  function probeSites1Panel(host) {
    var dirs = ONEPANEL.siteConfDirs.map(function (d) { return '"' + d + '"'; }).join(' ');
    var script = [
      'for dir in ' + dirs + '; do',
      '  [ -d "$dir" ] || continue',
      '  for f in "$dir"/*; do',
      '    [ -f "$f" ] || continue',
      '    case "$f" in',
      '      *.conf.disabled) printf "SITEFILE|%s|1\\n" "$f";;',
      '      *.conf) printf "SITEFILE|%s|0\\n" "$f";;',
      '      *) continue;;',
      '    esac',
      '    sed -e "s/\\r$//" "$f" 2>/dev/null',
      '    printf "ENDSITE\\n"',
      '  done',
      'done'
    ].join('\n');

    return core.execRead(['sh', '-c', script], { host: host, timeout: 30 }).then(function (r) {
      return { ok: r.ok, error: r.ok ? '' : r.err, sites: parseSiteBlocks(r.out, '1panel') };
    });
  }

  /** 把 SITEFILE / ENDSITE 包起来的文本切成一条条站点记录 */
  function parseSiteBlocks(text, panelKind) {
    var sites = [];
    var lines = String(text || '').split('\n');
    var cur = null;
    var body = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\r$/, '');
      if (line.indexOf('SITEFILE|') === 0) {
        var p = line.split('|');
        cur = { path: p[1] || '', disabled: p[2] === '1' };
        body = [];
        continue;
      }
      if (line === 'ENDSITE') {
        if (cur) sites.push(makeSite(cur, parseNginxConf(body.join('\n')), panelKind));
        cur = null;
        body = [];
        continue;
      }
      if (cur) body.push(line);
    }
    sites.sort(function (a, b) { return String(a.primary).localeCompare(String(b.primary)); });
    return sites;
  }

  function baseName(p) {
    var s = String(p || '');
    var i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function makeSite(meta, parsed, panelKind) {
    var file = baseName(meta.path);
    var id = file.replace(/\.conf(\.disabled)?$/, '');
    var primary = parsed.serverNames[0] || id;
    return {
      id: id,
      panel: panelKind,
      path: meta.path,
      disabled: meta.disabled,
      domains: parsed.serverNames.length ? parsed.serverNames : [id],
      primary: primary,
      root: parsed.roots[0] || '',
      roots: parsed.roots,
      phpShort: parsed.phpShort,
      phpVersion: parsed.phpShort ? shortToVersion(parsed.phpShort) : '',
      certPath: parsed.certs[0] || '',
      listen: parsed.listens.join(' '),
      ssl: parsed.certs.length > 0 || parsed.listens.some(function (l) { return /443/.test(l); }),
      cert: null
    };
  }

  /** 从 nginx 配置文本里抽取关心的指令 */
  function parseNginxConf(text) {
    var out = { serverNames: [], roots: [], phpShort: '', certs: [], listens: [] };
    var lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var hash = raw.indexOf('#');
      var line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
      if (!line) continue;

      var m = /^server_name\s+([^;]+);/.exec(line);
      if (m) {
        var names = m[1].trim().split(/\s+/);
        for (var k = 0; k < names.length; k++) {
          var n = names[k];
          if (!n || n === '_' || n.charAt(0) === '~' || n.indexOf('$') >= 0) continue;
          if (out.serverNames.indexOf(n) < 0) out.serverNames.push(n);
        }
        continue;
      }

      var mr = /^root\s+([^;]+);/.exec(line);
      if (mr) {
        var root = mr[1].trim().replace(/^["']|["']$/g, '');
        if (root && out.roots.indexOf(root) < 0) out.roots.push(root);
        continue;
      }

      var mp = /^include\s+.*enable-php-([0-9]{2,3})\.conf\s*;?\s*$/.exec(line);
      if (mp) {
        if (!out.phpShort) out.phpShort = mp[1];
        continue;
      }

      var mc = /^ssl_certificate\s+([^;]+);/.exec(line);
      if (mc) {
        var cert = mc[1].trim().replace(/^["']|["']$/g, '');
        if (cert && out.certs.indexOf(cert) < 0) out.certs.push(cert);
        continue;
      }

      var ml = /^listen\s+([^;]+);/.exec(line);
      if (ml) out.listens.push(ml[1].trim());
    }
    return out;
  }

  /* ================================================================== *
   * 四、证书到期
   * ================================================================== */

  /**
   * 批量读取证书到期时间。一次往返覆盖所有站点，避免每个站点各跑一次 openssl。
   * @param {string} host
   * @param {string[]} paths 证书绝对路径列表
   */
  function probeCerts(host, paths) {
    var list = (paths || []).filter(Boolean);
    if (!list.length) return Promise.resolve({ ok: true, certs: {} });

    var quoted = list.map(function (p) {
      return '"' + String(p).replace(/["$\x60\\]/g, '') + '"';
    }).join(' ');
    var script = [
      'for f in ' + quoted + '; do',
      '  if [ -r "$f" ]; then',
      '    end=$(openssl x509 -in "$f" -noout -enddate 2>/dev/null | sed -e "s/^notAfter=//" -e "s/\\r$//")',
      '    printf "CERT|%s|%s\\n" "$f" "$end"',
      '  else',
      '    printf "CERT|%s|MISSING\\n" "$f"',
      '  fi',
      'done'
    ].join('\n');

    return core.execRead(['sh', '-c', script], { host: host, timeout: 40 }).then(function (r) {
      var out = {};
      var lines = String(r.out || '').split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\r$/, '');
        if (line.indexOf('CERT|') !== 0) continue;
        var p = line.split('|');
        var path = p[1] || '';
        var endText = p[2] || '';
        out[path] = {
          ok: endText !== 'MISSING' && !!endText,
          missing: endText === 'MISSING',
          endText: endText,
          endDate: parseCertDate(endText)
        };
      }
      return { ok: r.ok, error: r.ok ? '' : r.err, certs: out };
    });
  }

  /** 解析 openssl 的 "Mar  1 12:00:00 2027 GMT" 时间串 */
  function parseCertDate(text) {
    var s = String(text || '').trim();
    if (!s) return null;
    var months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    var m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})/.exec(s);
    if (m && months[m[1]] !== undefined) {
      return new Date(Date.UTC(Number(m[6]), months[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])));
    }
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  /** 距到期还有多少天（负数表示已过期） */
  function daysUntil(date) {
    if (!date) return null;
    return Math.floor((date.getTime() - Date.now()) / 86400000);
  }

  /* ================================================================== *
   * 五、主机信息
   * ================================================================== */

  /** 取当前目标主机的地址与名称，用于拼面板入口链接（hosts:read） */
  function probeHostInfo() {
    return core.sysGet('hosts/list').then(function (r) {
      var list = (r && Array.isArray(r.hosts)) ? r.hosts : [];
      var id = core.bridge.hostId;
      if (!id) return { local: true, id: '', name: '本机', address: '', user: '' };
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) {
          return {
            local: false,
            id: id,
            name: list[i].name || list[i].address || id,
            address: list[i].address || '',
            user: list[i].user || ''
          };
        }
      }
      return { local: false, id: id, name: id, address: '', user: '' };
    }, function () {
      return { local: !core.bridge.hostId, id: core.bridge.hostId, name: core.bridge.hostId || '本机', address: '', user: '' };
    });
  }

  /* ================================================================== *
   * 六、面板命令行自检
   * ================================================================== */

  /**
   * 只读地调用面板自己的命令行，用于确认真实的面板地址与版本。
   *
   * 宝塔的 bt 是交互式菜单，没有终端时会一直等待输入而挂住，因此这里统一：
   *  - 用 timeout 包住，超时即返回；
   *  - 把 stdin 重定向到 /dev/null，让它读不到输入立刻走默认分支；
   *  - 用管道接到 head，避免输出过长占满缓冲区。
   *
   * @param {string} host
   * @param {object} env
   */
  function probePanelCli(host, env) {
    var cmds = [];
    if (env && env.baota && env.baota.present) {
      cmds.push({ label: 'bt default', script: 'timeout 15 bt default </dev/null 2>&1 | head -40' });
    }
    if (env && env.onepanel && env.onepanel.present) {
      cmds.push({ label: '1pctl user-info', script: 'timeout 10 1pctl user-info </dev/null 2>&1 | head -30' });
      cmds.push({ label: '1pctl version', script: 'timeout 10 1pctl version </dev/null 2>&1 | head -10' });
    }
    if (!cmds.length) {
      return Promise.resolve({ ok: false, error: '当前主机上没有可调用的面板命令行', results: [] });
    }

    var jobs = cmds.map(function (c) {
      return core.execRead(['sh', '-c', c.script], { host: host, timeout: 40 }).then(function (r) {
        return { label: c.label, command: 'timeout ... ' + c.label, out: r.out || '', err: r.err || '', ok: r.ok };
      }, function (e) {
        return { label: c.label, command: c.label, out: '', err: (e && e.message) || String(e), ok: false };
      });
    });

    return Promise.all(jobs).then(function (results) {
      return { ok: true, results: results };
    });
  }

  PM.probe = {
    BAOTA: BAOTA,
    ONEPANEL: ONEPANEL,
    probeEnvironment: probeEnvironment,
    probePhpBaota: probePhpBaota,
    probePhp1Panel: probePhp1Panel,
    probeSitesBaota: probeSitesBaota,
    probeSites1Panel: probeSites1Panel,
    probeCerts: probeCerts,
    probeHostInfo: probeHostInfo,
    probePanelCli: probePanelCli,
    parseNginxConf: parseNginxConf,
    parseKeyed: parseKeyed,
    shortToVersion: shortToVersion,
    versionFromName: versionFromName,
    cmpVersion: cmpVersion,
    parseCertDate: parseCertDate,
    daysUntil: daysUntil,
    baseName: baseName
  };
})();
