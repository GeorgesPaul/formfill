# LLM Form Filler

A browser extension that fills forms using large language models for smarter filling and less typing.
Runs on **Firefox** (Manifest V2) and **Chrome** (Manifest V3) from one shared source tree.

## How it fills a form

The extension gives the model what a person has, and nothing else: eyes, hands,
and the habit of looking again after acting. No part of it knows what a
"combobox", a "date picker" or a "cookie banner" is; whatever a site builds its
form out of, the model sees it as a person would and works it the same way.

1. **Look** (`pageView.js`). The visible page is written out as text, top to
   bottom in reading order, with a number on everything that can be acted on:
   `[6] combobox "Country" = "" (opens a list)`. A date in three boxes is three
   small fields. A dropdown is a field that opens a list; the list, once open,
   is a set of new lines with their own numbers. Labels are not guessed: the
   text around a control is shown where it stands. What appeared or changed
   since the last look is marked, and anything lying on top of the page (a
   menu, a dialog, a banner) is listed as such.
2. **Decide.** The model gets that text and the profile, and answers with one
   `form_actions` call: a batch of `{op, ref, value}` where `op` is `type`,
   `choose`, `check`, `click` or `press`, plus what it deliberately left alone
   and why (including "the user must supply this").
3. **Act** (`hands.js`). `type` clicks into the field and sends keystrokes.
   `choose` clicks the field and then clicks the entry with that text in
   whatever opened, typing to filter when the list is long. `check`, `click`
   and `press` are what they say. Real input when the browser grants it, the
   browser's own event sequences reproduced otherwise. Each action reports what
   the control shows afterwards; nothing is "verified" or repaired in code. A
   batch stops early when something has to be looked at first: a list opened
   under the field, a click brought up something new, something now covers the
   page.
4. **Look again.** The page is shown once more, with the changes marked. The
   model fills what appeared, fixes what the page flagged, and declares done.
   A plain form is one model call; a form that changes as it is filled costs
   one more call per change. The budget is configurable (default 12 looks).

Only the controls whose pop-up belongs to the browser are set through the DOM:
`<select>` and the native date, time, colour and range inputs. Buttons that
send the form are never clicked and password fields are never filled
(credentials come from the separate KeePass button). The model is told to leave
a cookie banner alone unless it covers fields it needs, and then to take the
least committing choice it offers.

### Why the events are reproduced so carefully

Events dispatched from an extension are `isTrusted: false`, and browsers run
default actions only for trusted events: a synthetic keydown inserts nothing, a
synthetic mousedown moves no focus. The extension therefore reproduces the
sequences the browser itself would emit (`eventSim.js`, `typingEngine.js`), and
for each step checks whether the event actually happened before adding it, so
nothing is delivered twice when the browser does its own part.

This matters most for focus. When the fill is driven from the sidebar or side
panel, the page is not the focused document, and in that state `el.focus()` and
`el.blur()` change `document.activeElement` without dispatching any event, in
both Firefox and Chrome. Any form that validates on blur (a very common
pattern) would never validate: the value is visibly correct, no error is shown,
and the Continue button stays disabled until you retype something by hand.

### Trusted input (Firefox and forks, development builds)

Reproducing events has a ceiling: a menu that moves keyboard focus into its own
list never sees arrow keys sent to its trigger, a masked input that parses real
keystrokes ignores synthetic ones, and nothing synthetic ever moves focus or
submits. So the dev build also carries a WebExtension Experiment
(`src/experiments/input/`) that asks the browser itself to perform the input:
it drives the same in-content machinery WebDriver BiDi uses (the remote agent's
`input` module, nsIDOMWindowUtils and nsITextInputProcessor), so clicks and
keystrokes arrive `isTrusted: true`, default actions run, and focus moves for
real. No WebDriver session is opened and `navigator.webdriver` stays false.

`trustedInput.js` is the content-side transport; the hands try it first and
fall back to the reproduced trail when the browser refuses. The fill logs
record which backend a run used (`input` in the session meta and the final
details).

