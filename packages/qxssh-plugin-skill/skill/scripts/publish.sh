#!/usr/bin/env bash
# publish.sh —— 用 API Key 发布 .qxp 到 QxSSH 应用商店
#
# 用法:
#   export QXSSH_API_KEY=qxk_xxx
#   bash scripts/publish.sh <包.qxp> [changelog] [--publish]
#
# 环境变量:
#   QXSSH_API      默认 https://app.meowhead.cn
#   QXSSH_API_KEY  必填
#   --publish      上传+提交后立即上架（需要管理员权限）
set -euo pipefail

PKG="${1:-}"
CHANGELOG="${2:-}"
DO_PUBLISH=0
for a in "$@"; do [ "$a" = "--publish" ] && DO_PUBLISH=1; done

API="${QXSSH_API:-https://app.meowhead.cn}"
KEY="${QXSSH_API_KEY:-}"

if [ -z "$PKG" ] || [ ! -f "$PKG" ]; then
  echo "用法: bash scripts/publish.sh <包.qxp> [changelog] [--publish]" >&2
  exit 2
fi
if [ -z "$KEY" ]; then
  echo "缺少 QXSSH_API_KEY（在 $API/account 生成）" >&2
  exit 2
fi

jqget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null || true; }

echo "==> 1/5 校验身份"
ME=$(curl -sf "$API/api/v1/me" -H "Authorization: Bearer $KEY") || {
  echo "API Key 无效或服务不可达" >&2; exit 1; }
echo "    身份: $ME"

APP_ID=$(python3 - "$PKG" <<'PY'
import sys, zipfile, json
with zipfile.ZipFile(sys.argv[1]) as z:
    m = json.loads(z.read("manifest.json").decode("utf-8"))
print(m.get("id",""))
PY
)
if [ -z "$APP_ID" ]; then
  echo "包内 manifest.json 没有 id" >&2; exit 1
fi
NAME=$(python3 - "$PKG" <<'PY'
import sys, zipfile, json
with zipfile.ZipFile(sys.argv[1]) as z:
    m = json.loads(z.read("manifest.json").decode("utf-8"))
print(m.get("name") or m.get("id"))
PY
)
echo "    应用: $APP_ID ($NAME)"

echo "==> 2/5 创建/更新应用"
CREATED=$(curl -sf -X POST "$API/api/v1/apps" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$APP_ID\",\"name\":\"$NAME\"}") || {
  echo "创建应用失败" >&2; exit 1; }
echo "    $CREATED"
APP_PK=$(echo "$CREATED" | jqget "['app']['id']")
if [ -z "$APP_PK" ]; then
  echo "响应里没有 app.id" >&2; exit 1
fi

echo "==> 3/5 上传安装包"
UP=$(curl -sf -X POST "$API/api/v1/apps/$APP_PK/upload" \
  -H "Authorization: Bearer $KEY" \
  -F "package=@$PKG" -F "changelog=$CHANGELOG") || {
  echo "上传失败（检查包内容与版本号格式）" >&2; exit 1; }
echo "    $UP"

echo "==> 4/5 提交审核"
curl -sf -X POST "$API/api/v1/apps/$APP_PK/submit" \
  -H "Authorization: Bearer $KEY" >/dev/null || {
  echo "提交失败" >&2; exit 1; }
echo "    已提交"

if [ "$DO_PUBLISH" = "1" ]; then
  echo "==> 5/5 上架"
  curl -sf -X POST "$API/api/v1/apps/$APP_PK/publish" \
    -H "Authorization: Bearer $KEY" || { echo "上架失败（可能需要管理员权限）" >&2; exit 1; }
  echo "    已上架"
else
  echo "==> 5/5 跳过上架（等管理员审核；加 --publish 可直接上架）"
fi

echo "完成。线上索引: $API/api/v1/catalog"
