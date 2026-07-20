---
title: Technical Reference
weight: 40
---

# Technical Reference

This document describes the built-in tools, automation features, templates, and file/document access functions used internally by the LLM Chat package.

## list_tables()

*Syntax*: `list_tables()`

Query the available table list in Machbase Neo. It returns the names of all tables owned by the current user, one per line.

### Example: List Tables

Ask the chat: "Show me the table list"

The tool executes internally (the owner is resolved to the connected user):

```sql
SELECT st.NAME FROM m$sys_tables AS st
JOIN m$sys_users AS su ON st.USER_ID = su.USER_ID
WHERE su.NAME = 'SYS' AND st.FLAG = 0
ORDER BY st.NAME
```

```text
EXAMPLE
GOLD
SENSOR
```

## list_table_tags()

*Syntax*: `list_table_tags( table_name )`

Get tag metadata from a tag table. It queries the `_tablename_meta` table and returns all tag or sensor names.

- `table_name` *string* required, tag table name

### Example: List Tags

```text
list_table_tags(table_name="EXAMPLE")
```

```text
[EXAMPLE] temperature, humidity, pressure
```

## describe_table()

*Syntax*: `describe_table( table_name [, profile] )`

Get the table type (TAG / LOG) and column structure (name, type, role such as PRIMARY KEY / BASETIME / SUMMARIZED), plus whether ROLLUP tables exist. The agentic loop calls this before generating TQL/SQL so it knows the real column names. Includes an ownership check.

- `table_name` *string* required, table name to describe
- `profile` *boolean* for TAG tables, also return the tag list, per-tag statistics (count / avg / min / max), and the data time range in milliseconds. Useful when building dashboards. Default: `false`

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
- `timezone` *string* timezone (for example `UTC`, `Asia/Seoul`)
- `limit` *integer* maximum rows to return. Default: `500`

> Note: `UPDATE`, `DELETE`, and `DROP` statements are blocked for safety. When SQL execution fails, the tool returns a parsed error message.

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

Execute a TQL (Transforming Query Language) script on Machbase Neo. It returns chart HTML or CSV data depending on the SINK function used in the script. Output longer than 5000 characters is truncated.

- `tql_content` *string* required, TQL script content

### Example: Execute TQL with CSV Output

```text
execute_tql_script(tql_content="SQL(`SELECT NAME, COUNT(*) FROM EXAMPLE GROUP BY NAME`)\nCSV()")
```

```csv
temperature,15230
humidity,15230
pressure,15230
```

### Example: Execute TQL with Chart Output

```js
SQL(`SELECT TIME, VALUE FROM EXAMPLE WHERE NAME = 'temperature' GROUP BY TIME, VALUE ORDER BY TIME`)
CHART(
    size("600px", "340px"),
    chartOption({
        xAxis: { type: "time" },
        yAxis: {},
        series: [{
            type: "line",
            data: column(0).map(function(t, idx){ return [t, column(1)[idx]]; })
        }]
    }),
    tz("Asia/Seoul")
)
```

The tool returns the rendered chart as an HTML fragment.

## save_tql_file()

*Syntax*: `save_tql_file( filename, tql_content )`

Save a TQL or SQL script file to Machbase Neo. TQL files are validated by execution before saving.

- `filename` *string* required, file path (for example `GOLD/chart.tql`)
- `tql_content` *string* required, TQL script content

Before saving, the tool:

1. Executes the TQL script to validate correctness (it is not saved if validation fails).
2. If the query returns 0 rows, snaps the time range to the table's actual MIN/MAX(TIME) boundaries and retries.
3. Creates parent folders automatically when needed.

### Example: Save a Chart TQL

```text
save_tql_file(
    filename="GOLD/avg_trend.tql",
    tql_content="SQL(`SELECT ...`)\nCHART(...)"
)
```

```text
File saved successfully: GOLD/avg_trend.tql
```

If validation fails:

```text
TQL validation failed (not saved): MACH-ERR 2044 ...
```

## compile_tql_from_spec()

*Syntax*: `compile_tql_from_spec( spec [, filename] )`

Compile execution-verified TQL from an analysis intent (IR JSON) instead of hand-writing raw TQL. The tool auto-injects the real column names and ROLLUP availability from the database, validates tag names, corrects the time range to the actual data boundaries, and returns TQL that is guaranteed to run. This is the preferred way to generate chart TQL.

- `spec` *object* required, analysis intent. Key fields:
  - `kind` — `metrics` (single tag, one or more aggregates), `tags` (multi-tag comparison), `ohlc` (candlestick / price), or `geomap` (coordinates / map)
  - `table`, `tag` / `tags`, `timeRange: { start, end }`
  - `rollup` — bucket unit (`sec`, `min`, `hour`, `day`, `week`, `month`) or `null` for raw
  - `metrics` — for `kind=metrics`, e.g. `[{ "agg": "avg", "label": "..." }]` (agg: avg / max / min / sum / count / sumsq / raw)
  - `output` *optional* — `{ chartType: "line" | "bar", title, subtitle }`
