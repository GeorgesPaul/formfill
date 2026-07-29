@echo off
setlocal
rem Full auto-publish to the Chrome Web Store: build the Chrome package, upload it
rem as the new draft, submit it for review.
rem
rem Unlike publish_to_amo.bat this does NOT bump the version: bump_version.ps1
rem derives the next number from AMO and writes it into BOTH manifests, so the
rem Chrome package is already carrying the right one. Bump first if you are
rem shipping to Chrome on its own:
rem     powershell -ExecutionPolicy Bypass -File bump_version.ps1
rem
rem Pass-through args go to the UPLOAD step, e.g.:  publish_to_cws.bat -UploadOnly
rem For a safe dry run:
rem     powershell -ExecutionPolicy Bypass -File upload_to_cws.ps1 -CheckOnly
rem %~dp0 = this script's folder (build\), so it works from any directory.

echo === Building the Chrome package ===
call "%~dp0create_Chrome_extension_zip.bat"
if errorlevel 1 (
  echo Build failed - aborting.
  endlocal & exit /b 1
)

echo.
echo === Uploading to the Chrome Web Store ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0upload_to_cws.ps1" %*
set "rc=%errorlevel%"

endlocal & exit /b %rc%
