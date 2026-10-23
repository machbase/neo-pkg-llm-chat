---
title: HTTP API and WebSocket
weight: 50
---

This document summarizes the HTTP API endpoints and WebSocket protocol exposed by the LLM Chat package service.

The package uses a gateway / worker architecture: the browser opens a WebSocket to the gateway, and the gateway starts a per-session worker process that runs the agentic loop. **Chat happens entirely over WebSocket, not HTTP** — the HTTP endpoints are used only for configuration, preferences, and health/diagnostics.

## HTTP API Endpoints

All configuration responses use a `{ success, reason, data }` JSON envelope. To avoid a CORS preflight, `PUT` / `DELETE` can also be issued as `POST` with a `_method=PUT` or `_method=DELETE` query parameter and a `text/plain` body.

### Health & Diagnostics

| Method | Path | Description |
| :---: | :--- | :--- |
| GET | `/health` | Health check. Returns `{ "ok": true }` |
| GET | `/api/debug` | Diagnostics: configs directory and file list, active worker count. Requires an API token |

The service port is set by `server.port` in `configs/sys.json` (default `8884`). The launcher reads it at startup.

### User Configurations

A configuration is stored per user (`configs/{user}.json`). The config name is the Machbase user.

Every request to the token check, config, and preference APIs below **requires an `Authorization: Bearer {API token}` header** (a token starting with `nt_`, issued in the Neo web console). The server verifies it with Machbase Neo's `POST /db/token/validate` to establish the account, and refuses any name that is not theirs. Account names are handled in lowercase (e.g. `SYS` → `sys`).

| Situation | Response |
| :--- | :--- |
| Missing / invalid / deleted or expired token | `401` `{"success": false, "reason": "authentication required"}` |
| Asking for another user's config | `403` `{"success": false, "reason": "forbidden"}` |

### Token Check

| Method | Path | Description |
| :---: | :--- | :--- |
| GET | `/api/token/validate` | Verify the API token in the header and return the account name. Success `200` `{"success": true, "data": {"user": "sys"}}`, failure `401` `{"success": false, "reason": "invalid token"}` |

The **검증** (Verify) button on the Settings screen calls this API. Whether the account matches the console login account is checked separately in the browser.

| Method | Path | Description |
| :---: | :--- | :--- |
| GET | `/api/configs` | List saved config names (**yours only**). With `?name={name}`, return that config |
| POST | `/api/configs` | Save a config. The file name and the body's `machbase.user` are **forced to the token's user** (a different account in the body is ignored). `machbase.token` and `machbase.password` in the body are **removed, never saved** |
| PUT | `/api/configs?name={name}` | Update a config |
| DELETE | `/api/configs?name={name}` | Delete a config |
| GET | `/api/configs/{name}` | Get a specific config |
| PUT | `/api/configs/{name}` | Update a specific config |
| DELETE | `/api/configs/{name}` | Delete a specific config |

### Per-User UI Preferences

| Method | Path | Description |
| :---: | :--- | :--- |
| GET | `/api/prefs` | Get UI preferences (favorites) |
| POST | `/api/prefs` | Save UI preferences (favorites) |
| PUT | `/api/prefs` | Save UI preferences (favorites) |

The target user comes from the token — there is no name parameter.

### WebSocket Paths

| Method | Path | Description |
| :---: | :--- | :--- |
| GET | `/ws` | Browser chat WebSocket. The user is established by **verifying `auth_token` on every message** |
| GET | `/internal/ws` | Internal gateway ↔ worker channel (not for clients) |

### Relay Routes

These routes proxy directly to the connected Machbase Neo server (used by the UI to run TQL and render charts / dashboards).

| Method | Path | Description |
| :---: | :--- | :--- |
| POST | `/db/tql` | Relay a TQL execution request to Neo's `/db/tql`. **Requires an `Authorization: Bearer {API token}` header**; the caller's token is passed through (`401` without one). Before relaying, unprefixed table names after `FROM` and `JOIN` are filled in as `DB.OWNER.TABLE`, based on the tables the token's account can see. If the same name exists under several accounts, the request is not executed and `400` is returned with the candidates |

Relayed calls run as the account of the caller's token, so Machbase refuses tables they may not read.

