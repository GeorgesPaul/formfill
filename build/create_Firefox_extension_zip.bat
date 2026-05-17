@echo off
setlocal

rem This script lives in build\. Always operate on the repo root
rem (%~dp0 = this script's folder), independent of the directory the
rem script was launched from. Previously a relative "cd .." meant the
rem delete check and the zip creation could target different folders,
rem so a stale extension.zip was never deleted nor overwritten.
pushd "%~dp0.."

rem Delete existing zip file if it exists (force, quiet)
if exist extension.zip del /f /q extension.zip
if exist extension.zip (
    echo ERROR: could not delete existing extension.zip ^(file in use?^).
    popd
    exit /b 1
)

rem Create new zip file with specified contents
zip -r extension.zip icons background.js content.js LICENSE manifest.json popup.html popup.js README.md qr-code.png apiUtils.js llmConfig.html llmConfig.js keepassConfig.html keepassConfig.js keepassClient.js styles.css domUtils.js utils.js llmClient.js formFiller.js heuristicFiller.js overlayUtils.js visionFiller.js lib

echo Zip file created successfully in "%CD%".
popd
endlocal
