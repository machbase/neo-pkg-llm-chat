---
title: Technical Reference
weight: 40
---

# Technical Reference

<p align="center" style="margin-top:1.25rem"><a href="./technical-reference.kr.md">한국어</a> | <strong>English</strong> | <a href="./technical-reference.ja.md">日本語</a></p>

This document describes the built-in tools, automation features, templates, and file/document access functions used internally by the LLM Chat package.

## Common Rules

These rules apply across the tools below.

**Execution identity and reach** — every query runs as the account of the API token entered in Settings, and Machbase decides what it may touch. The visible tables are the ones that account **owns plus the ones granted to it**, across **every database** it can `CONNECT` to.

**Table names** — tools return names as `DATABASE.OWNER.TABLE` (for example `MACHBASEDB.SYS.EXAMPLE`). An unqualified name resolves in the connected account's schema, so a table owned by someone else is not found even when access was granted. When an unqualified name comes in, the tool fills the owner in just before execution (if the same name exists under several owners it does not guess — it asks which one).

**Where output is stored** — `.tql`, `.dsh`, and report files are written **under the account folder**. Calling with `filename="GOLD/chart.tql"` stores it at `{user}/GOLD/chart.tql`, and dashboard/report links follow the same rule. Separate folders keep two accounts from overwriting each other's output (the files themselves stay readable by other accounts).

**Available tools** — each question flow gives the model a fixed set of tools. A tool that is not in the list does not run even if the model calls it by name.

| Flow | Tools |
| :--- | :--- |
| Data query | `list_tables`, `list_table_tags`, `describe_table`, `execute_sql_query`, `compile_tql_from_spec`, `forecast_table` |
| Basic analysis | `list_tables`, `list_table_tags`, `describe_table`, `execute_sql_query`, `create_dashboard_with_charts`, `preview_dashboard`, `forecast_table`, `list_available_documents`, `get_full_document_content` |
| Advanced analysis | Basic analysis tools + `compile_tql_from_spec`, `create_folder` |
| Report | `save_html_report` |
| Document search | `search_documents`, `list_available_documents`, `get_full_document_content`, `get_document_sections`, `extract_code_blocks`, `list_tables`, `describe_table`, `list_table_tags`, `compile_tql_from_spec` |
| System info | `get_version`, `debug_mcp_status`, `execute_sql_query` |
| General | Every tool except the three delete tools (`remove_chart_from_dashboard`, `delete_dashboard`, `delete_file`) |

The three delete tools are not in any flow; delete dashboards and files in the Neo web console. The dashboard edit tools (`get_dashboard`, `add_chart_to_dashboard`, `update_chart_in_dashboard`, `update_dashboard_time_range`) are only in the general flow, so they are not used for edit requests that are classified into an analysis flow (such as "add a chart").

## list_tables()

*Syntax*: `list_tables()`

Query the accessible TAG tables. It returns a two-column table (database, table) plus the table count, along with the fully qualified names (`DATABASE.OWNER.TABLE`) to use in SQL/TQL.

### Example: List Tables

Ask the chat: "Show me the table list"

The tool executes internally (no owner filter — the catalog already shows only what the session user can reach, so filtering by owner would drop tables reachable through `GRANT`):

```sql
SELECT st.DATABASE_NAME, su.NAME, st.NAME FROM m$sys_tables AS st
JOIN m$sys_users AS su ON st.USER_ID = su.USER_ID
WHERE st.FLAG = 0
ORDER BY st.DATABASE_NAME, su.NAME, st.NAME
```

```text
| database | table |
|---|---|
| FACTORY_A | SENSOR_A |
| MACHBASEDB | EXAMPLE |
| MACHBASEDB | GOLD |

(3 tables)
```

The table is shown in the chat answer as-is.

## list_table_tags()

*Syntax*: `list_table_tags( table_name )`

Get tag metadata from a tag table. It queries the `_tablename_meta` table and returns all tag or sensor names.

- `table_name` *string* required, tag table name. Accepts the fully qualified form (`MACHBASEDB.SYS.EXAMPLE`); the tag metadata table is read with the same prefix

### Example: List Tags

```text
list_table_tags(table_name="EXAMPLE")
```

```text
[EXAMPLE] temperature, humidity, pressure
```

