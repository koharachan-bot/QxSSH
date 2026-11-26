# 构建 QxSSH 并安装到当前用户的程序目录，供双击启动。
#
# 以 Windows GUI 子系统链接（-H windowsgui）：gui 窗口启动时不创建控制台。
# 安装到 %LOCALAPPDATA%\Programs\QxSSH，避免把 exe 放在受限工作区目录里被
# 系统/安全软件以低完整性运行（那种情况下 Windows 会拒绝写入配置目录）。
param(
    [string]$Output = "qxssh.exe"
)

$ErrorActionPreference = "Stop"

go build -ldflags "-H windowsgui" -o $Output .
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$install = Join-Path $env:LOCALAPPDATA "Programs\QxSSH"
New-Item -ItemType Directory -Force -Path $install | Out-Null
$target = Join-Path $install "qxssh.exe"
Copy-Item $Output $target -Force

$desktop = [Environment]::GetFolderPath("Desktop")
$lnk = Join-Path $desktop "QxSSH.lnk"
if (-not (Test-Path $lnk)) {
    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($lnk)
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = $install
    $shortcut.IconLocation = $target + ",0"
    $shortcut.Description = "QxSSH SSH 管理控制台"
    $shortcut.Save()
}

Write-Host "installed: $target"
if (Test-Path $lnk) { Write-Host "shortcut:  $lnk" }
