#!/usr/bin/env node
/**
 * build-store.mjs —— 生成 QxSSH 应用商店站点（index.json + .qxp + 图标）
 *
 * 扫描指定的应用目录，调用 packgui 逐个打包，产出可直接上传到对象存储或静态站的目录：
 *   <out>/index.json
 *   <out>/apps/packages/<id>-<version>.qxp
 *   <out>/apps/icons/<id>.<ext>
 *
 * 用法：
 *   node tools/build-store.mjs --out dist/store examples/gui-apps/wechat
 *   node tools/build-store.mjs --out dist/store --base https://app.meowhead.cn/ examples/gui-apps/*
 *
 * --base 写进 index.json 的 base 字段，客户端按它解析相对路径；不传则回退到索引地址所在目录。
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

function parseArgs(argv) {
  const out = { out: "dist/store", base: "", name: "QxSSH 应用商店", packgui: "dist/packgui.exe", dirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--name") out.name = argv[++i];
    else if (a === "--packgui") out.packgui = argv[++i];
    else out.dirs.push(a);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dirs.length) {
    console.error("用法：node tools/build-store.mjs --out dist/store <应用目录>...");
    process.exit(2);
  }

  const pkgs = path.join(opts.out, "apps", "packages");
  const icons = path.join(opts.out, "apps", "icons");
  await fs.mkdir(pkgs, { recursive: true });
  await fs.mkdir(icons, { recursive: true });

  const apps = [];
  for (const dir of opts.dirs) {
    let m;
    try {
      m = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
    } catch (e) {
      console.warn("跳过 " + dir + "：" + e.message);
      continue;
    }
    const id = m.id;
    const version = m.version || "1.0.0";
    const file = path.join(pkgs, id + "-" + version + ".qxp");
    await pexec(opts.packgui, ["-dir", dir, "-out", file]);
    const buf = await fs.readFile(file);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

    let icon = "";
    if (m.icon && /\.[a-z0-9]+$/i.test(m.icon)) {
      const ext = path.extname(m.icon);
      const dst = path.join(icons, id + ext);
      try {
        await fs.copyFile(path.join(dir, m.icon), dst);
        icon = "apps/icons/" + id + ext;
      } catch { /* 图标缺失不阻塞打包 */ }
    }

    apps.push({
      id,
      name: m.name || id,
      version,
      description: m.description || "",
      author: m.author || "",
      category: m.category || "",
      icon,
      file: "apps/packages/" + id + "-" + version + ".qxp",
      size: buf.length,
      sha256,
      runtime: m.runtime || "",
      keywords: m.keywords || [],
    });
    console.log(id + " -> " + buf.length + " bytes, sha256=" + sha256.slice(0, 12));
  }

  const catalog = { schema: 1, name: opts.name, updated: new Date().toISOString().slice(0, 10) };
  if (opts.base) catalog.base = opts.base;
  catalog.apps = apps;
  await fs.writeFile(path.join(opts.out, "index.json"), JSON.stringify(catalog, null, 2) + "\n", "utf8");
  console.log("写入 " + path.join(opts.out, "index.json") + "（" + apps.length + " 款应用）");
}

main().catch((e) => {
  console.error("生成失败：" + (e && e.message ? e.message : e));
  process.exit(1);
});