## describe_table()

*Syntax*: `describe_table( table_name [, profile] )`

Get the table type (TAG / LOG) and column structure (name, type, role such as PRIMARY KEY / BASETIME / SUMMARIZED), plus whether ROLLUP tables exist. The agentic loop calls this before generating TQL/SQL so it knows the real column names. Includes an access check, and when given a qualified name it reads the companion objects (tag metadata, stat view) with the same prefix.

- `table_name` *string* required, table name to describe
- `profile` *boolean* for TAG tables, also return the tag list, per-tag statistics (count / avg / min / max), and the data time range in milliseconds. Useful when building dashboards. The time range also shows readable times in the user's time zone. Default: `false`

### Example: Describe a Table

```text
describe_table(table_name="EXAMPLE", profile=true)
```

```text
[EXAMPLE] type: TAG
- NAME (varchar) PRIMARY KEY
- TIME (datetime) BASETIME
- VALUE (double) SUMMARIZED
ROLLUP: available (3 rollup tables)
...
```

## execute_sql_query()

*Syntax*: `execute_sql_query( sql_query [, format, timeformat, timezone, limit] )`

Execute an SQL query directly on Machbase Neo.

- `sql_query` *string* required, SQL query to execute
- `format` *string* output format: `csv` (default) or `json`
- `timeformat` *string* time format: `default`, `ms`, `us`, `ns`
- `timezone` *string* timezone (for example `UTC`, `Asia/Seoul`). Pass only when the user asks for a specific zone; when omitted, the user's browser time zone is used
- `limit` *integer* maximum rows to return. Default: `500`

> Note: `UPDATE`, `DELETE`, and `DROP` statements are blocked for safety. When SQL execution fails, the tool returns a parsed error message.
>
> The query runs as the API token's account, and Machbase refuses tables it may not read. An unqualified name after `FROM`/`JOIN` gets its owner filled in just before execution (for example `FROM EXAMPLE` becomes `FROM MACHBASEDB.SYS.EXAMPLE`).
>
> Times in results are shown in readable form (`Default`) in the user's time zone. For a pure range query (`MIN(TIME)`, `MAX(TIME)`) with `timeformat="ms"`, the user-time-zone time is written next to each number.
>
> When a ROLLUP query fails (`ERR-2264` for a table without a ROLLUP table, `ERR-2816` for an aggregate that ROLLUP cannot compute), the tool suggests the equivalent `DATE_TRUNC` expression for the same unit.
>
> Local models (Ollama) can run this tool at most 8 times per question.

### Example: Tag Statistics

```text
execute_sql_query(sql_query="SELECT NAME, COUNT(*), AVG(VALUE) FROM EXAMPLE GROUP BY NAME")
```

```csv
NAME,COUNT(*),AVG(VALUE)
temperature,15230,23.456
humidity,15230,65.123
pressure,15230,1013.25
```

### Example: Time Range Query

```text
execute_sql_query(
    sql_query="SELECT MIN(TIME), MAX(TIME) FROM EXAMPLE",
    timeformat="ms"
)
```

```csv
MIN(TIME),MAX(TIME)
1695222000000,1702425600000
```

## execute_tql_script()

*Syntax*: `execute_tql_script( tql_content )`

An **internal-only** tool that executes TQL scripts. It is not exposed to the model, and it does not run even if the model calls it by name. `compile_tql_from_spec` uses it internally to verify the TQL it compiles.

- TQL pasted into the chat is not executed. Run it in the TQL editor of the Neo web console.
- Pasted SQL is executed with `execute_sql_query`.

## save_tql_file()

*Syntax*: `save_tql_file( filename, tql_content )`

An **internal-only** tool that saves TQL files. It is not exposed to the model, and it does not run even if the model calls it by name. `compile_tql_from_spec` and `forecast_table` use it internally when they save files.

Before saving, the tool:

1. Executes the TQL script to validate correctness (it is not saved if validation fails).
2. If the query returns 0 rows, snaps the time range to the table's actual MIN/MAX(TIME) boundaries and retries.
3. Creates parent folders automatically when needed.

## compile_tql_from_spec()

*Syntax*: `compile_tql_from_spec( spec [, filename] )`

