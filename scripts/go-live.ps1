# GeoStar: bring everything up and put the live site online, in one command.
#
#   powershell -ExecutionPolicy Bypass -File scripts\go-live.ps1          start local + tunnels + redeploy the live site
#   powershell -ExecutionPolicy Bypass -File scripts\go-live.ps1 -Local   only localhost (API on 8000, website on 3000)
#   powershell -ExecutionPolicy Bypass -File scripts\go-live.ps1 -Stop    close the public tunnels (live site loses data)
#
# The live site (Vercel) has its own database (Neon Postgres) and keys. Only the CoStar data service stays on this
# laptop (the kit cannot leave it); the site reaches it through a temporary Cloudflare tunnel to port 8000.
# A tunnel's address changes whenever it restarts, so a new tunnel means a redeploy (about 2 minutes). A tunnel that
# is still working is reused, and nothing is redeployed.
# While the tunnels are open, anyone with the site link can see the CoStar data and use the AI features.
# The drone and real emergency calls stay local: they refuse anything that arrives through a tunnel.
param([switch]$Local, [switch]$Stop)

$repo = Split-Path -Parent $PSScriptRoot
$run = Join-Path $repo ".geostar-live"                             # logs and the last deployed addresses (gitignored)
$deploy = Join-Path (Split-Path -Parent $repo) "GeoStar-deploy"    # clean copy of the last commit, linked to Vercel
New-Item -ItemType Directory -Force $run | Out-Null

function Listening($port) { [bool](netstat -ano | Select-String ":$port\s+.*LISTENING") }
# curl.exe, not Invoke-WebRequest: Windows PowerShell 5.1 does not offer TLS 1.2 by default, which the tunnel requires.
function Reachable($url) { (curl.exe -s -m 20 -o NUL -w "%{http_code}" $url) -eq "200" }
function WaitFor($url, $seconds) {
  for ($i = 0; $i -lt $seconds; $i += 3) { if (Reachable $url) { return $true }; Start-Sleep 3 }
  return $false
}
function TunnelUrl($log) {
  if (-not (Test-Path $log)) { return $null }
  $m = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($m) { $m.Matches[0].Value }
}
# A working tunnel to a local port: the existing one when it still answers, otherwise a new one.
function EnsureTunnel($name, $port, $probe) {
  $log = Join-Path $run "tunnel-$name.log"
  $pidFile = Join-Path $run "tunnel-$name.pid"
  $url = TunnelUrl $log
  if ($url -and (Reachable "$url$probe")) { return $url }
  if (Test-Path $pidFile) { Stop-Process -Id (Get-Content $pidFile) -Force -ErrorAction SilentlyContinue }
  Remove-Item $log -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath "cloudflared" -ArgumentList "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$port" `
    -WindowStyle Hidden -RedirectStandardOutput (Join-Path $run "tunnel-$name.out.log") -RedirectStandardError $log -PassThru
  Set-Content $pidFile $p.Id
  $url = $null
  for ($i = 0; $i -lt 60 -and -not $url; $i++) { Start-Sleep 1; $url = TunnelUrl $log }
  if (-not $url) { throw "The $name tunnel did not start. See $log" }
  Start-Sleep 6   # a new address needs a few seconds before it resolves
  if (-not (WaitFor "$url$probe" 120)) { throw "The $name tunnel is up but port $port is not reachable through it." }
  return $url
}
# A public (browser-side) setting from the repo's .env, for the Vercel build. Never used for secret keys.
function PublicEnv($name) {
  $m = Select-String -Path (Join-Path $repo ".env") -Pattern "^$name=(.+)$" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($m) { $m.Matches[0].Groups[1].Value.Trim().Trim('"') }
}

if ($Stop) {
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  Get-ChildItem $run -Filter "tunnel-*" -ErrorAction SilentlyContinue | Remove-Item -Force
  Remove-Item (Join-Path $run "live-url.txt") -ErrorAction SilentlyContinue
  "Tunnels closed. The live site can no longer reach this laptop. Localhost is unaffected."
  exit 0
}

if (-not (Listening 8000)) {
  $env:PYTHONIOENCODING = "utf-8"
  Start-Process -FilePath (Join-Path $repo "services\api\.venv\Scripts\python.exe") `
    -ArgumentList "-m", "uvicorn", "app.main:app", "--port", "8000" -WorkingDirectory (Join-Path $repo "services\api") `
    -WindowStyle Hidden -RedirectStandardOutput (Join-Path $run "api.out.log") -RedirectStandardError (Join-Path $run "api.log")
}
if (-not (Listening 3000)) {
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev" -WorkingDirectory $repo `
    -WindowStyle Hidden -RedirectStandardOutput (Join-Path $run "web.log") -RedirectStandardError (Join-Path $run "web.err.log")
}
if (-not (WaitFor "http://127.0.0.1:8000/studio/defaults" 120)) { "The data service did not start. See $run\api.log"; exit 1 }
if (-not (WaitFor "http://127.0.0.1:3000/" 180)) { "The local website did not start. See $run\web.log"; exit 1 }
"Data service:  http://127.0.0.1:8000"
"Local website: http://localhost:3000/studio"
if ($Local) { exit 0 }

