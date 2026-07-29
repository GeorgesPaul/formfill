# Build and release

Source lives in `src\` and is shared by both browsers; the only per-browser file
is the manifest in `manifests\`.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1                 # both targets -> dist\firefox, dist\chrome
powershell -ExecutionPolicy Bypass -File build.ps1 -Target chrome  # one target
powershell -ExecutionPolicy Bypass -File build.ps1 -Zip            # also package dist\formfill-<target>-<version>.zip
```

Load unpacked while developing:

- Firefox: `about:debugging` -> This Firefox -> Load Temporary Add-on -> `dist\firefox\manifest.json`
- Chrome: `chrome://extensions` -> Developer mode -> Load unpacked -> `dist\chrome`

## Release to AMO (Firefox)

`publish_to_amo.bat` runs the three steps below in order; run them separately for a dry run.

1. `bump_version.ps1` - sets the version one patch above the highest version on AMO,
   in **both** manifests (`-Preview` to see the number without writing).
2. `create_Firefox_extension_zip.bat` - calls `build.ps1 -Target firefox -Zip`.
3. `upload_to_amo.ps1` - uploads `dist\formfill-firefox-<version>.zip`
   (`-ValidateOnly` to stop after AMO validation).

Credentials come from `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` or `$HOME\.amo\credentials.ps1`, never from the repo.

## Chrome Web Store

`build.ps1 -Target chrome -Zip` produces `dist\formfill-chrome-<version>.zip`, which is what the
developer dashboard expects. There is no automated upload script for it.
