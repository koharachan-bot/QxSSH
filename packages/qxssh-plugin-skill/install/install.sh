#!/usr/bin/env bash
# QxSSH 插件技能安装脚本（不依赖 npm）
#   curl -fsSL https://cos.meowhead.cn/skill/install.sh | bash
#   curl -fsSL https://cos.meowhead.cn/skill/install.sh | bash -s -- --dir ~/.codex/skills
set -euo pipefail

BASE="${QXSSH_SKILL_BASE:-https://cos.meowhead.cn/skill}"
PKG="qxssh-plugin-skill-1.0.0.tgz"
NAME="qxssh-plugin"
TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) TARGET="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$TARGET" ]; then
  for d in "$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.cursor/skills"; do
    [ -d "$(dirname "$d")" ] && { TARGET="$d"; break; }
  done
fi
[ -z "$TARGET" ] && TARGET="$HOME/.claude/skills"
DEST="$TARGET/$NAME"

tmp="$(mktemp -d)"
trap "rm -rf $tmp" EXIT

echo "==> 下载 $BASE/$PKG"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$BASE/$PKG" -o "$tmp/pkg.tgz"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp/pkg.tgz" "$BASE/$PKG"
else
  echo "需要 curl 或 wget" >&2; exit 1
fi

echo "==> 解压"
mkdir -p "$tmp/x"
tar -xzf "$tmp/pkg.tgz" -C "$tmp/x"

echo "==> 安装到 $DEST"
mkdir -p "$TARGET"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$tmp/x/package/skill/." "$DEST/"

echo ""
echo "OK 已安装到: $DEST"
echo ""
echo "现在可以对 Agent 说：用 qxssh-plugin 技能做一个插件并发布"
echo ""
echo "发布前在 https://app.meowhead.cn/account 生成 API Key，然后："
echo "  export QXSSH_API_KEY=qxk_xxxx"
echo "  bash $DEST/scripts/publish.sh my-app.qxp 首个版本"
