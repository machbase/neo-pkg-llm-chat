---
title: LLM Chat Technical Documentation
weight: 10
---

# LLM Chat Technical Documentation

<p align="center" style="margin-top:1.25rem"><a href="./index.kr.md">한국어</a> | <strong>English</strong> | <a href="./index.ja.md">日本語</a></p>

The Machbase Neo LLM Chat package is an LLM-based chat interface for interacting with the Machbase Neo time-series database in natural language.
Through conversation, you can query data, generate dashboards, create analysis reports, and explore manual documents.

The package runs an agentic loop internally. It sends user questions to the LLM, executes tool calls in Machbase Neo, feeds the results back to the model, and repeats until a final response is produced.

## Installation

The left sidebar in Machbase Neo shows the list of available packages.  
Select the LLM Chat package and click the `Install` button to install it.

Installation may take a short time, so wait until it is completed.

![Package installation screen](./images/package-install.png)

### Requirements

- Machbase Neo 8.7.3 or later
- A Machbase Neo API token for the account that will use LLM Chat (issued in the Neo web console; see [First Setup](./first-setup.en.md))

### Uninstall

Select `neo-pkg-llm-chat` from the left panel and click **Uninstall** to remove the package and its related service.

## LLM Providers

The package supports four LLM providers. Provider calls themselves are single-shot (non-streaming) request/response; per-tool-step progress is streamed to the browser over WebSocket.

| Provider | API | Local |
| :--- | :--- | :---: |
| Claude | Anthropic API | No |
| ChatGPT | OpenAI API | No |
| Gemini | Google Gemini API | No |
| Ollama | Ollama REST API | Yes |

Provider and connection settings are configured from the web-based Settings screen. API keys, model lists, and Machbase Neo connection information are saved on the server per account, while the Machbase Neo API token is stored only in the browser, never on the server.

## Agentic Loop

The agentic loop is the core execution engine of this package. It classifies the question to choose an execution flow, then repeats a cycle in which the LLM runs that flow's tools and decides the next step from the results until an answer is ready (tool calls are automatically corrected and checked before they run).

### Query Type Detection

Each question is classified in the order below to choose an execution flow. Each flow has a fixed set of tools the model can use (see Common Rules in [Technical Reference](./technical-reference.en.md)).

| Question | Flow |
| :--- | :--- |
| Pasted code (`SQL(`, `CHART(`, etc.) | Data query |
| Contains `report` / `summary report` (Korean `리포트`, `보고서`) | Report — generates an HTML analysis report |
| Contains `timer`, `cron`, `scheduler` (Korean `타이머`, `스케줄러`) | Document search — answered from the manual (timer registration is not supported) |
| A short question about the server version or status | System info |
| `forecast` (Korean `예측`) without mentioning a report or dashboard | Data query — generates a forecast report |
| Execution requests, queries naming a table or tag, measurement questions such as `온도 몇 도야` ("what is the temperature") | Data query |
| Concept or usage questions (`what is`, `how to`, `example`; Korean `뭐야`, `어떻게`, `예제`) | Document search |
| `advanced`, `FFT`, `RMS`, `spectrum`, `anomaly`, etc. (Korean `심층`, `고급`, `스펙트럼`, `이상 탐지`) | Advanced analysis — in-depth charts compiled from analysis intent (IR) |
| Chart, dashboard, analysis, or trend requests | Basic analysis — table-based charts |
| Lookup expressions such as `average`, `latest`, `how many`, `list` (Korean `평균`, `최근`, `몇 건`, `목록`) | Data query |
| Greetings | General conversation |
| Anything else | Document search |

## What This Documentation Covers

- Package installation
- Initial setup and model registration
- Chat screen usage and question patterns
- Built-in tools and automation features
- HTTP API and WebSocket protocol
- Common connection and usage problems

## Basic Workflow

1. Install the LLM Chat package in Neo.
2. Issue an API token for your account in the Neo web console.
3. When you open it for the first time, enter Host, Port, and the API token in Settings and click **검증** (Verify).
4. Enter the API key or endpoint for the provider you want to use.
5. Register one or more models.
6. Save and move to the Chat screen.
7. Select a model and send questions from the Chat screen.

## Screen Layout

- Settings screen
  - Machbase Connection
  - API Keys & Endpoints
  - Models
- Chat screen
  - Conversation area
  - Model selection button
  - Connection status
  - Message input

![LLM Chat main screen](./images/llm-chat-main.png)

## Documents

- [First Setup](./first-setup.en.md)
- [How to Use Chat](./chat-usage.en.md)
- [Technical Reference](./technical-reference.en.md)
- [HTTP API and WebSocket](./http-api-and-websocket.en.md)
- [Troubleshooting](./troubleshooting.en.md)

## Navigation

- [Next: First Setup](./first-setup.en.md)
