@echo off
setlocal

cd ..

rem Delete existing zip file if it exists
if exist extension.zip del extension.zip

rem Create new zip file with specified contents
zip -r extension.zip icons node_modules background.js content.js LICENSE manifest.json popup.html popup.js profileFields.yaml README.md

echo Zip file created successfully.