- `filename` *string* optional, save path `"TABLE/name.tql"` (English only). If provided, the TQL is saved for dashboard use (reference it from `charts` via `tql_path`). If omitted, the verified TQL text is returned in the answer.

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
Dashboard created: GOLD/Gold_Analysis.dsh (3 charts)
```

## add_chart_to_dashboard()

*Syntax*: `add_chart_to_dashboard( filename, chart_title, chart_type [, table, tag, column, tql_path] )`

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

Remove a chart panel from a dashboard by panel UUID or title.

- `filename` *string* required, dashboard filename
- `panel_id` *string* panel UUID to remove
- `panel_title` *string* panel title to remove

## update_chart_in_dashboard()

*Syntax*: `update_chart_in_dashboard( filename [, panel_id, panel_title, new_title] )`

Update the title of an existing chart panel in a dashboard. Target the panel by UUID or title.

- `filename` *string* required, dashboard filename
- `panel_id` *string* panel UUID
- `panel_title` *string* panel title (first match)
- `new_title` *string* new panel title

## get_dashboard()

*Syntax*: `get_dashboard( filename )`

Get the full configuration of a dashboard as JSON.

- `filename` *string* required, dashboard filename

## delete_dashboard()

*Syntax*: `delete_dashboard( filename )`

Delete a dashboard file from Machbase Neo.

- `filename` *string* required, dashboard filename to delete

## update_dashboard_time_range()

*Syntax*: `update_dashboard_time_range( filename [, time_start, time_end, refresh] )`

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

*Syntax*: `save_html_report( table [, template_id, tag_name, analysis, recommendations, rollup_unit, time_start, time_end, tag_count, data_count, time_range] )`

Generate an HTML analysis report with charts and deep analysis. The tool internally performs data retrieval, FFT/statistical calculations, chart generation, and HTML file creation.

- `table` *string* required, table name (for example `GOLD`)
- `template_id` *string* report template ID. If omitted, a built-in template is auto-detected from the data
- `tag_name` *string* target tag or symbol name. Pass it whenever the user mentions a specific target — omitting it scans the whole table (thousands of tags) and can be slow or exceed context
- `analysis` *string* deep analysis text (markdown). Leave empty on the first call; fill it on the second call
- `recommendations` *string* overall findings and recommendations (markdown). Leave empty on the first call
- `rollup_unit` *string* one of `sec`, `min`, `hour`, `day`, `week`, `month`
- `time_start` *string* analysis start (epoch ms). Pass only when the user gives an explicit period
- `time_end` *string* analysis end (epoch ms), paired with `time_start`
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
Report saved: GOLD/GOLD_financial_report.html
```

## list_timers()

*Syntax*: `list_timers()`

List all timers or schedulers registered in Machbase Neo. It returns the name, state (`RUNNING` / `STOP`), schedule, and TQL path for each timer.

### Example: List Timers

```text
list_timers()
```

```json
[
  {
    "name": "SENSOR_DATA",
    "state": "RUNNING",
    "schedule": "@every 10s",
    "path": "SENSOR_DATA/SENSOR_DATA.tql"
  }
]
```

## add_timer()

*Syntax*: `add_timer( name, schedule, path [, auto_start] )`

Create a new timer or scheduler that runs a TQL script on a schedule.

- `name` *string* required, timer name (unique identifier)
- `schedule` *string* required, execution schedule
- `path` *string* required, path of the TQL script to run
- `auto_start` *boolean* automatically start after server restart. Default: `false`

Schedule format examples:

| Expression | Description |
| :--- | :--- |
| `@every 10s` | Every 10 seconds |
| `@every 1h30m` | Every 1 hour 30 minutes |
| `@daily` | Once a day at midnight |
| `0 30 * * * *` | Every hour at 30 minutes |

> Note: Creating a timer does not start it automatically. You must call `start_timer` separately.

### Example: Create and Start a Timer

Recommended workflow:

1. Create the target TAG table

```sql
CREATE TAG TABLE IF NOT EXISTS SENSOR_DATA (
    name VARCHAR(80) PRIMARY KEY,
    time DATETIME BASETIME,
    value DOUBLE SUMMARIZED
) WITH ROLLUP;
```

2. Create the TQL script with `save_tql_file`
3. Register the timer

```text
add_timer(name="SENSOR_DATA", schedule="@every 10s", path="SENSOR_DATA/SENSOR_DATA.tql")
```

```text
Timer 'SENSOR_DATA' created successfully. (schedule: @every 10s, path: SENSOR_DATA/SENSOR_DATA.tql)
NOTE: The timer is NOT running yet. Call start_timer with name='SENSOR_DATA' to begin execution.
```

4. Start the timer

```text
start_timer(name="SENSOR_DATA")
```

```text
Timer 'SENSOR_DATA' started.
```

## start_timer()

*Syntax*: `start_timer( name )`

Start an existing timer. If the timer is already running, it returns a corresponding message.

- `name` *string* required, timer name to start

## stop_timer()

*Syntax*: `stop_timer( name )`

Stop a running timer.

- `name` *string* required, timer name to stop

## delete_timer()

*Syntax*: `delete_timer( name )`

Delete a timer from Machbase Neo. If the timer is still running, it is automatically stopped before deletion.

- `name` *string* required, timer name to delete

To completely clean up a timer and its related resources:

```text
stop_timer(name="SENSOR_DATA")
delete_timer(name="SENSOR_DATA")
delete_file(filename="SENSOR_DATA/SENSOR_DATA.tql")
delete_file(filename="SENSOR_DATA/")
execute_sql_query(sql_query="DROP TABLE SENSOR_DATA CASCADE")
```

## create_folder()

*Syntax*: `create_folder( folder_name )`

Create a folder in the Machbase Neo file system.

- `folder_name` *string* required, folder path to create

## list_files()

*Syntax*: `list_files( [path] )`

List files and folders in the Machbase Neo file system.

- `path` *string* directory path. Default: `/`

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

Delete a file or empty folder from the Machbase Neo file system.

- `filename` *string* required, file path to delete

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
  "tools_count": 32,
  "tools": ["list_tables", "list_table_tags", "describe_table", "..."],
  "runtime": "JSH",
  "machbase": "connected"
}
```

## Navigation

- [Previous: How to Use Chat](./chat-usage.en.md)
- [Back to Index](./index.en.md)
- [Next: HTTP API and WebSocket](./http-api-and-websocket.en.md)