Compile execution-verified TQL from an analysis intent (IR JSON) instead of hand-writing raw TQL. The tool auto-injects the real column names and ROLLUP availability from the database, validates tag names, corrects the time range to the actual data boundaries, and returns TQL that is guaranteed to run. This is the only way the model creates and saves TQL. Special charts that the IR cannot express (heatmap, FFT, 3D, and so on) are not supported.

- `spec` *object* required, analysis intent. Key fields:
  - `kind` — `metrics` (single tag, one or more aggregates), `tags` (multi-tag comparison), `ohlc` (candlestick / price), or `geomap` (coordinates / map)
  - `table`, `tag` / `tags`, `timeRange: { start, end }`
  - `rollup` — bucket unit (`sec`, `min`, `hour`, `day`, `week`, `month`) or `null` for raw
  - `rollupN` *optional* — bucket multiple. For example, a 5-minute average is `rollup: "min"`, `rollupN: 5`. Values such as `"5min"` or `"10s"` are split automatically
  - `metrics` — for `kind=metrics`, e.g. `[{ "agg": "avg", "label": "..." }]` (agg: avg / max / min / sum / count / sumsq / raw)
  - `output` *optional* — `{ chartType: "line" | "bar", title, subtitle }`
- `filename` *string* optional, save path `"TABLE/name.tql"` (English only). If provided, the TQL is saved for dashboard use (reference it from `charts` via `tql_path`). If omitted, the verified TQL text is returned in the answer.

### Time Range and Bucket Unit

The chart time range and bucket unit depend on whether the user's question names a time range and a unit. The time range takes priority over the unit.

| Question | Example | Result |
| :--- | :--- | :--- |
| Unit only | "BITCOIN 1-minute average" | Keeps the unit and trims the range to the length that fits the unit, ending at the last data timestamp |
| Range and unit | "1-minute average for the last 6 months" | Keeps the range and raises the unit if it is too fine for the range |
| Range only | "Trend for the last week" | Picks the unit automatically for the range |
| Neither | "BITCOIN trend" | Full range, automatic unit |

- A unit in the question counts when a number and a bucket expression appear together, such as "1분 평균" (1-minute average), "5분 단위" (5-minute unit), "10초 간격" (10-second interval), "1시간마다" (every hour), "5분봉" (5-minute candles), "시간별" (hourly), or "일별" (daily).
- Range each unit can draw: second 1 hour, minute 48 hours, hour 30 days, day and week under 1 year. A multiple extends it by that factor (240 hours for 5 minutes).
- The range is trimmed from the end of the data, so tables that stopped receiving data do not produce empty charts.
- Candlestick charts (`ohlc`) raise the unit only when the question has both a range and a unit. Tag comparison (`tags`) only applies the range trim when the question has a unit only.
- Multiples: tables with ROLLUP support multiples for every unit. Tables without ROLLUP and candlestick charts use `DATE_TRUNC`, which allows multiples up to one day (second up to 86400, minute up to 1440, hour up to 24; day, week, and month only 1).
- When the unit or range is changed, a `[주의] …` notice is added to the tool result, and the chart title shows the unit actually applied. If a local model (Ollama) leaves the changed value out of its answer, one `※ 적용 기준:` ("applied basis") line is appended to the answer.
- The chart time axis is drawn in the user's (browser) time zone.

### Time Range in the Question

When the question names a time range, the range read from the question is used instead of the value the model supplied. Times are server local time, and weeks start on Monday.

| Kind | Examples | Meaning |
| :--- | :--- | :--- |
| Length from now | "최근 6개월" (last 6 months), "지난 3일" (last 3 days), "last 2 weeks" | That length counted back from now |
| Date or calendar | "오늘" (today), "어제" (yesterday), "그제" (day before yesterday), "3일 전" (3 days ago) | That one day (today runs until now) |
| Date or calendar | "이번 주" (this week), "지난주" (last week), "이번 달" (this month), "지난달" (last month) | That week (Monday to Sunday) or month (this week and this month run until now) |
| Date or calendar | "올해" (this year), "작년" (last year), "재작년" (two years ago), "2025년" | That whole year (this year runs until now) |
| Date or calendar | "2025년 3월", "2025-03", "작년 3월", "3월" (March) | That month. Without a year it means this year, or last year if that month has not come yet |
| Date or calendar | "2025년 3월 5일", "3월 5일", "2025-03-05" | That one day |
| Date or calendar | "3월부터 5월까지" (March to May), "어제~오늘", "2025-01-01 ~ 2025-03-01" | From the start of the first expression to the end of the second. With no end, as in "3월부터" (since March), until now |
| English | "yesterday", "last week", "this month", "March 2025", "in 2025" | Same rules as above |

