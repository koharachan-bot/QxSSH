#!/usr/bin/env node
/**
 * mirror-runtime.mjs —— 把重型运行时镜像到自有 CDN，锁定版本
 *
 * 为什么需要它：.qxp 有 50MB 上限，Blender 这类 300~400MB 的运行时塞不进包，
 * 只能在目标主机按需下载。如果直连上游官方地址，上游一旦删版本或改路径，
 * 所有插件会同时失效。镜像到自己的 CDN 并把 sha256 写死，才不受上游影响。
 *
 * 用法：
 *   node tools/mirror-runtime.mjs --list              # 列出各应用的运行时清单
 *   node tools/mirror-runtime.mjs --app blender45     # 镜像单个应用
 *   node tools/mirror-runtime.mjs --app blender45 --dry-run
 *
 * 上传走 COS 匿名写（当前桶为公有写）；配置 COS_SECRET_KEY 后可改为签名上传。
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const COS_HOST = process.env.COS_HOST || "qxssh-1309442077.cos.ap-guangzhou.myqcloud.com";
const PUBLIC_BASE = process.env.STORE_RUNTIME_BASE || "https://cos.meowhead.cn/runtimes";

const APPS = ["examples/gui-apps", "examples/store-apps"];

async function loadManifests() {
  const out = [];
  for (const root of APPS) {
    let names = [];
    try { names = await fs.readdir(root); } catch { continue; }
    for (const name of names) {
      const p = path.join(root, name, "manifest.json");
      try {
        const m = JSON.parse(await fs.readFile(p, "utf8"));
        if (m?.gui?.install?.url) out.push({ dir: path.join(root, name), m });
      } catch { /* 忽略非应用目录 */ }
    }
  }
  return out;
}

function fileNameOf(url) {
  try { return path.basename(new URL(url).pathname); } catch { return ""; }
}

async function mirror(entry, dryRun) {
  const { dir, m } = entry;
  const inst = m.gui.install;
  const srcs = [inst.url, ...(inst.fallback || [])];
  const official = srcs.find((u) => !u.includes("cos.meowhead.cn")) || srcs[0];
  const name = fileNameOf(official);
  const dest = `${PUBLIC_BASE}/${name}`;

  console.log(`\n==> ${m.id}`);
  console.log(`    源: ${official}`);
  console.log(`    目标: ${dest}`);

  // 已指向自有镜像且是首选，说明已经镜像过
  if (inst.url === dest) {
    console.log("    已镜像，跳过");
    return;
  }

  if (dryRun) {
    console.log("    dry-run：不下载不上传");
    return;
  }

  console.log("    下载中…");
  const res = await fetch(official);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  console.log(`    大小 ${(buf.length / 1048576).toFixed(1)} MB  sha256=${sha.slice(0, 16)}…`);

  if (inst.sha256 && inst.sha256.toLowerCase() !== sha) {
    throw new Error(`sha256 不匹配：manifest=${inst.sha256} 实际=${sha}`);
  }

  console.log("    上传到 CDN…");
  const up = await fetch(`https://${COS_HOST}/runtimes/${name}`, {
    method: "PUT", body: buf,
    headers: { "Content-Type": "application/x-xz", "Cache-Control": "public, max-age=31536000" },
  });
  if (!up.ok) throw new Error(`上传失败 HTTP ${up.status} ${(await up.text()).slice(0, 200)}`);

  // 回写 manifest：首选自有镜像，官方地址保留为 fallback
  const p = path.join(dir, "manifest.json");
  const next = JSON.parse(await fs.readFile(p, "utf8"));
  next.gui.install = {
    ...next.gui.install,
    url: dest,
    fallback: [official],
    sha256: sha,
    size: buf.length,
  };
  await fs.writeFile(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log("    已更新 manifest.json");
}

async function main() {
  const args = process.argv.slice(2);
  const pick = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const dryRun = args.includes("--dry-run");
  const list = await loadManifests();

  if (args.includes("--list") || (!pick("--app") && !args.includes("--all"))) {
    console.log("带运行时的应用：");
    for (const { m } of list) {
      const inst = m.gui.install;
      const mirrored = inst.url.includes("cos.meowhead.cn");
      console.log(`  ${m.id.padEnd(14)} ${mirrored ? "已镜像" : "未镜像"}  ${fileNameOf(inst.url)}`);
    }
    console.log("\n用法: node tools/mirror-runtime.mjs --app <id> [--dry-run]  或  --all");
    return;
  }

  const only = pick("--app");
  const targets = only ? list.filter((e) => e.m.id === only) : list;
  if (!targets.length) { console.error("找不到该应用"); process.exit(1); }

  for (const t of targets) {
    await mirror(t, dryRun);
  }
}

main().catch((e) => { console.error("失败：" + (e?.message || e)); process.exit(1); });
