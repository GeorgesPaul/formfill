# Shared helpers for the Chrome Web Store API (v1.1). Dot-source this file:
#   . (Join-Path $PSScriptRoot 'cws_common.ps1')
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-CwsApiBase { 'https://www.googleapis.com/chromewebstore/v1.1' }
function Get-CwsUploadBase { 'https://www.googleapis.com/upload/chromewebstore/v1.1' }
function Get-CwsTokenUri { 'https://oauth2.googleapis.com/token' }
function Get-CwsAuthUri { 'https://accounts.google.com/o/oauth2/v2/auth' }
function Get-CwsScope { 'https://www.googleapis.com/auth/chromewebstore' }

# Credentials come from env vars or $HOME\.cws\credentials.ps1 (NEVER from the repo).
# ItemId is not secret, but it lives with the rest so one file configures everything.
function Get-CwsCredentials {
  $id = $env:CWS_CLIENT_ID
  $secret = $env:CWS_CLIENT_SECRET
  $refresh = $env:CWS_REFRESH_TOKEN
  $item = $env:CWS_ITEM_ID
  $credFile = Join-Path $HOME '.cws\credentials.ps1'
  if (Test-Path -LiteralPath $credFile) {
    . $credFile
    if (-not $id) { $id = $CWS_CLIENT_ID }
    if (-not $secret) { $secret = $CWS_CLIENT_SECRET }
    if (-not $refresh) { $refresh = $CWS_REFRESH_TOKEN }
    if (-not $item) { $item = $CWS_ITEM_ID }
  }
  if (-not $id -or -not $secret) {
    throw "Missing Chrome Web Store OAuth client. Set env vars CWS_CLIENT_ID and CWS_CLIENT_SECRET, or create $credFile (copy credentials.example.ps1). See build\readme.md for how to create the client."
  }
  [pscustomobject]@{ ClientId = $id; ClientSecret = $secret; RefreshToken = $refresh; ItemId = $item }
}

# Access tokens last an hour; get a fresh one per run rather than caching it to disk.
function Get-CwsAccessToken {
  param([Parameter(Mandatory)][pscustomobject]$Cred)
  if (-not $Cred.RefreshToken) {
    throw "No refresh token. Run:  powershell -ExecutionPolicy Bypass -File get_cws_refresh_token.ps1"
  }
  $body = @{
    client_id     = $Cred.ClientId
    client_secret = $Cred.ClientSecret
    refresh_token = $Cred.RefreshToken
    grant_type    = 'refresh_token'
  }
  try {
    $resp = Invoke-RestMethod -Method Post -Uri (Get-CwsTokenUri) -Body $body
  }
  catch {
    $detail = Read-CwsErrorBody $_
    # invalid_grant means the refresh token is dead: revoked, unused for 6 months,
    # or issued by a test-mode OAuth consent screen (those expire after 7 days).
    $hint = ''
    if ($detail -match 'invalid_grant') {
      $hint = " The refresh token is no longer valid. Re-run get_cws_refresh_token.ps1, and if the consent screen is still in Testing mode, publish it so tokens stop expiring after 7 days."
    }
    throw "Could not exchange the refresh token for an access token.$hint Response:`n$detail"
  }
  if (-not $resp.access_token) { throw "Token endpoint returned no access_token." }
  $resp.access_token
}

# Invoke-RestMethod throws away the response body on non-2xx; dig it back out.
function Read-CwsErrorBody {
  param([Parameter(Mandatory)]$ErrorRecord)
  $resp = $ErrorRecord.Exception.Response
  if (-not $resp) { return $ErrorRecord.Exception.Message }
  try {
    $reader = New-Object IO.StreamReader($resp.GetResponseStream())
    $text = $reader.ReadToEnd()
    $reader.Dispose()
  }
  catch { return $ErrorRecord.Exception.Message }
  $code = 0
  try { $code = [int]$resp.StatusCode } catch {}
  if ($code) { "HTTP $code`n$text" } else { $text }
}

function Invoke-CwsApi {
  param(
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][string]$Path,
    [ValidateSet('Get', 'Post', 'Put')][string]$Method = 'Get'
  )
  $headers = @{ Authorization = "Bearer $Token"; 'x-goog-api-version' = '2' }
  try {
    Invoke-RestMethod -Method $Method -Uri ('{0}{1}' -f (Get-CwsApiBase), $Path) -Headers $headers
  }
  catch {
    throw ("Chrome Web Store API call failed: $Method $Path`n" + (Read-CwsErrorBody $_))
  }
}

# The store only exposes the DRAFT projection: after an upload this is the version
# you just pushed, before one it is whatever is sitting in the dashboard draft.
function Get-CwsItem {
  param([Parameter(Mandatory)][string]$Token, [Parameter(Mandatory)][string]$ItemId)
  Invoke-CwsApi -Token $Token -Path "/items/$ItemId`?projection=DRAFT"
}

# Item IDs are the 32-character a-p string from the dashboard URL.
function Assert-CwsItemId {
  param([string]$ItemId)
  if (-not $ItemId) {
    throw "No Chrome Web Store item ID. Pass -ItemId, set CWS_ITEM_ID, or add `$CWS_ITEM_ID to $HOME\.cws\credentials.ps1. The ID is the 32-letter string in the dashboard URL of your item. The very first submission has to be made by hand in the dashboard; this script only ships updates."
  }
  if ($ItemId -notmatch '^[a-p]{32}$') {
    throw "'$ItemId' does not look like a Chrome Web Store item ID (32 letters, a-p)."
  }
  $ItemId
}
