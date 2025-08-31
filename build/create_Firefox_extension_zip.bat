@echo off
setlocal

cd ..

rem Delete existing zip file if it exists
if exist extension.zip del extension.zip

rem Create new zip file with specified contents
zip -r extension.zip icons lib/js-yaml.min.js background.js content.js LICENSE manifest.json popup.html popup.js profileFields.yaml README.md qr-code.png apiUtils.js llmConfig.html llmConfig.js styles.css



echo Zip file created successfully.