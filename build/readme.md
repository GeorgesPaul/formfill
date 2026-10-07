# Build and release

Source lives in `src\` and is shared by both browsers; the only per-browser file
is the manifest in `manifests\`.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1                 # both targets -> dist\firefox, dist\chrome
powershell -ExecutionPolicy Bypass -File build.ps1 -Target chrome  # one target
powershell -ExecutionPolicy Bypass -File build.ps1 -Zip            # also package dist\formfill-<target>-<version>.zip
powershell -ExecutionPolicy Bypass -File build.ps1 -Channel store  # without the fill logs (what gets published)
```

Load unpacked while developing:

- Firefox: `about:debugging` -> This Firefox -> Load Temporary Add-on -> `dist\firefox\manifest.json`
- Chrome: `chrome://extensions` -> Developer mode -> Load unpacked -> `dist\chrome`

## Channels: what ships and what does not

The fill logs (`fillLogger.js`, `pageHook.js`, the panel's "Fill logs" section,
the submit/network watchers in `content.js`) record what a form looked like,
what the model was asked, and what was actually submitted. That is a
development tool for improving the filling, and it is **not published**.

- `-Channel dev` (default): everything, for loading unpacked while working on
  the extension. This is the build to use when gathering logs.
- `-Channel store`: `fillLogger.js` and `pageHook.js` are left out, every block
  between `ff:logs:start` and `ff:logs:end` markers is stripped from the other
  files, and the manifest loses the page-world content script and the
  `unlimitedStorage` permission. The build then greps the package for any
  remaining log code and fails if it finds some, so a published version cannot
  record page content, submissions or request bodies at all.

Both `create_Firefox_extension_zip.bat` and `create_Chrome_extension_zip.bat`
pass `-Channel store`, so everything the publish scripts upload is stripped.
When you touch logging code, keep it inside the markers.

## Release to AMO (Firefox)

`publish_to_amo.bat` runs the three steps below in order; run them separately for a dry run.

1. `bump_version.ps1` - sets the version one patch above the highest version on AMO,
   in **both** manifests (`-Preview` to see the number without writing).
2. `create_Firefox_extension_zip.bat` - calls `build.ps1 -Target firefox -Zip`.
3. `upload_to_amo.ps1` - uploads `dist\formfill-firefox-<version>.zip`
   (`-ValidateOnly` to stop after AMO validation).

Credentials come from `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` or `$HOME\.amo\credentials.ps1`, never from the repo.

## Release to the Chrome Web Store

`publish_to_cws.bat` builds the Chrome package and submits it for review. It does **not**
bump the version: `bump_version.ps1` derives the next number from AMO and writes it into
both manifests, so after a Firefox release the Chrome package already carries the right one.
Shipping to Chrome on its own? Run `bump_version.ps1` first.

1. `create_Chrome_extension_zip.bat` - calls `build.ps1 -Target chrome -Zip`.
2. `upload_to_cws.ps1` - replaces the store draft with `dist\formfill-chrome-<version>.zip`
   and submits it for review.
   - `-CheckOnly` talks to the API and prints what the store holds, uploads nothing.
   - `-UploadOnly` updates the draft but does not submit, so you can eyeball the listing.
   - `-Target trustedTesters` ships to the tester group instead of everyone.
   - `-DeployPercentage 20` starts a staged rollout.

The submit step fails with "Publish condition not met ... mandatory privacy information"
whenever the listing's **Privacy practices** tab is out of date, which happens as soon as the
manifest asks for a permission the store has not seen a justification for (1.28 added
`contextMenus`). The upload itself succeeds and the draft holds the new version; open the
item in the dashboard, fill in the Privacy practices tab, then submit there or re-run
`upload_to_cws.ps1`.

Credentials come from `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN` /
`CWS_ITEM_ID`, or from `$HOME\.cws\credentials.ps1`, never from the repo.

### One-time setup

Google has no "copy your API key" page. You create an OAuth client once, approve it once
in a browser, and keep the refresh token.

1. [Google Cloud console](https://console.cloud.google.com/): create a project (any name).
2. APIs & Services -> Library -> enable **Chrome Web Store API**.
3. APIs & Services -> OAuth consent screen -> External -> fill in the required fields ->
   **Publish** the app. Left in Testing, refresh tokens expire after 7 days.
4. APIs & Services -> Credentials -> Create credentials -> OAuth client ID ->
   application type **Desktop app**. Note the client ID and secret.
5. `get_cws_refresh_token.ps1 -ClientId ... -ClientSecret ... -ItemId ...` opens the
   consent screen, catches the redirect on a loopback port, and writes
   `$HOME\.cws\credentials.ps1`.
6. Verify with `upload_to_cws.ps1 -CheckOnly`.

The item ID is the 32-letter string in the item's dashboard URL. The **first** submission
has to be made by hand at the [developer dashboard](https://chrome.google.com/webstore/devconsole/)
(one-off 5 USD developer fee, plus the store listing: description, screenshots, category,
privacy declarations). The API only ships updates to an item that already exists.
