---
title: Troubleshooting
weight: 60
---

# Troubleshooting

## Settings Cannot Be Saved

Check the following items:

- Machbase `Host`, `Port`, and `API Token`
- Whether the API token verification result is `✓` (see "Token Verification Fails" below)
- The added model's `Display Name` and `Model ID`
- Whether at least one usable provider has been registered

If required input is missing, an error message is shown when you try to save.

## Token Verification Fails

| Result shown | Cause | Action |
| :--- | :--- | :--- |
| `✗ 유효하지 않은 토큰입니다` (invalid token) | The token was copied incorrectly, or it was deleted or expired in Neo | Copy the token again or issue a new one in the Neo console |
| `✗ 콘솔 로그인 계정(…)과 다른 계정(…)의 토큰입니다` (token of a different account) | The token's account differs from the account logged in to the console | Enter a token of the console login account, or log in to the console with the token's account |
| `✗ Neo 콘솔 로그인 정보를 확인할 수 없습니다` (console login not found) | Not logged in to the console | Log in to the console, then reopen LLM Chat |
| `✗ 검증 실패: …` (verification failed) | The LLM Chat service cannot be reached | Check that the package service is running |

## "저장된 API 토큰을 사용할 수 없습니다" Appears When Opening the App

- The token saved in the browser was deleted or has expired in Neo.
- On the Settings screen, enter a new token, click **검증** (Verify), then **Save**.

## "API 토큰이 확인되지 않았습니다" Appears in the Chat

- The token was deleted or expired while in use.
- Enter a new token on the Settings screen, verify and save it, then ask again.

## Asked to Enter the Token Again on Another PC or Browser

- This is expected. The token is stored per browser and per console account.
- Enter and verify a token of the same account, and the settings saved on the server (providers, models) are loaded.
- When the access address changes (`127.0.0.1` ↔ `192.168.x.x`), the browser treats it as different storage, so the token must be entered again.

## A Report Link Does Not Open

- A report link in the chat fetches the file with the saved API token and shows it in a new window.
- If "API 토큰이 유효하지 않습니다" (invalid API token) appears, check the token in Settings.
- Copying the link address and opening it directly in the address bar fails with `401`, because Neo requires token authentication. Open it by clicking the link in the chat.

## A Timer Was Requested but Not Registered

- LLM Chat does not register, start, stop, delete, or list timers.
- For timer questions, it explains from the manual how to register them (the Timer menu in the web console, the shell `timer` commands) and shows TQL examples.
- Register and manage timers yourself from the Timer menu in the Neo web console or from the shell.

## The Model List Is Empty

- The list is empty until this account's settings have been saved. Click Save in Settings.
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
- Local models (Ollama) run SQL at most 8 times per question. Split questions that need many queries.

## Asked to Edit a Dashboard but a New Dashboard Was Created

- This version does not support editing an existing dashboard through chat (adding or removing charts, changing the time range, and so on).
- Edit dashboards in the dashboard screen of the Neo web console.

## Times Look Different from What You Expected

- Times in query results, charts, and reports are based on the browser's time zone.
- If you need another time zone, say so in the question, for example "in UTC".
- Dates in the question (`yesterday`, `March 2025`) are interpreted in the Neo server's time zone. If the browser and server time zones differ, period boundaries can be off.

## Recommended Practices

- Start with one provider and one model first, and confirm that the package works.
- If the Machbase connection changes or you issue a new token, update it in Settings immediately.
- If you use multiple models, use clear Display Names so they are easy to distinguish.

## Navigation

- [Previous: HTTP API and WebSocket](./http-api-and-websocket.en.md)
- [Back to Index](./index.en.md)
