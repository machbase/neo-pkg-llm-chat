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

| Method | Path | Description |
| :---: | :--- | :--- |
| GET | `/api/configs` | List saved config names. With `?name={name}`, return that config |
| POST | `/api/configs` | Save a config (name derived from `machbase.user`) |
| PUT | `/api/configs?name={name}` | Update a config |
| DELETE | `/api/configs?name={name}` | Delete a config |
| GET | `/api/configs/{name}` | Get a specific config |
| PUT | `/api/configs/{name}` | Update a specific config |
| DELETE | `/api/configs/{name}` | Delete a specific config |

### Per-User UI Preferences

| Method | Path | Description |
| :---: | :--- | :--- |
| GET | `/api/prefs?user={user}` | Get UI preferences (favorites) for a user |
| POST | `/api/prefs?user={user}` | Save UI preferences (favorites) |
| PUT | `/api/prefs?user={user}` | Save UI preferences (favorites) |

### WebSocket Paths

| Method | Path | Description |
| :---: | :--- | :--- |
| GET | `/{user_id}/ws` | Browser chat WebSocket (current gateway architecture) |
| GET | `/ws` | Browser chat WebSocket (old-convention path, wired to the same gateway handler — user_id is taken from the message body) |
| GET | `/internal/ws` | Internal gateway ↔ worker channel (not for clients) |

### Relay Routes

These routes proxy directly to the connected Machbase Neo server (used by the UI to run TQL and render charts / dashboards).

| Method | Path | Description |
| :---: | :--- | :--- |
| POST | `/db/tql` | Relay a TQL execution request to Machbase Neo |
| GET / POST | `/web/*path` | Relay to the Machbase Neo web API |

### Example: Health Check

```bash
curl http://localhost:8884/health
```

```json
{"ok": true}
```

### Example: List Saved Configs

```bash
curl http://localhost:8884/api/configs
```

```json
{"success": true, "reason": "success", "data": {"configs": ["sys"]}}
```

## WebSocket Protocol

The chat UI communicates with the service over WebSocket. The connection URL is `ws://{host}:{port}/{user_id}/ws`. The gateway routes each session to a worker process and relays the worker's streaming messages back to the browser.

### Client to Server Messages

**get_models** — request the available LLM providers and models:

```json
{"type": "get_models", "user_id": "sys"}
```

**chat** — send a chat message (`provider` and `model` are required):

```json
{
  "type": "chat",
  "user_id": "sys",
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
