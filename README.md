# LLM Form Filler

A browser extension that fills forms using large language models for smarter filling and less typing.
Runs on **Firefox** (Manifest V2) and **Chrome** (Manifest V3) from one shared source tree.

## How it fills a form (the agent loop)

Filling is a short closed loop, not a single guess:

1. **Snapshot.** `formKit.js` describes every visible field with a stable ref
   (`f12`, radio groups collapsed into one `g3` choice), its computed
   accessible label (spec order first, then layout heuristics: text to the
   left/above, table headers), options, current value, and any validation
   error the page shows.
2. **Memory and heuristics.** If this same form was filled before, the
   remembered field-to-profile mapping is applied directly; when it covers
   everything cleanly, **no model call is made at all**. Deterministic
   matches (autocomplete attributes, label patterns) are attached as
   suggestions.
3. **Model turn.** The model gets the snapshot and the profile and answers
   with a `form_actions` tool call: a batch of `{ref, op, value}` actions plus
   what it deliberately skipped and why (including "the user must supply
   this").
4. **Execute and observe.** The extension performs the actions with real
   keystrokes, resolves suggestion dropdowns, drives comboboxes, radios and
   checkboxes, and can click "Next"/"Continue" style buttons. Then it reports
   back: the value each field actually holds, validation messages, and which
   fields appeared, changed or vanished.
5. **Repeat.** The model fixes rejected values, fills newly revealed fields,
   and declares done. Bounded by the configurable turn budget (default 4;
   most forms finish in 1 or 2 calls, remembered forms in 0).

Submit-type buttons are never clicked and password fields are never filled
(credentials come from the separate KeePass button).

## Features

- **Closed-loop agent filling** - the model sees what the page did and fixes it, instead of one-shot fill-and-hope
- **Per-site memory** - repeat forms fill instantly and free; the model is only consulted for what memory does not cover
- **Simulated typing by default** - real keydown/keypress/beforeinput/input/keyup, then change + blur; modern forms reject values that merely appear
- **Autocomplete dropdown handling** - suggestion lists are watched from the first keystroke, scored, and selected by keyboard or mouse (LLM tiebreak on ambiguity)
- **Validation-aware** - aria-invalid, constraint validation and visible error text are read back after every action and fed to the model
- **"Needs your input" report** - fields the profile cannot answer are listed in the panel instead of silently skipped
- **Local fill logs** - every fill records what the site looked like, what the model was asked/answered, what the extension did, what the page did in response, and what was actually submitted afterwards (FormData + request bodies). Export as JSON from the panel; nothing leaves your machine
- **Optional screenshot** - a checkbox attaches one screenshot on the first turn for vision-capable models; off by default (slower, more expensive)
- **KeePass integration** - fill username/password directly from a KeePass database
- **Multiple profiles**, free-text `key: value` format
- **Works with any LLM** - OpenRouter, OpenAI-compatible endpoints, or local models (Ollama `/v1/chat/completions` recommended; tool calls and JSON fallback both supported)

## Recommended models

Use OpenRouter as the endpoint. One-click presets in **LLM API Config** for:

| Model | OpenRouter slug | Notes |
|---|---|---|
| Claude Opus 5 | `anthropic/claude-opus-5` | Default. Best reasoning for ambiguous profile-to-field matching. |
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
Requires Firefox 128+ (the network-capture hook runs in the page's world).

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
3. Paste your OpenRouter API key and save. Reasoning effort and the per-fill turn budget are configurable per config.

### Using Local LLM (Ollama)
1. Install [Ollama](https://ollama.com/)
2. Run a tool-capable model, e.g. `ollama run llama3.1`
3. In extension config, set API URL: `http://localhost:11434/v1/chat/completions`

### KeePass Integration
1. Click "KeePass Config" in the extension
2. Upload your .kdbx database file and unlock it
3. Use "Fill User/Pass" to fill credentials

## Fill logs

Every fill session is recorded locally (toggle in the panel):

- the page snapshot (fields, labels, options, values) and sanitized form HTML
- one screenshot at start and end (when the tab allows capture)
- every model request/response, executed action and its per-action result
- what the page did after each batch: new/changed/removed fields, validation errors, autocomplete popups seen and picked
- what was submitted afterwards: form values and FormData at submit/Next clicks, non-GET request bodies (fetch/XHR/beacon/form.submit, password-like keys redacted), and the page that followed

Export from the panel as JSON (optionally with profile values redacted) and feed
the file to an LLM to analyse why a fill went wrong. Storage is
`browser.storage.local` only; the last 30 sessions are kept.

## Repository layout

```
src/          extension source, shared by both browsers (no manifest here)
manifests/    manifest.firefox.json (MV2) and manifest.chrome.json (MV3)
build/        build.ps1 (assembles dist\<target>) plus the release scripts
test/         test benches + harness; `node test/serve.js` then open http://localhost:8123/test/
dist/         build output, git-ignored
attic/        files no longer wired into the extension, kept for reference
```

Key source files:

| File | Role |
|---|---|
| `formKit.js` | The primitive layer: snapshot (refs, labels, validation, geometry), execute (fill/choose/set/click/clear), diff, page HTML capture |
| `fillAgent.js` | The closed-loop driver: memory fast path, model turns via the `form_actions` tool, feedback, needs-input reporting |
| `accessibleName.js` | Computed accessible names, helper/error text extraction, section context |
| `domUtils.js` | Per-element fill mechanics: realistic focus, typing cascade, selects, custom comboboxes, checkboxes/radios, validation reading |
| `typingEngine.js` | Keystroke-level text entry: per-character typing, clearing, retyping, commit on blur |
| `autocompleteFiller.js` | Detects suggestion popups, scores options against the intended value, selects one |
| `siteMemory.js` | Remembers which profile key filled which field, per site+form signature |
| `fillLogger.js` / `pageHook.js` | Local fill logs; page-world hook that captures submitted request bodies |
| `heuristicFiller.js` | Deterministic suggestions from autocomplete attributes and label patterns |
| `apiUtils.js` | One chat() for OpenRouter / OpenAI-compatible / Ollama, with tools, images, caching, reasoning effort |
| `browserCompat.js` | Firefox/Chrome API shim |

## Testing

```
node test/serve.js
```
Then open, in any browser:

- `http://localhost:8123/test/agent_bench_test.html` - the agent-loop bench: typed-input checks, date mask, radio group, pre-filled select, hidden custom checkbox, live validation errors, a "Next" step revealing more fields, and submit capture
- `http://localhost:8123/test/typing_and_autocomplete_test.html` - form that rejects untyped values and an address field requiring a suggestion pick
- `http://localhost:8123/test/widget_variants_test.html` - mouse-only suggestions, non-matching suggestions, readonly combobox, controlled input
- `http://localhost:8123/test/basic_controls_test.html` - select, checkbox, radio, textarea, contenteditable, date, number

`test/agent_harness.js` loads the real extension sources into any of those pages
with a stubbed `browser` API and drives `FillAgent.run` with a scripted mock
model, so the whole loop can be exercised without packaging the extension or
spending API calls (see the header of that file for usage).

## Demo

[![Form filling demo (YouTube)](https://img.youtube.com/vi/RIxEZ4BZXlI/0.jpg)](https://youtu.be/RIxEZ4BZXlI)
