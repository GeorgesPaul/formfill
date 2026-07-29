@echo off
setlocal

rem Builds the Firefox (MV2) package. Kept under its old name because
rem publish_to_amo.bat calls it; the actual work is in build.ps1, which also
rem builds the Chrome (MV3) package with -Target chrome.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" -Target firefox -Zip
if errorlevel 1 (
  echo Build failed.
  endlocal & exit /b 1
)

endlocal
