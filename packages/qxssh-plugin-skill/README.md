# qxssh-plugin-skill

QxSSH 插件（应用商店应用）的开发与发布技能，以 [Agent Skill](https://www.anthropic.com/news/skills) 形式分发。

## 安装

```bash
npx qxssh-plugin-skill
```

默认装到已存在的 Agent skills 目录（`~/.claude/skills`、`~/.codex/skills` 等）。
也可以指定：

```bash
npx qxssh-plugin-skill --dir ~/.claude/skills
npx qxssh-plugin-skill --print     # 只打印目标路径
npx qxssh-plugin-skill --force     # 覆盖已安装
```

装好后对 Agent 说：「用 qxssh-plugin 技能做一个插件并发布」。

## 里面有什么

| 文件 | 用途 |
| --- | --- |
| `SKILL.md` | 完整流程：manifest 规范、打包、五步发布、排错 |
| `scripts/pack.sh` | 把插件目录打成 `.qxp` |
| `scripts/publish.sh` | 用 API Key 上传并发布 |
| `references/permissions.md` | 权限清单与危险级别 |
| `references/api.md` | 发布 API 细节 |

## 发布到应用商店

1. 在 <https://app.meowhead.cn/account> 生成 API Key
2. `export QXSSH_API_KEY=qxk_xxx`
3. `bash .../scripts/publish.sh my-app.qxp "首个版本"`

管理员加 `--publish` 可直接上架，否则等审核。

## License

MIT
