# Shared helpers for the addons.mozilla.org (AMO) v5 API. Dot-source this file:
#   . (Join-Path $PSScriptRoot 'amo_common.ps1')
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-AmoApiBase { 'https://addons.mozilla.org/api/v5' }

# Credentials come from env vars or $HOME\.amo\credentials.ps1 (NEVER from the repo).
function Get-AmoCredentials {
  $issuer = $env:AMO_JWT_ISSUER
  $secret = $env:AMO_JWT_SECRET
  if (-not $issuer -or -not $secret) {
    $credFile = Join-Path $HOME '.amo\credentials.ps1'
    if (Test-Path $credFile) {
      . $credFile
      if (-not $issuer) { $issuer = $AMO_JWT_ISSUER }
      if (-not $secret) { $secret = $AMO_JWT_SECRET }
    }
  }
  if (-not $issuer -or -not $secret) {
    throw "Missing AMO credentials. Set env vars AMO_JWT_ISSUER and AMO_JWT_SECRET, or create $HOME\.amo\credentials.ps1 (copy credentials.example.ps1). Get keys at https://addons.mozilla.org/developers/addon/api/key/"
  }
  [pscustomobject]@{ Issuer = $issuer; Secret = $secret }
}

# AMO JWTs are short-lived (max 5 min); generate a fresh one per request.
function New-AmoJwt {
  param([Parameter(Mandatory)][pscustomobject]$Cred)
  $b64url = { param([byte[]]$bytes) [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $header = '{"alg":"HS256","typ":"JWT"}'
  $payload = @{ iss = $Cred.Issuer; jti = [guid]::NewGuid().ToString(); iat = $now; exp = ($now + 120) } | ConvertTo-Json -Compress
  $h = & $b64url ([Text.Encoding]::UTF8.GetBytes($header))
  $p = & $b64url ([Text.Encoding]::UTF8.GetBytes($payload))
  $si = "$h.$p"
  $hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($Cred.Secret))
  try { $sig = & $b64url ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($si))) }
  finally { $hmac.Dispose() }
  "$si.$sig"
}

function Invoke-AmoGet {
  param([Parameter(Mandatory)]$Cred, [Parameter(Mandatory)][string]$Path)
  Invoke-RestMethod -Uri ('{0}{1}' -f (Get-AmoApiBase), $Path) -Headers @{ Authorization = "JWT $(New-AmoJwt $Cred)" }
}

# $true if version $A is strictly greater than $B (component-wise numeric compare, e.g. 1.10 > 1.9).
function Test-AmoVersionGreater {
  param([string]$A, [string]$B)
  $pa = @($A -split '\.'); $pb = @($B -split '\.')
  $n = [Math]::Max($pa.Count, $pb.Count)
  for ($i = 0; $i -lt $n; $i++) {
    $x = 0; $y = 0
    if ($i -lt $pa.Count) { [void][int]::TryParse(($pa[$i] -replace '\D.*$', ''), [ref]$x) }
    if ($i -lt $pb.Count) { [void][int]::TryParse(($pb[$i] -replace '\D.*$', ''), [ref]$y) }
    if ($x -ne $y) { return ($x -gt $y) }
  }
  return $false
}

# Highest version that exists on AMO (incl. in-review/disabled/deleted), or $null if none.
function Get-AmoHighestVersion {
  param([Parameter(Mandatory)]$Cred, [Parameter(Mandatory)][string]$AddonId)
  $idEnc = [uri]::EscapeDataString($AddonId)
  try {
    $resp = Invoke-AmoGet -Cred $Cred -Path "/addons/addon/$idEnc/versions/?filter=all_with_deleted&page_size=50"
    $versions = @($resp.results | ForEach-Object { $_.version } | Where-Object { $_ })
  }
  catch {
    # Fall back to the public "current_version" if the filtered list isn't accessible.
    try { return (Invoke-AmoGet -Cred $Cred -Path "/addons/addon/$idEnc/").current_version.version } catch { return $null }
  }
  if (-not $versions) { return $null }
  $max = $versions[0]
  foreach ($v in $versions) { if (Test-AmoVersionGreater $v $max) { $max = $v } }
  $max
}

# Increment the last dotted component by 1: 1.21 -> 1.22, 1.21.4 -> 1.21.5
function Step-Version {
  param([Parameter(Mandatory)][string]$Version)
  $parts = @($Version -split '\.')
  $last = 0
  [void][int]::TryParse(($parts[-1] -replace '\D.*$', ''), [ref]$last)
  $parts[-1] = [string]($last + 1)
  ($parts -join '.')
}
