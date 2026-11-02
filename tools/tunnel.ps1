# Starts a public https tunnel to the BizMap API (http://localhost:8787) with Cloudflare's free "quick tunnel"
# and writes its address into .env as APP_URL, so Twilio can fetch call scripts and report keypresses.
# The address changes every time the tunnel starts: run this, then restart the API (npm run app:api).
# Stop the tunnel with: Stop-Process -Name cloudflared
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$exe = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $exe) { $exe = 'C:\Program Files (x86)\cloudflared\cloudflared.exe' }
if (-not (Test-Path $exe)) { throw 'cloudflared is not installed. Run: winget install --id Cloudflare.cloudflared' }

Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force   # one tunnel at a time
$log = Join-Path $env:TEMP 'bizmap-tunnel.log'
Remove-Item $log -ErrorAction SilentlyContinue
Start-Process $exe -ArgumentList 'tunnel', '--no-autoupdate', '--url', 'http://localhost:8787', '--logfile', "`"$log`"" -WindowStyle Hidden | Out-Null

$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $log) { $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $url = $m.Matches[0].Value } }
}
if (-not $url) { throw "No tunnel address after 30 s. See $log" }

$envFile = Join-Path $root '.env'
$lines = @(Get-Content $envFile -Encoding utf8 | Where-Object { $_ -notmatch '^APP_URL=' })
$lines += "APP_URL=$url"
[IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding $false))   # no BOM: Node reads .env
Write-Host "Tunnel running: $url"
Write-Host "APP_URL updated in .env. Restart the API so it uses it."
