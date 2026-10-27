# dscs-server installer for Windows.
#
# Installs the published `dscs-server` npm package into a versioned directory,
# switches a `current` junction, and optionally registers an AtStartup task.
# It never updates itself and never removes data unless -Purge is explicit.
[CmdletBinding()]
param(
  [string]$Version = "latest",
  [string]$InstallDir = "",
  [string]$DataDir = "",
  [string]$BindHost = "127.0.0.1",
  [int]$Port = 8787,
  [string]$Source = "",
  [string]$Registry = "",
  [switch]$NoService,
  [switch]$Upgrade,
  [switch]$Uninstall,
  [switch]$Purge,
  [switch]$Yes,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$TaskName = "dscs-server"
$ServiceLabel = "未安装"

function Write-Step([string]$Message) { Write-Host "[dscs] $Message" }
function Write-Warn([string]$Message) { Write-Warning "[dscs] $Message" }
function Fail([string]$Message) { throw "[dscs] $Message" }

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Stop-DscsTask {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
}

function Find-ServerEntry([string]$ReleaseDir) {
  $candidates = @(
    (Join-Path $ReleaseDir "node_modules\dscs-server\dist\index.js"),
    (Join-Path $ReleaseDir "package\dist\index.js"),
    (Join-Path $ReleaseDir "dist\index.js")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

function Install-FromArchive([string]$Archive, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($null -eq $tar) { Fail "需要 tar.exe 解压本地安装包" }
  & $tar.Source -xzf $Archive -C $Destination
  if ($LASTEXITCODE -ne 0) { Fail "解压失败：$Archive" }
  $nested = Join-Path $Destination "package"
  if (Test-Path -LiteralPath $nested) {
    Get-ChildItem -LiteralPath $nested -Force | Move-Item -Destination $Destination -Force
    Remove-Item -LiteralPath $nested -Recurse -Force
  }
}

function Wait-Health([int]$ListenPort) {
  for ($i = 0; $i -lt 10; $i += 1) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$ListenPort/health"
      if ($response.StatusCode -eq 200) { return $true }
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  return $false
}

if ($Help) {
  Write-Host @"
用法: install.ps1 [选项]

  -Version <v>        安装指定 npm 版本，默认 latest
  -InstallDir <dir>   程序目录；管理员默认 Program Files\dscs，普通用户默认 LocalAppData\dscs
  -DataDir <dir>      数据目录；管理员默认 ProgramData\dscs，普通用户默认 <install-dir>\data
  -BindHost <addr>    监听地址，默认 127.0.0.1
  -Port <n>           监听端口，默认 8787
  -Source <archive>   从本地 .tgz/.tar.gz 安装，而不是 npm
  -Registry <url>     覆盖 npm registry
  -NoService          不注册开机启动任务
  -Upgrade            停服务、备份数据、安装新版本并启动
  -Uninstall          卸载程序和服务，保留数据
  -Purge              配合 -Uninstall，同时删除数据
  -Yes                不询问确认
  -Help               显示帮助

需要 Node.js >= 24 和 npm。
"@
  exit 0
}

if ($Port -lt 1 -or $Port -gt 65535) { Fail "端口必须在 1–65535 之间" }

$isAdmin = Test-Admin
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  if ($isAdmin) { $InstallDir = Join-Path $env:ProgramFiles "dscs" }
  else { $InstallDir = Join-Path $env:LOCALAPPDATA "dscs" }
}
if ([string]::IsNullOrWhiteSpace($DataDir)) {
  if ($isAdmin) { $DataDir = Join-Path $env:ProgramData "dscs" }
  else { $DataDir = Join-Path $InstallDir "data" }
}
if (-not $isAdmin -and -not $NoService) {
  Fail "注册服务需要管理员 PowerShell；请以管理员运行，或加 -NoService"
}

$ReleasesDir = Join-Path $InstallDir "releases"
$CurrentLink = Join-Path $InstallDir "current"

if ($Uninstall) {
  Write-Step "正在停止 dscs-server 任务"
  Stop-DscsTask
  if (Test-Path -LiteralPath $CurrentLink) { cmd /c rmdir "$CurrentLink" | Out-Null }
  if (Test-Path -LiteralPath $ReleasesDir) { Remove-Item -LiteralPath $ReleasesDir -Recurse -Force }
  if ($Purge) {
    if (-not $Yes) {
      $answer = Read-Host "是否删除数据目录 $DataDir？[y/N]"
      if ($answer -notmatch "^(?i)y") { Fail "已取消；数据未删除" }
    }
    if (Test-Path -LiteralPath $DataDir) { Remove-Item -LiteralPath $DataDir -Recurse -Force }
    Write-Step "已删除数据目录：$DataDir"
  } else {
    Write-Step "已保留数据目录：$DataDir（使用 -Purge 可删除）"
  }
  Write-Step "卸载完成"
  exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) { Fail "需要 Node.js >= 24" }
$nodeVersion = & $node.Source -p "process.versions.node"
if ([int]($nodeVersion.Split(".")[0]) -lt 24) { Fail "需要 Node.js >= 24（当前 $nodeVersion）" }
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
if ($null -eq $npm) { Fail "需要 npm" }
if (-not [string]::IsNullOrWhiteSpace($Registry)) { $env:npm_config_registry = $Registry }
if (-not [string]::IsNullOrWhiteSpace($Source) -and -not (Test-Path -LiteralPath $Source)) {
  Fail "找不到安装包：$Source"
}

New-Item -ItemType Directory -Force -Path $InstallDir, $ReleasesDir, $DataDir | Out-Null

if ($Upgrade) {
  Write-Step "正在停止 dscs-server 任务以升级"
  Stop-DscsTask
  if (Test-Path -LiteralPath $DataDir) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backup = "$DataDir.backup-$stamp.zip"
    Write-Step "正在备份数据到 $backup"
    Compress-Archive -Path $DataDir -DestinationPath $backup -Force
  }
}

if (-not [string]::IsNullOrWhiteSpace($Source)) {
  $releaseId = "local-" + (Get-Date -Format "yyyyMMdd-HHmmss")
  $releaseDir = Join-Path $ReleasesDir $releaseId
  Write-Step "正在安装本地包：$Source"
  Install-FromArchive -Archive $Source -Destination $releaseDir
} else {
  $resolvedVersion = $Version
  if ($resolvedVersion -eq "latest") {
    $resolvedVersion = (& $npm.Source view dscs-server version --silent)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($resolvedVersion)) {
      Fail "无法解析 dscs-server 最新版本"
    }
  }
  if ($resolvedVersion -notmatch "^[0-9A-Za-z._+-]+$") { Fail "版本号不合法：$resolvedVersion" }
  $releaseDir = Join-Path $ReleasesDir $resolvedVersion
  $entry = Find-ServerEntry $releaseDir
  if ($null -eq $entry) {
    Write-Step "正在安装 dscs-server@$resolvedVersion"
    & $npm.Source install --prefix $releaseDir --omit=dev --no-audit --no-fund "dscs-server@$resolvedVersion"
    if ($LASTEXITCODE -ne 0) { Fail "npm 安装失败" }
  }
}

