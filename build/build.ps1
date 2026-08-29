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

.PARAMETER Channel
  dev (default) keeps the fill logs: the local recording of what a form looked
  like, what the model was asked, and what was actually submitted. That is a
  development tool for improving the filling, not something to ship.

  store strips it from the package: fillLogger.js and pageHook.js are left out,
  every block between "ff:logs:start" and "ff:logs:end" markers is removed from
  the remaining files, and the manifest loses the page-world content script and
  the unlimitedStorage permission. The published extension therefore cannot
  record page content, submissions or request bodies at all.
#>
[CmdletBinding()]
param(
  [ValidateSet('firefox', 'chrome', 'all')]
  [string]$Target = 'all',
  [switch]$Zip,
  [ValidateSet('dev', 'store')]
  [string]$Channel = 'dev'
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

# The fill logs, dropped from store packages.
$logFiles = @('fillLogger.js', 'pageHook.js')
$logMarked = @('popup.html', 'popup.js', 'background.js', 'content.js', 'fillAgent.js', 'README.md')

# Remove every "ff:logs:start" .. "ff:logs:end" block, markers and all.
function Remove-LogBlocks([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $text = Get-Content -Raw -LiteralPath $path
  if ($text -notmatch 'ff:logs:start') { return }
  $stripped = [regex]::Replace($text, '(?s)[^\r\n]*ff:logs:start.*?ff:logs:end[^\r\n]*(\r?\n)?', '')
  if ($stripped -match 'ff:logs:(start|end)') { throw "Unbalanced log markers in $path" }
  [System.IO.File]::WriteAllText($path, $stripped, (New-Object System.Text.UTF8Encoding $false))
}

# Drop the page-world hook and the storage permission the logs needed.
function Remove-LogManifestEntries([string]$path) {
  $m = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
  $m.content_scripts = @($m.content_scripts | Where-Object { $_.js -notcontains 'pageHook.js' })
  foreach ($cs in $m.content_scripts) { $cs.js = @($cs.js | Where-Object { $logFiles -notcontains $_ }) }
  $m.permissions = @($m.permissions | Where-Object { $_ -ne 'unlimitedStorage' })
  [System.IO.File]::WriteAllText($path, ($m | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding $false))
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

  if ($Channel -eq 'store') {
    foreach ($f in $logFiles) {
      $p = Join-Path $out $f
      if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
    foreach ($f in $logMarked) { Remove-LogBlocks (Join-Path $out $f) }
    Remove-LogManifestEntries (Join-Path $out 'manifest.json')

    # Nothing that records may survive in a store package.
    $leftovers = Get-ChildItem -LiteralPath $out -Recurse -File -Include *.js, *.html, *.json |
      Select-String -Pattern 'FillLogger|ffLog|ff-record|ff-net-capture|pageHook' |
      Select-Object -ExpandProperty Path -Unique
    if ($leftovers) { throw ("Log code left in the store package: " + ($leftovers -join ', ')) }
  }

  $version = (Get-Content -Raw -LiteralPath (Join-Path $out 'manifest.json') | ConvertFrom-Json).version
  Write-Host ("Built {0} v{1} ({2}) -> {3}" -f $name, $version, $Channel, $out) -ForegroundColor Green

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
