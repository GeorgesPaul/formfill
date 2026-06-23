<#
.SYNOPSIS
  Upload a new version of the extension to addons.mozilla.org (AMO) via the v5 API.

.DESCRIPTION
  Takes a pre-built zip (default: ..\extension.zip) and submits it as a new version:
    1. POST the zip to /addons/upload/        -> returns an upload uuid
    2. Poll  /addons/upload/{uuid}/           -> wait for validation
    3. POST  /addons/addon/{id}/versions/     -> creates the new version (skipped with -ValidateOnly)

  Credentials + JWT are handled by amo_common.ps1 (env vars or $HOME\.amo\credentials.ps1).

.PARAMETER ValidateOnly
  Steps 1-2 only (upload + validation). Nothing is published. Safe way to test your
  token and that the zip passes AMO validation.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File upload_to_amo.ps1 -ValidateOnly
  powershell -ExecutionPolicy Bypass -File upload_to_amo.ps1 -Channel unlisted
#>
[CmdletBinding()]
param(
  [string]$Zip,
  [ValidateSet('listed', 'unlisted')][string]$Channel = 'listed',
  [string]$AddonId = '{7d43f771-471b-4067-86f8-21812d277fa0}',
  [int]$TimeoutSeconds = 300,
  [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'amo_common.ps1')
$apiBase = Get-AmoApiBase

if (-not $Zip) { $Zip = Join-Path $PSScriptRoot '..\extension.zip' }
if (-not (Test-Path -LiteralPath $Zip)) { throw "Zip not found: $Zip  (build it first with create_Firefox_extension_zip.bat)" }
$Zip = (Resolve-Path -LiteralPath $Zip).Path

$cred = Get-AmoCredentials

$manifestPath = Join-Path $PSScriptRoot '..\manifest.json'
$version = $null
if (Test-Path $manifestPath) { try { $version = (Get-Content $manifestPath -Raw | ConvertFrom-Json).version } catch {} }

Write-Host "Zip:     $Zip"
Write-Host "Version: $version   Channel: $Channel   Add-on: $AddonId" -ForegroundColor Cyan
if ($ValidateOnly) { Write-Host "(validate-only: nothing will be published)" -ForegroundColor Yellow }

# --- 1) Upload the package (multipart via curl.exe; Windows PowerShell 5.1 has no -Form) ---
Write-Host "`n[1/3] Uploading package..."
$uploadJson = & curl.exe -sS -X POST `
  -H "Authorization: JWT $(New-AmoJwt $cred)" `
  -F "upload=@$Zip;type=application/zip" `
  -F "channel=$Channel" `
  "$apiBase/addons/upload/"
if ($LASTEXITCODE -ne 0) { throw "curl failed (network/TLS). Output:`n$uploadJson" }
$upload = $uploadJson | ConvertFrom-Json
if (-not $upload.uuid) { throw "Upload rejected by AMO. Response:`n$uploadJson" }
$uuid = $upload.uuid
Write-Host "      upload uuid: $uuid"

# --- 2) Poll validation ---
Write-Host "[2/3] Waiting for validation..."
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
  Start-Sleep -Seconds 3
  $status = Invoke-AmoGet -Cred $cred -Path "/addons/upload/$uuid/"
  Write-Host ("      processed={0} valid={1}" -f $status.processed, $status.valid)
} until ($status.processed -or (Get-Date) -gt $deadline)

if (-not $status.processed) { throw "Validation timed out after $TimeoutSeconds s." }
if (-not $status.valid) {
  $errs = @($status.validation.messages | Where-Object { $_.type -eq 'error' } | ForEach-Object { "  - $($_.message)" })
  throw ("Validation FAILED:`n" + ($errs -join "`n") + "`nFull report: $apiBase/addons/upload/$uuid/")
}
Write-Host "      validation passed." -ForegroundColor Green

if ($ValidateOnly) {
  Write-Host "`nValidate-only complete. Token works and the zip is valid. Nothing was published." -ForegroundColor Green
  return
}

# --- 3) Create the new version on the add-on ---
Write-Host "[3/3] Creating version on the add-on..."
$idEnc = [uri]::EscapeDataString($AddonId)
$body = @{ upload = $uuid } | ConvertTo-Json -Compress
try {
  $ver = Invoke-RestMethod -Method Post -Uri "$apiBase/addons/addon/$idEnc/versions/" `
    -Headers @{ Authorization = "JWT $(New-AmoJwt $cred)" } -ContentType 'application/json' -Body $body
}
catch {
  $resp = $_.Exception.Response
  if ($resp) {
    $reader = New-Object IO.StreamReader($resp.GetResponseStream())
    $errBody = $reader.ReadToEnd()
    throw "Create-version failed (HTTP $([int]$resp.StatusCode)). Common cause: version $version already exists on AMO (bump manifest.json). Response:`n$errBody"
  }
  throw
}

Write-Host "`nSUCCESS - version $version submitted (id $($ver.id))." -ForegroundColor Green
if ($Channel -eq 'listed') {
  Write-Host "It is now in Mozilla's review queue; you'll get an email when it's approved." -ForegroundColor Yellow
}
else {
  Write-Host "Unlisted: it will be auto-signed shortly. Grab the .xpi from the Developer Hub or the API." -ForegroundColor Yellow
}
