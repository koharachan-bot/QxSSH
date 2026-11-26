/**
 * mirrors-data.js —— 国内镜像站生态数据与配置生成（纯数据 + 纯函数）
 *
 * 立场说明：镜像站可用性随厂商政策与网络环境变化，这里只登记“社区广泛使用”的地址，
 * 并区分状态（active 常用 / legacy 历史地址 / vendor 需自有账号 / private 内网）。
 * 任何站点是否真的可用，一律以此应用内的“连通性测试”结果为准，不做静态断言。
 */

/**
 * docker daemon 的 registry-mirrors 候选。
 * @type {Array<{id:string,name:string,url:string,note:string,status:'active'|'legacy'|'vendor'|'private',needFill?:boolean}>}
 */
export const MIRRORS = [
  {
    id: 'aliyun',
    name: '阿里云 ACR 专属加速器',
    url: 'https://<你的ID>.mirror.aliyuncs.com',
    note: '登录阿里云容器镜像服务控制台获取专属地址，国内最稳定的一类方案；地址因人而异。',
    status: 'vendor',
    needFill: true,
  },
  {
    id: 'daocloud',
    name: 'DaoCloud 公共镜像源',
    url: 'https://docker.m.daocloud.io',
    note: '社区维护的 Docker Hub 镜像代理，同时提供 gcr/quay/ghcr 等仓库的前缀代理。',
    status: 'active',
  },
  {
    id: '1ms',
    name: '毫秒镜像',
    url: 'https://docker.1ms.run',
    note: '社区公共加速地址，常用于 Docker Hub 拉取。',
    status: 'active',
  },
  {
    id: '1panel',
    name: '1Panel 镜像加速',
    url: 'https://docker.1panel.live',
    note: '1Panel 面板维护的公共加速地址。',
    status: 'active',
  },
  {
    id: 'xuanyuan',
    name: '轩辕镜像',
    url: 'https://docker.xuanyuan.me',
    note: '社区公共加速地址，可作前几项失效时的备用。',
    status: 'active',
  },
  {
    id: 'nju',
    name: '南京大学镜像站',
    url: 'https://docker.nju.edu.cn',
    note: '高校镜像站，服务策略以站方公告为准。',
    status: 'active',
  },
  {
    id: 'tencent-vpc',
    name: '腾讯云内网加速',
    url: 'https://mirror.ccs.tencentyun.com',
    note: '仅腾讯云 CVM 内网可用，公网访问不通；在腾讯云上部署时优先。',
    status: 'private',
  },
  {
    id: 'huawei',
    name: '华为云 SWR 加速',
    url: 'https://<你的ID>.swr.cn-north-4.myhuaweicloud.com',
    note: '在华为云 SWR 控制台获取专属加速地址。',
    status: 'vendor',
    needFill: true,
  },
  {
    id: 'ustc',
    name: '中科大镜像站',
    url: 'https://docker.mirrors.ustc.edu.cn',
    note: '历史常用地址，近年对外服务已调整，可能不可用。',
    status: 'legacy',
  },
  {
    id: '163',
    name: '网易蜂巢镜像',
    url: 'https://hub-mirror.c.163.com',
    note: '历史公共加速地址，服务已停止，仅作留档。',
    status: 'legacy',
  },
  {
    id: 'baidu',
    name: '百度云镜像',
    url: 'https://mirror.baidubce.com',
    note: '历史公共加速地址，可用性不稳定。',
    status: 'legacy',
  },
  {
    id: 'sjtug',
    name: '上海交大镜像站',
    url: 'https://docker.mirrors.sjtug.sjtu.edu.cn',
    note: '历史常用地址，公开服务已调整，可能不可用。',
    status: 'legacy',
  },
];

/**
 * 被墙 / 慢速仓库的国内前缀替代（DaoCloud d. 系列，公开文档可查）。
 * 用途：拉取 k8s、gcr、quay 等镜像时把原始引用替换成可直连前缀。
 */
export const REGISTRY_PROXIES = [
  { from: 'docker.io', to: 'docker.m.daocloud.io', note: 'Docker Hub 官方仓库' },
  { from: 'registry-1.docker.io', to: 'docker.m.daocloud.io', note: 'Docker Hub 实际端点' },
  { from: 'registry.k8s.io', to: 'k8s.m.daocloud.io', note: 'Kubernetes 官方镜像（含 kube-apiserver 等）' },
  { from: 'k8s.gcr.io', to: 'k8s.m.daocloud.io', note: 'k8s 旧域名，已迁移到 registry.k8s.io' },
  { from: 'gcr.io', to: 'gcr.m.daocloud.io', note: 'Google Container Registry' },
  { from: 'ghcr.io', to: 'ghcr.m.daocloud.io', note: 'GitHub Container Registry' },
  { from: 'quay.io', to: 'quay.m.daocloud.io', note: 'Red Hat Quay（Prometheus、etcd 等）' },
  { from: 'nvcr.io', to: 'nvcr.m.daocloud.io', note: 'NVIDIA GPU Cloud' },
  { from: 'mcr.microsoft.com', to: 'mcr.m.daocloud.io', note: '微软容器仓库' },
  { from: 'docker.elastic.co', to: 'elastic.m.daocloud.io', note: 'Elastic 官方镜像' },
  { from: 'registry.gitlab.com', to: 'gitlab.m.daocloud.io', note: 'GitLab 容器仓库' },
];

/**
 * daemon.json 预设方案：在保留用户既有键的前提下，按需覆盖。
 * @type {Array<{id:string,name:string,desc:string,opts:object}>}
 */
