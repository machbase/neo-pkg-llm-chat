---
title: Troubleshooting
weight: 60
---

# Troubleshooting

## Settings Cannot Be Saved

Check the following items:

- Machbase `Host`, `Port`, `User ID`, and `Password`
- The added model's `Display Name` and `Model ID`
- Whether at least one usable provider has been registered

If required input is missing, an error message is shown when you try to save.

## The Model List Is Empty

- Check whether a model was actually added in Settings.
- Check whether the provider API key or Ollama URL is correct.
- Open the model list again from the Chat screen and refresh it.

## The Chat Screen Shows Disconnected

- The server connection may have been interrupted temporarily.
- Try reconnecting with the `Reconnect` button.
- If it keeps failing, check both the package service status and the browser network condition.

## A Question Was Sent but the Response Is Slow

Possible causes:

- The selected model itself is slow
- The external provider response is slow
- Machbase queries or dashboard generation take a long time

In this case, wait a little longer, or stop the response and retry with a simpler question.

## The Result Is Not What You Wanted

- Ask with the exact table name.
- Results are usually more stable when you also include the time range, tag name, and column name.
- It helps to make the purpose explicit with terms like "dashboard", "report", or "tag list".

## Recommended Practices

- Start with one provider and one model first, and confirm that the package works.
- If the Machbase connection changes, update it in Settings immediately.
- If you use multiple models, use clear Display Names so they are easy to distinguish.

## Navigation

- [Previous: HTTP API and WebSocket](./http-api-and-websocket.en.md)
- [Back to Index](./index.en.md)
