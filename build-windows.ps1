# QxSSH Windows 构建脚本。
#
# 默认以 Windows GUI 子系统链接（-H windowsgui），这样 gui 插件启动时不会创建
# 控制台窗口；-web / -tui 运行时会自动接回父终端（见 internal/console 的控制台处理）。
param(
    [string]$Output = "qxssh.exe"
)

$ErrorActionPreference = "Stop"
go build -ldflags "-H windowsgui" -o $Output .
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
Write-Host "built $Output (windowsgui subsystem)"
