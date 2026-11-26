# QxSSH 插件技能安装脚本（Windows PowerShell）
#   irm https://cos.meowhead.cn/skill/install.ps1 | iex
param([string]$Dir = "")
$ErrorActionPreference = "Stop"
$base = "https://cos.meowhead.cn/skill"
$pkg  = "qxssh-plugin-skill-1.0.0.tgz"
$name = "qxssh-plugin"

if (-not $Dir) {
  $cands = @("$env:USERPROFILE/.claude/skills", "$env:USERPROFILE/.codex/skills", "$env:USERPROFILE/.cursor/skills")
  foreach ($d in $cands) {
    $parent = Split-Path $d -Parent
    if (Test-Path $parent) { $Dir = $d; break }
  }
}
if (-not $Dir) { $Dir = "$env:USERPROFILE/.claude/skills" }
$dest = Join-Path $Dir $name

$tmp = Join-Path $env:TEMP ("qxs-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Write-Host "==> 下载 $base/$pkg"
  Invoke-WebRequest -Uri "$base/$pkg" -OutFile (Join-Path $tmp "pkg.tgz") -UseBasicParsing
  Write-Host "==> 解压"
  tar -xzf (Join-Path $tmp "pkg.tgz") -C $tmp
  Write-Host "==> 安装到 $dest"
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -Path (Join-Path $tmp "package/skill/*") -Destination $dest -Recurse -Force
  Write-Host ""
  Write-Host "OK 已安装到: $dest"
  Write-Host "发布前在 https://app.meowhead.cn/account 生成 API Key"
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
