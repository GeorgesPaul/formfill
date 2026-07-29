<#
.SYNOPSIS
  Assemble a loadable/uploadable extension for Firefox (MV2) and/or Chrome (MV3).

.DESCRIPTION
  One shared source tree lives in src\. The only per-browser file is the
  manifest, in manifests\. This script copies src\ into dist\<target>\, drops the
  right manifest in as manifest.json, and (with -Zip) packages it.

  Load unpacked while developing:
    Firefox : about:debugging -> This Firefox -> Load Temporary Add-on -> dist\firefox\manifest.json
    Chrome  : chrome://extensions -> Developer mode -> Load unpacked -> dist\chrome

.PARAMETER Target
  firefox, chrome, or all (default).

.PARAMETER Zip
  Also produce dist\formfill-<target>-<version>.zip.
#>
[CmdletBinding()]
param(
  [ValidateSet('firefox', 'chrome', 'all')]
  [string]$Target = 'all',
  [switch]$Zip
)
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$srcDir = Join-Path $root 'src'
$distDir = Join-Path $root 'dist'

# Files that belong to one browser only.
$targetOnlyFiles = @{
  chrome  = @('serviceWorker.js')   # MV3 entry point; Firefox uses background.scripts
  firefox = @()
}

function Build-Target([string]$name) {
  $manifest = Join-Path $root "manifests\manifest.$name.json"
  if (-not (Test-Path -LiteralPath $manifest)) { throw "Manifest not found: $manifest" }

  $out = Join-Path $distDir $name
  if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Recurse -Force }
  New-Item -ItemType Directory -Path $out -Force | Out-Null

  Copy-Item -Path (Join-Path $srcDir '*') -Destination $out -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $out -Force
  Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination $out -Force
  Copy-Item -LiteralPath $manifest -Destination (Join-Path $out 'manifest.json') -Force

  # Strip files meant for the other browser.
  foreach ($other in $targetOnlyFiles.Keys) {
    if ($other -eq $name) { continue }
    foreach ($f in $targetOnlyFiles[$other]) {
      $p = Join-Path $out $f
      if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
  }

  $version = (Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json).version
  Write-Host ("Built {0} v{1} -> {2}" -f $name, $version, $out) -ForegroundColor Green

  if ($Zip) {
    $zipPath = Join-Path $distDir ("formfill-{0}-{1}.zip" -f $name, $version)
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    # Prefer the `zip` CLI: it writes forward-slash entry names, which is what
    # AMO's validator and the Chrome Web Store expect.
    $zipExe = (Get-Command zip -ErrorAction SilentlyContinue)
    if ($zipExe) {
      Push-Location $out
      try { & $zipExe.Source -r -X -q $zipPath . }
      finally { Pop-Location }
    }
    else {
      Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zipPath -Force
    }
    Write-Host ("Packaged {0}" -f $zipPath) -ForegroundColor Green
  }
}

if (-not (Test-Path -LiteralPath $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }

switch ($Target) {
  'all' { Build-Target 'firefox'; Build-Target 'chrome' }
  default { Build-Target $Target }
}