### Example: Health Check

```bash
curl http://localhost:8884/health
```

```json
{"ok": true}
```

### Example: Token Check

```bash
TOKEN=nt_a_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
curl -H "Authorization: Bearer $TOKEN" http://localhost:8884/api/token/validate
```

```json
{"success": true, "reason": "success", "data": {"user": "sys"}}
```

### Example: List Saved Configs

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8884/api/configs
```

```json
{"success": true, "reason": "success", "data": {"configs": ["sys"]}}
```

Calling without a token returns `401`.

## WebSocket Protocol

The chat UI communicates with the service over WebSocket. The connection URL is `ws://{host}:{port}/ws`. The gateway routes each session to a worker process and relays the worker's streaming messages back to the browser.

**Every client message must carry `auth_token`** (a Machbase Neo API token). The gateway verifies it on every message to establish the user, so changing the token or deleting it in Neo takes effect from the next message. The `user_id` field is not used to decide identity.

The gateway passes the verified token to the worker only inside the `chat` message; it is never written to the worker config files (`workers/*.json`) or to user config files.

When verification fails the gateway replies:

```json
{"type": "error", "code": "auth_required", "msg": "API 토큰이 확인되지 않았습니다. 설정에서 토큰을 확인한 뒤 다시 시도하세요."}
```

A message that uses a session ID created by another account is refused with `code: "auth_required"` and `msg: "다른 계정의 세션입니다."` (session of another account).

### Client to Server Messages

**get_models** — request the available LLM providers and models:

```json
{"type": "get_models", "auth_token": "nt_a_xxxx..."}
```

**chat** — send a chat message (`provider` and `model` are required):

```json
{
  "type": "chat",
  "auth_token": "nt_a_xxxx...",
  "session_id": "sess-1234567890",
  "provider": "claude",
  "model": "claude-sonnet-4-6",
  "query": "Analyze the GOLD table",
  "tz": "Asia/Seoul"
}
```

`tz` is optional: the browser time zone (IANA name). It sets the zone for times in query results, charts, and reports, and for the current time given to the model; when omitted, the server time zone is used.

**stop** — stop the current generation:

```json
{"type": "stop", "session_id": "sess-1234567890"}
```

**clear** — clear the session (kills the worker):

```json
{"type": "clear", "session_id": "sess-1234567890"}
```

### Server to Client Messages

**models** — response to `get_models`:

```json
{"type": "models", "providers": [ { "provider": "claude", "models": ["..."] } ]}
```

If this account has no saved settings yet, the following is returned instead of `providers`:

```json
{"type": "models", "msg": "No providers configured. Please set API keys in Settings."}
```

**msg** — streaming envelope. Progress narration and the final answer are both delivered as `msg` events. The inner `message.type` marks the phase, and text arrives in `body.ofStreamBlockDelta`:

```json
{
  "type": "msg",
  "message": {
    "ver": "1.0",
    "id": 1699999999999,
    "type": "stream_block_delta",
    "body": {
      "ofStreamBlockDelta": {
        "contentType": "text/markdown",
        "text": "Querying the GOLD table..."
      }
    }
  }
}
```

Inner `message.type` phases, in order:

- `answer_start` — a response is starting
- `stream_block_start` / `stream_block_delta` / `stream_block_stop` — progress narration (tool steps are described here as markdown text)
- `stream_msg_start` / `stream_msg_delta` / `stream_msg_stop` — the final answer text
- `answer_stop` — the response is complete

**followups** — suggested follow-up questions after an answer (not sent if none could be generated):

```json
{"type": "followups", "session_id": "sess-1234567890", "items": ["..."]}
```

**error** — an error occurred (may include a `code`, for example `config_required`):

```json
{"type": "error", "session_id": "sess-1234567890", "msg": "Agent error: ..."}
```

> Note: There are no separate `tool_call` / `tool_result` messages. Tool activity is streamed as markdown text inside `stream_block_delta` progress events.

## Navigation

- [Previous: Technical Reference]({{< relref "technical-reference" >}})
- [Back to Index]({{< relref "/" >}})
- [Next: Troubleshooting]({{< relref "troubleshooting" >}})
