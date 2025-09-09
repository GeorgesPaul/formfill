# LLM Form filling Firefox extension
A Firefox extension that fills forms using a large language model for better filling and less typing. 

This attempts to fix issues with all other form filling software that never seems to be able to get it right. 
Currently there are two primary ways to run LLMs for form filling: 
1. Use an online LLM, such as Grok-1 through openrouter.ai (recommended for best performance and accuracy).
2. Use an offline LLM, for example Llama3.1 through Ollama running on your local machine. 

The advantages of running an offline LLM are that it's free and no data is shared with third parties. The disadvantages are that it's typically much slower, less performant, and requires a fast machine to run acceptably. 

# Example video of form filling: 

[![Filling example video (Youtube)](https://img.youtube.com/vi/RIxEZ4BZXlI/0.jpg)](https://youtu.be/RIxEZ4BZXlI)


# To try it out
This extension was written for Firefox.


**Steps to get it to work with openrouter.ai using Grok-1:**
1. Go to https://addons.mozilla.org/en-US/firefox/addon/llm-form-filler/ and install the extension.
2. Sign up for an account on openrouter.ai to access Grok-1 or any other LLM you prefer. 
3. In the extension configuration, set the API URL and Model. The API URL will typically be `https://openrouter.ai/api/v1/chat/completions`. Under 'Model', enter `xai/grok-1`.
4. Ensure you have a valid API key from openrouter.ai. You will need to obtain and set this up in the openrouter.ai interface.
5. In the extension configuration, enter your openrouter.ai API key in the designated field.
6. Save the configuration changes. 
7. In Firefox, click "fill form" on a website with forms. The extension will now use Grok-1 through openrouter.ai to fill the form.
![Screenshot of the extension configuration for openrouter.ai with Claude Sonnet 3.5](/screenies/openrouterconfig.png)


**Steps to get it to work with an offline LLM running locally on your machine:**
1. Go to https://addons.mozilla.org/en-US/firefox/addon/llm-form-filler/ and install the extension. 
2. Download and install Ollama from https://ollama.com/
3. In the command line, type `ollama run llama3.1` (or your preferred local model).

Note: the API check doesn't work for local models yet. 

