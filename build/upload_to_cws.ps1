<#
.SYNOPSIS
  Upload a new version of the extension to the Chrome Web Store and submit it for review.

.DESCRIPTION
  Takes a pre-built zip (default: ..\dist\formfill-chrome-<version>.zip) and:
    1. PUT  /upload/chromewebstore/v1.1/items/{id}   -> replaces the draft
    2. GET  /chromewebstore/v1.1/items/{id}          -> confirm the draft version
    3. POST /chromewebstore/v1.1/items/{id}/publish  -> submit for review (skipped with -UploadOnly)

  Credentials and the OAuth token are handled by cws_common.ps1 (env vars or
  $HOME\.cws\credentials.ps1). Run get_cws_refresh_token.ps1 once to create them.

  The store rejects a re-upload of a version it already has, so the manifest
  version must be higher than the draft's. bump_version.ps1 keeps both manifests
  in step; this script only warns if they have drifted apart.

.PARAMETER CheckOnly
  Talk to the API and print what is in the store, upload nothing. Safe way to
  test the token and the item ID.

.PARAMETER UploadOnly
  Steps 1-2 only. The draft in the dashboard is updated but nothing is submitted
  for review, so you can eyeball the listing before pushing the button.

.PARAMETER Target
  default   - everyone (normal release)
  trustedTesters - the tester group only

.PARAMETER DeployPercentage
  Staged rollout, 1-99. Omit for a full rollout.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File upload_to_cws.ps1 -CheckOnly
  powershell -ExecutionPolicy Bypass -File upload_to_cws.ps1 -UploadOnly
  powershell -ExecutionPolicy Bypass -File upload_to_cws.ps1 -DeployPercentage 20
#>
[CmdletBinding()]
param(
  [string]$Zip,
  [string]$ItemId,
  [ValidateSet('default', 'trustedTesters')][string]$Target = 'default',
  [ValidateRange(1, 99)][int]$DeployPercentage,
  [int]$TimeoutSeconds = 300,
  [switch]$CheckOnly,
  [switch]$UploadOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'cws_common.ps1')

$manifestPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\manifests\manifest.chrome.json')).Path
$version = (Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json).version
if (-not $version) { throw "No 'version' field in $manifestPath" }

# Both stores ship the same source, so a drift here means one of them is about to
# get a package labelled with the other one's version.
$ffManifest = Join-Path $PSScriptRoot '..\manifests\manifest.firefox.json'
if (Test-Path -LiteralPath $ffManifest) {
  $ffVersion = (Get-Content -Raw -LiteralPath $ffManifest | ConvertFrom-Json).version
  if ($ffVersion -ne $version) {
    Write-Host "WARNING: manifest versions differ (chrome $version, firefox $ffVersion). bump_version.ps1 sets both." -ForegroundColor Yellow
  }
}

$cred = Get-CwsCredentials
if (-not $ItemId) { $ItemId = $cred.ItemId }
$ItemId = Assert-CwsItemId $ItemId

if (-not $CheckOnly) {
  if (-not $Zip) { $Zip = Join-Path $PSScriptRoot ("..\dist\formfill-chrome-{0}.zip" -f $version) }
  if (-not (Test-Path -LiteralPath $Zip)) { throw "Zip not found: $Zip  (build it first with create_Chrome_extension_zip.bat)" }
  $Zip = (Resolve-Path -LiteralPath $Zip).Path
  Write-Host "Zip:     $Zip"
}
Write-Host "Version: $version   Target: $Target   Item: $ItemId" -ForegroundColor Cyan
if ($CheckOnly) { Write-Host "(check-only: nothing will be uploaded)" -ForegroundColor Yellow }
elseif ($UploadOnly) { Write-Host "(upload-only: the draft is replaced but not submitted for review)" -ForegroundColor Yellow }

Write-Host "`n[0/3] Getting an access token..."
$token = Get-CwsAccessToken -Cred $cred
Write-Host "      ok."

