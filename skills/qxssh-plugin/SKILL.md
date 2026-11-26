---
name: qxssh-plugin
description: 制作并发布 QxSSH 插件（应用商店应用）。当用户要开发 QxSSH 插件/应用、打包 .qxp、通过开发者平台 API 上传发布、或排查插件安装失败时使用。
---

# QxSSH 插件制作与发布

QxSSH 的"插件"就是一份带 `manifest.json` 的静态资源包（`.qxp`，本质是 zip）。
装进 QxSSH 后表现为桌面上的一个应用窗口。两种形态：

| 形态 | 声明 | 窗口里是什么 |
| --- | --- | --- |
| Web 应用 | 不写 `runtime` | 你的 `index.html`（iframe 内运行，走 `qx.*` SDK 调宿主 API） |
| Linux 图形应用 | `"runtime": "linux-gui"` | 宿主在远端 Linux 主机上跑的原生程序（微信/Blender 等），画面以 H.264 推流 |

## 流程总览

```
写 manifest + 页面  →  本地打包 .qxp  →  用 API Key 上传  →  提交审核  →  管理员上架  →  客户端可见
```

---

## 1. 写 manifest.json

放在项目根目录。

```json
{
  "id": "my-app",
  "name": "我的应用",
  "version": "1.0.0",
  "description": "一句话说明",
  "author": "你的名字",
  "category": "工具",
  "keywords": ["demo"],
  "entry": "index.html",
  "preferredSize": { "width": 900, "height": 620, "minWidth": 480, "minHeight": 320 },
  "permissions": ["hosts:read", "exec:run"]
}
```

要点：

- `id` 只允许字母数字 `-` `_`，最长 64，**创建后不可改**，且必须与包内 manifest 一致。
- `version` 只允许 `[0-9A-Za-z._+-]`，最长 32（含 `/` 或 `..` 会被安装器直接拒绝）。
- `entry` 必须是包内真实存在的 HTML；Linux 图形应用可省略。
- `permissions` 逐条申请，装的时候用户会看到；写多了会被当成可疑应用。
- 不要写 `systemApp` / `disableable`——那是内置应用专用，第三方包声明会被拒绝。

常用权限见 `references/permissions.md`。

### Linux 图形应用（可选）

```json
{
  "id": "wechat",
  "name": "微信",
  "runtime": "linux-gui",
  "gui": {
    "command": ["wechat"],
    "screen": { "width": 1200, "height": 820, "depth": 24 },
    "fps": 30,
    "bitrateKbps": 2500,
    "softwareGL": false,
    "windowManager": "auto"
  }
}
```

目标主机需要 `Xvfb`、`ffmpeg`、`python3`（可选 `xclip`、`openbox`）。

---

## 2. 打包

```bash
# 在 QxSSH 仓库根目录
go run ./tools/packgui -dir /path/to/my-app -out dist/my-app.qxp
```

或用脚本：`bash scripts/pack.sh /path/to/my-app dist/my-app.qxp`

包内**不能**有以下内容（会被拒）：

- `.qx-` 开头的文件（宿主保留元数据）
- 超过 50MB 的单个文件、解压总量超 100MB、文件数超 500

---

## 3. 发布（API）

### 3.1 拿 API Key

登录 <https://app.meowhead.cn/account> → **API Key** → 生成。明文只显示一次。

存到环境变量：

```bash
export QXSSH_API_KEY="qxk_xxxxxxxxxxxx"
export QXSSH_API="https://app.meowhead.cn"
```

### 3.2 五步发布

```bash
# 0. 自检身份
curl -s "$QXSSH_API/api/v1/me" -H "Authorization: Bearer $QXSSH_API_KEY"

# 1. 创建应用（已存在则更新元信息）
curl -s -X POST "$QXSSH_API/api/v1/apps" \
  -H "Authorization: Bearer $QXSSH_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"my-app","name":"我的应用","summary":"一句话说明","category":"工具"}'

# 2. 上传安装包（返回它的内部 id，通常是 1、2…）
curl -s -X POST "$QXSSH_API/api/v1/apps/1/upload" \
  -H "Authorization: Bearer $QXSSH_API_KEY" \
  -F "package=@dist/my-app.qxp" \
  -F "changelog=首个版本"

# 3. 提交审核
curl -s -X POST "$QXSSH_API/api/v1/apps/1/submit" \
  -H "Authorization: Bearer $QXSSH_API_KEY"

# 4. 上架（需要管理员权限；普通开发者到这一步为止，等管理员审核）
curl -s -X POST "$QXSSH_API/api/v1/apps/1/publish" \
  -H "Authorization: Bearer $QXSSH_API_KEY"

# 5. 确认线上索引
curl -s "$QXSSH_API/api/v1/catalog" -H "Authorization: Bearer $QXSSH_API_KEY"
```

一键脚本：`bash scripts/publish.sh dist/my-app.qxp`（读 `QXSSH_API_KEY`）。

### 3.3 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/me` | 当前 Key 的身份与角色 |
| GET | `/api/v1/apps` | 我的应用列表 |
| POST | `/api/v1/apps` | 创建/更新应用（JSON） |
| POST | `/api/v1/apps/{id}/upload` | 上传 .qxp（multipart，字段 `package`，可选 `changelog`） |
| POST | `/api/v1/apps/{id}/submit` | 提交审核 |
| POST | `/api/v1/apps/{id}/publish` | 上架（管理员） |
| POST | `/api/v1/apps/{id}/reject` | 驳回（管理员，JSON `{"note":"原因"}`） |
| GET | `/api/v1/catalog` | 拉取线上商店索引 |

认证：`Authorization: Bearer qxk_...` 或 `X-API-Key: qxk_...`。

错误统一返回 `{"error": "..."}`，HTTP 4xx/5xx。

---

## 4. 版本、更新与降级

- 每次 upload 都会在平台留一条版本记录，同 `app_id` 可保留多个版本。
- 上架后商店索引里同一应用会有多条记录（每版一条），最新版带 `"latest": true`。
- 客户端据版本号比较：已装版本落后 → 提示「更新」；用户也能从下拉里选任意历史版本安装（降级）。
- 版本号比较规则：按 `.` `-` `+` 切段，数字段按数值比，非数字段按字典序；`1.0` 与 `1.0.0` 等价。

---

## 5. 排错

| 现象 | 原因 |
| --- | --- |
| `manifest.runtime 应为 linux-gui，实际 ""` | 用了只支持图形应用的旧打包器；当前 packgui 已支持普通 Web 应用 |
| 安装时报「manifest.version 非法」 | 版本号含 `/` 或 `..`，或超过 32 字符 |
| 安装时报「与内置应用冲突」 | `id` 撞了内置应用（store/settings/hosts/terminal/files/tunnels/logs/taskmon/systemd/browser），换一个 |
| 上传 400「包内 manifest.id ... 不一致」 | 平台登记的 `app_id` 与包内不一致，改包内 manifest 或用正确的 app_id |
| 商店里看不到刚发布的应用 | 索引有 CDN 缓存，通常几分钟内生效；`GET /api/v1/catalog` 可确认源站内容 |
| API 返回 401 | Key 无效或已作废；到 /account 重新生成 |