When there is no data in that range, the handling depends on the kind.

- Length from now: the range is moved to end at the last data timestamp with the same length, and a `[주의] …` notice is added. This keeps charts visible for tables that stopped receiving data.
- Date or calendar: the range is not moved. If the table has no data in that range at all, no chart is made and the tool reports "기간에 데이터 없음" (no data in the range) with the table's data range. When saving, if the chart's data is 0 rows, it is not saved and the same notice is returned.

The same interpretation is used for the time range hint of analysis and report requests. For example, "2025년 BITCOIN 리포트" (BITCOIN report for 2025) produces a report for 2025.

### Example: Compile and Save a Chart

```text
compile_tql_from_spec(
    spec={"kind":"metrics","table":"GOLD","tag":"close","rollup":"day",
          "metrics":[{"agg":"avg","label":"Average"}]},
    filename="GOLD/avg_trend.tql"
)
```

## forecast_table()

*Syntax*: `forecast_table( spec [, filename] )`

Forecast future values for a table's tag. The tool fits several candidate models (SES / linear / quadratic / Holt / Theta / AR / Holt-Winters additive & multiplicative / harmonic / Prophet-style), ranks them with a holdout backtest, and auto-selects the best one. It anchors the forecast to the last observed value and adds a confidence band. **Calling it generates and saves an HTML report — with a tag dropdown × model dropdown to browse every tag's and model's forecast curve (confidence interval and backtest included) — and returns the link.** One tag forecasts that tag; 2–5 tags forecast all of them; more than 5 tags auto-selects the top 5 by data count (with a note, without prompting).

- `spec` *object* required, forecast intent. Key fields:
  - `table` *required*
  - `tag` — single tag to forecast (omit and the tool decides automatically), or `tags: ["a","b"]` for multi-tag comparison (up to 5)
  - `rollup` — bucket unit (`sec` … `month`), auto-selected from the range if omitted
  - `timeRange: { start, end }` — training window (whole dataset if omitted)
  - `horizon` — number of future buckets to forecast (defaults to 20% of the training length)
  - `method` — model to use (defaults to `auto` = the leaderboard winner). Values: `auto`, `ses`, `linear`, `quadratic`, `holt`, `theta`, `ar`, `holtwinters`, `holtwinters_mult`, `harmonic`, `prophet`. Korean aliases (`선형` / `2차` / `계절성`) and rank strings (`2위` / `rank2`) are also accepted
  - `rank` — select a model by leaderboard rank (1-based, e.g. `2`)
  - `lookback` — trend window in buckets (auto if omitted)
  - `output` *optional* — `{ title, subtitle }`
- `filename` *string* optional, save path `"TABLE/name.tql"` (English only). If provided, the report **additionally** saves a live-recomputing `.tql` (for a dashboard `tql_path`). If omitted, only the HTML report is generated.

### Example: Forecast and Save

```text
forecast_table(
    spec={"table":"GOLD","tag":"close","rollup":"day","horizon":30},
    filename="GOLD/close_forecast.tql"
)
```

## create_dashboard_with_charts()

*Syntax*: `create_dashboard_with_charts( filename, title, charts [, time_start, time_end, refresh] )`

Create a dashboard with multiple chart panels in a single call.

- `filename` *string* required, dashboard path (for example `GOLD/Gold_Analysis.dsh`)
- `title` *string* required, dashboard title
- `charts` *string* required, JSON array of chart definitions
- `time_start` *string* time range start (epoch ms as string). Auto-fitted to the data when omitted
- `time_end` *string* time range end (epoch ms as string). Auto-fitted to the data when omitted
- `refresh` *string* auto-refresh interval (`Off`, `3 seconds`, `10 seconds`, `1 minute`, `1 hour`, …). Default: `Off`

