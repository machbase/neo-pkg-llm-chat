---
title: How to Use Chat
weight: 30
---

# How to Use Chat

## Select a Model

Click **Select model** at the bottom of the Chat screen to choose the model you want to use.

- A list of registered models is shown by provider.
- The selected model appears in `provider / model` form.
- You cannot send a question until a model is selected.

## Connection Status

The connection status appears below the input area.

- `Connected`
  - The connection to the server is working normally.
- `Disconnected`
  - The connection has been lost.

If the connection is lost, try reconnecting with the **Reconnect** button.

## Send a Question

1. Select a model.
2. Type a question in the input box.
3. Click the send button.

When a model is selected and the conversation is still empty, suggestion chips may appear.  
Clicking a chip fills the input box with an example prompt.

Examples:

- What tables are available?
- Show me the tag list
- Create an analysis dashboard
- Write an analysis report

![Suggestion chips screen](./images/llm-chat-suggestions.png)

## Automatic Mode Switching

Depending on the question text, the internal execution mode may change automatically.

- `report` / `summary report` or their Korean equivalents (`리포트`, `보고서`)
  - Prioritizes the HTML report generation flow.
- `advanced`, `spectrum`, `envelope`, `anomaly`, `FFT`, `RMS` or their Korean equivalents (`심층`, `다각도`, `고급`, `스펙트럼`, `엔벨로프`)
  - Prioritizes the advanced analysis flow (in-depth charts compiled from analysis intent).
- General query, analysis, or dashboard requests
  - Use the basic analysis flow.

## While a Response Is Being Generated

While a response is being generated, the normal send button is replaced by a **Stop** button.

- Click Stop if you want to interrupt generation.
- When generation finishes, the normal send button returns.

## Clear the Conversation

After messages have accumulated, you can clear the current session with **Clear session** in the upper-right area.

This action is used only to reset the current conversation session.

## Go Back to Settings

Click the Settings button in the lower-right area of the input section to return to the Settings screen.

This is mainly used when:

- Adding another provider API key
- Registering a new model
- Changing the Machbase connection information

## Example Requests

- List tables
  - `"Show me the table list"`
- List tags
  - `"Show me the tag list for the Example table"`
- Explore documentation
  - `"What is Rollup?"`
- Create a dashboard
  - `"Create an analysis dashboard for the Example table data"`
- Create an in-depth dashboard
  - `"Create an in-depth analysis dashboard for the Example table data"`
- Create an analysis report
  - `"Write an analysis report for the Example table data"`

## Tips

- Start with simple lookup questions first.
- For dashboard or report requests, it helps to include the table name explicitly.
- If you use multiple models, it is useful to separate fast-query models from deeper-analysis models.

## Navigation

- [Previous: First Setup](./first-setup.en.md)
- [Back to Index](./index.en.md)
- [Next: Technical Reference](./technical-reference.en.md)
