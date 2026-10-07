# attic

Files that are no longer wired into the extension, kept because they may still
be useful reference. Nothing here is copied into a build.

- `background.html` - MV2 background page; the manifest uses `background.scripts` instead.
- `idleMonitor.js` - unused idle/lock monitor, referenced keepassUI.js.
- `keepassUI.js` - older KeePass picker UI; the live picker lives in `src/credentialFill.js`.
- `profileFields.yaml` - reference list of profile field names from the pre-LLM era.
- `formFiller.js` - the old one-shot DOM-only LLM fill path (one prompt, index-keyed JSON, verify/refill loop). Replaced by the agent loop.
- `visionFiller.js` - the old screenshot + DOM one-shot vision path. Screenshots are now an optional attachment in `fillAgent.js`.
- `classic-engine/` - the previous filling engine as it last ran (Sep 2026): a snapshot of the form built in code (`formKit.js`, labels guessed by `accessibleName.js`), one mechanic per widget family (`choiceWidget.js`, `dateField.js`, `autocompleteFiller.js`), heuristic and remembered field mappings (`heuristicFiller.js`, `siteMemory.js`), and the loop that drove them (`fillAgent.js`). Replaced by `src/pageView.js` + `src/hands.js` + `src/fillAgent.js`, which show the model the page as a person sees it and know no widget by name. `agent_harness.js` was its in-page test harness; the bench now runs the real build through `tools/floorp_rig.mjs`.
