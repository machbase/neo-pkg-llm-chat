---
title: First Setup
weight: 20
---

# First Setup

If no settings have been saved yet, the Settings screen appears first when you open the package.  
If settings already exist, you may go directly to the Chat screen.

## Machbase Connection

First, enter the Machbase Neo connection information.

Input fields:

- `Host`
- `Port`
- `User ID`
- `Password`

This is the Machbase connection used by the LLM for query execution and dashboard creation.

![Machbase Connection settings screen](./images/llm-settings-connection.png)

## API Keys & Endpoints

Next, enter the LLM provider information you want to use.

Supported entries:

- `Claude`
- `ChatGPT`
- `Gemini`
- `Ollama`

Input method:

- Claude, ChatGPT, Gemini: enter an API key
- Ollama: enter a `base_url`

You do not need to fill in every provider.  
Only the providers you actually plan to use are required.

Where to find model information for each provider:

- Claude
  - Check the `Claude API ID` in the Anthropic Models documentation.
- ChatGPT
  - Check the `Model ID` in the OpenAI Models documentation.
- Gemini
  - Check the model code in the Gemini Models documentation.
- Ollama
  - Use the local model name exactly as downloaded with `ollama pull`.

## Register Models

LLM Chat registers models separately for each provider.

Values entered in each row:

- `Provider`
- `Display Name`
- `Model ID`

For example, the visible label may be `GPT-4.1`, while the actual call uses the provider's exact model ID.

Configuration tips:

- Use an easy-to-recognize name for Display Name.
- Use the exact value shown in the provider documentation for Model ID.
- For Ollama, use the name of the model you pulled locally.

![Models settings screen](./images/llm-settings-models.png)

## Check Before Saving

The following conditions must be satisfied before settings can be saved.

- The Machbase connection fields are not empty
- Every added model row has both Display Name and Model ID filled in
- At least one provider is actually usable

If saving fails, the screen shows which input is missing or why the save could not be completed.

## After Save

After saving the settings, the screen moves to Chat.

Later, you can open the Settings screen again from the Settings button in the lower-right area.

## Navigation

- [Back to Index](./index.en.md)
- [Next: How to Use Chat](./chat-usage.en.md)