export const DAEMON_PRESETS = [
  {
    id: 'mirror-only',
    name: '仅加速拉取',
    desc: '只写 registry-mirrors，改动面最小，适合只想解决“拉不动”的场景。',
    opts: { mirrors: true, logRotate: false, liveRestore: false, throughput: false },
  },
  {
    id: 'recommended',
    name: '推荐：加速 + 日志轮转',
    desc: '加速拉取并给容器日志加轮转上限，避免 json-file 日志把磁盘写满（国内小云盘最常见的事故）。',
    opts: { mirrors: true, logRotate: true, liveRestore: false, throughput: true },
  },
  {
    id: 'full',
    name: '完整调优',
    desc: '加速 + 日志轮转 + live-restore + 并发调优，适合长期运行的生产主机。',
    opts: { mirrors: true, logRotate: true, liveRestore: true, throughput: true },
  },
];

/** 日志轮转默认值：单文件 50MB、最多 3 个，兼顾排查与磁盘 */
export const LOG_ROTATE_DEFAULT = { 'max-size': '50m', 'max-file': '3' };

/**
 * 合并生成新的 daemon.json 对象（不修改入参）。
 * 规则：只覆盖本方案涉及的键，其余用户自定义键原样保留。
 * @param {object} current 现有配置对象
 * @param {object} plan { mirrors:string[], logRotate:boolean, liveRestore:boolean, throughput:boolean, dataRoot:string, insecure:string[] }
 */
export function buildDaemonJson(current, plan) {
  const base = current && typeof current === 'object' ? JSON.parse(JSON.stringify(current)) : {};
  const p = plan || {};

  if (Array.isArray(p.mirrors) && p.mirrors.length) {
    // 去重且保持用户勾选顺序 —— 顺序决定优先级，排在前面的先试
    const seen = new Set();
    const list = [];
    for (const m of p.mirrors) {
      const v = String(m || '').trim().replace(/\/+$/, '');
      if (!v || seen.has(v)) continue;
      if (!/^https?:\/\//i.test(v)) continue;
      if (v.includes('<')) continue; // 未替换的模板占位符不入库
      seen.add(v);
      list.push(v);
    }
    if (list.length) base['registry-mirrors'] = list;
    else delete base['registry-mirrors'];
  } else if (p.mirrors && Array.isArray(p.mirrors) && !p.mirrors.length) {
    delete base['registry-mirrors'];
  }

  if (p.logRotate) {
    const cur = base['log-opts'] && typeof base['log-opts'] === 'object' ? base['log-opts'] : {};
    base['log-driver'] = base['log-driver'] || 'json-file';
    base['log-opts'] = { ...LOG_ROTATE_DEFAULT, ...cur };
  }

  if (p.liveRestore) base['live-restore'] = true;

  if (p.throughput) {
    if (!base['max-concurrent-downloads']) base['max-concurrent-downloads'] = 8;
    if (!base['max-concurrent-uploads']) base['max-concurrent-uploads'] = 4;
    if (!base['max-download-attempts']) base['max-download-attempts'] = 5;
  }

  if (p.dataRoot && String(p.dataRoot).trim()) {
    base['data-root'] = String(p.dataRoot).trim();
  }

  if (Array.isArray(p.insecure) && p.insecure.length) {
    const seen = new Set();
    const list = [];
    for (const m of p.insecure) {
      const v = String(m || '').trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      list.push(v);
    }
    if (list.length) base['insecure-registries'] = list;
  }

  return base;
}

/**
 * 判断引用第一段是否真的是仓库域（而不是 Docker Hub 的用户名或仓库名）。
 * Docker 的规则：第一段含 . 或 : 或等于 localhost 时才算域；
 * 必须先剥掉 tag/digest，否则 nginx:1.27 里的点会被误判成域。
 */
function isRegistryHost(first) {
  const head = String(first || '').split('@')[0].split(':')[0];
  return head.includes('.') || head === 'localhost';
}

/** 把原始镜像引用按代理表替换成国内可直连前缀；未命中返回原引用 */
export function applyProxy(ref, proxies) {
  const s = String(ref || '').trim();
  if (!s) return '';
  const table = Array.isArray(proxies) && proxies.length ? proxies : REGISTRY_PROXIES;
  const first = s.split('/')[0] || '';

  // 1) 显式写了仓库域的，按表精确替换
  for (const p of table) {
    const from = String(p.from || '');
    if (!from) continue;
    if (s === from) return p.to;
    if (s.startsWith(from + '/')) return p.to + s.slice(from.length);
  }

  // 2) 省略 docker.io 的短引用（nginx:1.27 / library/nginx / bitnami/redis:7）
  const hubProxy = table.find((x) => x.from === 'docker.io');
  if (hubProxy && !isRegistryHost(first)) {
    // 已经指向某个国内代理时不要重复加前缀
    if (table.some((x) => s.startsWith(x.to + '/'))) return s;
    return hubProxy.to + '/' + s.replace(/^\/+/, '');
  }
  return s;
}

/** 生成“从加速站拉取并回打原名”的可执行命令提示 */
export function pullHint(ref, mirrorBase) {
  const r = String(ref || '').trim();
  const m = String(mirrorBase || '').replace(/\/+$/, '');
  if (!r) return '';
  if (!m) return 'docker pull ' + r;
  return 'docker pull ' + m + '/' + r + ' && docker tag ' + m + '/' + r + ' ' + r;
}