Each chart object in the `charts` array. The preferred form references a TQL file compiled with `compile_tql_from_spec` / `forecast_table`:

```json
{ "title": "Average Trend", "tql_path": "GOLD/avg_trend.tql" }
```

For a simple ad-hoc chart without a compiled `.tql`, use an inline definition. The `column`, name, and time columns are auto-detected from the table metadata, so omit them unless you need to override:

```json
{ "title": "Temperature", "type": "Line", "table": "EXAMPLE", "tag": "temperature" }
```

Supported chart types: `Line`, `Bar`, `Scatter`, `Pie`, `Gauge`, `Text`, `Geomap`, `Video`, `Tql chart`

> Note: Candlestick / OHLC and any compiled chart must use `tql_path`. An inline OHLC panel will not render. Inline (basic-analysis) charts are restricted to `Line` / `Bar` / `Scatter` with real tags.

### Example: Create Dashboard with TQL Charts

```text
create_dashboard_with_charts(
    filename="GOLD/Gold_Analysis.dsh",
    title="GOLD Deep Analysis",
    time_start="1695222000000",
    time_end="1702425600000",
    charts='[
        {"title":"Average Trend","type":"Tql chart","tql_path":"GOLD/avg_trend.tql"},
        {"title":"Volatility","type":"Tql chart","tql_path":"GOLD/volatility.tql"},
        {"title":"Price Band","type":"Tql chart","tql_path":"GOLD/price_band.tql"}
    ]'
)
```

```text
Dashboard created: sys/GOLD/Gold_Analysis_20260910_143022.dsh (3 charts)
```

## add_chart_to_dashboard()

*Syntax*: `add_chart_to_dashboard( filename, chart_title, chart_type [, table, tag, column, tql_path] )`

> Available only in the general flow.

Add a chart panel to an existing dashboard. The tool lays out the panel size, position, and color automatically.

- `filename` *string* required, dashboard filename
- `chart_title` *string* required, chart title
- `chart_type` *string* required, chart type (for example `Line`, `Bar`, `Scatter`, `Tql chart`)
- `table` *string* tag table name
- `tag` *string* tag name(s), comma-separated
- `column` *string* column name. Default: `VALUE`
- `tql_path` *string* TQL file path for `Tql chart`

### Example: Add a Line Chart

```text
add_chart_to_dashboard(
    filename="GOLD/Gold_Analysis.dsh",
    chart_title="Temperature Trend",
    chart_type="Line",
    table="EXAMPLE",
    tag="temperature"
)
```

### Example: Add a TQL Chart

```text
add_chart_to_dashboard(
    filename="GOLD/Gold_Analysis.dsh",
    chart_title="FFT Spectrum",
    chart_type="Tql chart",
    tql_path="GOLD/fft_spectrum.tql"
)
```

## remove_chart_from_dashboard()

*Syntax*: `remove_chart_from_dashboard( filename [, panel_id, panel_title] )`

> Not open to any question flow, so the model does not use it. Delete in the Neo web console.

Remove a chart panel from a dashboard by panel UUID or title.

- `filename` *string* required, dashboard filename
- `panel_id` *string* panel UUID to remove
- `panel_title` *string* panel title to remove

## update_chart_in_dashboard()

*Syntax*: `update_chart_in_dashboard( filename [, panel_id, panel_title, new_title] )`

> Available only in the general flow.

Update the title of an existing chart panel in a dashboard. Target the panel by UUID or title.

- `filename` *string* required, dashboard filename
- `panel_id` *string* panel UUID
- `panel_title` *string* panel title (first match)
- `new_title` *string* new panel title

## get_dashboard()

*Syntax*: `get_dashboard( filename )`

> Available only in the general flow.

Get the full configuration of a dashboard as JSON.

- `filename` *string* required, dashboard filename

## delete_dashboard()

*Syntax*: `delete_dashboard( filename )`

> Not open to any question flow, so the model does not use it. Delete in the Neo web console.

Delete a dashboard file from Machbase Neo.

- `filename` *string* required, dashboard filename to delete

## update_dashboard_time_range()

*Syntax*: `update_dashboard_time_range( filename [, time_start, time_end, refresh] )`

> Available only in the general flow.

Update the time range of a dashboard.

