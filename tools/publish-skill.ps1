# publish-skill.ps1 —— 发布 qxssh-plugin-skill 到 npm（Windows）
# 用法:
#   $env:NPM_TOKEN = "npm_xxxxxxxx"
#   ./tools/publish-skill.ps1
param([string]$Dir = "packages/qxssh-plugin-skill")
$ErrorActionPreference = "Stop"
$token = $env:NPM_TOKEN
if (-not $token) { $token = $env:NODE_AUTH_TOKEN }
if (-not $token) {
  Write-Error "缺少 NPM_TOKEN，请先设置环境变量"
  exit 2
}
$rc = Join-Path $Dir ".npmrc"
try {
  "//registry.npmjs.org/:_authToken=$token`nregistry=https://registry.npmjs.org/" | Set-Content -LiteralPath $rc -Encoding ascii -NoNewline
  Push-Location $Dir
  Write-Host "==> 发布"
  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    pnpm publish --access public --no-git-checks
  } else {
    npm publish --access public
  }
  Write-Host "==> 验证"
  npm view qxssh-plugin-skill version
  Write-Host "完成：npx qxssh-plugin-skill"
} finally {
  Pop-Location
  Remove-Item -LiteralPath $rc -Force -ErrorAction SilentlyContinue
}
