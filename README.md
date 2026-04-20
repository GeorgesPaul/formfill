# LLM Form Filler Firefox Extension

A Firefox extension that fills forms using large language models for smarter filling and less typing.

## Features

- **LLM-powered form filling** - Uses AI to intelligently match your profile data to form fields
- **Vision mode** - Attaches a page screenshot to the LLM call so models can read visual labels the DOM doesn't expose (no external parser, no Docker — one API call)
- **Heuristic fast-path** - Common fields (name, email, phone, address, credit card, etc.) are matched deterministically from HTML `autocomplete` attributes and label patterns before the LLM is called, cutting cost and latency
- **KeePass integration** - Fill username/password fields directly from your KeePass database
- **Multiple profiles** - Store and select from multiple data profiles
- **Works with any LLM** - OpenRouter, OpenAI, Anthropic, or local models via Ollama

## Recommended vision models (for "Vision mode")

Use OpenRouter as the endpoint. One-click presets in **LLM API Config** for:

| Model | OpenRouter slug | Notes |
|---|---|---|
| Claude Opus 4.7 | `anthropic/claude-opus-4.7` | Default. Best reasoning for ambiguous profile-to-field matching. |
| Claude Sonnet 4.5 | `anthropic/claude-sonnet-4.5` | Anthropic's agentic flagship; often beats Opus on GUI/computer-use at ~1/5 the price. |
| GPT-5 | `openai/gpt-5` | OpenAI's latest flagship with vision. |
| Qwen2.5-VL 72B | `qwen/qwen-2.5-vl-72b-instruct` | Cheap open-source option; strong on GUI grounding benchmarks. |

Avoid GPT-4o-mini and Gemini 2.5 Pro — in testing they performed notably worse than the above on form-fill tasks.

## Installation

Install from [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/llm-form-filler/)

## Quick Setup

### Using OpenRouter (recommended)
1. Sign up at [openrouter.ai](https://openrouter.ai)
2. In the extension's **LLM API Config**, click a preset (Claude Opus 4.7, Sonnet 4.5, GPT-5, or Qwen2.5-VL 72B) — it auto-fills the URL and model.
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

## Demo

[![Form filling demo (YouTube)](https://img.youtube.com/vi/RIxEZ4BZXlI/0.jpg)](https://youtu.be/RIxEZ4BZXlI)
