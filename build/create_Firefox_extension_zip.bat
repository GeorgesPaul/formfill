@echo off
setlocal

cd ..

rem Delete existing zip file if it exists
if exist extension.zip del extension.zip

rem Create new zip file with specified contents
zip -r extension.zip icons background.js content.js LICENSE manifest.json popup.html popup.js README.md qr-code.png apiUtils.js llmConfig.html llmConfig.js keepassConfig.html keepassConfig.js keepassClient.js keepassUI.js styles.css domUtils.js utils.js llmClient.js formFiller.js visualProcessor.js lib



echo Zip file created successfully.