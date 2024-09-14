# LLM Form filling Firefox extension
A Firefox extension that fills forms using a large language model for better filling and less typing. 

This attempts to fix issues with all other form filling software that never seems to be able to get it right. 
Currently there 2 ways to run LLMs: 
1. Use an online LLM, for example Claude Sonnet 3.5 through openrouter.ai (recommended for best performance)
2. Use an offline LLM, for example llama3.1 through Ollama running on your laptop/machine. 

The advantages of running the offline LLM are that it's free and that no data is shared with anybody. The disadvantage are that it's much slower, less performant and requires a fast machine to run acceptably fast. 

# Example of form filling: 

[![Filling example](https://youtu.be/RIxEZ4BZXlI/0.jpg)](https://youtu.be/RIxEZ4BZXlI)

# To try it out
This extension was written for Firefox


**Steps to get it to work with openrouter.ai with Claude Sonnet 3.5:**
1. Go to https://addons.mozilla.org/en-US/firefox/addon/llm-form-filler/ and install the extension.
2. Sign up for an account on openrouter.ai to access Claude Sonnet 3.5.
3. In the extension configuration, set the API URL and Model to the Claude Sonnet 3.5 endpoint provided by openrouter.ai. This will typically be in the format of `https://openrouter.ai/api/v1/chat/completions`. Under model fill out: anthropic/claude-3.5-sonnet:beta
4. Ensure you have a valid API key from openrouter.ai. You need to purchase and set this up in the openrouter.ai interface.
5. In the extension configuration, enter your openrouter.ai API key in the designated field.
6. Save the configuration changes. 
7. In Firefox, click "fill form" on a website with forms. The extension will now use Claude Sonnet 3.5 through openrouter.ai to fill the form.
![Screenshot of the extension configuration for openrouter.ai with Claude Sonnet 3.5](/screenies/openrouterconfig.png)

**Steps to get it to work with offline LLM running locally on your machine:**
1. Go to https://addons.mozilla.org/en-US/firefox/addon/llm-form-filler/ and install the extension. 
2. Download and install Ollama from https://ollama.com/
3. In the command line type **ollama run llama3.1**
4. Wait for the model to completely download and run.
5. In Firefox in the extension configure the API to use the local LLM. See screenshot:
![Screenshot of the extension configuration for local LLM](/screenies/ollamaconfig.png) Default URL for this is http://localhost:11434/api/generate 
6. In Firefox click "fill form" on a website with forms.

Note: the API check doesn't work for local models yet. 

