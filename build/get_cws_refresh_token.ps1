<#
.SYNOPSIS
  One-time OAuth dance to get a Chrome Web Store refresh token.

.DESCRIPTION
  Google's publishing API has no "API key" you can copy out of a page the way AMO
  does. You create an OAuth client once in Google Cloud, approve it once in a
  browser, and keep the resulting refresh token. That token is what the publish
  script uses from then on.

  This script opens the consent screen, catches the redirect on a loopback port,
  swaps the code for a refresh token, and writes $HOME\.cws\credentials.ps1.

  Before running it you need (see build\readme.md for the click-path):
    - a Google Cloud project with the "Chrome Web Store API" enabled
    - an OAuth client of type "Desktop app"
    - the consent screen published (Testing mode expires refresh tokens after 7 days)

.PARAMETER ClientId, ClientSecret
  From the OAuth client. Omit to read them from env vars or the existing
  credentials.ps1.

.PARAMETER ItemId
  Chrome Web Store item ID, stored alongside the token so the publish script
  needs no arguments. The 32-letter string in your item's dashboard URL.

.PARAMETER Print
  Print the token instead of writing credentials.ps1.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File get_cws_refresh_token.ps1 -ClientId 123.apps.googleusercontent.com -ClientSecret GOCSPX-xxxx -ItemId abcdefghijklmnopabcdefghijklmnop
#>
[CmdletBinding()]
param(
  [string]$ClientId,
  [string]$ClientSecret,
  [string]$ItemId,
  [int]$TimeoutSeconds = 300,
  [switch]$Print
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'cws_common.ps1')

$credFile = Join-Path $HOME '.cws\credentials.ps1'

# Fill any blanks from the environment / existing credentials file.
if (-not $ClientId -or -not $ClientSecret -or -not $ItemId) {
  $existing = $null
  try { $existing = Get-CwsCredentials } catch {}
  if ($existing) {
    if (-not $ClientId) { $ClientId = $existing.ClientId }
    if (-not $ClientSecret) { $ClientSecret = $existing.ClientSecret }
    if (-not $ItemId) { $ItemId = $existing.ItemId }
  }
}
if (-not $ClientId -or -not $ClientSecret) {
  throw "Need -ClientId and -ClientSecret (from the Desktop app OAuth client in Google Cloud). See build\readme.md."
}

# --- 1) Listen on a loopback port for the redirect ---
# TcpListener rather than HttpListener: binding a loopback socket needs no
# elevation or URL ACL, and the callback is a single plain GET.
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$redirect = "http://127.0.0.1:$port"

$q = @(
  "client_id=$([uri]::EscapeDataString($ClientId))"
  "redirect_uri=$([uri]::EscapeDataString($redirect))"
  'response_type=code'
  "scope=$([uri]::EscapeDataString((Get-CwsScope)))"
  'access_type=offline'   # without this Google returns no refresh token
  'prompt=consent'        # force a fresh refresh token even if already approved
) -join '&'
$authUrl = "$(Get-CwsAuthUri)?$q"

Write-Host "Opening the Google consent screen in your browser..." -ForegroundColor Cyan
Write-Host "If it does not open, paste this URL yourself:`n$authUrl`n"
Start-Process $authUrl | Out-Null

Write-Host "Waiting for the redirect on $redirect (timeout ${TimeoutSeconds}s)..."
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while (-not $listener.Pending()) {
  if ((Get-Date) -gt $deadline) { $listener.Stop(); throw "Timed out waiting for the browser redirect." }
  Start-Sleep -Milliseconds 250
}

$client = $listener.AcceptTcpClient()
try {
  $stream = $client.GetStream()
  $reader = New-Object IO.StreamReader($stream)
  $requestLine = $reader.ReadLine()   # e.g. "GET /?code=4/0Ax...&scope=... HTTP/1.1"

  $code = $null
  $oauthError = $null
  if ($requestLine -match '[?&]code=([^&\s]+)') { $code = [uri]::UnescapeDataString($Matches[1]) }
  if ($requestLine -match '[?&]error=([^&\s]+)') { $oauthError = [uri]::UnescapeDataString($Matches[1]) }

  $msg = if ($code) { 'Authorised. You can close this tab and go back to the terminal.' } else { "Authorisation failed: $oauthError" }
  $page = "<!doctype html><meta charset=utf-8><title>Chrome Web Store</title><body style='font:16px system-ui;padding:3rem'>$msg</body>"
  $pageBytes = [Text.Encoding]::UTF8.GetBytes($page)
  $head = [Text.Encoding]::ASCII.GetBytes(
    "HTTP/1.1 200 OK`r`nContent-Type: text/html; charset=utf-8`r`nContent-Length: $($pageBytes.Length)`r`nConnection: close`r`n`r`n")
  $bytes = $head + $pageBytes
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush()
}
finally {
  $client.Close()
  $listener.Stop()
}

if (-not $code) { throw "No authorisation code came back. Google said: $oauthError" }
Write-Host "Got the authorisation code." -ForegroundColor Green

# --- 2) Swap the code for a refresh token ---
$body = @{
  client_id     = $ClientId
  client_secret = $ClientSecret
  code          = $code
  grant_type    = 'authorization_code'
  redirect_uri  = $redirect
}
try {
  $tok = Invoke-RestMethod -Method Post -Uri (Get-CwsTokenUri) -Body $body
}
catch {
  throw "Token exchange failed:`n" + (Read-CwsErrorBody $_)
}
if (-not $tok.refresh_token) {
  throw "Google returned an access token but no refresh token. Revoke this app's access at https://myaccount.google.com/permissions and run this script again (it needs a first-time consent to issue one)."
}

if ($Print) {
  Write-Host "`nrefresh_token: $($tok.refresh_token)" -ForegroundColor Yellow
  Write-Host "(not saved: -Print was given)"
  return
}

# --- 3) Save it ---
$credDir = Split-Path -Parent $credFile
if (-not (Test-Path -LiteralPath $credDir)) { New-Item -ItemType Directory -Path $credDir -Force | Out-Null }
if (Test-Path -LiteralPath $credFile) {
  $backup = "$credFile.bak"
  Copy-Item -LiteralPath $credFile -Destination $backup -Force
  Write-Host "Existing credentials.ps1 backed up to $backup" -ForegroundColor Yellow
}

$itemLine = if ($ItemId) { "`$CWS_ITEM_ID      = '$ItemId'" } else { "# `$CWS_ITEM_ID      = 'the 32-letter id from your dashboard URL'" }
$content = @"
# Chrome Web Store API credentials. Written by build\get_cws_refresh_token.ps1.
# Anyone with these can publish to your item: treat the file like a password.
# It lives in your home dir, NOT in the project / sync folder / git repo.

`$CWS_CLIENT_ID     = '$ClientId'
`$CWS_CLIENT_SECRET = '$ClientSecret'
`$CWS_REFRESH_TOKEN = '$($tok.refresh_token)'
$itemLine
"@
[IO.File]::WriteAllText($credFile, $content)

Write-Host "`nSaved $credFile" -ForegroundColor Green
if (-not $ItemId) { Write-Host "No item ID stored. Add `$CWS_ITEM_ID to that file, or pass -ItemId to the publish script." -ForegroundColor Yellow }
Write-Host "Check it works:  powershell -ExecutionPolicy Bypass -File upload_to_cws.ps1 -CheckOnly"
