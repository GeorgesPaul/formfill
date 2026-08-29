@echo off
setlocal

rem Builds the Chrome (MV3) package. Mirror of create_Firefox_extension_zip.bat;
rem the actual work is in build.ps1.
rem
rem -Channel store leaves the fill logs out: what is published cannot record
rem page content, submissions or request bodies.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" -Target chrome -Zip -Channel store
if errorlevel 1 (
  echo Build failed.
  endlocal & exit /b 1
)

endlocal
