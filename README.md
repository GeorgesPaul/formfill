# LLM Form Filler

A browser extension that fills forms using large language models for smarter filling and less typing.
Runs on **Firefox** (Manifest V2) and **Chrome** (Manifest V3) from one shared source tree.

## Features

- **LLM-powered form filling** - Uses AI to intelligently match your profile data to form fields
- **Simulated typing by default** - Every text field is typed into character by character (real keydown/keypress/beforeinput/input/keyup, then change + blur). Modern forms check that a field was actually typed into and reject values that simply appear, which is why plain value assignment now produces "this field is required" on a visibly filled form
- **Autocomplete dropdown handling** - Address/city/company lookups that require picking a suggestion are detected while typing, scored against your profile value, and selected by keyboard or mouse (with an LLM tiebreak when the choice is ambiguous)
- **Vision mode** - Attaches a page screenshot to the LLM call so models can read visual labels the DOM doesn't expose (no external parser, no Docker: one API call)
- **Heuristic fast-path** - Common fields (name, email, phone, address, credit card, etc.) are matched deterministically from HTML `autocomplete` attributes and label patterns before the LLM is called, cutting cost and latency
- **KeePass integration** - Fill username/password fields directly from your KeePass database
- **Multiple profiles** - Store and select from multiple data profiles
- **Works with any LLM** - OpenRouter, OpenAI, Anthropic, or local models via Ollama

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

### Chrome
```powershell
powershell -ExecutionPolicy Bypass -File build\build.ps1 -Target chrome
```
then `chrome://extensions` -> enable Developer mode -> Load unpacked -> select `dist\chrome`.

The Chrome build uses the side panel (click the toolbar icon) instead of Firefox's sidebar. Everything else is identical.

## Quick Setup

### Using OpenRouter (recommended)
1. Sign up at [openrouter.ai](https://openrouter.ai)
2. In the extension's **LLM API Config**, click a preset (Claude Opus 5, Sonnet 5, GPT-5, or Qwen2.5-VL 72B): it auto-fills the URL and model.
3. Paste your OpenRouter API key and save.
4. Tick **Vision mode (attach screenshot)** on the main panel if you want the model to see the page visually (recommended for tricky forms).

### Using Local LLM (Ollama)
1. Install [Ollama](https://ollama.com/)
2. Run `ollama run llama3.1`
3. In extension config, set API URL: `http://localhost:11434/v1/chat/completions`

### KeePass Integration
1. Click "KeePass Config" in the extension
2. Upload your .kdbx database file
3. Enter your master password to unlock
4. Use "Fill User/Pass" button to fill credentials

## Repository layout

```
src/          extension source, shared by both browsers (no manifest here)
manifests/    manifest.firefox.json (MV2) and manifest.chrome.json (MV3)
build/        build.ps1 (assembles dist\<target>) plus the AMO release scripts
test/         test benches; `node test/serve.js` then open http://localhost:8123/test/
dist/         build output, git-ignored
attic/        files no longer wired into the extension, kept for reference
```

Key source files:

| File | Role |
|---|---|
| `typingEngine.js` | Keystroke-level text entry: per-character typing, clearing, retyping the last character, commit on blur |
| `autocompleteFiller.js` | Detects suggestion popups, scores options against the intended value, selects one |
| `domUtils.js` | Field discovery, `fillField` dispatch per control type, fill/verify/refill loop |
| `formFiller.js` | DOM-only LLM path (runs in iframes and when vision mode is off) |
| `visionFiller.js` | Top-frame vision-LLM path (screenshot + DOM metadata in one call) |
| `heuristicFiller.js` | Deterministic pre-pass before the LLM is consulted |
| `browserCompat.js` | Firefox/Chrome API shim (`browser` alias, `executeScript`, `captureVisibleTab`, safe notify) |

## Testing

```
node test/serve.js
```
Then open, in any browser:

- `http://localhost:8123/test/typing_and_autocomplete_test.html` - form that rejects untyped values and an address field requiring a suggestion pick
- `http://localhost:8123/test/widget_variants_test.html` - mouse-only suggestions, non-matching suggestions, readonly combobox, controlled input
- `http://localhost:8123/test/basic_controls_test.html` - select, checkbox, radio, textarea, contenteditable, date, number

## Demo

[![Form filling demo (YouTube)](https://img.youtube.com/vi/RIxEZ4BZXlI/0.jpg)](https://youtu.be/RIxEZ4BZXlI)
