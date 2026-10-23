<#
  给 Windows 任务计划程序注册一个每日巡检（可选，不做也能用）。

  用法（在本目录下，PowerShell 里跑）：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-watch-task.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-watch-task.ps1 -Time 09:30
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-watch-task.ps1 -Remove

  它做的事：
    1. 每天指定时间跑 `node bin/resfinder.js watch --json`，结果写进 $DSH_HOME/resfinder/watch-log/<日期>.json
    2. 用当前用户身份运行，不需要管理员权限（只作用在当前用户的任务里）

  注意：巡检会真实发请求（每条 1~5 个）。库大了就调大 -Limit 或改小范围，别让任务每天扫几百条。
#>
param(
  [string]$Time = "09:00",
  [int]$Limit = 50,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$taskName = "dsh-resfinder-watch"

if ($Remove) {
  schtasks /Delete /TN $taskName /F 2>$null | Out-Null
  Write-Host "已删除任务 $taskName" -ForegroundColor Yellow
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "找不到 node，先把 Node 加进 PATH" }

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "D:\DeepSeekHarness\home" }
$logDir = Join-Path $dshHome "resfinder\watch-log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 用 cmd 包一层，才能把 stdout 重定向到按日期命名的文件
$cmdline = "cmd /c set DSH_HOME=$dshHome&& `"$node`" `"$root\bin\resfinder.js`" watch --limit $Limit --json > `"$logDir\%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%.json`" 2>&1"

schtasks /Create /TN $taskName /TR $cmdline /SC DAILY /ST $Time /F | Out-Null

Write-Host "已注册每日巡检任务：$taskName（每天 $Time，最多 $Limit 条）" -ForegroundColor Green
Write-Host "  命令：$cmdline"
Write-Host "  日志：$logDir\YYYYMMDD.json"
Write-Host "  取消：本脚本加 -Remove"
Write-Host ""
Write-Host "提示：任务在后台跑，不会弹窗；想立刻试一次就运行：" -ForegroundColor Cyan
Write-Host "  `$env:DSH_HOME='$dshHome'; node `"$root\bin\resfinder.js`" watch --limit $Limit"
