# attic

Files that are no longer wired into the extension, kept because they may still
be useful reference. Nothing here is copied into a build.

- `background.html` - MV2 background page; the manifest uses `background.scripts` instead.
- `idleMonitor.js` - unused idle/lock monitor, referenced keepassUI.js.
- `keepassUI.js` - older KeePass picker UI; the live picker lives in `src/content.js`.
- `profileFields.yaml` - reference list of profile field names from the pre-LLM era.
- `formFiller.js` - the old one-shot DOM-only LLM fill path (one prompt, index-keyed JSON, verify/refill loop). Replaced by `src/fillAgent.js` + `src/formKit.js`.
- `visionFiller.js` - the old screenshot + DOM one-shot vision path. Screenshots are now an optional attachment in `fillAgent.js`.
