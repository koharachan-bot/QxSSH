/**
 * actions.js —— 写操作层
 *
 * 设计原则：
 *  1. 每个操作先"构造"出一个 spec（含要执行的脚本原文、影响说明与风险等级），
 *     界面拿 spec 弹二次确认框，用户看到的就是即将执行的确切命令；
 *  2. 所有可变参数都来自调用方已通过白名单校验的值，路径再经单引号转义；
 *  3. 破坏性操作自带备份与失败回滚，执行后回读校验。
 *
 * 权限：写操作走 exec:run 并声明 elevated，宿主在需要时会触发 sudo:request 流程。
 */
(function () {
  'use strict';

  var PM = (window.PM = window.PM || {});
  var core = PM.core;
  var guard = core.guard;
  var shq = core.shellQuote;

  var BAOTA = PM.probe.BAOTA;
  var ONEPANEL = PM.probe.ONEPANEL;

  /** 执行记录，供"执行记录"视图展示 */
  var log = [];
  var MAX_LOG = 200;

  function pushLog(entry) {
    log.unshift(entry);
    if (log.length > MAX_LOG) log.length = MAX_LOG;
  }

  function getLog() { return log; }
  function clearLog() { log.length = 0; }

  function fail(error) { return { ok: false, error: error }; }
  function spec(title, summary, script, risk, extra) {
    var out = {
      title: title,
      summary: summary,
      argv: ['sh', '-c', script],
      preview: script,
      risk: risk || 'normal'
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
      }
    }
    return { ok: true, spec: out };
  }

  /* ================================================================== *
   * 一、站点 PHP 版本切换
   * ================================================================== */

  /**
   * 把站点配置里的 include enable-php-XX.conf 换成目标版本。
   * 宝塔与 1Panel 的 vhost conf 都是同一套 nginx 语法，因此共用一段脚本。
   * @param {object} site 站点记录（path 来自探测，仍需校验）
   * @param {string} targetShort 目标版本短名，如 83
   * @param {object} env 环境信息
   */
  function buildSwitchPhp(site, targetShort, env) {
    var chkPath = guard.checkPath(site && site.path);
    if (!chkPath.ok) return chkPath;
    var chkVer = guard.checkPhpShort(targetShort);
    if (!chkVer.ok) return chkVer;

    var conf = chkPath.value;
    var nginx = env && env.nginxBin ? env.nginxBin : BAOTA.nginxBin;
    var target = 'enable-php-' + chkVer.value + '.conf';

    var sedExpr = 's|^[[:space:]]*include[[:space:]]+enable-php-[0-9]{2,3}\\.conf;|include ' + target + ';|';

    var script = [
      'set -u',
      'conf=' + shq(conf),
      'nginx=' + shq(nginx),
      'bak="$conf.pm-bak.$$"',
      'if [ ! -f "$conf" ]; then echo "配置文件不存在：$conf"; exit 10; fi',
      'if ! cp -a "$conf" "$bak" 2>/dev/null; then echo "无法备份配置文件，已中止"; exit 11; fi',
      'if ! sed -i -E ' + shq(sedExpr) + ' "$conf"; then',
      '  cp -a "$bak" "$conf"; rm -f "$bak"',
      '  echo "改写配置失败，已还原"; exit 12',
      'fi',
      'if ! grep -qF ' + shq('include ' + target + ';') + ' "$conf"; then',
      '  cp -a "$bak" "$conf"; rm -f "$bak"',
      '  echo "配置中未找到 enable-php 引用，未做改动"; exit 13',
      'fi',
      'if ! "$nginx" -t 2>&1; then',
      '  cp -a "$bak" "$conf"; rm -f "$bak"',
      '  echo "nginx 配置检查未通过，已还原原文件"; exit 14',
      'fi',
      'rm -f "$bak"',
      '"$nginx" -s reload 2>&1 || { echo "nginx 重载失败"; exit 15; }',
      'echo "已切换为 PHP ' + chkVer.value + ' 并重载 nginx"'
    ].join('\n');

    return spec(
      '切换站点 PHP 版本',
      '将 ' + (site.primary || site.id) + ' 的 PHP 版本切换为 ' + PM.probe.shortToVersion(chkVer.value),
      script,
      'warn',
      { timeout: 60, siteId: site.id, kind: 'switch-php' }
    );
  }

  /* ================================================================== *
   * 二、PHP-FPM 重载 / 重启
   * ================================================================== */

  /**
   * @param {object} php 版本记录
   * @param {'reload'|'restart'} mode
   * @param {object} env
   */
  function buildFpmAction(php, mode, env) {
    if (!php) return fail('未指定 PHP 版本');
    var action = mode === 'restart' ? 'restart' : 'reload';
    var script;

    if (php.source === '1panel' && php.container) {
      var name = guard.checkSiteId(php.container);
      if (!name.ok) return name;
      if (!env || !env.hasDocker) return fail('1Panel 的 PHP 以容器运行，但目标主机上没有可用的 docker 命令');
      // 容器内 php-fpm 的平滑重载用 USR2，重启交给容器运行时；对外暴露的语义都是"让配置生效"
      script = action === 'reload'
        ? [
          'docker exec ' + shq(name.value) + ' sh -c \'kill -USR2 1\' 2>&1',
          'echo "已向容器 ' + name.value + ' 发送 USR2（平滑重载）"'
        ].join('\n')
        : [
          'docker restart ' + shq(name.value) + ' 2>&1',
          'echo "已重启容器 ' + name.value + '"'
        ].join('\n');
    } else if (php.source === 'baota') {
      var short = guard.checkPhpShort(php.short);
      if (!short.ok) return short;
      var conf = guard.checkPath(php.fpmConf || (BAOTA.phpRoot + '/' + short.value + '/etc/php-fpm.conf'));
      if (!conf.ok) return conf;
      var init = '/etc/init.d/php-fpm-' + short.value;

      script = [
        'set -u',
        'init=' + shq(init),
        'conf=' + shq(conf.value),
        'if [ -x "$init" ]; then',
        '  "$init" ' + action + ' 2>&1 && { echo "已通过 $init ' + action + '"; exit 0; }',
        'fi'
      ].join('\n');

      if (action === 'reload') {
        script += '\n' + [
          'pid=$(ps -eo pid,args 2>/dev/null | grep -F "php-fpm: master process ($conf)" | grep -v grep | awk \'NR==1{print $1}\')',
          'if [ -z "$pid" ]; then echo "未找到 PHP-FPM 主进程，请检查该版本是否已启动"; exit 20; fi',
          'kill -USR2 "$pid" 2>&1 || { echo "发送 USR2 失败"; exit 21; }',
          'echo "已向主进程 $pid 发送 USR2（平滑重载）"'
        ].join('\n');
      } else {
        script += '\n' + [
          'echo "未找到 init 脚本，无法安全重启；请先在面板中确认该版本的服务管理方式"',
          'exit 22'
        ].join('\n');
      }
    } else {
      return fail('该 PHP 版本没有可用的服务管理方式');
    }

    return spec(
      (action === 'restart' ? '重启' : '重载') + ' PHP-FPM',
      'PHP ' + (php.version || php.label || php.short) + '：' + (action === 'restart' ? '重启' : '平滑重载') + '进程',
      script,
      action === 'restart' ? 'danger' : 'warn',
      { timeout: 90, kind: 'fpm-' + action }
    );
  }

  /* ================================================================== *
   * 三、nginx 重载 / 重启
   * ================================================================== */

  function buildNginxAction(mode, env) {
    var nginx = env && env.nginxBin ? env.nginxBin : BAOTA.nginxBin;
    var action = mode === 'restart' ? 'restart' : 'reload';
    var script;

    if (action === 'reload') {
      script = [
        'set -u',
        'nginx=' + shq(nginx),
        'if [ ! -x "$nginx" ]; then echo "未找到 nginx 可执行文件：$nginx"; exit 10; fi',
        '"$nginx" -t 2>&1 || { echo "nginx 配置检查未通过，已中止重载"; exit 11; }',
        '"$nginx" -s reload 2>&1 || { echo "nginx 重载失败"; exit 12; }',
        'echo "nginx 已重载"'
      ].join('\n');
    } else {
      script = [
        'set -u',
        'nginx=' + shq(nginx),
        'if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -qE \'^(nginx|openresty)\\.service\'; then',
        '  systemctl restart nginx 2>&1 || systemctl restart openresty 2>&1 || { echo "systemctl 重启失败"; exit 10; }',
        '  echo "已通过 systemctl 重启 nginx"',
        '  exit 0',
        'fi',
        'if [ ! -x "$nginx" ]; then echo "未找到 nginx 可执行文件：$nginx"; exit 11; fi',
        '"$nginx" -t 2>&1 || { echo "nginx 配置检查未通过，已中止重启"; exit 12; }',
        '"$nginx" -s quit 2>/dev/null',
        'sleep 1',
        '"$nginx" 2>&1 || { echo "nginx 启动失败，请立即检查"; exit 13; }',
        'echo "nginx 已重启"'
      ].join('\n');
    }

    return spec(
      (action === 'restart' ? '重启' : '重载') + ' nginx',
      action === 'restart' ? '中断式重启，期间有极短的服务空窗' : '平滑重载配置，不断开现有连接',
      script,
      action === 'restart' ? 'danger' : 'normal',
      { timeout: 90, kind: 'nginx-' + action }
    );
  }

  /* ================================================================== *
   * 四、站点启用 / 停用
   * ================================================================== */

  /**
   * 通过把 vhost 配置移出 nginx 加载范围来停用站点：改名为 *.conf.disabled。
   * 这样 nginx 不再加载该站点，面板侧的站点记录与文件内容都不改动，随时可逆。
   * @param {object} site
   * @param {boolean} enable true 启用，false 停用
   * @param {object} env
   */
  function buildToggleSite(site, enable, env) {
    var chk = guard.checkPath(site && site.path);
    if (!chk.ok) return chk;
    var conf = chk.value;
    var nginx = env && env.nginxBin ? env.nginxBin : BAOTA.nginxBin;

    // 停用：x.conf → x.conf.disabled；启用：x.conf.disabled → x.conf
    var from;
    var to;
    if (enable) {
      if (!/\.conf\.disabled$/.test(conf)) return fail('该站点当前不是停用状态，无需启用');
      from = conf;
      to = conf.replace(/\.conf\.disabled$/, '.conf');
    } else {
      if (/\.conf\.disabled$/.test(conf)) return fail('该站点当前已是停用状态，无需停用');
      if (!/\.conf$/.test(conf)) return fail('只支持对 .conf 结尾的站点配置执行停用');
      from = conf;
      to = conf + '.disabled';
    }

    var script = [
      'set -u',
      'from=' + shq(from),
      'to=' + shq(to),
      'nginx=' + shq(nginx),
      'if [ ! -f "$from" ]; then echo "源文件不存在：$from"; exit 10; fi',
      'if [ -e "$to" ]; then echo "目标文件已存在，已中止：$to"; exit 11; fi',
      'if ! mv -f "$from" "$to" 2>/dev/null; then echo "重命名失败"; exit 12; fi',
      'if ! "$nginx" -t 2>&1; then',
      '  mv -f "$to" "$from"',
      '  echo "nginx 配置检查未通过，已还原"; exit 13',
      'fi',
      '"$nginx" -s reload 2>&1 || { echo "nginx 重载失败，配置文件已改动，请手动确认"; exit 14; }',
      'echo "' + (enable ? '已启用并重载 nginx' : '已停用并重载 nginx') + '"'
    ].join('\n');

    return spec(
      enable ? '启用站点' : '停用站点',
      (site.primary || site.id) + '：' + (enable ? '把配置文件移回加载范围' : '把配置文件移出 nginx 加载范围'),
      script,
      enable ? 'warn' : 'danger',
      { timeout: 60, siteId: site.id, kind: enable ? 'site-enable' : 'site-disable' }
    );
  }

  /* ================================================================== *
   * 五、修改 php.ini 指令
   * ================================================================== */

  /**
   * 修改指定 PHP 版本的 php.ini，改完重载 FPM 使其生效。
   * 指令名与取值都先过白名单，sed 表达式里只出现校验过的字面量。
   * @param {object} php 版本记录
   * @param {string} key 指令名
   * @param {string} value 取值
   * @param {object} env
   */
  function buildIniChange(php, key, value, env) {
    if (!php) return fail('未指定 PHP 版本');
    var k = guard.checkIniKey(key);
    if (!k.ok) return k;
    var v = guard.checkIniValue(k.value, value);
    if (!v.ok) return v;

    var iniCheck = guard.checkPath(php.iniPath || '');
    if (!iniCheck.ok) return fail('该 PHP 版本没有可识别的 php.ini 路径');

    var ini = iniCheck.value;
    var sedExpr = 's|^[[:space:]]*;?[[:space:]]*' + k.value + '[[:space:]]*=.*|' + k.value + ' = ' + v.value + '|';
    var verifyExpr = '^' + k.value + '[[:space:]]*=[[:space:]]*' + v.value + '$';

    var script = [
      'set -u',
      'ini=' + shq(ini),
      'bak="$ini.pm-bak.$$"',
      'if [ ! -f "$ini" ]; then echo "php.ini 不存在：$ini"; exit 10; fi',
      'if ! cp -a "$ini" "$bak" 2>/dev/null; then echo "无法备份 php.ini，已中止"; exit 11; fi',
      'if grep -qE ' + shq('^[[:space:]]*;?[[:space:]]*' + k.value + '[[:space:]]*=') + ' "$ini"; then',
      '  if ! sed -i -E ' + shq(sedExpr) + ' "$ini"; then',
      '    cp -a "$bak" "$ini"; rm -f "$bak"; echo "改写失败，已还原"; exit 12',
      '  fi',
      'else',
      '  printf "\\n%s = %s\\n" ' + shq(k.value) + ' ' + shq(v.value) + ' >> "$ini" || {',
      '    cp -a "$bak" "$ini"; rm -f "$bak"; echo "追加失败，已还原"; exit 13',
      '  }',
      'fi',
      'if ! grep -qE ' + shq(verifyExpr) + ' "$ini"; then',
      '  cp -a "$bak" "$ini"; rm -f "$bak"',
      '  echo "写入后校验未通过，已还原"; exit 14',
      'fi',
      'rm -f "$bak"',
      'echo "已写入 ' + k.value + ' = ' + v.value + '"'
    ].join('\n');

    return spec(
      '修改 PHP 配置',
      'PHP ' + (php.version || php.short) + '：' + k.value + ' = ' + v.value + '，写入后重载 FPM',
      script,
      'warn',
      { timeout: 60, kind: 'ini', php: php, key: k.value, value: v.value }
    );
  }

  /** 修改完 php.ini 后紧接着重载对应 FPM，两步合成一个确认动作 */
  function buildIniChangeAndReload(php, key, value, env) {
    var a = buildIniChange(php, key, value, env);
    if (!a.ok) return a;
    var b = buildFpmAction(php, 'reload', env);
    if (!b.ok) return b;

    var script = [
      a.spec.preview,
      'rc=$?',
      'if [ "$rc" != "0" ]; then echo "php.ini 改写失败，跳过重载"; exit "$rc"; fi',
      b.spec.preview
    ].join('\n');

    return spec(
      '修改 PHP 配置并重载',
      a.spec.summary,
      script,
      'warn',
      { timeout: 120, kind: 'ini-reload', php: php, key: key, value: value }
    );
  }

  /* ================================================================== *
   * 六、证书申请 / 续签
   * ================================================================== */

  /**
   * 证书签发与续签一律交给面板自带的 acme.sh，本插件不实现 ACME 协议。
   * - 宝塔：优先用宿主上的 /root/.acme.sh/acme.sh；
   * - 1Panel：其 ACME 以容器运行，用 docker exec 进入容器执行；
   * - 两者都不可用时明确返回不可用，由界面提示去面板网页端操作。
   *
   * @param {object} site 站点记录
   * @param {'issue'|'renew'} mode
   * @param {object} env
   */
  function buildCertAction(site, mode, env) {
    if (!site) return fail('未指定站点');
    var d = guard.checkDomain(site.primary);
    if (!d.ok) return d;

    var rootCheck = guard.checkPath(site.root || '');
    if (!rootCheck.ok) return fail('该站点没有可用的根目录，无法用 webroot 方式签发证书');

    var domain = d.value;
    var webroot = rootCheck.value;
    var acmeLocal = (env && env.acmePath) || '';
    var action = mode === 'renew' ? '--renew' : '--issue';
    // 首次签发需要 webroot；续签只认证书既有的签发配置，额外传 webroot 会报错。
    var acmeArgs = mode === 'renew'
      ? action + ' -d ' + shq(domain) + ' --force 2>&1'
      : action + ' -d ' + shq(domain) + ' --webroot ' + shq(webroot) + ' 2>&1';

    var script;
    if (acmeLocal) {
      var acmeCheck = guard.checkPath(acmeLocal);
      if (!acmeCheck.ok) return acmeCheck;
      script = [
        'set -u',
        'acme=' + shq(acmeCheck.value),
        'if [ ! -x "$acme" ]; then echo "acme.sh 不可执行：$acme"; exit 10; fi',
        '"$acme" ' + acmeArgs,
        'rc=$?',
        'echo "----"',
        'echo "acme.sh 退出码：$rc（0 表示成功；证书文件位于 acme.sh 的安装目录，需在面板中部署到站点）"',
        'exit "$rc"'
      ].join('\n');
    } else if (env && env.hasDocker) {
      script = [
        'set -u',
        'c=$(docker ps --format "{{.Names}}" 2>/dev/null | grep -i acme | head -1)',
        'if [ -z "$c" ]; then echo "未找到 1Panel 的 ACME 容器，也无法使用宿主机上的 acme.sh"; exit 10; fi',
        'docker exec "$c" /root/.acme.sh/acme.sh ' + acmeArgs,
        'rc=$?',
        'echo "----"',
        'echo "容器 $c 内 acme.sh 退出码：$rc"',
        'exit "$rc"'
      ].join('\n');
    } else {
      return fail('该主机上没有可用的 acme.sh，也没有 1Panel 的 ACME 容器；请在面板网页端申请或续签证书');
    }

    return spec(
      mode === 'renew' ? '续签证书' : '申请证书',
      (mode === 'renew' ? '为 ' : '为 ') + domain + (mode === 'renew' ? ' 强制续签 Let' + String.fromCharCode(39) + 's Encrypt 证书' : ' 申请 Let' + String.fromCharCode(39) + 's Encrypt 证书'),
      script,
      'warn',
      { timeout: 300, siteId: site.id, kind: 'cert-' + mode, domain: domain }
    );
  }

  /* ================================================================== *
   * 七、用目录中的配置文件覆盖站点配置
   * ================================================================== */

  /**
   * 把同目录下的另一个配置文件应用到当前站点（例如先上传备份或手改好的新配置）。
   * 覆盖前备份，nginx -t 不通过时自动还原。
   * @param {string} confPath 当前站点配置的绝对路径
   * @param {string} srcPath 用来覆盖的源文件绝对路径
   * @param {object} env
   */
  function buildApplyConf(confPath, srcPath, env) {
    var chkConf = guard.checkPath(confPath);
    if (!chkConf.ok) return chkConf;
    var chkSrc = guard.checkPath(srcPath);
    if (!chkSrc.ok) return chkSrc;

    var conf = chkConf.value;
    var src = chkSrc.value;
    var confDir = conf.slice(0, conf.lastIndexOf('/'));
    var srcDir = src.slice(0, src.lastIndexOf('/'));
    if (confDir !== srcDir) return fail('源文件必须与站点配置位于同一目录');
    if (src === conf) return fail('源文件与目标文件相同，无需覆盖');

    var srcName = src.slice(src.lastIndexOf('/') + 1);
    var nameChk = guard.checkSiteId(srcName);
    if (!nameChk.ok) return nameChk;
    if (!/\.conf(\.disabled)?$/.test(srcName)) return fail('源文件必须是 .conf 结尾的配置文件');

    var nginx = env && env.nginxBin ? env.nginxBin : BAOTA.nginxBin;
    var script = [
      'set -u',
      'conf=' + shq(conf),
      'src=' + shq(src),
      'nginx=' + shq(nginx),
      'bak="$conf.pm-bak.$$"',
      'if [ ! -f "$src" ]; then echo "源文件不存在：$src"; exit 10; fi',
      'if ! cp -a "$conf" "$bak" 2>/dev/null; then echo "无法备份当前配置，已中止"; exit 11; fi',
      'if ! cp -a "$src" "$conf" 2>/dev/null; then',
      '  cp -a "$bak" "$conf"; rm -f "$bak"',
      '  echo "覆盖失败，已还原"; exit 12',
      'fi',
      'if ! "$nginx" -t 2>&1; then',
      '  cp -a "$bak" "$conf"; rm -f "$bak"',
      '  echo "nginx 配置检查未通过，已还原原配置"; exit 13',
      'fi',
      'rm -f "$bak"',
      '"$nginx" -s reload 2>&1 || { echo "nginx 重载失败，配置已更新但未生效"; exit 14; }',
      'echo "已用 ' + srcName + ' 覆盖站点配置并重载 nginx"'
    ].join('\n');

    return spec(
      '覆盖站点配置',
      '用 ' + srcName + ' 覆盖 ' + PM.probe.baseName(conf) + '，校验失败自动还原',
      script,
      'danger',
      { timeout: 60, kind: 'apply-conf' }
    );
  }

  /* ================================================================== *
   * 八、执行
   * ================================================================== */

  /**
   * 执行一个 spec，自动记录日志。
   * @param {object} s spec
   * @param {object} env 环境信息（用于取 host）
   */
  function execute(s, env) {
    var host = (env && env.hostId) || core.bridge.hostId || '';
    var started = Date.now();
    var entry = {
      time: core.util.nowFull(),
      title: s.title || '操作',
      summary: s.summary || '',
      preview: s.preview || '',
      ok: false,
      out: '',
      err: '',
      elevated: false,
      duration: 0
    };

    return core.execWrite(s.argv, {
      host: host,
      timeout: s.timeout || 60,
      title: s.title,
      reason: s.summary
    }).then(function (r) {
      entry.ok = !!r.ok;
      entry.out = r.out || '';
      entry.err = r.err || '';
      entry.elevated = !!r.elevated;
      entry.duration = Date.now() - started;
      pushLog(entry);
      return { ok: r.ok, out: r.out, err: r.err, exit: r.exit, elevated: r.elevated, denied: r.denied, log: entry };
    }, function (e) {
      entry.err = (e && e.message) || String(e);
      entry.duration = Date.now() - started;
      pushLog(entry);
      return { ok: false, out: '', err: entry.err, exit: -1, log: entry };
    });
  }

  PM.actions = {
    buildSwitchPhp: buildSwitchPhp,
    buildFpmAction: buildFpmAction,
    buildNginxAction: buildNginxAction,
    buildToggleSite: buildToggleSite,
    buildIniChange: buildIniChange,
    buildIniChangeAndReload: buildIniChangeAndReload,
    buildCertAction: buildCertAction,
    buildApplyConf: buildApplyConf,
    execute: execute,
    getLog: getLog,
    clearLog: clearLog
  };
})();
