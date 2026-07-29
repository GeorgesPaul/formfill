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

if (-not $ManifestPath) { $ManifestPath = Join-Path $PSScriptRoot '..\manifests\manifest.firefox.json' }
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

# A no-op replace means one of two very different things: the file has no version
# field (a real error), or it already holds the target version (fine, and normal
# when the version was set by hand). Test for the field itself to tell them apart.
function Set-ManifestVersion([string]$path, [string]$version) {
  $text = Get-Content -Raw -LiteralPath $path
  $name = Split-Path -Leaf $path
  if (-not $rx.IsMatch($text)) { throw "Could not locate the version field to update in $path" }
  $new = $rx.Replace($text, { param($m) $m.Groups[1].Value + $version + $m.Groups[2].Value }, 1)
  if ($new -eq $text) {
    Write-Host "$name already at $version." -ForegroundColor Green
    return
  }
  [IO.File]::WriteAllText($path, $new)  # UTF-8, no BOM; newlines preserved
  Write-Host "$name updated to $version." -ForegroundColor Green
}

Set-ManifestVersion $ManifestPath $next

# Keep the Chrome manifest on the same version so the two packages never drift.
$chromeManifest = Join-Path (Split-Path -Parent $ManifestPath) 'manifest.chrome.json'
if (Test-Path -LiteralPath $chromeManifest) {
  Set-ManifestVersion (Resolve-Path -LiteralPath $chromeManifest).Path $next
}
