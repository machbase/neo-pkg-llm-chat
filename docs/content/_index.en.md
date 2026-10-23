---
title: LLM Chat Technical Documentation
weight: 10
---

[한국어]({{< relref path="/" lang="kr" >}}) | **English** | [日本語]({{< relref path="/" lang="ja" >}})

The Machbase Neo LLM Chat package is an LLM-based chat interface for interacting with the Machbase Neo time-series database in natural language.
Through conversation, you can query data, generate dashboards, create analysis reports, and explore manual documents.

The package runs an agentic loop internally. It sends user questions to the LLM, executes tool calls in Machbase Neo, feeds the results back to the model, and repeats until a final response is produced.

## Installation

The left sidebar in Machbase Neo shows the list of available packages.  
Select the LLM Chat package and click the `Install` button to install it.

Installation may take a short time, so wait until it is completed.

![Package installation screen](/images/package-install.png)

### Requirements

- Machbase Neo 8.7.3 or later
- A Machbase Neo API token for the account that will use LLM Chat (issued in the Neo web console; see [First Setup]({{< relref "first-setup" >}}))

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

The agentic loop is the core execution engine of this package. When a user sends a question, the system first detects the query type, then enters an autonomous loop where the LLM selects tools and executes them.

### Query Type Detection

Each question is classified in the order below to choose an execution flow. Each flow has a fixed set of tools the model can use (see Common Rules in [Technical Reference]({{< relref "technical-reference" >}})).

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

### Correction (Fixer) Layer

Before a tool runs, the fixer layer auto-corrects common LLM mistakes so the call can succeed.

| Fixer | Description |
| :--- | :--- |
| Argument normalization | Corrects wrong or misspelled parameter names in tool calls |
| Exploration assist | Infers the table name for `list_table_tags` and adds `profile` to `describe_table` in basic analysis |
| Question context injection | Passes the period, unit, and original text read from the question to the report and chart compile tools (takes precedence over the model's values) |
| Time range correction | Adjusts `time_start` / `time_end` to match actual data boundaries |
| Time value cleanup | Normalizes `time_start` / `time_end` to epoch ms strings |
| Chart definition cleanup | Normalizes the dashboard `charts` array |
| Newline cleanup | Turns literal `\n` into real newlines |

### Guard Pipeline

The guard pipeline runs behavioral guards around the agentic loop. Pre-tool guards run before a tool executes; post-loop guards run when the model tries to finish.

Pre-tool guards:

| Guard | Description |
| :--- | :--- |
| `consecutive_failure` | When the same tool keeps failing, re-prompts the model to reread the error and fix it; after 4 consecutive compile failures, has it skip that chart |
| `dashboard_early` | Prevents dashboard creation before all TQL templates are saved (advanced mode) |
| `redundant_finalize` | Blocks extra finalize calls after the dashboard URL was already issued (avoids orphan files) |

Post-loop guards:

| Guard | Description |
| :--- | :--- |
| `dashboard_omission` | Catches a false "dashboard created" claim when no tool was actually called |
| `chart_omission` | Re-prompts when advanced analysis finished but charts are missing from the dashboard |
| `report_omission` | Re-prompts when report mode is active but `save_html_report` was never called |
| `forecast_label` | Corrects the label when a plain analysis report is finished but the answer calls it a "forecast report" (passing off unvalidated past analysis, with no backtest or confidence interval, as a forecast) |
| `doc_index_answer` | Forces a body fetch when the document tool result is only a section list / navigation hint but the model tries to answer without re-querying |
| `dashboard_answer` | Recovers a successfully created dashboard URL that the final answer left out |
| `tql_inject` (tql_omission) | Ensures the validated ```tql chart is present and intact in the final answer |
| `raw_tql` | Detects hand-written ```tql that came from no tool result and redirects to the compiler |
| `fake_tql_answer` | Blocks fabricated / hallucinated TQL syntax in the final answer |
| `applied_basis` | If a tool changed the unit, period, or tag and the answer does not mention the applied value, appends one `※ 적용 기준:` ("applied basis") line to the answer (local models) |

### Execution-Stage Limits

Right before a tool runs, the following checks apply.

| Limit | Applies to | Behavior |
| :--- | :--- | :--- |
| Allowed tools | All models | A tool that is not in the current flow's allowed list does not run, even if the model calls it by name |
| Repeated identical call | All models | After the same tool has run twice with the same arguments, further identical calls are blocked |
| SQL run count | Local models (Ollama) | `execute_sql_query` runs at most 8 times per question; after that the model is told to answer from the results so far |
| Time unit | Local models (Ollama) | For hourly/daily/weekly/monthly questions (Korean `시간별`, `일별`, `주별`, `월별`), SQL with no bucket or a different bucket is sent back for rewriting before it runs. The example bucket uses `ROLLUP` if the table has a ROLLUP table, otherwise `DATE_TRUNC` |

As blocks accumulate, local models stop using tools and answer from what they have confirmed so far.

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

![LLM Chat main screen](/images/llm-chat-main.png)

## Documents

- [First Setup]({{< relref "first-setup" >}})
- [How to Use Chat]({{< relref "chat-usage" >}})
- [Technical Reference]({{< relref "technical-reference" >}})
- [HTTP API and WebSocket]({{< relref "http-api-and-websocket" >}})
- [Troubleshooting]({{< relref "troubleshooting" >}})

## Navigation

- [Next: First Setup]({{< relref "first-setup" >}})
