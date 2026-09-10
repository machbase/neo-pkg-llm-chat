---
title: HTTP API and WebSocket
weight: 50
---

# HTTP API and WebSocket

This document summarizes the HTTP API endpoints and WebSocket protocol exposed by the LLM Chat package service.

The package uses a gateway / worker architecture: the browser opens a WebSocket to the gateway, and the gateway starts a per-session worker process that runs the agentic loop. **Chat happens entirely over WebSocket, not HTTP** — the HTTP endpoints are used only for configuration, preferences, and health/diagnostics.

## HTTP API Endpoints

All configuration responses use a `{ success, reason, data }` JSON envelope. To avoid a CORS preflight, `PUT` / `DELETE` can also be issued as `POST` with a `_method=PUT` or `_method=DELETE` query parameter and a `text/plain` body.

### Health & Diagnostics

| Method | Path | Description |
| :---: | :--- | :--- |
| GET | `/health` | Health check. Returns `{ "ok": true }` |
| GET | `/api/info` | Server info. Returns `{ ok, data: { port } }` |
| GET | `/api/debug` | Diagnostics: configs directory, config files, active worker count |

### Main (Server) Configuration

| Method | Path | Description |
| :---: | :--- | :--- |
| GET | `/api/config` | Get the main/server config |
| PUT | `/api/config` | Update the main/server config (for example the server port) |

### User Configurations

A configuration is stored per user (`configs/{user}.json`). The config name is the Machbase user.

Every request to the config and preference APIs below **requires an `Authorization: Bearer {accessToken}` header** (the token from a Machbase Neo login). The server verifies it to establish the user, and refuses any name that is not theirs.

| Situation | Response |
| :--- | :--- |
| Missing / expired / forged token | `401` `{"success": false, "reason": "authentication required"}` |
| Asking for another user's config | `403` `{"success": false, "reason": "forbidden"}` |

| Method | Path | Description |
| :---: | :--- | :--- |
| GET | `/api/configs` | List saved config names (**yours only**). With `?name={name}`, return that config |
| POST | `/api/configs` | Save a config. The file name and the body's `machbase.user` are **forced to the token's user** (a different account in the body is ignored) |
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
| GET | `/ws` | Browser chat WebSocket. The user is established by **verifying `auth_token` on the first message** |
| GET | `/{user_id}/ws` | Old path wired to the same handler. **The name in the URL is not used as identity** |
| GET | `/internal/ws` | Internal gateway ↔ worker channel (not for clients) |

### Relay Routes

These routes proxy directly to the connected Machbase Neo server (used by the UI to run TQL and render charts / dashboards).

| Method | Path | Description |
| :---: | :--- | :--- |
| POST | `/db/tql` | Relay a TQL execution request. **Requires an `Authorization` header**; the caller's token is passed through to Neo (`401` without one) |
| GET / POST | `/web/*path` | Relay to the Machbase Neo web API. **Only the caller's token** is forwarded (the service account never authenticates on their behalf) |

Relayed calls run as the caller, so Machbase refuses tables they may not read.

### Example: Health Check

```bash
curl http://localhost:8884/health
```

```json
{"ok": true}
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

**Every client message must carry `auth_token`** (a Machbase Neo accessToken). The gateway verifies it once per connection to establish the user, then applies that user to every message on the connection. The `user_id` field is not used to decide identity. When verification fails the gateway replies:

```json
{"type": "error", "code": "auth_required", "msg": "로그인 정보가 확인되지 않았습니다. 페이지를 새로고침한 뒤 다시 시도하세요."}
```

### Client to Server Messages

**get_models** — request the available LLM providers and models:

```json
{"type": "get_models", "user_id": "sys", "auth_token": "eyJhbGciOi..."}
```

**chat** — send a chat message (`provider` and `model` are required):

```json
{
  "type": "chat",
  "user_id": "sys",
  "auth_token": "eyJhbGciOi...",
  "session_id": "sess-1234567890",
  "provider": "claude",
  "model": "claude-sonnet-4-6",
  "query": "Analyze the GOLD table"
}
```

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

**error** — an error occurred (may include a `code`, for example `config_required`):

```json
{"type": "error", "session_id": "sess-1234567890", "msg": "Agent error: ..."}
```

> Note: There are no separate `tool_call` / `tool_result` messages. Tool activity is streamed as markdown text inside `stream_block_delta` progress events.

## Navigation

- [Previous: Technical Reference](./technical-reference.en.md)
- [Back to Index](./index.en.md)
- [Next: Troubleshooting](./troubleshooting.en.md)