It works where experiments are allowed: Floorp, LibreWolf, Nightly and
Developer Edition, and any unbranded build, loaded as a temporary add-on with
`extensions.experiments.enabled` not set to false. Release Firefox, Chrome and
the store package ignore it and fill with reproduced events.

## Features

- **Closed-loop filling** - the model sees what the page did and fixes it, instead of one-shot fill-and-hope
- **Any widget, no widget code** - the page is shown as a person sees it; dropdowns, searchable selects, masked dates, calendars, suggestion lists and clickable cards are all just things to click and type into
- **Dynamic forms** - fields that appear after a choice, lists that swap, suggestion pop-ups and dialogs are seen on the next look and dealt with
- **Faithful input** - real keystrokes and clicks where the browser allows it, the browser's own focus/typing/commit sequences reproduced elsewhere, so blur-only validators, masks and framework-controlled inputs behave as if a person had typed
- **Validation-aware** - what the page flags, and what it says, is in the next look
- **Card fields in separate frames** - payment pages that host each card field in its own iframe get every frame filled; the frames take turns at the keyboard, and the panel keeps its progress bar and Cancel button until the last frame is done
- **Right-click filling** - a "Fill this form" context menu with a submenu of your profiles. The sidebar and side panel only exist in ordinary browser windows, so this is the only way to fill a chrome-less popup window (payment and 3-D Secure flows), and it works inside iframes too
- **"Needs your input" report** - fields the profile cannot answer are listed in the panel instead of silently skipped, with what the page still flags and what required fields are still empty
<!-- ff:logs:start -->
- **Local fill logs** - every fill records what the model was shown, what it answered, what the hands did, what the page did in response, and what was actually submitted afterwards (FormData + request bodies). Export as JSON from the panel; nothing leaves your machine
<!-- ff:logs:end -->
- **Optional screenshot** - a checkbox attaches one screenshot on the first look for vision-capable models; off by default (slower, more expensive)
- **KeePass integration** - fill username/password directly from a KeePass database
- **Multiple profiles**, free-text `key: value` format
- **Works with any LLM** - OpenRouter, OpenAI-compatible endpoints, or local models (Ollama `/v1/chat/completions` recommended; tool calls and JSON fallback both supported)

## Recommended models

Use OpenRouter as the endpoint. One-click presets in **LLM API Config** for:

| Model | OpenRouter slug | Notes |
|---|---|---|
| Claude Opus 5.5 | `anthropic/claude-opus-5.5` | Default, low reasoning effort. Best reasoning for ambiguous profile-to-field matching. |
| Claude Sonnet 5 | `anthropic/claude-sonnet-5` | Much cheaper and faster; good default for simple forms. |
| GPT-5 | `openai/gpt-5` | OpenAI's flagship with vision. |
| Qwen2.5-VL 72B | `qwen/qwen-2.5-vl-72b-instruct` | Cheap open-source option; strong on GUI grounding benchmarks. |

Avoid GPT-4o-mini and Gemini 2.5 Pro: in testing they performed notably worse than the above on form-fill tasks.

## Installation

### Firefox
Install from [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/llm-form-filler/), or load it yourself:

```powershell
powershell -ExecutionPolicy Bypass -File build\build.ps1 -Target firefox
```
then `about:debugging` -> This Firefox -> Load Temporary Add-on -> `dist\firefox\manifest.json`.
Requires Firefox 128+.

### Chrome
```powershell
powershell -ExecutionPolicy Bypass -File build\build.ps1 -Target chrome
```
then `chrome://extensions` -> enable Developer mode -> Load unpacked -> select `dist\chrome`.

The Chrome build uses the side panel (click the toolbar icon) instead of Firefox's sidebar. Everything else is identical.

## Quick Setup

