/**
 * app.js —— 插件入口
 *
 * 负责一次性编排：等宿主握手完成 → 探测环境 → 按面板类型拉取 PHP 与站点 → 渲染。
 * 界面本身不发起探测，只通过 PM.ui.refresh 回到这里。
 */
(function () {
  'use strict';

  var PM = window.PM;
  var core = PM.core;
  var ui = PM.ui;
  var probe = PM.probe;

  var busy = false;

  function mainEl() { return document.getElementById('main'); }

  /** 按探测到的面板类型拉取版本与站点，两者都装时全部拉取 */
  function loadPanelData(env, host) {
    var jobs = [];

    if (env.baota.present) {
      jobs.push(probe.probePhpBaota(host).then(function (r) {
        return { kind: 'php', source: 'baota', data: r };
      }, function (e) {
        return { kind: 'php', source: 'baota', data: { ok: false, error: (e && e.message) || String(e), versions: [] } };
      }));
      jobs.push(probe.probeSitesBaota(host).then(function (r) {
        return { kind: 'sites', source: 'baota', data: r };
      }, function (e) {
        return { kind: 'sites', source: 'baota', data: { ok: false, error: (e && e.message) || String(e), sites: [] } };
      }));
    }

    if (env.onepanel.present) {
      jobs.push(probe.probePhp1Panel(host).then(function (r) {
        return { kind: 'php', source: '1panel', data: r };
      }, function (e) {
        return { kind: 'php', source: '1panel', data: { ok: false, error: (e && e.message) || String(e), versions: [] } };
      }));
      jobs.push(probe.probeSites1Panel(host).then(function (r) {
        return { kind: 'sites', source: '1panel', data: r };
      }, function (e) {
        return { kind: 'sites', source: '1panel', data: { ok: false, error: (e && e.message) || String(e), sites: [] } };
      }));
    }

    return Promise.all(jobs).then(function (results) {
      var php = [];
      var sites = [];
      var problems = [];

      results.forEach(function (r) {
        if (!r.data || !r.data.ok) {
          var msg = (r.data && r.data.error) || '未知错误';
          problems.push((r.source === 'baota' ? '宝塔' : '1Panel') + (r.kind === 'php' ? ' PHP 列表' : ' 站点列表') + '读取失败：' + msg);
        }
        if (r.kind === 'php') php = php.concat(r.data.versions || []);
        else sites = sites.concat(r.data.sites || []);
      });

      // 版本去重：同一主次版本只保留一条，宝塔优先
      var seen = {};
      php = php.filter(function (p) {
        var key = p.version || p.container || p.short;
        if (!key) return false;
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      });

      ui.setState({ php: php, sites: sites });

      var certPaths = sites.map(function (s) { return s.certPath; }).filter(Boolean);
      var certJob = certPaths.length
        ? probe.probeCerts(host, certPaths)
        : Promise.resolve({ ok: true, certs: {} });

      return certJob.then(function (certRes) {
        var map = (certRes && certRes.certs) || {};
        sites.forEach(function (s) {
          if (s.certPath && map[s.certPath]) s.cert = map[s.certPath];
        });
        ui.setState({ sites: sites, problems: problems });
        return { php: php, sites: sites, problems: problems };
      }, function () {
        ui.setState({ problems: problems });
        return { php: php, sites: sites, problems: problems };
      });
    });
  }

  function refresh() {
    if (busy) return;
    busy = true;

    var host = core.bridge.hostId || '';
    ui.setState({ env: null, php: [], sites: [], error: '', problems: [] });
    ui.render();
    ui.setStatus('正在探测目标主机');
    if (mainEl()) mainEl().classList.add('pm-busy');

    probe.probeHostInfo()
      .then(function (info) {
        ui.setState({ host: info });
        ui.setStatus(info.name + (info.address ? ' · ' + info.address : '') + (info.local ? '（本机执行）' : ''));
        return probe.probeEnvironment(host);
      })
      .then(function (res) {
        if (!res.ok) {
          var err = new Error(res.error || '环境探测失败');
          throw err;
        }
        var env = res.env;
        env.hostId = host;
        ui.setState({ env: env });
        if (env.kind === 'none') return null;
        ui.setStatus((ui.state.host ? ui.state.host.name : '目标主机') + ' · ' + panelKindText(env));
        return loadPanelData(env, host);
      })
      .then(function (data) {
        var problems = (data && data.problems) || [];
        if (problems.length) {
          ui.toast(problems[0], 'warn');
        }
        ui.render();
      })
      .catch(function (e) {
        var msg = (e && e.message) || String(e);
        if (e && e.status === 403) {
          msg = '缺少执行命令的权限。请在应用设置中为本插件授予 exec:run 权限后重试。（' + msg + '）';
        } else if (e && e.status === 0) {
          msg = '无法连接宿主接口，请确认 QxSSH 正在运行。（' + msg + '）';
        }
        ui.setState({ error: msg });
        ui.setStatus('探测失败');
        ui.render();
      })
      .then(function () {
        busy = false;
        if (mainEl()) mainEl().classList.remove('pm-busy');
      });
  }

  function panelKindText(env) {
    if (env.kind === 'baota') return '宝塔面板';
    if (env.kind === '1panel') return '1Panel';
    if (env.kind === 'both') return '宝塔面板 + 1Panel';
    return '未检测到面板';
  }

  function boot() {
    ui.bindTabs();
    ui.setHandlers({ onRefresh: refresh });

    var probeBtn = document.getElementById('btnProbe');
    if (probeBtn) probeBtn.addEventListener('click', refresh);

    if (!core.bridge.ready) {
      ui.setStatus('等待宿主握手');
    }
    refresh();
  }

  core.onReady(function () {
    boot();
  });

  // 宿主未在 5 秒内完成握手时，仍然尝试探测：此时多半是本机直开调试，
  // 会话令牌缺失，行为退化为给出明确的连接错误提示。
  setTimeout(function () {
    if (!core.bridge.ready && !ui.state.env && !ui.state.error) {
      ui.setStatus('未收到宿主握手，按直连模式尝试');
      refresh();
    }
  }, 5000);
})();