try {
  $url = EnsureTunnel "api" 8000 "/studio/defaults"
} catch { "$_"; exit 1 }
# The old second tunnel (laptop website) is no longer used: close it if it is still running.
$webPid = Join-Path $run "tunnel-web.pid"
if (Test-Path $webPid) { Stop-Process -Id (Get-Content $webPid) -Force -ErrorAction SilentlyContinue; Remove-Item $webPid, (Join-Path $run "tunnel-web.log") -ErrorAction SilentlyContinue }
"Public data address: $url"
$state = "$url"
$liveFile = Join-Path $run "live-url.txt"
$last = $null
if (Test-Path $liveFile) { $last = (Get-Content $liveFile -Raw).Trim() }
if ($last -eq $state) { "The live site already points at these addresses. Nothing to redeploy."; exit 0 }

if (-not (Test-Path (Join-Path $deploy ".vercel\project.json"))) {
  "No Vercel link in $deploy. Run 'vercel link' there once, then run this again."; exit 1
}
# Fresh copy of the last commit only: no .env, no CoStar kit, no databases. Keeps the Vercel link and ignore files.
Get-ChildItem $deploy -Force | Where-Object { $_.Name -notin ".vercel", ".vercelignore", "vercel.json" } |
  Remove-Item -Recurse -Force
cmd /c "cd /d `"$repo`" && git archive HEAD | tar -x -C `"$deploy`""
if (Test-Path (Join-Path $deploy ".env")) { "Refusing to deploy: a .env file is in the deploy copy."; exit 1 }

$vars = @{ NEXT_PUBLIC_API_URL = $url }
# Browser-side values only. Server secrets (Neon, Clerk, AI keys) are stored on the Vercel project itself.
foreach ($name in "NEXT_PUBLIC_MATTERPORT_SDK_KEY", "NEXT_PUBLIC_MAP_TILE_URL", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
                  "NEXT_PUBLIC_CLERK_SIGN_IN_URL", "NEXT_PUBLIC_CLERK_SIGN_UP_URL") {
  $value = PublicEnv $name
  if ($value) { $vars[$name] = $value }
}
$flags = @()
foreach ($k in $vars.Keys) { $flags += "--build-env"; $flags += "$k=$($vars[$k])"; $flags += "--env"; $flags += "$k=$($vars[$k])" }
$flags += "--env"; $flags += "PLOTSTAR_API_URL=$url"

Push-Location $deploy
# Keep Vercel's stored settings in step too, so deploys started by a git push use the current addresses.
foreach ($pair in @(@("NEXT_PUBLIC_API_URL", $url), @("PLOTSTAR_API_URL", $url))) {
  foreach ($target in "production", "preview") {
    $extra = @(); if ($target -eq "preview") { $extra = @("") }
    $pair[1] | & vercel env add $pair[0] $target @extra --force 2>&1 | Out-Null
  }
}
"Redeploying the live site (about 2 minutes)..."
$out = & vercel deploy --prod --yes @flags 2>&1 | Out-String
Pop-Location
$site = [regex]::Match($out, 'Production URL: (https://[^"\s]+)').Groups[1].Value
if ($site) { Set-Content $liveFile $state; "Live site: $site/studio" }
else { "The deploy did not report a site address. Output:"; $out; exit 1 }
"Keep this laptop awake. Run this script with -Stop when the demo is over."