### Using OpenRouter (recommended)
1. Sign up at [openrouter.ai](https://openrouter.ai)
2. In the extension's **LLM API Config**, click a preset: it auto-fills the URL and model.
3. Paste your OpenRouter API key and save. Reasoning effort and the number of model calls a fill may make are configurable per config.

### Using Local LLM (Ollama)
1. Install [Ollama](https://ollama.com/)
2. Run a tool-capable model, e.g. `ollama run llama3.1`
3. In extension config, set API URL: `http://localhost:11434/v1/chat/completions`

### KeePass Integration
1. Click "KeePass Config" in the extension
2. Upload your .kdbx database file and unlock it
3. Use "Fill User/Pass" to fill credentials

<!-- ff:logs:start -->
## Fill logs (development builds only)

This is a tool for improving the filling, and it is not published: the
packages on AMO and the Chrome Web Store are built with
`build.ps1 -Channel store`, which leaves the recording out entirely (see
`build/readme.md`). Load an unpacked dev build to gather logs.

Every fill session is recorded locally (toggle in the panel), one entry per
step:

- `view`: the page text the model was shown at each look (the first one also carries the sanitized page HTML)
- `screenshot`: one at the start and one at the end (when the tab allows capture)
- `llmRequest`, `llmResponse`, `llmError`: every model call
- `actions`, `results`: each batch and what every action reported (the value the control shows afterwards, what the click opened, why the batch stopped)
- `loopGuard`: why a run was cut short (a repeated batch, a page that stopped changing)
- `finalState`: every control's value at the end, and the report the panel got
- `submitCapture`, `networkSubmit`, `pagehide`, `postSubmitPage`: what was submitted afterwards (form values and FormData at submit/Next clicks, non-GET request bodies with password-like keys redacted) and the page that followed

Export from the panel as JSON (optionally with profile values redacted) and feed
the file to an LLM to analyse why a fill went wrong. Storage is
`browser.storage.local` only; the last 30 sessions are kept.
<!-- ff:logs:end -->

## Repository layout

```
src/          extension source, shared by both browsers (no manifest here)
manifests/    manifest.firefox.json (MV2) and manifest.chrome.json (MV3)
build/        build.ps1 (assembles dist\<target>) plus the release scripts
test/         bench pages; `node test/serve.js` then open http://localhost:8123/test/
tools/        floorp_rig.mjs: runs the dev build in a scratch Floorp/Firefox over WebDriver BiDi and drives the bench pages through the real extension;
              watch-build.ps1: rebuilds dist\<target> on every save, so a running `web-ext run --source-dir dist\firefox` reloads the add-on
dist/         build output, git-ignored
attic/        code no longer wired into the extension, kept for reference (attic/classic-engine is the previous filling engine)
```

Key source files:

| File | Role |
|---|---|
| `pageView.js` | Eyes: the visible page as numbered text, what is new since the last look, what lies on top |
| `hands.js` | Hands: type, choose, check, click, press; waits for the page to come to rest; takes turns with the other frames of the tab |
| `fillAgent.js` | The loop: page text to the model, its `form_actions` batch to the hands, the page again; the rules the model is given; the needs-input report |
| `eventSim.js` / `typingEngine.js` | The browser's input event sequences (press, focus, leave, keystroke) reproduced and verified, so pages react as they would to a person |
| `trustedInput.js` / `experiments/input/` | Real, trusted input through the browser's own WebDriver machinery when the browser allows a privileged experiment (Floorp, Nightly, LibreWolf); the reproduced trail stays the fallback |
| `credentialFill.js` | The KeePass button: user name and password typed into the login fields |
| `content.js` | The page side's switchboard: panel requests to the module that does the work |
| `background.js` | Screenshots, the real-input bridge, turn-taking between frames, and the panel's view of a fill spread over several frames |
| `contextMenu.js` | The "Fill this form" right-click menu and its profile submenu; the only fill trigger that reaches chrome-less popup windows |
<!-- ff:logs:start -->
| `fillLogger.js` / `pageHook.js` / `selftest.js` | Local fill logs; page-world hook that captures submitted request bodies; the bench hook the test rig drives the extension through (dev builds only) |
<!-- ff:logs:end -->
| `apiUtils.js` | One chat() for OpenRouter / OpenAI-compatible / Ollama, with tools, images, caching, reasoning effort |
| `browserCompat.js` | Firefox/Chrome API shim |

<!-- ff:logs:start -->
## Testing

```
node test/serve.js
```
Then open, in any browser:

- `http://localhost:8123/test/real_widgets_test.html` - the real libraries, unmodified, from esm.sh: MUI X date field (three "spinbutton" parts), react-select, MUI Autocomplete and Select, and a field that only exists after a choice
- `http://localhost:8123/test/dynamic_form_test.html` - a form that keeps changing, in plain HTML: a cookie banner on top, a date in three boxes, labels placed after their inputs, a country that swaps the region list and adds a tax field, address suggestions that must be picked, clickable delivery cards, required and optional consent, a "Save" that is the user's to press
- `http://localhost:8123/test/trusted_input_test.html` - a real MUI form: Select menus with 250 countries and a hidden native-input mirror, TextField, Checkbox, RadioGroup; records every event with its `isTrusted` flag
- `http://localhost:8123/test/choice_and_date_test.html` - searchable selects (one with emoji flags), a masked date, floating labels, an input that replaces itself while typed into, a date only its calendar can set
- `http://localhost:8123/test/hosted_fields_test.html` - hosted card fields: number, name, expiry and CVC each in their own cross-origin iframe with its own input mask
- `http://localhost:8123/test/agent_bench_test.html` - typed-input checks, date mask, radio group, pre-filled select, hidden custom checkbox, live validation errors, a "Next" step revealing more fields, and submit capture
- `http://localhost:8123/test/typing_and_autocomplete_test.html` - a form that rejects untyped values and an address field requiring a suggestion pick
- `http://localhost:8123/test/widget_variants_test.html` - mouse-only suggestions, non-matching suggestions, readonly combobox, controlled input
- `http://localhost:8123/test/basic_controls_test.html` - select, checkbox, radio, textarea, contenteditable, date, number
- `http://localhost:8123/test/blur_gate_test.html` - a checkout that only records a field's validity in its `blur` handler and keeps "Continuar" disabled until then; the regression test for filling from an unfocused page

The real extension, trusted input included, is driven without a model by the
rig. Each scenario plays the model's part with a script that reads the page by
its words, the way the model does:

```
powershell -ExecutionPolicy Bypass -File build\build.ps1 -Target firefox
node tools/floorp_rig.mjs --all                    # every scenario, real input then reproduced events
node tools/floorp_rig.mjs --scenario real          # one scenario, printing what it saw and did
node tools/floorp_rig.mjs --scenario hosted        # all card frames at once; --no-lock to see what the turn-taking prevents
node tools/floorp_rig.mjs --scenario loop          # the whole loop with the fill log on, and the submit capture after it
node tools/floorp_rig.mjs --scenario look --page test/<file>.html     # only print the page as the model is shown it
node tools/floorp_rig.mjs --page test/dynamic_form_test.html --brain <dir>   # the whole loop, model answers read from files
node tools/floorp_rig.mjs --diag --keep            # the real-input transport stage by stage, browser left open
```
It starts a scratch Floorp (or `--browser <path>`) with its own profile and
WebDriver BiDi, installs `dist/firefox` as a temporary add-on, opens the page
and talks to the extension through the `ff-selftest` hook (`selftest.js`,
localhost pages, dev builds only). It prints per-action results, how many
events the page saw as trusted, and the page's own state.

With `--brain <dir>` the model's place is taken by files: each request is
written to `<dir>/request-<n>.txt` (rules and profile to `system.txt`) and the
answer is read from `<dir>/response-<n>.json`, the arguments of a
`form_actions` call. Any model, or a person, can be the brain of a bench run
that way, with no API key in the scratch profile. The profile used is
`test/bench_profile.txt` (fictional).

`node test/background_test.js` checks the background page's bookkeeping in
Node: frames that start late or outlive the others, a stop, a page without
fields, a failing frame, and the turn-taking.

To reproduce the unfocused-page condition in a test (the sidebar case), stub
`document.hasFocus` to false and make `focus()`/`blur()` update
`document.activeElement` without dispatching events; see the header of
`blur_gate_test.html`.
<!-- ff:logs:end -->

## Demo

[![Form filling demo (YouTube)](https://img.youtube.com/vi/RIxEZ4BZXlI/0.jpg)](https://youtu.be/RIxEZ4BZXlI)
