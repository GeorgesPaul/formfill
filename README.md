# LLM Form Filler Firefox Extension

A Firefox extension that fills forms using large language models for smarter filling and less typing.

## Features

- **LLM-powered form filling** - Uses AI to intelligently match your profile data to form fields
- **Visual form processing** - Optional screenshot-based analysis using OmniParser for complex forms
- **KeePass integration** - Fill username/password fields directly from your KeePass database
- **Multiple profiles** - Store and select from multiple data profiles
- **Works with any LLM** - OpenRouter, OpenAI, Anthropic, or local models via Ollama

## Installation

Install from [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/llm-form-filler/)

## Quick Setup

### Using OpenRouter (recommended)
1. Sign up at [openrouter.ai](https://openrouter.ai)
2. In extension config, set API URL: `https://openrouter.ai/api/v1/chat/completions`
3. Set Model: `anthropic/claude-sonnet-4` (or your preferred model)
4. Enter your API key

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
