# GeoStar: bring everything up and put the live site online, in one command.
#
#   powershell -ExecutionPolicy Bypass -File scripts\go-live.ps1          start local + tunnel + redeploy the live site
#   powershell -ExecutionPolicy Bypass -File scripts\go-live.ps1 -Local   only localhost (API on 8000, website on 3000)
#   powershell -ExecutionPolicy Bypass -File scripts\go-live.ps1 -Stop    close the public tunnel (live site loses data)
#
# The data service runs on this laptop. The live site (Vercel) reaches it through a temporary Cloudflare tunnel whose
# address changes whenever the tunnel restarts, so a new tunnel means a redeploy with the new address (about 2 minutes).
# A tunnel that is still working is reused, and nothing is redeployed.
# While the tunnel is open, anyone with the site link can see the CoStar data and use the AI features.
param([switch]$Local, [switch]$Stop)

$repo = Split-Path -Parent $PSScriptRoot
$run = Join-Path $repo ".geostar-live"                             # logs and the last deployed address (gitignored)
$deploy = Join-Path (Split-Path -Parent $repo) "GeoStar-deploy"    # clean copy of the last commit, linked to Vercel
New-Item -ItemType Directory -Force $run | Out-Null

function Listening($port) { [bool](netstat -ano | Select-String ":$port\s+.*LISTENING") }
# curl.exe, not Invoke-WebRequest: Windows PowerShell 5.1 does not offer TLS 1.2 by default, which the tunnel requires.
function Reachable($url) { (curl.exe -s -m 10 -o NUL -w "%{http_code}" $url) -eq "200" }
function WaitFor($url, $seconds) {
  for ($i = 0; $i -lt $seconds; $i += 3) { if (Reachable $url) { return $true }; Start-Sleep 3 }
  return $false
}
function TunnelUrl {
  $m = Select-String -Path "$run\tunnel.log" -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($m) { $m.Matches[0].Value }
}
# A public (browser-side) setting from the repo's .env, for the Vercel build. Never used for secret keys.
function PublicEnv($name) {
  $m = Select-String -Path (Join-Path $repo ".env") -Pattern "^$name=(.+)$" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($m) { $m.Matches[0].Groups[1].Value.Trim().Trim('"') }
}

if ($Stop) {
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  Remove-Item "$run\live-url.txt" -ErrorAction SilentlyContinue
  "Tunnel closed. The live site can no longer reach the data. Localhost is unaffected."
  exit 0
}

if (-not (Listening 8000)) {
  $env:PYTHONIOENCODING = "utf-8"
  Start-Process -FilePath (Join-Path $repo "services\api\.venv\Scripts\python.exe") `
    -ArgumentList "-m", "uvicorn", "app.main:app", "--port", "8000" -WorkingDirectory (Join-Path $repo "services\api") `
    -WindowStyle Hidden -RedirectStandardOutput "$run\api.out.log" -RedirectStandardError "$run\api.log"
}
if (-not (Listening 3000)) {
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev" -WorkingDirectory $repo `
    -WindowStyle Hidden -RedirectStandardOutput "$run\web.log" -RedirectStandardError "$run\web.err.log"
}
if (-not (WaitFor "http://127.0.0.1:8000/studio/defaults" 120)) { "The data service did not start. See $run\api.log"; exit 1 }
"Data service:  http://127.0.0.1:8000"
"Local website: http://localhost:3000/studio"
if ($Local) { exit 0 }

# Reuse a tunnel that is still working; a new one means a new address and a redeploy.
$url = $null
if (Get-Process cloudflared -ErrorAction SilentlyContinue) { $url = TunnelUrl }
if (-not ($url -and (Reachable "$url/studio/defaults"))) {
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  Remove-Item "$run\tunnel.log" -ErrorAction SilentlyContinue
  Start-Process -FilePath "cloudflared" -ArgumentList "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8000" `
    -WindowStyle Hidden -RedirectStandardOutput "$run\tunnel.out.log" -RedirectStandardError "$run\tunnel.log"
  $url = $null
  for ($i = 0; $i -lt 60 -and -not $url; $i++) { Start-Sleep 1; $url = TunnelUrl }
  if (-not $url) { "The tunnel did not start. See $run\tunnel.log"; exit 1 }
  Start-Sleep 6   # a new address needs a few seconds before it resolves
  if (-not (WaitFor "$url/studio/defaults" 90)) { "The tunnel is up but the data service is not reachable through it."; exit 1 }
}
"Public data address: $url"
$last = $null
if (Test-Path "$run\live-url.txt") { $last = (Get-Content "$run\live-url.txt" -Raw).Trim() }
if ($last -eq $url) { "The live site already points at this address. Nothing to redeploy."; exit 0 }

if (-not (Test-Path "$deploy\.vercel\project.json")) {
  "No Vercel link in $deploy. Run 'vercel link' there once, then run this again."; exit 1
}
# Fresh copy of the last commit only: no .env, no CoStar kit, no databases. Keeps the Vercel link and ignore files.
Get-ChildItem $deploy -Force | Where-Object { $_.Name -notin ".vercel", ".vercelignore", "vercel.json" } |
  Remove-Item -Recurse -Force
cmd /c "cd /d `"$repo`" && git archive HEAD | tar -x -C `"$deploy`""
if (Test-Path "$deploy\.env") { "Refusing to deploy: a .env file is in the deploy copy."; exit 1 }

$vars = @{ NEXT_PUBLIC_API_URL = $url }
foreach ($name in "NEXT_PUBLIC_MATTERPORT_SDK_KEY", "NEXT_PUBLIC_MAP_TILE_URL") {   # browser-side values, safe to ship
  $value = PublicEnv $name
  if ($value) { $vars[$name] = $value }
}
$flags = @()
foreach ($k in $vars.Keys) { $flags += "--build-env"; $flags += "$k=$($vars[$k])"; $flags += "--env"; $flags += "$k=$($vars[$k])" }
$flags += "--env"; $flags += "PLOTSTAR_API_URL=$url"

Push-Location $deploy
"Redeploying the live site (about 2 minutes)..."
$out = & vercel deploy --prod --yes @flags 2>&1 | Out-String
Pop-Location
$site = [regex]::Match($out, 'Production URL: (https://[^"\s]+)').Groups[1].Value
if ($site) { Set-Content "$run\live-url.txt" $url; "Live site: $site/studio" }
else { "The deploy did not report a site address. Output:"; $out; exit 1 }
"Keep this laptop awake. Run this script with -Stop when the demo is over."
