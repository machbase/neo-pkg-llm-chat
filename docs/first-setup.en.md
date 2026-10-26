---
title: First Setup
weight: 20
---

# First Setup

<p align="center" style="margin-top:1.25rem"><a href="./first-setup.kr.md">한국어</a> | <strong>English</strong> | <a href="./first-setup.ja.md">日本語</a></p>

If no settings have been saved yet, the Settings screen appears first when you open the package.  
If settings already exist, you may go directly to the Chat screen.

## Before You Start: Issue an API Token

LLM Chat connects to the database with a Machbase Neo **API token**.  
Queries, charts, dashboards, and reports all run with the permissions of that token's account.

1. Open the Neo web console (`http://<neo-host>:5654`) and log in with the account you will use LLM Chat with.
2. Click the shield icon **①**, then the **+** button next to **TOKENS** **②**.
3. Enter a name for the token **③** (e.g. `llm-chat`) and click **Issue token** **④**. You can set the expiry date in **NotAfter**.

   ![Create a Neo API token](./images/neo-token-create.png)

4. Copy the issued token (it starts with `nt_`) with the copy button **⑤**.

   ![Copy the Neo API token](./images/neo-token-copy.png)

> The token string is shown only once, when it is issued. If you lose it, issue a new token.  
> The token must **belong to the account logged in to the console**. A token of another account is rejected during verification.  
> Required version: Machbase Neo 8.7.3 or later

## Machbase Connection

Enter the Machbase Neo connection the LLM uses for query execution and dashboard creation.

| Field | Value |
| :--- | :--- |
| `Host` | Machbase Neo address (e.g. `127.0.0.1`) |
| `Port` | Machbase Neo HTTP port (default `5654`) |
| `API Token` | The token issued above |

### Verify the Token

1. Paste the token into the `API Token` field. The value is masked; use the eye icon on the right to reveal it.
2. Click the **검증** (Verify) button.
3. Check the result shown below the field.

| Result shown | Meaning | Action |
| :--- | :--- | :--- |
| `✓ JOY` | Valid token that matches the console login account | Continue to the next step |
| `✗ 유효하지 않은 토큰입니다` | The token is wrong, or was deleted or expired in Neo | Copy the token again or issue a new one |
| `✗ 콘솔 로그인 계정(JOY)과 다른 계정(SYS)의 토큰입니다` | The token belongs to a different account | Enter a token of the account logged in to the console |
| `✗ Neo 콘솔 로그인 정보를 확인할 수 없습니다` | Not logged in to the console | Log in to the console, then reopen LLM Chat |

When verification succeeds, `현재 JOY 토큰으로 접속 중` (connected with the JOY token) is shown.  
If the server already has settings saved for this account, they are loaded automatically.

![Machbase Connection settings screen](./images/llm-settings-connection.png)

### How the Token Is Stored

- The token is stored **only in this browser**, separately for each console account. It is not saved in the server's config files.
- Once saved, you do not have to enter it again after closing the browser or restarting the PC or Neo.
- Enter the token again in these cases:
  - Opening from another PC or another browser
  - The browser's site data was cleared, or a private window is used
  - The access address changed (`127.0.0.1` and `192.168.x.x` are treated as different storage)
  - The token was deleted in Neo or has expired
- Even in the same browser, the token field starts empty when the console login account changes.
- On a shared PC, click **토큰 지우기** (Clear token) when you are done.

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

- `Host`, `Port`, and `API Token` are not empty
- The API token is valid and matches the console login account (it is verified again when you click Save)
- Every added model row has both Display Name and Model ID filled in
- At least one provider is actually usable

If saving fails, the screen shows which input is missing or why the save could not be completed.

## After Save

After saving the settings, the screen moves to Chat.  
The connection status at the bottom of the Chat input box also shows the account, such as `Connected · JOY`.

Later, you can open the Settings screen again from the Settings (gear) button at the lower right of the input box.

> If you enter only the token in a new browser and click Save, and the server already has settings for this account, those settings are loaded first and the save stops. Review the loaded values, then click Save again.

## Navigation

- [Back to Index](./index.en.md)
- [Next: How to Use Chat](./chat-usage.en.md)
