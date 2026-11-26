# API 细节

## 认证

```
Authorization: Bearer qxk_xxxxxxxx
# 或
X-API-Key: qxk_xxxxxxxx
```

Key 在 <https://app.meowhead.cn/account> 生成，明文只显示一次，服务端只存 SHA-256。

## 端点

### GET /api/v1/me

```json
{"email":"a@b.c","nickname":"...","role":"developer","is_admin":false}
```

### GET /api/v1/apps

```json
{"apps":[{"id":1,"app_id":"my-app","name":"...","version":"1.0.0","status":"published",...}]}
```

`status` 取值：`draft` / `pending` / `approved` / `rejected` / `published`。

### POST /api/v1/apps

请求：

```json
{"app_id":"my-app","name":"我的应用","summary":"简介","category":"工具","author":"我"}
```

已存在且是自己的应用时更新元信息；被他人占用返回 403。

响应：

```json
{"ok":true,"created":true,"app":{"id":1,"app_id":"my-app",...}}
```

### POST /api/v1/apps/{id}/upload

`multipart/form-data`：

- `package`：`.qxp` 文件（必填，≤50MB）
- `changelog`：本版说明（可选）

会做完整校验：zip 结构、路径穿越、manifest.id 与登记一致、版本号字符集、入口页存在。

响应：

```json
{"ok":true,"app":{...},"sha256":"...","size":12345}
```

### POST /api/v1/apps/{id}/submit

无请求体。要求已上传过包。

### POST /api/v1/apps/{id}/publish

需要 `role=admin`。把应用置为 published 并**整体重发商店索引**（所有已上架应用的历史版本都会重新上传）。

响应里的 `catalog_entries` 是索引条目数（多版本时大于应用数）。

### POST /api/v1/apps/{id}/reject

需要 `role=admin`。

```json
{"note":"缺少权限说明"}
```

### GET /api/v1/catalog

拉取线上 `index.json`（带 `Cache-Control: no-cache`，尽量回源），用于发布后自检。

## 错误

```json
{"error":"包内 manifest.id 是 \"a\"，与登记的应用 id \"b\" 不一致"}
```
