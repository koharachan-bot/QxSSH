#!/usr/bin/env bash
# publish-skill.sh —— 发布 qxssh-plugin-skill 到 npm
#
# 用法:
#   export NPM_TOKEN=npm_xxxxxxxx      # npmjs.com 生成的 Automation token
#   bash tools/publish-skill.sh
#
# 会用临时 .npmrc 写入 token，发布结束后立即删除，不把凭据留在磁盘上。
set -euo pipefail

DIR="${1:-packages/qxssh-plugin-skill}"
TOKEN="${NPM_TOKEN:-${NODE_AUTH_TOKEN:-}}"

if [ -z "$TOKEN" ]; then
  echo "缺少 NPM_TOKEN。在 https://www.npmjs.com/settings/~/tokens 生成 Automation token 后：" >&2
  echo "  export NPM_TOKEN=npm_xxx" >&2
  exit 2
fi
if [ ! -f "$DIR/package.json" ]; then
  echo "找不到 $DIR/package.json" >&2
  exit 2
fi

cd "$DIR"
RC=".npmrc"
cleanup() { rm -f "$RC"; }
trap cleanup EXIT

printf '//registry.npmjs.org/:_authToken=%s\nregistry=https://registry.npmjs.org/\n' "$TOKEN" > "$RC"
chmod 600 "$RC" 2>/dev/null || true

echo "==> 预检"
node -e "const p=require('./package.json');console.log(p.name+'@'+p.version)"

echo "==> 发布"
if command -v pnpm >/dev/null 2>&1; then
  pnpm publish --access public --no-git-checks
else
  npm publish --access public
fi

echo "==> 验证"
npm view qxssh-plugin-skill version || true
echo "完成：npx qxssh-plugin-skill"
