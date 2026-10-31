<#
  Starts the Tracing Guatemala HTTPS front: Caddy with Cloudflare DNS-01 (#166).

  The Cloudflare API token is read from the single .txt file in -SecretDir into
  this process's environment only, inherited by caddy.exe, and removed again when
  Caddy stops. It is never printed, logged or written anywhere else.

  The folder layout next to this script is:
    bin\caddy.exe      built by build-caddy.ps1
    config\Caddyfile   copied from deploy/caddy/Caddyfile
    data\              certificates, keys, ACME account (restricted ACL)
    logs\              caddy.log

  Defaults keep Caddy on loopback. Binding a home-network address (-BindHost)
  also needs a host firewall rule limited to the home subnet.
#>
[CmdletBinding()]
param(
  [string]$SecretDir = $env:TG_CADDY_SECRET_DIR,
  [string]$Hostname = 'tg.krunchymonkey.dev',
  [string]$BindHost = '127.0.0.1',
  [int]$HttpsPort = 443,
  [string]$Upstream = '127.0.0.1:4182',
  [switch]$Staging,
  [switch]$Validate
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$caddy = Join-Path $root 'bin\caddy.exe'
$config = Join-Path $root 'config\Caddyfile'

if (-not $SecretDir) { throw 'Give -SecretDir <folder> (or set TG_CADDY_SECRET_DIR). Not starting.' }
$secrets = @(Get-ChildItem -LiteralPath $SecretDir -File -Filter '*.txt')
if ($secrets.Count -ne 1) {
  throw "Expected exactly one .txt file in $SecretDir, found $($secrets.Count). Not starting."
}

# Refuse a token that every account on this computer can read.
$broad = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545') # Everyone, Authenticated Users, Users
foreach ($path in @($SecretDir, $secrets[0].FullName)) {
  foreach ($rule in (Get-Acl -LiteralPath $path).Access) {
    $sid = try { $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { '' }
    if ($rule.AccessControlType -eq 'Allow' -and $broad -contains $sid) {
      throw "$path is readable by $($rule.IdentityReference). Restrict it to your account, SYSTEM and Administrators first. Not starting."
    }
  }
}

$env:TG_HOSTNAME = $Hostname
$env:TG_BIND_HOST = $BindHost
$env:TG_HTTPS_PORT = "$HttpsPort"
$env:TG_UPSTREAM = $Upstream
$env:TG_LOG_DIR = (Join-Path $root 'logs') -replace '\\', '/'
$env:TG_ACME_CA = if ($Staging) { 'https://acme-staging-v02.api.letsencrypt.org/directory' } else { 'https://acme-v02.api.letsencrypt.org/directory' }
# Keep certificates, keys and the ACME account inside this folder, not %AppData%.
$env:XDG_DATA_HOME = Join-Path $root 'data'
$env:XDG_CONFIG_HOME = Join-Path $root 'data'

try {
  $env:CLOUDFLARE_API_TOKEN = (Get-Content -LiteralPath $secrets[0].FullName -Raw).Trim()
  if ([string]::IsNullOrEmpty($env:CLOUDFLARE_API_TOKEN)) { throw 'The token file is empty. Not starting.' }
  if ($Validate) {
    & $caddy validate --config $config --adapter caddyfile
  } else {
    & $caddy run --config $config --adapter caddyfile
  }
  exit $LASTEXITCODE
} finally {
  Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
}
