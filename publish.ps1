<#
  一键发布 Uber 收据下载脚本
  ------------------------------------------------
  做两件事：
    1) 把本目录的改动提交并推送到【私有】源码仓库
    2) 同步到【秘密 Gist】—— 即对外唯一的安装源

  用法：
    .\publish.ps1                  # 提交信息自动用 @version
    .\publish.ps1 "修复 xxx bug"   # 自定义提交信息

  GitHub Token 从 Windows 凭据管理器现取（git credential fill），
  不写入任何文件、不打印到屏幕。
#>
param([string]$Message = "")

$ErrorActionPreference = "Stop"

$GistId = "aad00af583ffef6911f1ceaca7bb2c42"
$File   = Join-Path $PSScriptRoot "uber_receipts_batch.user.js"

if (-not (Test-Path $File)) { throw "找不到 $File" }

$content = [System.IO.File]::ReadAllText($File, [System.Text.Encoding]::UTF8)
$version = ([regex]::Match($content, '(?m)^//\s*@version\s+(\S+)')).Groups[1].Value
if (-not $version) { throw "读取 @version 失败" }
if (-not $Message) { $Message = "chore: release v$version" }

Push-Location $PSScriptRoot
try {
  $cred = ("protocol=https`nhost=github.com`n`n" | git credential fill) 2>$null
  $tok = (($cred | Select-String '^password=') -replace '^password=','').ToString().Trim()
  if (-not $tok) { throw "未找到 GitHub 凭据，请先手动 git push 一次完成登录" }

  git add -A
  git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    "仓库无改动，跳过提交"
  } else {
    $msg = "$Message`n`nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
    $tmp = Join-Path $env:TEMP "uber_rc_publish_msg.txt"
    [System.IO.File]::WriteAllText($tmp, $msg, (New-Object System.Text.UTF8Encoding($false)))
    git commit -F $tmp 2>&1 | Out-String | Write-Host
    git push 2>&1 | Out-String | Write-Host
  }

  $h = @{
    Authorization = "Bearer $tok"
    Accept        = "application/vnd.github+json"
    "User-Agent"  = "codex-agent"
  }
  $body = @{
    description = "Uber 收据批量下载（安装源 v$version）"
    files       = @{ "uber_receipts_batch.user.js" = @{ content = $content } }
  } | ConvertTo-Json -Depth 6 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  Invoke-WebRequest -Uri "https://api.github.com/gists/$GistId" -Method PATCH -Headers $h `
    -Body $bytes -ContentType "application/json; charset=utf-8" -UseBasicParsing -TimeoutSec 60 | Out-Null

  "已发布 v$version"
  "安装链接：https://gist.githubusercontent.com/BEDUSER/$GistId/raw/uber_receipts_batch.user.js"
}
finally { Pop-Location }
