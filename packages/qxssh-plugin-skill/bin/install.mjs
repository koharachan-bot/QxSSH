#!/usr/bin/env node
/**
 * qxssh-plugin-skill 安装器
 *
 * 把 SKILL.md 与脚本复制到本机的 Agent skills 目录，让 Claude Code / Codex
 * 这类 Agent 能自动发现「做 QxSSH 插件」这项技能。
 *
 * 用法：
 *   npx qxssh-plugin-skill            自动检测目标目录并安装
 *   npx qxssh-plugin-skill --dir X    安装到指定目录
 *   npx qxssh-plugin-skill --print    只打印会装到哪里
 *   npx qxssh-plugin-skill --force    覆盖已存在
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'skill');
const NAME = 'qxssh-plugin';

const args = process.argv.slice(2);
const flag = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : true) : null;
};

function candidates() {
  const home = os.homedir();
  const out = [];
  // 常见的 Agent skills 根目录，按优先级排列
  for (const rel of ['.claude/skills', '.codex/skills', '.cursor/skills', '.dsh/skills']) {
    out.push(path.join(home, rel));
  }
  return out;
}

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function pickTarget(explicit) {
  if (explicit && typeof explicit === 'string') return path.resolve(explicit);
  const found = [];
  for (const c of candidates()) {
    if (await exists(path.dirname(c))) found.push(c);
  }
  // 已存在 skills 目录优先；一个都没有就默认装到 ~/.claude/skills
  if (found.length) return found[0];
  return candidates()[0];
}

async function main() {
  const target = await pickTarget(flag('--dir'));
  const dest = path.join(target, NAME);

  if (flag('--print')) {
    console.log(dest);
    return;
  }

  if ((await exists(dest)) && !flag('--force')) {
    console.log('已安装：' + dest);
    console.log('如需覆盖请加 --force');
    return;
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(SRC, dest, { recursive: true });

  console.log('✓ 已安装 QxSSH 插件技能到：' + dest);
  console.log('');
  console.log('现在可以直接对 Agent 说：');
  console.log('  「用 qxssh-plugin 技能做一个插件并发布」');
  console.log('');
  console.log('发布前需要在 https://app.meowhead.cn/account 生成 API Key，然后：');
  console.log('  export QXSSH_API_KEY=qxk_xxxx');
  console.log('  bash ' + path.join(dest, 'scripts', 'publish.sh') + ' my-app.qxp "首个版本"');
}

main().catch((e) => {
  console.error('安装失败：' + (e && e.message ? e.message : e));
  process.exit(1);
});