if ($CheckOnly) {
  $item = Get-CwsItem -Token $token -ItemId $ItemId
  Write-Host "`nStore draft:" -ForegroundColor Cyan
  Write-Host ("      uploadState: {0}" -f $item.uploadState)
  Write-Host ("      crxVersion:  {0}" -f $item.crxVersion)
  Write-Host ("      local:       {0}" -f $version)
  if ($item.itemError) { $item.itemError | ForEach-Object { Write-Host ("      error: {0}" -f $_.error_detail) -ForegroundColor Yellow } }
  Write-Host "`nCheck-only complete. The token and item ID work. Nothing was uploaded." -ForegroundColor Green
  return
}

# --- 1) Replace the draft package ---
# curl.exe for the binary PUT: same reason as the AMO script, Windows PowerShell
# 5.1 mangles large raw bodies and hides the response on failure.
Write-Host "[1/3] Uploading package..."
$uploadJson = & curl.exe -sS -X PUT `
  -H "Authorization: Bearer $token" `
  -H "x-goog-api-version: 2" `
  -H "Content-Type: application/zip" `
  --data-binary "@$Zip" `
  "$(Get-CwsUploadBase)/items/$ItemId"
if ($LASTEXITCODE -ne 0) { throw "curl failed (network/TLS). Output:`n$uploadJson" }
$upload = $null
try { $upload = $uploadJson | ConvertFrom-Json } catch {}
if (-not $upload) { throw "Unexpected response from the upload endpoint:`n$uploadJson" }

# IN_PROGRESS means the store is still unpacking it; poll until it settles.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ($upload.uploadState -eq 'IN_PROGRESS' -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  $upload = Get-CwsItem -Token $token -ItemId $ItemId
  Write-Host ("      uploadState={0}" -f $upload.uploadState)
}
if ($upload.uploadState -ne 'SUCCESS') {
  $errs = @($upload.itemError | ForEach-Object { "  - $($_.error_detail)" })
  $hint = ''
  if ($uploadJson -match 'already exists|same version|version number') {
    $hint = "`nVersion $version is already in the store. Bump the manifest (bump_version.ps1) and rebuild."
  }
  throw ("Upload FAILED (uploadState=$($upload.uploadState)):`n" + ($errs -join "`n") + $hint)
}
Write-Host "      upload accepted." -ForegroundColor Green

# --- 2) Confirm what the draft now holds ---
Write-Host "[2/3] Confirming the draft..."
$item = Get-CwsItem -Token $token -ItemId $ItemId
Write-Host ("      draft version: {0}" -f $item.crxVersion)
if ($item.crxVersion -and $item.crxVersion -ne $version) {
  Write-Host ("WARNING: the store reports $($item.crxVersion) but we uploaded $version.") -ForegroundColor Yellow
}

if ($UploadOnly) {
  Write-Host "`nUpload-only complete. The draft is updated but NOT submitted." -ForegroundColor Green
  Write-Host "Review it at https://chrome.google.com/webstore/devconsole/ and publish there, or re-run without -UploadOnly." -ForegroundColor Yellow
  return
}

# --- 3) Submit for review ---
Write-Host "[3/3] Submitting for review..."
$query = "publishTarget=$Target"
if ($PSBoundParameters.ContainsKey('DeployPercentage')) { $query += "&deployPercentage=$DeployPercentage" }
$pub = Invoke-CwsApi -Token $token -Method Post -Path "/items/$ItemId/publish`?$query"

$status = @($pub.status) -join ', '
$detail = @($pub.statusDetail) -join "`n      "
Write-Host ("      status: {0}" -f $status)
if ($detail) { Write-Host ("      {0}" -f $detail) }

if ($pub.status -contains 'OK' -or $pub.status -contains 'ITEM_PENDING_REVIEW') {
  Write-Host "`nSUCCESS - version $version submitted." -ForegroundColor Green
  Write-Host "It is now in Google's review queue; you'll get an email when it goes live." -ForegroundColor Yellow
  if ($PSBoundParameters.ContainsKey('DeployPercentage')) {
    Write-Host "Staged rollout at $DeployPercentage%. Raise it in the dashboard when you're happy." -ForegroundColor Yellow
  }
}
else {
  throw "Publish returned $status. Details:`n      $detail"
}
