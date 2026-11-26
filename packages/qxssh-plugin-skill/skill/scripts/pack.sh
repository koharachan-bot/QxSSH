#!/usr/bin/env bash
# pack.sh —— 把插件目录打成 .qxp
# 用法: bash scripts/pack.sh <插件目录> [输出.qxp]
set -euo pipefail

DIR="${1:-}"
OUT="${2:-}"
if [ -z "$DIR" ] || [ ! -f "$DIR/manifest.json" ]; then
  echo "用法: bash scripts/pack.sh <含 manifest.json 的目录> [输出.qxp]" >&2
  exit 2
fi
[ -z "$OUT" ] && OUT="${DIR%/}.qxp"

# 优先用仓库里的打包器（会做 manifest 校验），退回 zip 但要自己保证结构
if [ -f tools/packgui/main.go ]; then
  go run ./tools/packgui -dir "$DIR" -out "$OUT"
elif command -v packgui >/dev/null 2>&1; then
  packgui -dir "$DIR" -out "$OUT"
else
  echo "未找到 packgui，退回 zip 打包（不做校验）" >&2
  ( cd "$DIR" && zip -r -q "../$(basename "$OUT")" . -x "*.git*" )
  OUT="../$(basename "$OUT")"
fi
echo "已生成: $OUT"