- `filename` *string* required, dashboard filename
- `time_start` *string* start time (set to empty when omitted)
- `time_end` *string* end time (set to empty when omitted)
- `refresh` *string* auto-refresh interval. Default: `Off`

## preview_dashboard()

*Syntax*: `preview_dashboard( filename )`

Get a dashboard preview and a direct Neo Web UI link.

- `filename` *string* required, dashboard filename

## save_html_report()

*Syntax*: `save_html_report( table [, template_id, tag_name, analysis, recommendations, rollup_unit, time_start, time_end, timezone, tag_count, data_count, time_range] )`

Generate an HTML analysis report with charts and deep analysis. The tool internally performs data retrieval, FFT/statistical calculations, chart generation, and HTML file creation.

Trend aggregation in the finance (`R-1`), vibration (`R-2`), and driving (`R-3`) templates uses `ROLLUP` when the table has a ROLLUP table, and otherwise `DATE_TRUNC` with the same unit. Times in the report (period, statistics, chart labels, generation time) are shown in the user's time zone.

- `table` *string* required, table name (for example `GOLD`)
- `template_id` *string* report template ID. If omitted, a built-in template is auto-detected from the data
- `tag_name` *string* target tag or symbol name. Pass it whenever the user mentions a specific target — omitting it scans the whole table (thousands of tags) and can be slow or exceed context
- `analysis` *string* deep analysis text (markdown). Leave empty on the first call; fill it on the second call
- `recommendations` *string* overall findings and recommendations (markdown). Leave empty on the first call
- `rollup_unit` *string* one of `sec`, `min`, `hour`, `day`, `week`, `month`
- `time_start` *string* analysis start (epoch ms). Pass only when the user gives an explicit period
- `time_end` *string* analysis end (epoch ms), paired with `time_start`
- `timezone` *string* time zone for displayed times (IANA name, e.g. `UTC`). Pass only when the user asks for a specific zone; when omitted, the user's browser time zone is used
- `tag_count` / `data_count` / `time_range` *string* optional descriptive metadata

### Report Templates

Built-in templates live under `neo/report/`; custom `C-*` templates can be dropped into `neo/report/custom/`.

| Template ID | Type | Description |
| :--- | :--- | :--- |
| `R-0-general` | General | Basic statistical analysis with trend charts |
| `R-1-finance` | Financial | Price bands, volatility, and log-scale analysis |
| `R-2-vibration` | Vibration | RMS, FFT spectrum, envelope, and crest factor |
| `R-3-driving` | Driving | Speed/RPM correlation and driving pattern analysis |
| `C-1-energy` | Custom (example) | Energy-analysis custom report template |

### Example: Generate a Financial Report

First call — the tool queries the data and returns a chart analysis summary (leave `analysis` empty):

```text
save_html_report(table="GOLD", template_id="R-1-finance", tag_name="close")
```

```text
Chart analysis summary: Gold price from 2023-09-20 to 2025-12-13 ...
Please call again with this summary in the analysis parameter.
```

Second call — the tool generates the final HTML report:

```text
save_html_report(
    table="GOLD",
    template_id="R-1-finance",
    tag_name="close",
    analysis="Gold price from 2023-09-20 to 2025-12-13 ...",
    recommendations="1. ..."
)
```

```text
Report saved: sys/GOLD/GOLD_financial_report.html
```

## Timer Requests

LLM Chat does not register, start, stop, delete, or list timers (schedulers).

Timer-related questions are answered from the manual. They include:

- Questions that contain "타이머", "timer", "cron", "스케줄러", or "scheduler"
- Questions that contain "스케줄" or "schedule" and ask for an action such as create, add, register, start, stop, delete, or list

Based on the Neo manual, the answer explains:

- How to register, start, stop, and delete timers from the Timer menu in the web console
- Shell commands: `timer add <name> <timer_spec> <tql-path>;`, `timer list;`, `timer start|stop <name>;`, `timer del <name>;`
- Schedule expressions (`@every 10s`, cron format, etc.) and TQL templates for timers

Example questions: "Make a timer that collects sensor data every 10 seconds", "Show the timer list", "Turn off the SENSOR_DATA timer"

> The TQL in an answer is an example based on the manual templates and has not been executed for verification. Adjust the table and tag names to your data, check it in Neo's TQL editor, then register it with a timer.

