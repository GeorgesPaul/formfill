@echo off
setlocal
rem Full auto-publish: bump the version (based on AMO), build extension.zip, upload as a new version.
rem Pass-through args go to the UPLOAD step, e.g.:  publish_to_amo.bat -Channel unlisted
rem For a safe dry run, use the standalone scripts instead:
rem     powershell -ExecutionPolicy Bypass -File bump_version.ps1 -Preview
rem     powershell -ExecutionPolicy Bypass -File upload_to_amo.ps1 -ValidateOnly
rem %~dp0 = this script's folder (build\), so it works from any directory.

echo === Bumping version (from AMO) ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bump_version.ps1"
if errorlevel 1 (
  echo Version bump failed - aborting.
  endlocal & exit /b 1
)

echo.
echo === Building extension.zip ===
call "%~dp0create_Firefox_extension_zip.bat"
if errorlevel 1 (
  echo Build failed - aborting.
  endlocal & exit /b 1
)

echo.
echo === Uploading to AMO ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0upload_to_amo.ps1" %*
set "rc=%errorlevel%"

endlocal & exit /b %rc%
