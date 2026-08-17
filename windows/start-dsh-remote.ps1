# start-dsh-remote.ps1 — DSH 手机远程（Windows 版）
# 启动：密码网关 + Cloudflare 隧道（如 3080 空闲也会顺便拉起 DSH GUI）。
# 需要：Node.js 与 cloudflared 在 PATH 中。
$ErrorActionPreference = "Stop"

$DshDir  = Join-Path $env:USERPROFILE ".dsh"
$BinDir  = Join-Path $DshDir "bin"
$LogDir  = Join-Path $DshDir "logs"
$CfgFile = Join-Path $DshDir "remote-auth.json"
$UrlFile = Join-Path $DshDir "remote-url.txt"
New-Item -ItemType Directory -Force $BinDir, $LogDir | Out-Null

# 1) 首次运行生成随机密码与密钥
if (-not (Test-Path $CfgFile)) {
  $hex = { -join (1..$args[0] | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }) }
  $pw  = (& $hex 4) + "-" + (& $hex 4) + "-" + (& $hex 4)
  $cfg = @{
    password = $pw
    secret   = (& $hex 64)
    listen   = "127.0.0.1:8443"
    upstream = "http://127.0.0.1:3080"
    cookieName = "dsh_remote"
    cookieMaxAgeDays = 180
  } | ConvertTo-Json
  Set-Content -Path $CfgFile -Value $cfg -Encoding UTF8
}

# 2) 从仓库复制最新网关
$proxySrc = Join-Path $PSScriptRoot "..\proxy\dsh-auth-proxy.mjs"
Copy-Item $proxySrc (Join-Path $BinDir "dsh-auth-proxy.mjs") -Force

# 3) DSH GUI（3080 空闲才启动；已在跑则不动）
$portBusy = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
if (-not $portBusy) {
  Start-Process "cmd.exe" -ArgumentList '/c npm exec @deepseek-ai/dsh web ^> "%USERPROFILE%\.dsh\logs\dsh-web.out.log" 2^>^&1' -WindowStyle Hidden
}

# 4) 密码网关（后台）
Start-Process "node" -ArgumentList ('"' + (Join-Path $BinDir "dsh-auth-proxy.mjs") + '"') -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $LogDir "auth-proxy.out.log") `
  -RedirectStandardError  (Join-Path $LogDir "auth-proxy.err.log")

# 5) Cloudflare 隧道（后台，日志用于提取网址）
$cfLog = Join-Path $LogDir "cloudflared.log"
Remove-Item $cfLog, $UrlFile -ErrorAction SilentlyContinue
Start-Process "cloudflared" -ArgumentList "tunnel","--no-autoupdate","--url","http://127.0.0.1:8443" `
  -WindowStyle Hidden -RedirectStandardError $cfLog

# 6) 等隧道分配网址
$url = $null
for ($i = 0; $i -lt 60; $i++) {
  if (Test-Path $cfLog) {
    $m = Select-String -Path $cfLog -Pattern 'https://[-a-z0-9.]+trycloudflare\.com' | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value; break }
  }
  Start-Sleep -Seconds 1
}
if ($url) { Set-Content -Path $UrlFile -Value $url -Encoding UTF8 }

$pwOut = (Get-Content $CfgFile | ConvertFrom-Json).password
Write-Host ""
Write-Host "============================================================"
Write-Host " 安装完成！手机上这样用："
if ($url) { Write-Host "   1. 浏览器打开:  $url" } else { Write-Host "   1. 网址稍后见 $cfLog（隧道还在分配）" }
Write-Host "   2. 输入访问密码:  $pwOut"
Write-Host "   3. 添加到主屏幕，以后点图标即可"
Write-Host "============================================================"
Write-Host " 开机自启：把本脚本快捷方式放进 shell:startup，或用 README 里的 schtasks 命令"