## create_folder()

*Syntax*: `create_folder( folder_name )`

Create a folder in the Machbase Neo file system.

- `folder_name` *string* required, folder path to create. Created under the account folder, parent folders included

## list_files()

*Syntax*: `list_files( [path] )`

List files and folders in the Machbase Neo file system.

- `path` *string* directory path. Default: `/`. Looks under the account folder first, then falls back to the path as given

### Example: List Files

```text
list_files(path="GOLD")
```

```text
Files in GOLD:
  [file] avg_trend.tql
  [file] volatility.tql
  [file] Gold_Analysis.dsh
```

## delete_file()

*Syntax*: `delete_file( filename )`

> Not open to any question flow, so the model does not use it. Delete in the Neo web console.

Delete a file or empty folder from the Machbase Neo file system.

- `filename` *string* required, file path to delete. Looks under the account folder first, then falls back to the path as given

## list_available_documents()

*Syntax*: `list_available_documents()`

List all available manual documentation files in Machbase Neo. It returns the documentation catalog (paths, titles, keywords).

## search_documents()

*Syntax*: `search_documents( keyword )`

Search the documentation catalog by keyword and return matching document paths. Use this before `get_full_document_content` to find the right document. If nothing matches, it returns a no-match message with the nearest candidate documents.

- `keyword` *string* required, search keyword (for example `PIVOT`, `ROLLUP`, `TQL`, `chart`)

### Example: Search Documents

```text
search_documents(keyword="ROLLUP")
```

```text
Found 2 document(s):
- sql/sql-rollup.md (ROLLUP) [rollup, aggregate]
- tql/tql-sink.md (TQL Sink) [chart, rollup]
```

## get_full_document_content()

*Syntax*: `get_full_document_content( file_identifier [, section] )`

Get manual document content. If the document is large, passing a `section` keyword returns only that section at full length, so deep sections (for example `ADD COLUMN` inside a large DDL doc) are not cut off. Without `section`, a large document returns its section list so you can choose one.

- `file_identifier` *string* required, document path from the catalog (copy it verbatim)
- `section` *string* a section-header keyword to return only that section in full (for example `ADD COLUMN`, `RETENTION`, `TO_CHAR`)

### Example: Read a Specific Section

```text
get_full_document_content(file_identifier="sql/sql-rollup.md", section="ADD COLUMN")
```

Returns only the matching section of the manual document at full length.

## get_document_sections()

*Syntax*: `get_document_sections( file_identifier [, section_filter] )`

Get manual document content organized by section, optionally filtered by keyword.

- `file_identifier` *string* required, file path
- `section_filter` *string* filter sections containing this text

### Example: Read Specific Sections

```text
get_document_sections(file_identifier="tql/tql-sink.md", section_filter="CHART")
```

Returns only the sections that contain "CHART" in the title or content.

## extract_code_blocks()

*Syntax*: `extract_code_blocks( file_identifier [, language] )`

Extract all code blocks from a manual document, optionally filtered by language.

- `file_identifier` *string* required, file path
- `language` *string* language filter, such as `js` or `sql`

### Example: Extract SQL Examples

```text
extract_code_blocks(file_identifier="sql/sql-guide.md", language="sql")
```

```text
--- Code Block 1 [sql] ---
CREATE TAG TABLE IF NOT EXISTS example (
  name varchar(100) primary key,
  time datetime basetime,
  value double summarized
);

--- Code Block 2 [sql] ---
INSERT INTO example VALUES('my-car', now, 1.2345);
```

## get_version()

*Syntax*: `get_version()`

Get version information for the package and the Machbase Neo server.

## debug_mcp_status()

*Syntax*: `debug_mcp_status()`

Check current status and connectivity by querying Machbase Neo system tables.

### Example: Health Check

```text
debug_mcp_status()
```

```json
{
  "tools_count": 27,
  "tools": ["list_tables", "list_table_tags", "describe_table", "..."],
  "runtime": "JSH",
  "machbase": "connected"
}
```

## Navigation

- [Previous: How to Use Chat](./chat-usage.en.md)
- [Back to Index](./index.en.md)
- [Next: HTTP API and WebSocket](./http-api-and-websocket.en.md)
