/**
 * ui.js —— 界面层
 *
 * 只负责把数据画成 DOM、把用户动作变成回调，不直接构造命令。
 * 所有写操作都必须先经过 confirmSpec：确认框里展示的就是即将执行的脚本原文。
 */
(function () {
  'use strict';

  var PM = (window.PM = window.PM || {});
  var core = PM.core;
  var el = core.util.el;
  var clear = core.util.clear;

  var state = {
    env: null,
    host: null,
    php: [],
    sites: [],
    error: '',
    problems: [],
    loading: false,
    loadedOnce: false
  };

  var handlers = { onRefresh: null, onAction: null };

  /* ================================================================== *
   * 通用小部件
   * ================================================================== */

  var toastWrap = null;

  function toast(message, kind) {
    if (!toastWrap) toastWrap = document.getElementById('toastWrap');
    if (!toastWrap) return;
    var node = el('div', { class: 'pm-toast' + (kind ? ' is-' + kind : ''), text: String(message || '') });
    toastWrap.appendChild(node);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 4200);
  }

  function badge(text, kind) {
    return el('span', { class: 'pm-badge' + (kind ? ' is-' + kind : ''), text: text });
  }

  function kvItem(key, value, mono) {
    return el('div', { class: 'pm-kv-item' }, [
      el('div', { class: 'pm-kv-key', text: key }),
      el('div', { class: 'pm-kv-val' + (mono ? ' is-mono' : ''), text: value || '—' })
    ]);
  }

  function card(title, actions, body, flush) {
    var head = [el('h2', { text: title }), el('span', { class: 'pm-grow' })];
    if (actions) {
      var box = el('div', { class: 'pm-actions' });
      for (var i = 0; i < actions.length; i++) box.appendChild(actions[i]);
      head.push(box);
    }
    return el('section', { class: 'pm-card' }, [
      el('div', { class: 'pm-card-head' }, head),
      el('div', { class: 'pm-card-body' + (flush ? ' is-flush' : '') }, [body])
    ]);
  }

  function btn(text, cls, onClick) {
    var b = el('button', { class: 'pm-btn' + (cls ? ' ' + cls : ''), type: 'button', text: text });
    b.addEventListener('click', onClick);
    return b;
  }

  function note(kind, text) {
    return el('div', { class: 'pm-note' + (kind ? ' is-' + kind : '') }, [
      el('div', { class: 'pm-note-body', text: text })
    ]);
  }

  /** 复制文本到剪贴板，失败时退回选中 */
  function copyText(text) {
    var ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) { ok = false; }
    if (!ok) {
      var ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); ok = true; } catch (e) { ok = false; }
      document.body.removeChild(ta);
    }
    toast(ok ? '已复制到剪贴板' : '复制失败，请手动选中', ok ? 'ok' : 'warn');
  }

  function codeBlock(text, inline) {
    return el('pre', { class: 'pm-code' + (inline ? ' is-inline' : '') }, [el('span', { text: String(text || '') })]);
  }

  function codeWithCopy(text) {
    return el('div', { style: 'display:flex;gap:6px;align-items:flex-start' }, [
      el('div', { style: 'flex:1;min-width:0' }, [codeBlock(text)]),
      btn('复制', 'is-xs is-ghost', function () { copyText(text); })
    ]);
  }

  /** 生成一个走宿主文件通道的下载链接（server:download） */
  function downloadLink(label, path, cls) {
    var a = el('a', {
      class: 'pm-btn' + (cls ? ' ' + cls : ''),
      href: core.downloadUrl(path),
      download: '',
      title: path
    }, [el('span', { text: label })]);
    return a;
  }

  function humanSize(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1048576).toFixed(1) + ' MB';
  }

  /* ================================================================== *
   * 对话框
   * ================================================================== */

  function openDialog(inner, wide) {
    var mask = el('div', { class: 'pm-overlay' }, [
      el('div', { class: 'pm-dialog' + (wide ? ' is-wide' : '') }, [inner])
    ]);
    function close() {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    document.body.appendChild(mask);
    return { mask: mask, close: close };
  }

  /**
   * 写操作确认框：展示将执行的确切脚本、影响说明与风险等级。
   * @returns {Promise<boolean>}
   */
  function confirmSpec(spec) {
    return new Promise(function (resolve) {
      var riskText = spec.risk === 'danger' ? '高风险' : (spec.risk === 'warn' ? '需谨慎' : '常规');
      var riskKind = spec.risk === 'danger' ? 'danger' : (spec.risk === 'warn' ? 'warn' : 'ok');

      var body = el('div', { class: 'pm-dialog-body' }, [
        el('p', { class: 'pm-dialog-msg', text: spec.summary || '' }),
        el('div', { style: 'display:flex;gap:6px;align-items:center' }, [
          el('span', { class: 'pm-cmd-label', text: '将执行以下命令：' }),
          badge(riskText, riskKind)
        ]),
        codeWithCopy(spec.preview),
        note('warn', '请确认目标主机与影响范围无误。命令以 root（sudo）身份执行时，宿主会另行向你申请授权。')
      ]);

      var okBtn = el('button', { class: 'pm-btn is-primary', type: 'button', text: '确认执行' });
      var cancelBtn = el('button', { class: 'pm-btn', type: 'button', text: '取消' });
      var foot = el('div', { class: 'pm-dialog-foot' }, [cancelBtn, okBtn]);
      var head = el('div', { class: 'pm-dialog-head' }, [
        el('h3', { text: spec.title || '确认操作' }),
        el('span', { class: 'pm-grow' })
      ]);
      var dlg = openDialog(el('div', { style: 'display:contents' }, [head, body, foot]), true);

      cancelBtn.addEventListener('click', function () { dlg.close(); resolve(false); });
      okBtn.addEventListener('click', function () { dlg.close(); resolve(true); });
      dlg.mask.addEventListener('click', function (e) {
        if (e.target === dlg.mask) { dlg.close(); resolve(false); }
      });
      okBtn.focus();
    });
  }

  /**
   * 通用表单对话框。
   * fields: [{ name, label, type: 'select'|'text'|'password', options, value, hint, validate }]
   * validate(value, values) 返回错误字符串或空串。
   * @returns {Promise<object|null>} 取消返回 null
   */
  function formDialog(opts) {
    return new Promise(function (resolve) {
      var fields = opts.fields || [];
      var controls = {};
      var errors = {};
      var body = el('div', { class: 'pm-dialog-body' });

      if (opts.message) body.appendChild(el('p', { class: 'pm-dialog-msg', text: opts.message }));

      fields.forEach(function (f) {
        var input;
        if (f.type === 'select') {
          input = el('select', { class: 'pm-select' });
          (f.options || []).forEach(function (o) {
            var optEl = el('option', { value: o.value, text: o.label });
            if (String(o.value) === String(f.value)) optEl.selected = true;
            input.appendChild(optEl);
          });
        } else {
          input = el('input', {
            class: 'pm-input',
            type: f.type === 'password' ? 'password' : 'text',
            placeholder: f.placeholder || '',
            autocomplete: f.type === 'password' ? 'current-password' : 'off'
          });
          if (f.value !== undefined) input.value = String(f.value);
        }
        controls[f.name] = input;

        var errEl = el('div', { class: 'pm-field-err' });
        errors[f.name] = errEl;

        var wrap = el('div', { class: 'pm-field' }, [
          el('label', { text: f.label || f.name }),
          input,
          f.hint ? el('div', { class: 'pm-field-hint', text: f.hint }) : null,
          errEl
        ]);
        body.appendChild(wrap);

        function validateNow() {
          if (typeof f.validate !== 'function') return true;
          var msg = f.validate(input.value) || '';
          errEl.textContent = msg;
          input.classList.toggle('is-bad', !!msg);
          return !msg;
        }
        input.addEventListener('input', validateNow);
        input.addEventListener('change', validateNow);
      });

      var okBtn = el('button', { class: 'pm-btn is-primary', type: 'button', text: opts.okText || '确定' });
      var cancelBtn = el('button', { class: 'pm-btn', type: 'button', text: '取消' });
      var dlg = openDialog(el('div', { style: 'display:contents' }, [
        el('div', { class: 'pm-dialog-head' }, [
          el('h3', { text: opts.title || '请输入' }),
          el('span', { class: 'pm-grow' })
        ]),
        body,
        el('div', { class: 'pm-dialog-foot' }, [cancelBtn, okBtn])
      ]));

      function collect() {
        var values = {};
        var allOk = true;
        fields.forEach(function (f) {
          values[f.name] = controls[f.name].value;
        });
        fields.forEach(function (f) {
          if (typeof f.validate !== 'function') return;
          var msg = f.validate(controls[f.name].value, values) || '';
          errors[f.name].textContent = msg;
          controls[f.name].classList.toggle('is-bad', !!msg);
          if (msg) allOk = false;
        });
        return allOk ? values : null;
      }

      cancelBtn.addEventListener('click', function () { dlg.close(); resolve(null); });
      okBtn.addEventListener('click', function () {
        var v = collect();
        if (!v) return;
        dlg.close();
        resolve(v);
      });
      dlg.mask.addEventListener('click', function (e) {
        if (e.target === dlg.mask) { dlg.close(); resolve(null); }
      });

      var first = fields.length ? controls[fields[0].name] : null;
      if (first) first.focus();
    });
  }

  /** sudo 密码输入框，供 core 在提权时调用 */
  function promptPassword(host, title, reason) {
    return formDialog({
      title: title || '需要管理员权限',
      message: reason || '该操作需要 sudo 权限，请输入目标主机的账号密码。密码只交给宿主用于本次提权，不会写入插件存储。',
      okText: '提权并继续',
      fields: [{
        name: 'password',
        label: 'sudo 密码',
        type: 'password',
        validate: function (v) { return v ? '' : '密码不能为空'; }
      }]
    }).then(function (v) { return v ? v.password : null; });
  }

  /* ================================================================== *
   * 状态区
   * ================================================================== */

  function setStatus(text) {
    var node = document.getElementById('hostLabel');
    if (node) node.textContent = text;
  }

  function setPanelChip(env) {
    var chip = document.getElementById('panelChip');
    if (!chip) return;
    if (!env) { chip.hidden = true; return; }
    chip.hidden = false;
    chip.className = 'pm-chip';
    if (env.kind === 'baota') {
      chip.textContent = '宝塔面板';
      chip.classList.add('is-ok');
    } else if (env.kind === '1panel') {
      chip.textContent = '1Panel';
      chip.classList.add('is-ok');
    } else if (env.kind === 'both') {
      chip.textContent = '宝塔 + 1Panel';
      chip.classList.add('is-warn');
    } else {
      chip.textContent = '未检测到面板';
      chip.classList.add('is-danger');
    }
  }

  function panelKindLabel(env) {
    if (!env) return '未知';
    if (env.kind === 'baota') return '宝塔面板（BaoTa）';
    if (env.kind === '1panel') return '1Panel';
    if (env.kind === 'both') return '宝塔面板 + 1Panel';
    return '未检测到面板';
  }

  /* ================================================================== *
   * 视图：概览
   * ================================================================== */

  function renderOverview() {
    var view = document.getElementById('viewOverview');
    clear(view);
    var env = state.env;

    if (state.error) {
      view.appendChild(card('探测失败', null, el('div', { class: 'pm-empty' }, [
        el('div', { class: 'pm-empty-title', text: '无法完成环境探测' }),
        el('div', { class: 'pm-empty-desc', text: state.error }),
        el('div', { class: 'pm-empty-actions' }, [
          btn('重新探测', 'is-primary', function () { refresh(); })
        ])
      ])));
      return;
    }

    if (!env) {
      view.appendChild(el('div', { class: 'pm-loading' }, [
        el('span', { class: 'pm-spin' }),
        el('span', { text: '正在探测目标主机' })
      ]));
      return;
    }

    if (env.kind === 'none') {
      view.appendChild(renderNoPanel());
      return;
    }

    // 面板信息
    var panelKv = el('div', { class: 'pm-kv' });
    var active = env.kind === 'baota' ? env.baota : (env.kind === '1panel' ? env.onepanel : null);

    if (env.baota.present) {
      panelKv.appendChild(kvItem('宝塔版本', env.baota.version || '未获取'));
      panelKv.appendChild(kvItem('面板端口', env.baota.port || '未获取'));
      panelKv.appendChild(kvItem('安全入口', env.baota.entry || '未设置', true));
      panelKv.appendChild(kvItem('面板状态', env.baota.running ? '运行中' : '未运行'));
      panelKv.appendChild(kvItem('安装目录', env.baota.dir, true));
      panelKv.appendChild(kvItem('站点配置目录', env.baota.vhostDir, true));
    }
    if (env.onepanel.present) {
      panelKv.appendChild(kvItem('1Panel 版本', env.onepanel.version || '未获取（1pctl 需要 root 权限）'));
      panelKv.appendChild(kvItem('面板端口', env.onepanel.ports.length ? env.onepanel.ports.join(' / ') : '未获取'));
      panelKv.appendChild(kvItem('配置文件', env.onepanel.conf ? '已读取' : '未找到'));
      panelKv.appendChild(kvItem('面板状态', env.onepanel.running ? '运行中' : '未运行'));
      panelKv.appendChild(kvItem('安装目录', env.onepanel.dir, true));
    }

    var panelActions = [];
    var entryUrl = buildEntryUrl(env);
    if (entryUrl) {
      panelActions.push(btn('复制面板地址', 'is-xs is-ghost', function () { copyText(entryUrl); }));
    }
    if ((env.baota.present && env.baota.cli) || (env.onepanel.present && env.onepanel.cli)) {
      panelActions.push(btn('命令行自检', 'is-xs is-ghost', function () { openPanelCli(env); }));
    }

    view.appendChild(card('面板环境', panelActions, panelKv));

    // 服务状态
    var svcKv = el('div', { class: 'pm-kv' });
    svcKv.appendChild(kvItem('nginx', env.nginxRunning ? '运行中' : '未检测到运行中的进程'));
    svcKv.appendChild(kvItem('nginx 可执行文件', env.nginxBin || '未获取', true));
    var fpmRun = state.php.filter(function (p) { return p.running; }).length;
    svcKv.appendChild(kvItem('PHP-FPM 运行中', fpmRun + ' / ' + state.php.length + ' 个版本'));
    svcKv.appendChild(kvItem('已安装 PHP 版本', state.php.length ? state.php.map(function (p) { return p.version || p.label; }).join('、') : '未发现'));
    svcKv.appendChild(kvItem('acme.sh', env.acmePath || (env.hasDocker ? '未在宿主机找到，将尝试 1Panel 的 ACME 容器' : '未安装')));
    svcKv.appendChild(kvItem('当前登录用户', (env.os.user || '未知') + (env.os.isRoot ? '（root）' : '（uid ' + env.os.uid + '）')));

    var svcActions = [
      btn('查看日志', 'is-xs', function () { openLogViewer(env); }),
      btn('重载 nginx', 'is-xs', function () { runNginx('reload'); }),
      btn('重启 nginx', 'is-xs is-danger', function () { runNginx('restart'); })
    ];

    view.appendChild(card('服务状态', svcActions, svcKv));

    // 站点与证书概览
    var siteRows = el('div', { class: 'pm-kv' });
    var enabled = state.sites.filter(function (s) { return !s.disabled; }).length;
    var disabledCount = state.sites.length - enabled;
    var expiring = state.sites.filter(function (s) {
      if (!s.cert || !s.cert.ok || !s.cert.endDate) return false;
      var d = PM.probe.daysUntil(s.cert.endDate);
      return d !== null && d <= 30;
    }).length;
    siteRows.appendChild(kvItem('站点总数', String(state.sites.length)));
    siteRows.appendChild(kvItem('启用 / 停用', enabled + ' / ' + disabledCount));
    siteRows.appendChild(kvItem('30 天内到期证书', expiring ? expiring + ' 个' : '无'));

    view.appendChild(card('站点概况', [
      btn('查看站点', 'is-xs is-ghost', function () { switchTab('sites'); })
    ], siteRows));

    if (!state.php.length) {
      view.appendChild(note('warn', '未发现任何 PHP 版本。宝塔通常在 /www/server/php 下按版本号分目录安装，1Panel 的 PHP 以容器运行时形式存在；若刚安装完成，请先在面板中安装 PHP 运行环境。'));
    }
  }

  function buildEntryUrl(env) {
    if (!env || !state.host) return '';
    var addr = state.host.address || state.host.name || '';
    if (!addr) return '';
    if (env.kind === '1panel' || (env.kind === 'both' && !env.baota.port)) {
      var port = env.onepanel.ports.length ? env.onepanel.ports[0] : '';
      return 'https://' + addr + (port ? ':' + port : '');
    }
    if (env.baota.port) {
      return 'http://' + addr + ':' + env.baota.port + (env.baota.entry || '');
    }
    return '';
  }

  /** 两台面板都没装时的空状态：只给安装提示，不自动安装 */
  function renderNoPanel() {
    var env = state.env;
    var wrap = el('div', { class: 'pm-empty' });
    wrap.appendChild(el('div', { class: 'pm-empty-title', text: '未检测到宝塔面板或 1Panel' }));
    wrap.appendChild(el('div', { class: 'pm-empty-desc', text:
      '本插件通过面板自身的目录结构与命令行接管 PHP 站点，需要目标主机上已安装宝塔面板或 1Panel。'
      + '当前主机上 /www/server/panel 与 /opt/1panel 均不存在，因此站点、PHP 版本与配置管理都不可用。'
    }));

    var install = el('div', { class: 'pm-install' });

    install.appendChild(installItem(
      '宝塔面板',
      '安装脚本来自宝塔官方，需 root 权限执行。安装完成后宝塔会在 /www/server/panel 下建立面板目录。',
      'url=https://download.bt.cn/install/install_6.0.sh && sh install_6.0.sh ed8484bec'
    ));

    install.appendChild(installItem(
      '1Panel',
      '安装脚本来自飞致云官方，安装过程会交互询问端口与安全入口。安装完成后 1Panel 运行在 /opt/1panel 下。',
      'curl -sSL https://resource.fit2cloud.com/1panel/package/quick_start.sh -o quick_start.sh && sh quick_start.sh'
    ));

    wrap.appendChild(install);
    wrap.appendChild(note('warn', '以上命令仅作提示，本插件不会自动安装任何软件。安装完成后点击右上角「重新探测」。'));

    wrap.appendChild(el('div', { class: 'pm-empty-actions' }, [
      btn('重新探测', 'is-primary', function () { refresh(); })
    ]));

    if (env && env.os.uname) {
      wrap.appendChild(el('div', { class: 'pm-empty-desc pm-muted', text:
        '目标主机系统：' + env.os.uname + '，当前用户：' + (env.os.user || '未知')
        + '（uid ' + env.os.uid + '）。安装面板需要 root 权限。'
      }));
    }

    var box = el('section', { class: 'pm-card' });
    box.appendChild(el('div', { class: 'pm-card-body' }, [wrap]));
    return box;
  }

  function installItem(title, desc, cmd) {
    return el('div', { class: 'pm-install-item' }, [
      el('div', { class: 'pm-install-head' }, [
        el('span', { text: title }),
        el('span', { class: 'pm-grow' }),
        btn('复制命令', 'is-xs is-ghost', function () { copyText(cmd); })
      ]),
      el('div', { class: 'pm-install-body' }, [
        el('div', { class: 'pm-field-hint', text: desc }),
        el('div', { style: 'margin-top:6px' }, [codeBlock(cmd)])
      ])
    ]);
  }

  /* ================================================================== *
   * 视图：PHP 版本
   * ================================================================== */

  function renderPhp() {
    var view = document.getElementById('viewPhp');
    clear(view);
    var env = state.env;
    if (!env || env.kind === 'none') {
      view.appendChild(card('PHP 版本', null, el('div', { class: 'pm-empty' }, [
        el('div', { class: 'pm-empty-title', text: '无可管理的 PHP 版本' }),
        el('div', { class: 'pm-empty-desc', text: '需要先在目标主机上安装宝塔面板或 1Panel。' })
      ])));
      return;
    }

    var thead = el('thead', null, [
      el('tr', null, [
        el('th', { text: '版本' }),
        el('th', { text: '来源' }),
        el('th', { text: 'FPM 状态' }),
        el('th', { text: '进程 / 容器' }),
        el('th', { text: '配置文件' }),
        el('th', { class: 'pm-col-ops', text: '操作' })
      ])
    ]);

    var tbody = el('tbody');
    if (!state.php.length) {
      tbody.appendChild(el('tr', { class: 'pm-empty-row' }, [
        el('td', { colspan: '6', text: '未发现 PHP 版本' })
      ]));
    }

    state.php.forEach(function (p) {
      var ops = el('div', { class: 'pm-actions', style: 'justify-content:flex-end' }, [
        btn('重载', 'is-xs', function () { runFpm(p, 'reload'); }),
        btn('重启', 'is-xs is-danger', function () { runFpm(p, 'restart'); }),
        btn('改配置', 'is-xs', function () { openIniDialog(p); }),
        (p.iniPath && core.bridge.hostId) ? downloadLink('下载 ini', p.iniPath, 'is-xs') : null
      ]);

      tbody.appendChild(el('tr', null, [
        el('td', null, [el('strong', { text: p.version || p.label || '未知' })]),
        el('td', null, [badge(p.source === 'baota' ? '宝塔' : '1Panel', 'accent')]),
        el('td', null, [p.running ? badge('运行中', 'ok') : badge('未运行', 'warn')]),
        el('td', { class: 'pm-mono', text: p.container ? p.container : (p.pid ? 'pid ' + p.pid : '—') }),
        el('td', { class: 'pm-mono', text: p.iniPath || p.fpmConf || '—' }),
        el('td', { class: 'pm-col-ops' }, [ops])
      ]));
    });

    var actions = [btn('刷新', 'is-xs is-ghost', function () { refresh(); })];
    view.appendChild(card('PHP 版本与 FPM', actions, el('table', { class: 'pm-table' }, [thead, tbody]), true));

    if (env.kind === '1panel' || (env.kind === 'both' && !state.php.some(function (p) { return p.source === 'baota'; }))) {
      view.appendChild(note(null, '1Panel 的 PHP 是容器化运行时：FPM 状态对应容器状态，"重载"通过向容器内 PID 1 发送 USR2 实现，"重启"由 docker 重启容器。'));
    }
  }

  /* ================================================================== *
   * 视图：站点
   * ================================================================== */

  function renderSites() {
    var view = document.getElementById('viewSites');
    clear(view);
    var env = state.env;
    if (!env || env.kind === 'none') {
      view.appendChild(card('站点', null, el('div', { class: 'pm-empty' }, [
        el('div', { class: 'pm-empty-title', text: '没有可管理的站点' }),
        el('div', { class: 'pm-empty-desc', text: '需要先在目标主机上安装宝塔面板或 1Panel，并在面板中创建站点。' })
      ])));
      return;
    }

    var thead = el('thead', null, [
      el('tr', null, [
        el('th', { text: '域名' }),
        el('th', { text: '根目录' }),
        el('th', { text: 'PHP 版本' }),
        el('th', { text: '证书' }),
        el('th', { text: '状态' }),
        el('th', { class: 'pm-col-ops', text: '操作' })
      ])
    ]);

    var tbody = el('tbody');
    if (!state.sites.length) {
      tbody.appendChild(el('tr', { class: 'pm-empty-row' }, [
        el('td', { colspan: '6', text: '未发现站点配置文件' })
      ]));
    }

    state.sites.forEach(function (s) {
      var ops = el('div', { class: 'pm-actions', style: 'justify-content:flex-end' }, [
        btn('切版本', 'is-xs', function () { openSwitchDialog(s); }),
        btn(s.disabled ? '启用' : '停用', 'is-xs' + (s.disabled ? '' : ' is-danger'), function () {
          runToggleSite(s, s.disabled);
        }),
        btn(s.ssl ? '续签证书' : '申请证书', 'is-xs', function () {
          runCert(s, s.ssl ? 'renew' : 'issue');
        }),
        btn('配置文件', 'is-xs', function () { openSiteFiles(s); })
      ]);

      tbody.appendChild(el('tr', null, [
        el('td', null, [
          el('div', { text: s.primary }),
          s.domains.length > 1 ? el('div', { class: 'pm-muted', text: s.domains.join('、') }) : null
        ]),
        el('td', { class: 'pm-mono', text: s.root || '—' }),
        el('td', null, [s.phpVersion ? badge('PHP ' + s.phpVersion, 'accent') : badge('未绑定', 'warn')]),
        el('td', null, [certCell(s)]),
        el('td', null, [s.disabled ? badge('已停用', 'danger') : badge('启用中', 'ok')]),
        el('td', { class: 'pm-col-ops' }, [ops])
      ]));
    });

    var actions = [btn('刷新', 'is-xs is-ghost', function () { refresh(); })];
    view.appendChild(card('站点', actions, el('table', { class: 'pm-table' }, [thead, tbody]), true));

    view.appendChild(note(null, '站点信息直接读取 nginx 的站点配置文件所得，反映的是 nginx 实际加载的内容。启停操作通过把配置文件移入或移出加载范围实现，面板中的站点记录不会被删除。'));
  }

  function certCell(site) {
    if (!site.certPath) return badge('未配置', 'warn');
    var c = site.cert;
    if (!c) return badge('读取中', 'warn');
    if (c.missing) return badge('证书文件缺失', 'danger');
    if (!c.ok || !c.endDate) return badge('无法解析', 'warn');
    var days = PM.probe.daysUntil(c.endDate);
    var text = c.endDate.toISOString().slice(0, 10);
    if (days === null) return badge(text, 'warn');
    if (days < 0) return badge('已过期 ' + (-days) + ' 天', 'danger');
    if (days <= 30) return badge(text + '（' + days + ' 天）', 'warn');
    return badge(text + '（' + days + ' 天）', 'ok');
  }

  /* ================================================================== *
   * 视图：执行记录
   * ================================================================== */

  function renderLog() {
    var view = document.getElementById('viewLog');
    clear(view);
    var list = PM.actions.getLog();

    var body = el('div', { class: 'pm-log-list' });
    if (!list.length) {
      body.appendChild(el('div', { class: 'pm-empty' }, [
        el('div', { class: 'pm-empty-title', text: '暂无执行记录' }),
        el('div', { class: 'pm-empty-desc', text: '每次写操作都会在这里留下时间、命令与结果，供事后核对。' })
      ]));
    }

    list.forEach(function (item) {
      var meta = el('div', { class: 'pm-log-meta' }, [
        el('span', { class: 'pm-log-time', text: item.time }),
        el('span', { class: 'pm-log-title', text: item.title }),
        item.ok ? badge('成功', 'ok') : badge('失败', 'danger'),
        item.elevated ? badge('root', 'accent') : null,
        el('span', { class: 'pm-log-time', text: item.duration + ' ms' })
      ]);

      var node = el('div', { class: 'pm-log-item' }, [
        meta,
        item.summary ? el('div', { class: 'pm-field-hint', text: item.summary }) : null,
        el('div', { class: 'pm-log-out' }, [el('details', null, [
          el('summary', { class: 'pm-field-hint', text: '查看命令与输出' }),
          el('div', { style: 'margin-top:5px' }, [codeBlock(item.preview)]),
          item.out ? el('div', { style: 'margin-top:5px' }, [codeBlock(item.out)]) : null,
          item.err ? el('div', { style: 'margin-top:5px' }, [codeBlock(item.err)]) : null
        ])])
      ]);
      body.appendChild(node);
    });

    var actions = [];
    if (list.length) actions.push(btn('清空记录', 'is-xs is-ghost', function () {
      PM.actions.clearLog();
      renderLog();
    }));

    view.appendChild(card('执行记录', actions, body, true));
  }

  /* ================================================================== *
   * 交互流程
   * ================================================================== */

  function runNginx(mode) {
    var built = PM.actions.buildNginxAction(mode, state.env);
    runBuilt(built);
  }

  function runFpm(php, mode) {
    var built = PM.actions.buildFpmAction(php, mode, state.env);
    runBuilt(built);
  }

  function runToggleSite(site, enable) {
    var built = PM.actions.buildToggleSite(site, enable, state.env);
    runBuilt(built);
  }

  function runCert(site, mode) {
    var built = PM.actions.buildCertAction(site, mode, state.env);
    if (!built.ok) {
      toast(built.error, 'warn');
      return;
    }
    runBuilt(built);
  }

  /** 统一入口：确认 → 执行 → 提示 → 刷新 */
  function runBuilt(built) {
    if (!built || !built.ok) {
      toast((built && built.error) || '操作参数不合法，已取消', 'danger');
      return;
    }
    confirmSpec(built.spec).then(function (yes) {
      if (!yes) return;
      var main = document.getElementById('main');
      main.classList.add('pm-busy');
      PM.actions.execute(built.spec, state.env).then(function (r) {
        main.classList.remove('pm-busy');
        if (r.ok) {
          toast('执行成功：' + built.spec.title, 'ok');
        } else if (r.denied) {
          toast('未取得管理员权限，操作已中止：' + (r.err || ''), 'danger');
        } else {
          toast('执行失败：' + (r.err || '未知错误'), 'danger');
        }
        renderLog();
        setTimeout(function () { refresh(); }, 400);
      }, function (e) {
        main.classList.remove('pm-busy');
        toast('执行异常：' + ((e && e.message) || e), 'danger');
      });
    });
  }

  /** 切换站点 PHP 版本：只允许选已安装的版本 */
  function openSwitchDialog(site) {
    if (!state.php.length) {
      toast('未发现任何已安装的 PHP 版本，无法切换', 'warn');
      return;
    }
    var options = state.php.map(function (p) {
      var short = p.short || (p.version ? p.version.replace('.', '') : '');
      return {
        value: short,
        label: 'PHP ' + (p.version || p.label) + (p.running ? '' : '（当前未运行）')
      };
    }).filter(function (o) { return /^[0-9]{2,3}$/.test(o.value); });

    if (!options.length) {
      toast('未获取到可用的 PHP 版本标识', 'warn');
      return;
    }

    formDialog({
      title: '切换站点 PHP 版本',
      message: '站点 ' + site.primary + ' 当前使用 ' + (site.phpVersion ? 'PHP ' + site.phpVersion : '未绑定 PHP') + '。切换后会自动检查 nginx 配置并重载。',
      okText: '继续',
      fields: [{
        name: 'target',
        label: '目标 PHP 版本',
        type: 'select',
        value: options[0].value,
        options: options
      }]
    }).then(function (v) {
      if (!v) return;
      var chk = core.guard.checkPhpShort(v.target);
      if (!chk.ok) { toast(chk.error, 'danger'); return; }
      runBuilt(PM.actions.buildSwitchPhp(site, chk.value, state.env));
    });
  }

  /** 修改 php.ini 白名单指令 */
  function openIniDialog(php) {
    var keys = [
      { value: 'memory_limit', label: 'memory_limit（脚本内存上限）', hint: '例如 256M' },
      { value: 'upload_max_filesize', label: 'upload_max_filesize（单文件上传上限）', hint: '例如 64M' },
      { value: 'post_max_size', label: 'post_max_size（POST 提交上限）', hint: '例如 64M' },
      { value: 'max_execution_time', label: 'max_execution_time（执行超时秒数）', hint: '例如 300' }
    ];

    formDialog({
      title: '修改 PHP 配置',
      message: '目标文件：' + (php.iniPath || '未识别') + '。写入前会备份原文件，写入后回读校验并重载 FPM。',
      okText: '继续',
      fields: [
        { name: 'key', label: '配置项', type: 'select', value: keys[0].value, options: keys },
        {
          name: 'value',
          label: '新取值',
          type: 'text',
          value: '',
          placeholder: '例如 256M',
          hint: '只允许字母、数字、点、下划线、连字符；容量类使用 K/M/G 单位。',
          validate: function (v, values) {
            var chk = core.guard.checkIniValue(values.key, v);
            return chk.ok ? '' : chk.error;
          }
        }
      ]
    }).then(function (v) {
      if (!v) return;
      runBuilt(PM.actions.buildIniChangeAndReload(php, v.key, v.value, state.env));
    });
  }

  /**
   * 站点配置文件面板：浏览配置目录、导出、上传、并用同目录下的文件覆盖当前配置。
   * server:read / server:upload / server:download 三个权限在这里都有真实用例。
   */
  function openSiteFiles(site) {
    var hostId = core.bridge.hostId || '';
    var confDir = '';
    var idx = String(site.path || '').lastIndexOf('/');
    if (idx > 0) confDir = site.path.slice(0, idx);

    var body = el('div', { class: 'pm-dialog-body' });

    var kv = el('div', { class: 'pm-kv' });
    kv.appendChild(kvItem('站点配置', site.path, true));
    kv.appendChild(kvItem('根目录', site.root || '—', true));
    if (site.certPath) kv.appendChild(kvItem('证书文件', site.certPath, true));
    body.appendChild(el('div', { class: 'pm-card' }, [el('div', { class: 'pm-card-body' }, [kv])]));

    if (hostId) {
      body.appendChild(el('div', null, [
        el('div', { class: 'pm-cmd-label', text: '导出（server:download）' }),
        el('div', { class: 'pm-actions', style: 'margin-top:5px' }, [
          downloadLink('下载站点配置', site.path, 'is-xs'),
          site.certPath ? downloadLink('下载证书', site.certPath, 'is-xs') : null
        ])
      ]));
    }

    var listBox = el('div');

    if (!hostId) {
      body.appendChild(note('warn', '本机模式下没有可用的 SSH 主机：目录浏览与上传依赖 SFTP 通道，因此这里只能下载文件。需要上传或浏览配置目录时，请在该目标主机的窗口中打开本插件。'));
    } else {
      var fileInput = el('input', { class: 'pm-input', type: 'file' });
      var uploadBtn = el('button', { class: 'pm-btn is-xs is-primary', type: 'button', text: '上传到配置目录' });
      body.appendChild(el('div', null, [
        el('div', { class: 'pm-cmd-label', text: '上传（server:upload）' }),
        el('div', { style: 'margin-top:5px;display:flex;gap:8px;align-items:center' }, [fileInput, uploadBtn]),
        el('div', { class: 'pm-field-hint', text: '上传的文件保存到 ' + confDir + '，文件名保持不变；随后可用下方列表里的「覆盖」应用到站点。' })
      ]));

      body.appendChild(el('div', null, [
        el('div', { class: 'pm-cmd-label', text: '配置目录内容（server:read）' }),
        el('div', { style: 'margin-top:5px' }, [listBox])
      ]));

      uploadBtn.addEventListener('click', function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) { toast('请先选择要上传的文件', 'warn'); return; }
        if (!/\.conf(\.disabled)?$/.test(f.name)) { toast('只允许上传 .conf 结尾的配置文件', 'warn'); return; }
        uploadBtn.disabled = true;
        core.uploadFile(confDir, f).then(function (r) {
          uploadBtn.disabled = false;
          if (r && r.ok) {
            toast('已上传 ' + f.name, 'ok');
            loadList();
          } else {
            toast('上传失败：' + ((r && r.error) || '未知错误'), 'danger');
          }
        }, function (e) {
          uploadBtn.disabled = false;
          toast('上传失败：' + ((e && e.message) || e), 'danger');
        });
      });

      loadList();
    }

    function loadList() {
      clear(listBox);
      listBox.appendChild(el('div', { class: 'pm-loading' }, [
        el('span', { class: 'pm-spin' }),
        el('span', { text: '读取目录' })
      ]));
      core.listFiles(confDir).then(function (r) {
        clear(listBox);
        var files = (r && Array.isArray(r.files)) ? r.files : [];
        if (!files.length) {
          listBox.appendChild(note(null, '目录为空或无法读取'));
          return;
        }
        var tbody = el('tbody');
        files.forEach(function (f) {
          if (f.isDir) return;
          var full = confDir + '/' + f.name;
          var ops = el('div', { class: 'pm-actions', style: 'justify-content:flex-end' });
          if (/\.conf(\.disabled)?$/.test(f.name) && full !== site.path) {
            ops.appendChild(btn('覆盖', 'is-xs is-danger', function () {
              runBuilt(PM.actions.buildApplyConf(site.path, full, state.env));
            }));
          }
          ops.appendChild(downloadLink('下载', full, 'is-xs'));
          tbody.appendChild(el('tr', null, [
            el('td', { text: f.name }),
            el('td', { class: 'pm-mono', text: humanSize(f.size) }),
            el('td', { class: 'pm-col-ops' }, [ops])
          ]));
        });
        listBox.appendChild(el('table', { class: 'pm-table' }, [tbody]));
      }, function (e) {
        clear(listBox);
        listBox.appendChild(note('danger', '读取目录失败：' + ((e && e.message) || e)));
      });
    }

    var dlg = openDialog(el('div', { style: 'display:contents' }, [
      el('div', { class: 'pm-dialog-head' }, [
        el('h3', { text: '站点配置文件 · ' + site.primary }),
        el('span', { class: 'pm-grow' })
      ]),
      body,
      el('div', { class: 'pm-dialog-foot' }, [
        btn('关闭', '', function () { dlg.close(); })
      ])
    ]), true);
  }

  /**
   * 日志查看器：走 exec/stream 边执行边显示输出（exec:stream 权限）。
   * 只做只读的 tail，不在目标机上留下任何进程。
   */
  function openLogViewer(env) {
    var candidates = ['/var/log/nginx/error.log'];
    if (env && env.baota && env.baota.present) {
      candidates = [
        '/www/server/nginx/logs/error.log',
        '/www/server/panel/logs/error.log',
        '/www/server/php/74/var/log/php-fpm.log'
      ];
    } else if (env && env.onepanel && env.onepanel.present) {
      candidates = [
        '/opt/1panel/apps/openresty/openresty/logs/error.log',
        '/opt/1panel/log/1Panel.log'
      ];
    }

    var out = el('pre', { class: 'pm-code', style: 'min-height:220px;max-height:420px' }, [
      el('span', { text: '尚未读取' })
    ]);
    var pathInput = el('input', { class: 'pm-input', type: 'text', value: candidates[0] || '' });
    var hint = el('div', { class: 'pm-field-hint', text: '候选路径：' + candidates.join('、') });
    var controller = null;

    var startBtn = el('button', { class: 'pm-btn is-xs is-primary', type: 'button', text: '开始读取' });
    var stopBtn = el('button', { class: 'pm-btn is-xs', type: 'button', text: '停止' });
    stopBtn.disabled = true;

    function setOut(text) {
      clear(out);
      out.appendChild(el('span', { text: text || '' }));
    }

    startBtn.addEventListener('click', function () {
      var chk = core.guard.checkPath(pathInput.value);
      if (!chk.ok) { toast(chk.error, 'warn'); return; }
      var script;
      try {
        script = 'tail -n 400 -- ' + core.shellQuote(chk.value) + ' 2>&1';
      } catch (e) {
        toast((e && e.message) || '路径不合法', 'warn');
        return;
      }
      controller = new AbortController();
      startBtn.disabled = true;
      stopBtn.disabled = false;
      setOut('', null);

      function append(text) {
        var node = out.firstChild;
        if (node) node.textContent += text;
        out.scrollTop = out.scrollHeight;
      }

      core.streamRun(['sh', '-c', script], {
        host: env && env.hostId ? env.hostId : core.bridge.hostId,
        timeout: 60,
        signal: controller.signal,
        onChunk: append
      }).then(function () {
        append('\n[读取结束]');
      }).catch(function (e) {
        var msg = (e && e.message) || String(e);
        if (e && e.name === 'AbortError') append('\n[已停止]');
        else append('\n[失败] ' + msg);
      }).then(function () {
        startBtn.disabled = false;
        stopBtn.disabled = true;
        controller = null;
      });
    });

    stopBtn.addEventListener('click', function () {
      if (controller) controller.abort();
    });

    var dlg = openDialog(el('div', { style: 'display:contents' }, [
      el('div', { class: 'pm-dialog-head' }, [
        el('h3', { text: '日志查看' }),
        el('span', { class: 'pm-grow' })
      ]),
      el('div', { class: 'pm-dialog-body' }, [
        el('div', { class: 'pm-field' }, [
          el('label', { text: '日志文件绝对路径' }),
          pathInput,
          hint
        ]),
        el('div', { class: 'pm-actions' }, [startBtn, stopBtn]),
        out
      ]),
      el('div', { class: 'pm-dialog-foot' }, [
        el('button', { class: 'pm-btn', type: 'button', text: '关闭', onclick: function () { dlg.close(); } })
      ])
    ]), true);

    return dlg;
  }

  /**
   * 面板命令行自检：展示 bt / 1pctl 这类 CLI 的真实输出。
   * 所有调用都在目标机上包了 timeout 并重定向了 stdin，不会因为等待输入而挂住。
   */
  function openPanelCli(env) {
    var body = el('div', { class: 'pm-dialog-body' });
    body.appendChild(note(null, '这些命令只做信息读取，不改动任何配置。宝塔的 bt 是交互式菜单，因此每条命令都加了 timeout 并把标准输入重定向到 /dev/null，防止在无终端环境里卡住。'));
    var box = el('div', { style: 'display:flex;flex-direction:column;gap:10px' }, [
      el('div', { class: 'pm-loading' }, [el('span', { class: 'pm-spin' }), el('span', { text: '正在调用面板命令行' })])
    ]);
    body.appendChild(box);

    var dlg = openDialog(el('div', { style: 'display:contents' }, [
      el('div', { class: 'pm-dialog-head' }, [
        el('h3', { text: '面板命令行自检' }),
        el('span', { class: 'pm-grow' })
      ]),
      body,
      el('div', { class: 'pm-dialog-foot' }, [
        btn('刷新', '', function () {
          PM.probe.probePanelCli(state.env && state.env.hostId, state.env).then(function (r) {
            clear(box);
            renderCliResults(box, r);
          });
        }),
        btn('关闭', 'is-primary', function () { dlg.close(); })
      ])
    ]), true);

    PM.probe.probePanelCli(state.env && state.env.hostId, state.env).then(function (r) {
      clear(box);
      renderCliResults(box, r);
    }, function (e) {
      clear(box);
      box.appendChild(note('danger', '调用失败：' + ((e && e.message) || e)));
    });
  }

  function renderCliResults(box, r) {
    if (!r || !r.ok) {
      box.appendChild(note('warn', (r && r.error) || '没有可调用的面板命令行'));
      return;
    }
    r.results.forEach(function (item) {
      box.appendChild(el('div', null, [
        el('div', { style: 'display:flex;gap:6px;align-items:center' }, [
          el('span', { class: 'pm-cmd-label', text: item.label }),
          item.ok ? badge('已返回', 'ok') : badge('执行失败', 'danger')
        ]),
        el('div', { style: 'margin-top:5px' }, [
          codeBlock((item.out || '') + (item.err ? '\n[stderr] ' + item.err : '') || '（无输出）')
        ])
      ]));
    });
  }

  /* ================================================================== *
   * 渲染总控
   * ================================================================== */

  function render() {
    setPanelChip(state.env);
    renderOverview();
    renderPhp();
    renderSites();
    renderLog();
  }

  function setState(patch) {
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) state[k] = patch[k];
    }
  }

  function switchTab(name) {
    var tabs = document.querySelectorAll('.pm-tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].dataset.view === name;
      tabs[i].classList.toggle('is-active', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var views = document.querySelectorAll('.pm-view');
    for (var j = 0; j < views.length; j++) {
      views[j].hidden = views[j].dataset.view !== name;
    }
  }

  function bindTabs() {
    var tabs = document.querySelectorAll('.pm-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (e) {
        switchTab(e.currentTarget.dataset.view);
      });
    }
  }

  /** 由 app.js 注入的刷新函数，供视图里的按钮回调 */
  function setHandlers(h) {
    handlers = h || {};
  }

  function refresh() {
    if (handlers.onRefresh) handlers.onRefresh();
  }

  PM.ui = {
    state: state,
    setState: setState,
    render: render,
    toast: toast,
    bindTabs: bindTabs,
    switchTab: switchTab,
    setStatus: setStatus,
    setHandlers: setHandlers,
    confirmSpec: confirmSpec,
    formDialog: formDialog,
    promptPassword: promptPassword,
    copyText: copyText,
    refresh: refresh
  };
})();
