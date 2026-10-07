<#
.SYNOPSIS
  Rebuild dist\<target> whenever src\, manifests\, README.md or LICENSE change.

.DESCRIPTION
  Meant to run next to `web-ext run --source-dir dist\firefox`: web-ext only
  watches the built folder, so edits in src\ reach the browser only after a
  rebuild. This script does that rebuild, debounced so a burst of saves (an
  editor writing several files, a git checkout) produces one build.

  It exits on its own when the process that started it goes away (the
  `formfill` launcher's cmd.exe), or with Ctrl+C.

.PARAMETER Target
  firefox (default), chrome, or all. Passed to build\build.ps1.

.PARAMETER QuietSeconds
  How long the tree must stay unchanged before a build starts.
#>
[CmdletBinding()]
param(
  [ValidateSet('firefox', 'chrome', 'all')]
  [string]$Target = 'firefox',
  [int]$QuietSeconds = 1
)
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$build = Join-Path $root 'build\build.ps1'
$parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId

# Editor swap and backup files, which change on every keystroke in some editors.
$ignore = '(\.swp|\.swo|\.tmp|~|\\4913)$'

$watchers = @()
$watch = @(
  @{ Path = (Join-Path $root 'src'); Filter = '*'; Sub = $true },
  @{ Path = (Join-Path $root 'manifests'); Filter = '*'; Sub = $false },
  @{ Path = $root; Filter = 'README.md'; Sub = $false },
  @{ Path = $root; Filter = 'LICENSE'; Sub = $false }
)
foreach ($w in $watch) {
  $fsw = New-Object System.IO.FileSystemWatcher $w.Path, $w.Filter
  $fsw.IncludeSubdirectories = $w.Sub
  $fsw.NotifyFilter = [System.IO.NotifyFilters]'FileName, DirectoryName, LastWrite, Size'
  $fsw.InternalBufferSize = 65536
  # Events queue up while a build runs, so nothing saved mid-build is lost.
  foreach ($ev in 'Changed', 'Created', 'Deleted', 'Renamed') {
    Register-ObjectEvent -InputObject $fsw -EventName $ev -SourceIdentifier "ffwatch-$($watchers.Count)-$ev" | Out-Null
  }
  $fsw.EnableRaisingEvents = $true
  $watchers += $fsw
}

function Say([string]$msg, [string]$color = 'DarkCyan') {
  Write-Host ("[watch {0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg) -ForegroundColor $color
}

# Drain queued events; return the relative paths that matter.
function Take-Changes {
  $paths = @()
  foreach ($e in @(Get-Event -ErrorAction SilentlyContinue | Where-Object { $_.SourceIdentifier -like 'ffwatch-*' })) {
    $p = $e.SourceEventArgs.FullPath
    Remove-Event -EventIdentifier $e.EventIdentifier
    if ($p -and $p -notmatch $ignore) { $paths += $p.Substring($root.Length).TrimStart('\') }
  }
  return $paths
}

Say "watching src\, manifests\, README.md, LICENSE -> dist\$Target"
try {
  while ($true) {
    $first = Wait-Event -Timeout 1
    if (-not $first) {
      if ($parentPid -and -not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
      continue
    }
    # Debounce: keep collecting until the tree has been quiet for QuietSeconds.
    $changed = @(Take-Changes)
    while (Wait-Event -Timeout $QuietSeconds) {
      $changed += Take-Changes
    }
    $changed = @($changed | Select-Object -Unique)
    if (-not $changed.Count) { continue }

    $shown = ($changed | Select-Object -First 3) -join ', '
    if ($changed.Count -gt 3) { $shown += " (+$($changed.Count - 3) more)" }
    Say "changed: $shown"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $build -Target $Target
    if ($LASTEXITCODE -ne 0) { Say "build failed (exit $LASTEXITCODE); fix and save again" 'Red' }
  }
}
finally {
  Get-EventSubscriber | Where-Object { $_.SourceIdentifier -like 'ffwatch-*' } | Unregister-Event
  foreach ($fsw in $watchers) { $fsw.Dispose() }
}
