<#
  一键发布 Uber 收据下载脚本
  ------------------------------------------------
  提交并推送到 https://github.com/BEDUSER/uber-receipts-downloader
  安装源就是仓库的 raw 地址，推送后即生效；已安装的用户 24 小时内自动更新。

  用法（本机默认禁止运行脚本，必须带 Bypass）：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\publish.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\publish.ps1 "修复 xxx"

  GitHub 凭据取自 Windows 凭据管理器，不写文件、不打印。
#>
param([string]$Message = "")

$ErrorActionPreference = "Stop"
$File = Join-Path $PSScriptRoot "uber_receipts_batch.user.js"
$InstallUrl = "https://raw.githubusercontent.com/BEDUSER/uber-receipts-downloader/main/uber_receipts_batch.user.js"

# git 会把正常进度写到 stderr，别让它被当成致命错误
function Invoke-Git {
  param([string[]]$GitArgs)
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & git @GitArgs 2>&1 | ForEach-Object { Write-Host $_ }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $old
  }
}

if (-not (Test-Path $File)) { throw "找不到 $File" }

$content = [System.IO.File]::ReadAllText($File, [System.Text.Encoding]::UTF8)
$version = ([regex]::Match($content, '(?m)^//\s*@version\s+(\S+)')).Groups[1].Value
if (-not $version) { throw "读取 @version 失败" }
if (-not $Message) { $Message = "chore: release v$version" }

Push-Location $PSScriptRoot
try {
  Invoke-Git @("add", "-A") | Out-Null
  $code = Invoke-Git @("diff", "--cached", "--quiet")
  if ($code -eq 0) {
    Write-Host "仓库无改动，跳过提交"
  } else {
    $msg = "$Message`n`nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
    $tmp = Join-Path $env:TEMP "uber_rc_publish_msg.txt"
    [System.IO.File]::WriteAllText($tmp, $msg, (New-Object System.Text.UTF8Encoding($false)))
    Invoke-Git @("commit", "-F", $tmp) | Out-Null
    $pushCode = Invoke-Git @("push")
    if ($pushCode -ne 0) { throw "git push 失败（exit $pushCode）" }
  }
  Write-Host ""
  Write-Host "已发布 v$version" -ForegroundColor Green
  Write-Host "安装链接：$InstallUrl"
}
finally { Pop-Location }