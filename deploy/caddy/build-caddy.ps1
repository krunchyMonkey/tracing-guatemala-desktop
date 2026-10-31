<#
  Reproducible Caddy build with the Cloudflare DNS provider (#166).

  Stock Caddy does not include DNS providers. This downloads a pinned Go
  toolchain (checksum verified) into -Root\toolchain, installs a pinned xcaddy
  and builds pinned Caddy + caddy-dns/cloudflare into -Root\bin\caddy.exe.
  Needs no administrator rights and touches nothing outside -Root.
#>
[CmdletBinding()]
param([Parameter(Mandatory)] [string]$Root)
$ErrorActionPreference = 'Stop'
# xcaddy logs to stderr; judge native commands by exit code only.
$PSNativeCommandUseErrorActionPreference = $false

$GoVersion = 'go1.27.3'
$GoSha256 = 'f26081f438319757f8a1b46d7d0b2c5ec7583d4038e485e0aa725cfde7885fff' # windows-amd64.zip, from go.dev/dl
$XcaddyVersion = 'v0.4.7'
$CaddyVersion = 'v2.11.7'
$CloudflareModule = 'github.com/caddy-dns/cloudflare@v0.2.4'

$toolchain = Join-Path $Root 'toolchain'
New-Item -ItemType Directory -Force $toolchain, (Join-Path $Root 'bin') | Out-Null
$goRoot = Join-Path $toolchain 'go'
if (-not (Test-Path (Join-Path $goRoot 'bin\go.exe'))) {
  $zip = Join-Path $toolchain "$GoVersion.windows-amd64.zip"
  Invoke-WebRequest "https://go.dev/dl/$GoVersion.windows-amd64.zip" -OutFile $zip
  $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($hash -ne $GoSha256) { Remove-Item $zip; throw "Go download checksum mismatch ($hash). Nothing was built." }
  Expand-Archive $zip $toolchain -Force
  Remove-Item $zip
}

$env:GOROOT = $goRoot
$env:GOPATH = Join-Path $toolchain 'gopath'
$env:GOCACHE = Join-Path $toolchain 'gocache'
$env:GOTOOLCHAIN = 'local'
$env:Path = "$goRoot\bin;$env:GOPATH\bin;$env:Path"

& go install "github.com/caddyserver/xcaddy/cmd/xcaddy@$XcaddyVersion"
if ($LASTEXITCODE -ne 0) { throw 'xcaddy install failed.' }
Push-Location $toolchain
try {
  & xcaddy build $CaddyVersion --with $CloudflareModule --output (Join-Path $Root 'bin\caddy.exe')
  if ($LASTEXITCODE -ne 0) { throw 'Caddy build failed.' }
} finally {
  Pop-Location
}
& (Join-Path $Root 'bin\caddy.exe') version
& (Join-Path $Root 'bin\caddy.exe') list-modules | Select-String 'dns.providers.cloudflare'