$entry = Find-ServerEntry $releaseDir
if ($null -eq $entry) { Fail "安装后没有 dist/index.js" }
if (Test-Path -LiteralPath $CurrentLink) { cmd /c rmdir "$CurrentLink" | Out-Null }
New-Item -ItemType Junction -Path $CurrentLink -Target $releaseDir | Out-Null
Write-Step "服务端已安装到 $releaseDir"

if (-not $NoService) {
  $arguments = "`"$entry`" serve --data-dir `"$DataDir`" --host `"$BindHost`" --port $Port"
  $action = New-ScheduledTaskAction -Execute $node.Source -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  $ServiceLabel = "计划任务: $TaskName"
  if (Wait-Health -ListenPort $Port) {
    Write-Step "健康检查通过"
  } else {
    Write-Warn "健康检查未通过；请检查计划任务 $TaskName"
  }
}

$setupPath = Join-Path $DataDir "onboarding-code.json"
Write-Host @"

dscs-server 安装完成
  程序目录:   $releaseDir
  当前版本:   $CurrentLink
  数据目录:   $DataDir
  监听地址:   http://${BindHost}:$Port
  管理台:     http://127.0.0.1:$Port/admin
  初始化码:   $setupPath（首次启动，10 分钟内有效）
  服务状态:   $ServiceLabel

首次启动会打印初始化密钥。打开 /admin 设置管理密码，
然后签发设备 token，在 DSH 中填写同一服务端地址和同步口令。
"@
