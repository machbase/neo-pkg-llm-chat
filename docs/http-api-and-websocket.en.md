---
title: HTTP API and WebSocket
weight: 50
---

# HTTP API and WebSocket

This document summarizes the HTTP API endpoints and WebSocket protocol used by the LLM Chat package when it runs in `server` mode.

## HTTP API Endpoints

### Master-Level Endpoints

| Method | Path | Description |
| :---: | :--- | :--- |
| GET | `/health` | Health check |
| GET | `/settings` | Settings page |
| GET | `/api/instances` | List running instances |
| POST | `/api/configs` | Save configuration and start an instance |
| GET | `/api/configs` | List all configurations |
| GET | `/api/configs/{name}` | Get a specific configuration |
| PUT | `/api/configs/{name}` | Update configuration and restart the instance |
| DELETE | `/api/configs/{name}` | Delete configuration and stop the instance |

### Per-Instance Endpoints

| Method | Path | Description |
| :---: | :--- | :--- |
| POST | `/{name}/api/chat` | Non-streaming chat |
| POST | `/{name}/api/chat/stream` | SSE streaming chat |
| GET | `/{name}/api/settings` | Get instance settings |
| POST | `/{name}/api/restart-llm` | Restart the instance LLM client |
| GET | `/{name}/ws` | WebSocket endpoint for the chat UI |
| GET | `/{name}/health` | Instance health check |

### Example: Streaming Chat via curl

```bash
curl -X POST http://localhost:8884/sys/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"query": "Show me the table list"}'
```

### Example: Health Check

```bash
curl http://localhost:8884/health
```

```json
{"status": "ok"}
```

## WebSocket Protocol

The chat UI communicates with the package service through WebSocket. The connection URL follows the format `ws://{host}:{port}/{user_id}/ws`.

### Client to Server Messages

**get_models** — Request the available LLM providers and models:

```json
{"type": "get_models", "user_id": "sys"}
```

**chat** — Send a chat message:

```json
{
  "type": "chat",
  "user_id": "sys",
  "session_id": "sess-1234567890",
  "provider": "claude",
  "model": "claude-sonnet-4-20250514",
  "query": "Analyze the GOLD table"
}
```

**stop** — Stop the current generation:

```json
{"type": "stop", "user_id": "sys", "session_id": "sess-1234567890"}
```

**clear** — Clear the session history:

```json
{"type": "clear", "user_id": "sys", "session_id": "sess-1234567890"}
```

### Server to Client Messages

The server sends streaming events while the agentic loop is running.

**Streaming text chunk:**

```json
{
  "type": "msg",
  "message": {
    "type": "ofStreamBlockDelta",
    "body": {
      "ofStreamBlockDelta": {
        "contentType": "text",
        "text": "Let me summarize the analysis results..."
      }
    }
  }
}
```

**Tool call notification:**

```json
{"type": "tool_call", "name": "execute_sql_query", "args": {"sql_query": "SELECT ..."}}
```

**Tool result:**

```json
{"type": "tool_result", "status": "success", "content": "NAME,COUNT(*)\\ntemperature,15230"}
```

## Navigation

- [Previous: Technical Reference](./technical-reference.en.md)
- [Back to Index](./index.en.md)
- [Next: Troubleshooting](./troubleshooting.en.md)
