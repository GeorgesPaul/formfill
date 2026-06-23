<#
.SYNOPSIS
  Bump manifest.json to one patch above the highest version that exists on AMO.

.DESCRIPTION
  Queries addons.mozilla.org for the add-on's highest existing version (including
  in-review / disabled / deleted, so the new number can never collide), increments
  the last dotted component, and writes it into manifest.json (formatting preserved).

.PARAMETER Preview
  Show what the next version would be, but do NOT modify manifest.json.
#>
[CmdletBinding()]
param(
  [string]$AddonId = '{7d43f771-471b-4067-86f8-21812d277fa0}',
  [string]$ManifestPath,
  [switch]$Preview
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'amo_common.ps1')

if (-not $ManifestPath) { $ManifestPath = Join-Path $PSScriptRoot '..\manifest.json' }
if (-not (Test-Path -LiteralPath $ManifestPath)) { throw "manifest.json not found: $ManifestPath" }
$ManifestPath = (Resolve-Path -LiteralPath $ManifestPath).Path

$raw = Get-Content -Raw -LiteralPath $ManifestPath
$localVersion = ($raw | ConvertFrom-Json).version
if (-not $localVersion) { throw "No 'version' field in $ManifestPath" }

$cred = Get-AmoCredentials
Write-Host "Querying AMO for the highest existing version..."
$serverHighest = Get-AmoHighestVersion -Cred $cred -AddonId $AddonId

if ($serverHighest) {
  Write-Host "  AMO highest version: $serverHighest"
  $base = $serverHighest
}
else {
  Write-Host "  AMO returned no versions; basing on local manifest ($localVersion)." -ForegroundColor Yellow
  $base = $localVersion
}

$next = Step-Version $base
Write-Host ("  local manifest: {0}   ->   next: {1}" -f $localVersion, $next) -ForegroundColor Cyan

if ($Preview) {
  Write-Host "(preview: manifest.json was NOT modified)" -ForegroundColor Yellow
  return
}

# Replace only the first quoted "version" string value; leaves all other formatting intact.
$rx = [regex]'("version"\s*:\s*")[^"]*(")'
$updated = $rx.Replace($raw, { param($m) $m.Groups[1].Value + $next + $m.Groups[2].Value }, 1)
if ($updated -eq $raw) { throw "Could not locate the version field to update in $ManifestPath" }
[IO.File]::WriteAllText($ManifestPath, $updated)  # UTF-8, no BOM; newlines preserved
Write-Host "manifest.json updated to $next." -ForegroundColor Green
