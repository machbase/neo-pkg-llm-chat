---
title: 技術リファレンス
weight: 40
---

# 技術リファレンス

<p align="center" style="margin-top:1.25rem"><a href="./technical-reference.kr.md">한국어</a> | <a href="./technical-reference.en.md">English</a> | <strong>日本語</strong></p>

このドキュメントは、LLM Chatパッケージが内部で使用するツール、自動化機能、テンプレート、ファイル/ドキュメントへのアクセス機能をまとめた技術リファレンスです。

## 共通ルール

以下のツールに共通して適用されるルールです。

**実行主体とアクセス範囲** — すべての照会はSettingsに入力したAPIトークンのアカウントで実行され、アクセスできるかどうかはMachbaseが判定します。表示されるテーブルは、そのアカウントが**所有するものと`GRANT`で権限を付与されたもの**で、`CONNECT`権限を持つ**すべてのデータベース**が対象です。

**テーブル名** — ツールは`DATABASE.OWNER.TABLE`の形式（例：`MACHBASEDB.SYS.EXAMPLE`）で名前を返します。接頭辞を外した名前は接続アカウントのスキーマで検索されるため、他人が所有するテーブルは権限があっても照会できません。接頭辞のない名前が渡されると、ツールが実行直前に所有者を補います（同じ名前が複数の所有者に存在する場合は補わず、どれなのかを聞き返します）。

**成果物の保存場所** — `.tql`・`.dsh`・レポートは**アカウントフォルダーの下**に保存されます。`filename="GOLD/chart.tql"`で呼び出すと実際のパスは`{user}/GOLD/chart.tql`になり、ダッシュボード・レポートのリンクも同じ規則に従います。アカウントごとにフォルダーが分かれるため、同じ名前の成果物が互いに上書きされることはありません（ファイル自体は他のアカウントからも閲覧できます）。

**使えるツール** — 質問フローごとに、モデルに渡すツールが決まっています。リストにないツールは、モデルが名前で呼び出しても実行されません。

| フロー | ツール |
| :--- | :--- |
| データ照会 | `list_tables`、`list_table_tags`、`describe_table`、`execute_sql_query`、`compile_tql_from_spec`、`forecast_table` |
| 基本分析 | `list_tables`、`list_table_tags`、`describe_table`、`execute_sql_query`、`create_dashboard_with_charts`、`preview_dashboard`、`forecast_table`、`list_available_documents`、`get_full_document_content` |
| 詳細分析 | 基本分析のツール + `compile_tql_from_spec`、`create_folder` |
| レポート | `save_html_report` |
| 文書検索 | `search_documents`、`list_available_documents`、`get_full_document_content`、`get_document_sections`、`extract_code_blocks`、`list_tables`、`describe_table`、`list_table_tags`、`compile_tql_from_spec` |
| システム情報 | `get_version`、`debug_mcp_status`、`execute_sql_query` |
| 一般 | 削除ツール3つ（`remove_chart_from_dashboard`、`delete_dashboard`、`delete_file`）を除くすべてのツール |

削除ツール3つはどのフローにもありません。ダッシュボードやファイルの削除はNeo Webコンソールで行います。ダッシュボード編集ツール（`get_dashboard`、`add_chart_to_dashboard`、`update_chart_in_dashboard`、`update_dashboard_time_range`）は一般フローにのみあるため、分析フローに分類される修正依頼（「add a chart」など）には使われません。

## list_tables()

*Syntax*: `list_tables()`

アクセス可能なTAGテーブルの一覧を取得します。データベースとテーブルの2列からなる表とテーブル数を返し、SQL・TQLで使う完全修飾名（`DATABASE.OWNER.TABLE`）もあわせて提供します。

### 例：テーブル一覧の取得

チャットで質問："Show me the table list"

ツールが内部で実行するSQL（所有者の条件は付けません。セッションユーザーがアクセスできるものだけがカタログに表示されるため、条件を付けると`GRANT`でアクセスできるテーブルが漏れてしまいます）：

```sql
SELECT st.DATABASE_NAME, su.NAME, st.NAME FROM m$sys_tables AS st
JOIN m$sys_users AS su ON st.USER_ID = su.USER_ID
WHERE st.FLAG = 0
ORDER BY st.DATABASE_NAME, su.NAME, st.NAME
```

```text
| データベース | テーブル |
|---|---|
| FACTORY_A | SENSOR_A |
| MACHBASEDB | EXAMPLE |
| MACHBASEDB | GOLD |

(3 tables)
```

表はチャットの回答にそのまま表示されます。

## list_table_tags()

*Syntax*: `list_table_tags( table_name )`

タグテーブルのタグメタデータを取得します。`_tablename_meta`テーブルをクエリし、すべてのタグ（センサー）名を返します。

- `table_name` *string* 必須、タグテーブル名。完全修飾名（`MACHBASEDB.SYS.EXAMPLE`）を受け付け、タグメタテーブルも同じ接頭辞で照会します

### 例：タグ一覧の取得

```text
list_table_tags(table_name="EXAMPLE")
```

```text
[EXAMPLE] temperature, humidity, pressure
```

## describe_table()

*Syntax*: `describe_table( table_name [, profile] )`

テーブルの種類（TAG / LOG）とカラム構造（名前、型、役割：PRIMARY KEY / BASETIME / SUMMARIZED）、ROLLUPテーブルの有無を取得します。エージェンティックループは、TQL/SQLを生成する前に実際のカラム名を把握するため、このツールを先に呼び出します。アクセス権限のチェックを含み、完全修飾名を受け取ると付属オブジェクト（タグメタ・統計ビュー）も同じ接頭辞で照会します。

- `table_name` *string* 必須、照会するテーブル名
- `profile` *boolean* TAGテーブルの場合、タグ一覧、タグごとの統計（件数 / 平均 / 最小 / 最大）、データの時間範囲（ミリ秒）もあわせて返します。ダッシュボードを構成するときに便利です。時間範囲には、ユーザーのタイムゾーンの読み取り形式の時刻も併記します。デフォルト値：`false`

### 例：テーブル構造の取得

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

Machbase NeoでSQLクエリを直接実行します。

- `sql_query` *string* 必須、実行するSQLクエリ
- `format` *string* 出力形式：`csv`（デフォルト）または`json`
- `timeformat` *string* 時刻形式：`default`、`ms`、`us`、`ns`
- `timezone` *string* タイムゾーン（例：`UTC`、`Asia/Seoul`）。ユーザーがタイムゾーンを指定したときだけ渡します。省略するとユーザーのブラウザのタイムゾーン
- `limit` *integer* 返す最大行数。デフォルト値：`500`

> 参考：安全のため、`UPDATE`、`DELETE`、`DROP`文はブロックされます。SQLの実行に失敗した場合は、解析したエラーメッセージを返します。
>
> クエリはAPIトークンのアカウントで実行され、権限のないテーブルはMachbaseが拒否します。`FROM`/`JOIN`の後に接頭辞のない名前があると、実行直前に所有者を補います（例：`FROM EXAMPLE` → `FROM MACHBASEDB.SYS.EXAMPLE`）。
>
> 結果の時刻は読み取り形式（`Default`）で、ユーザーのタイムゾーンを基準に表示します。純粋な期間の照会（`MIN(TIME)`、`MAX(TIME)`）を`timeformat="ms"`で行うと、数値の横にユーザーのタイムゾーンの時刻を併記します。
>
> ROLLUPクエリが失敗した場合（ROLLUPがないテーブルの`ERR-2264`、ROLLUPで計算できない集計の`ERR-2816`）、同じ単位の`DATE_TRUNC`式を案内します。
>
> ローカルモデル（Ollama）は、1つの質問でこのツールを8回まで実行します。

### 例：タグごとの統計

```text
execute_sql_query(sql_query="SELECT NAME, COUNT(*), AVG(VALUE) FROM EXAMPLE GROUP BY NAME")
```

```csv
NAME,COUNT(*),AVG(VALUE)
temperature,15230,23.456
humidity,15230,65.123
pressure,15230,1013.25
```

### 例：時間範囲の照会

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

TQLスクリプトを実行する**内部専用**のツールです。モデルには公開されず、モデルが名前で呼び出しても実行されません。`compile_tql_from_spec`がコンパイルしたTQLを実行して検証するときに内部で使用します。

- ユーザーがチャットに貼り付けたTQLは実行しません。Neo WebコンソールのTQLエディターで実行します。
- 貼り付けたSQLは`execute_sql_query`で実行します。

## save_tql_file()

*Syntax*: `save_tql_file( filename, tql_content )`

TQLファイルを保存する**内部専用**のツールです。モデルには公開されず、モデルが名前で呼び出しても実行されません。`compile_tql_from_spec`と`forecast_table`がファイルを保存するときに内部で使用します。

保存前に行われる検証：

1. TQLスクリプトを実行して正しさを検証します（検証に失敗した場合は保存しません）。
2. 照会結果が0行の場合、時間範囲をテーブルの実際のMIN/MAX(TIME)の境界に合わせて自動調整してから再試行します。
3. 必要に応じて親フォルダーを自動作成します。

## compile_tql_from_spec()

*Syntax*: `compile_tql_from_spec( spec [, filename] )`

raw TQLを直接書く代わりに、分析意図（IR JSON）から実行検証済みのTQLをコンパイルします。ツールがDBから実際のカラム名とROLLUPの利用可否を自動で注入し、タグ名を検証し、時間範囲を実際のデータ境界に補正して、必ず実行できるTQLを返します。モデルがTQLを作成・保存する方法はこのツールだけです。IRで表現できない特殊なチャート（ヒートマップ、FFT、3Dなど）はサポートしません。

- `spec` *object* 必須、分析意図。主なフィールド：
  - `kind` — `metrics`（単一タグ、1つ以上の集計）、`tags`（複数タグの比較）、`ohlc`（ローソク足チャート / 相場）、`geomap`（座標 / 地図）
  - `table`、`tag` / `tags`、`timeRange: { start, end }`
  - `rollup` — バケット単位（`sec`、`min`、`hour`、`day`、`week`、`month`）、rawの場合は`null`
  - `rollupN` *任意* — バケットの倍数。例：5分平均は`rollup: "min"`、`rollupN: 5`。`"5min"`、`"10s"`のように書いても自動的に分割します
  - `metrics` — `kind=metrics`用、例：`[{ "agg": "avg", "label": "..." }]`（agg: avg / max / min / sum / count / sumsq / raw）
  - `output` *任意* — `{ chartType: "line" | "bar", title, subtitle }`
- `filename` *string* 任意、保存パス`"TABLE/name.tql"`（英語のみ）。指定するとダッシュボード用に保存し（`charts`の`tql_path`で参照）、省略すると検証済みのTQLテキストを回答として返します。

### 期間とバケット単位

ユーザーの質問に期間と単位が含まれているかどうかによって、チャートの期間とバケット単位が決まります。期間は単位より優先されます。

| 質問 | 例 | 結果 |
| :--- | :--- | :--- |
| 単位のみ | "BITCOIN 1-minute average" | 単位を守り、データの最終時刻から単位に合った長さだけ期間を切り出します |
| 期間と単位 | "1-minute average for the last 6 months" | 期間を守り、期間に対して単位が細かすぎる場合は単位を上げます |
| 期間のみ | "Trend for the last week" | 期間に合わせて単位を自動で決めます |
| どちらもない | "BITCOIN trend" | 全期間、単位は自動 |

- 質問の単位は、"1분 평균"（1分平均）、"5분 단위"（5分単位）、"10초 간격"（10秒間隔）、"1시간마다"（1時間ごと）、"5분봉"（5分足）、"시간별"（時間別）、"일별"（日別）のように、数字とバケット表現が一緒にあるときに認められます。
- 単位ごとに描画できる期間：秒は1時間、分は48時間、時間は30日、日・週は1年未満。倍数を使うと、その倍数分だけ長くなります（5分なら240時間）。
- データの終端を基準に切り出すため、データの取り込みが止まったテーブルでも空のチャートになりません。
- ローソク足（`ohlc`）は、質問に期間と単位が両方あるときだけ単位を上げます。タグ比較（`tags`）は、単位だけがあるときに期間の切り出しのみを適用します。
- 倍数：ROLLUPがあるテーブルはすべての単位で使用できます。ROLLUPがないテーブルとローソク足は`DATE_TRUNC`を使うため、1日以内の倍数のみ使用できます（秒は86400・分は1440・時間は24まで、日・週・月は1）。
- 単位や期間を変更すると、ツールの結果に`[주의] …`（注意）の案内が付き、チャートのタイトルには実際に適用された単位が入ります。ローカルモデル（Ollama）の回答に変更後の値が抜けている場合、回答の末尾に`※ 적용 기준:`（適用基準）の1行が付きます。
- チャートの時間軸は、ユーザー（ブラウザ）のタイムゾーンで描画します。

### 例：チャートのコンパイルと保存

```text
compile_tql_from_spec(
    spec={"kind":"metrics","table":"GOLD","tag":"close","rollup":"day",
          "metrics":[{"agg":"avg","label":"Average"}]},
    filename="GOLD/avg_trend.tql"
)
```

## forecast_table()

*Syntax*: `forecast_table( spec [, filename] )`

特定テーブルのタグの今後の値を予測します。ツールが複数の候補モデル（SES / 線形 / 2次 / Holt / Theta / AR / Holt-Winters加法・乗法 / ハーモニック / Prophet風）をすべてフィッティングし、ホールドアウトバックテストで順位を付けて最適なモデルを自動選択します。最後の観測値から続くようにアンカリングし、信頼バンドを追加します。**呼び出すと、タグ別・モデル別の予測曲線（信頼区間・バックテストを含む）をドロップダウンですべて閲覧できるHTMLレポートを生成・保存し、リンクを返します**。タグが1個ならそのタグを、2\~5個ならすべてを予測し、5個を超える場合はデータの多い順に上位5個を自動で選びます（聞き返さずに案内をあわせて表示）。

- `spec` *object* 必須、予測意図。主なフィールド：
  - `table` *必須*
  - `tag` — 予測する単一タグ（省略するとツールが自動で決定）、または`tags: ["a","b"]`で複数タグを比較（最大5個）
  - `rollup` — バケット単位（`sec` … `month`）、省略すると範囲に基づいて自動選択
  - `timeRange: { start, end }` — 学習期間（省略するとデータ全体）
  - `horizon` — 予測する未来のバケット数（省略すると学習期間の長さの20%）
  - `method` — モデルの指定（省略すると`auto` = リーダーボード1位を自動選択）。値：`auto`、`ses`、`linear`、`quadratic`、`holt`、`theta`、`ar`、`holtwinters`、`holtwinters_mult`、`harmonic`、`prophet`。韓国語の別名（`선형` / `2차` / `계절성`）と順位の文字列（`2위` / `rank2`）も使用可能
  - `rank` — リーダーボードの順位でモデルを指定（1-based、例：`2`）
  - `lookback` — トレンドウィンドウのバケット数（省略すると自動）
  - `output` *任意* — `{ title, subtitle }`
- `filename` *string* 任意、保存パス`"TABLE/name.tql"`（英語のみ）。指定するとレポートに**加えて**ライブ再計算の`.tql`も保存します（ダッシュボードの`tql_path`用）。省略するとHTMLレポートのみ生成します。

### 例：予測と保存

```text
forecast_table(
    spec={"table":"GOLD","tag":"close","rollup":"day","horizon":30},
    filename="GOLD/close_forecast.tql"
)
```

## create_dashboard_with_charts()

*Syntax*: `create_dashboard_with_charts( filename, title, charts [, time_start, time_end, refresh] )`

複数のチャートパネルを含むダッシュボードを一度に作成します。

- `filename` *string* 必須、ダッシュボードのパス（例：`GOLD/Gold_Analysis.dsh`）
- `title` *string* 必須、ダッシュボードのタイトル
- `charts` *string* 必須、チャート定義のJSON配列
- `time_start` *string* 時間範囲の開始（epoch msの文字列）。省略するとデータに合わせて自動調整
- `time_end` *string* 時間範囲の終了（epoch msの文字列）。省略するとデータに合わせて自動調整
- `refresh` *string* 自動更新の間隔（`Off`、`3 seconds`、`10 seconds`、`1 minute`、`1 hour`など）。デフォルト値：`Off`

`charts`配列の各チャートオブジェクト。推奨される形式は、`compile_tql_from_spec` / `forecast_table`でコンパイルしたTQLファイルを参照する方式です：

```json
{ "title": "平均トレンド", "tql_path": "GOLD/avg_trend.tql" }
```

コンパイル済みの`.tql`なしで簡単な一時チャートを入れるときは、インライン定義を使います。`column`、name/timeカラムはテーブルのメタデータから自動検出されるため、上書きが必要なときだけ指定してください：

```json
{ "title": "温度", "type": "Line", "table": "EXAMPLE", "tag": "temperature" }
```

サポートするチャートの種類：`Line`、`Bar`、`Scatter`、`Pie`、`Gauge`、`Text`、`Geomap`、`Video`、`Tql chart`

> 参考：ローソク足チャート / OHLCおよびすべてのコンパイル済みチャートは、必ず`tql_path`を使う必要があります（インラインのOHLCパネルはレンダリングされません）。インライン（基本分析）チャートは、実在するタグを持つ`Line` / `Bar` / `Scatter`に限られます。

### 例：TQLチャートでダッシュボードを作成

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

> 一般フローでのみ使用できます。

既存のダッシュボードにチャートパネルを追加します。パネルのサイズ・位置・色はツールが自動で配置します。

- `filename` *string* 必須、ダッシュボードのファイル名
- `chart_title` *string* 必須、チャートのタイトル
- `chart_type` *string* 必須、チャートタイプ（例：`Line`、`Bar`、`Scatter`、`Tql chart`）
- `table` *string* タグテーブル名
- `tag` *string* タグ名、カンマ区切り
- `column` *string* カラム名。デフォルト値：`VALUE`
- `tql_path` *string* TQLファイルのパス（`Tql chart`タイプ用）

### 例：ラインチャートの追加

```text
add_chart_to_dashboard(
    filename="GOLD/Gold_Analysis.dsh",
    chart_title="Temperature Trend",
    chart_type="Line",
    table="EXAMPLE",
    tag="temperature"
)
```

### 例：TQLチャートの追加

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

> 現在どの質問フローにも開放されていないため、モデルは使用しません。削除はNeo Webコンソールで行います。

ダッシュボードからチャートパネルを削除します。パネルはUUIDまたはタイトルで指定します。

- `filename` *string* 必須、ダッシュボードのファイル名
- `panel_id` *string* 削除するパネルのUUID
- `panel_title` *string* 削除するパネルのタイトル

## update_chart_in_dashboard()

*Syntax*: `update_chart_in_dashboard( filename [, panel_id, panel_title, new_title] )`

> 一般フローでのみ使用できます。

ダッシュボードにある既存のチャートパネルのタイトルを変更します。対象のパネルはUUIDまたはタイトルで指定します。

- `filename` *string* 必須、ダッシュボードのファイル名
- `panel_id` *string* パネルのUUID
- `panel_title` *string* パネルのタイトル（最初に一致したもの）
- `new_title` *string* 新しいパネルのタイトル

## get_dashboard()

*Syntax*: `get_dashboard( filename )`

> 一般フローでのみ使用できます。

ダッシュボードの設定全体をJSONで取得します。

- `filename` *string* 必須、ダッシュボードのファイル名

## delete_dashboard()

*Syntax*: `delete_dashboard( filename )`

> 現在どの質問フローにも開放されていないため、モデルは使用しません。削除はNeo Webコンソールで行います。

Machbase Neoからダッシュボードファイルを削除します。

- `filename` *string* 必須、削除するダッシュボードのファイル名

## update_dashboard_time_range()

*Syntax*: `update_dashboard_time_range( filename [, time_start, time_end, refresh] )`

> 一般フローでのみ使用できます。

ダッシュボードの時間範囲を変更します。

- `filename` *string* 必須、ダッシュボードのファイル名
- `time_start` *string* 開始時刻（省略すると空の値に設定）
- `time_end` *string* 終了時刻（省略すると空の値に設定）
- `refresh` *string* 自動更新の間隔。デフォルト値：`Off`

## preview_dashboard()

*Syntax*: `preview_dashboard( filename )`

ダッシュボードのプレビューと、Neo Web UIへの直接リンクを返します。

- `filename` *string* 必須、ダッシュボードのファイル名

## save_html_report()

*Syntax*: `save_html_report( table [, template_id, tag_name, analysis, recommendations, rollup_unit, time_start, time_end, timezone, tag_count, data_count, time_range] )`

チャートと詳細分析を含むHTML分析レポートを生成します。データの取得、FFT/統計計算、チャート生成、HTMLファイルの作成はすべてツール内部で行います。

金融（`R-1`）・振動（`R-2`）・運転（`R-3`）テンプレートの推移の集計は、テーブルにROLLUPがあれば`ROLLUP`、なければ同じ単位の`DATE_TRUNC`で計算します。レポートの時刻（期間、統計、チャートのラベル、生成時刻）は、ユーザーのタイムゾーンで表示します。

- `table` *string* 必須、テーブル名（例：`GOLD`）
- `template_id` *string* レポートテンプレートID。省略するとデータを見てビルトインテンプレートを自動判別
- `tag_name` *string* 分析対象のタグ名または銘柄名。ユーザーが特定の対象に言及した場合は必ず指定 — 省略するとテーブル全体（数千タグ）を取得するため、遅くなったりコンテキストを超えたりするおそれがある
- `analysis` *string* 詳細分析のテキスト（Markdown）。1回目の呼び出しでは空にし、2回目の呼び出しで記述
- `recommendations` *string* 総合所見と推奨事項（Markdown）。1回目の呼び出しでは空にする
- `rollup_unit` *string* `sec`、`min`、`hour`、`day`、`week`、`month`のいずれか
- `time_start` *string* 分析の開始（epoch ms）。ユーザーが期間を明示した場合のみ指定
- `time_end` *string* 分析の終了（epoch ms）、`time_start`と一緒に指定
- `timezone` *string* 時刻表示のタイムゾーン（IANA名、例：`UTC`）。ユーザーがタイムゾーンを指定したときだけ渡します。省略するとユーザーのブラウザのタイムゾーン
- `tag_count` / `data_count` / `time_range` *string* 任意、説明用のメタデータ

### レポートテンプレート

ビルトインテンプレートは`neo/report/`の下にあり、カスタムの`C-*`テンプレートは`neo/report/custom/`に配置できます。

| テンプレートID | 種類 | 説明 |
| :--- | :--- | :--- |
| `R-0-general` | 汎用 | 基本統計分析とトレンドチャート |
| `R-1-finance` | 金融 | 価格バンド、ボラティリティ、対数スケール分析 |
| `R-2-vibration` | 振動 | RMS、FFTスペクトル、エンベロープ、クレストファクター |
| `R-3-driving` | 運転 | 速度/RPMの相関関係、走行パターン分析 |
| `C-1-energy` | カスタム（例） | エネルギー分析のカスタムレポートテンプレート |

### 例：金融分析レポートの生成

1回目の呼び出し — ツールがデータを取得し、チャート分析の要約を返します（`analysis`は空のまま）：

```text
save_html_report(table="GOLD", template_id="R-1-finance", tag_name="close")
```

```text
Chart analysis summary: 金価格は2023-09-20から2025-12-13にかけて ...
Please call again with this summary in the analysis parameter.
```

2回目の呼び出し — ツールが最終的なHTMLレポートを生成します：

```text
save_html_report(
    table="GOLD",
    template_id="R-1-finance",
    tag_name="close",
    analysis="金価格は2023-09-20から2025-12-13にかけて ...",
    recommendations="1. ..."
)
```

```text
Report saved: sys/GOLD/GOLD_financial_report.html
```

## タイマーリクエスト

タイマー（スケジューラー）の登録・開始・停止・削除・一覧取得は、LLM Chatではサポートしていません。Machbase NeoのタイマーAPIが、APIトークン認証のパス（`/db/*`）にないためです。

タイマーに関する質問には、マニュアル検索で回答します。対象となるのは次の質問です。

- 「타이머」「timer」「cron」「스케줄러」「scheduler」を含む質問
- 「스케줄」を含み、作成・追加・登録・開始・停止・削除・一覧などの操作を依頼する質問

回答では、Neoのマニュアルに基づいて次の内容を案内します。

- WebコンソールのTimerメニューでタイマーを登録・開始・停止・削除する方法
- シェルコマンド：`timer add <name> <timer_spec> <tql-path>;`、`timer list;`、`timer start|stop <name>;`、`timer del <name>;`
- スケジュール式（`@every 10s`、cron形式など）とタイマー用のTQLテンプレート

質問例：「Make a timer that collects sensor data every 10 seconds」「Show the timer list」「Turn off the SENSOR_DATA timer」

> 回答に含まれるTQLはマニュアルのテンプレートを参考にした例で、実行による検証は行っていません。実際のテーブル名・タグ名に合わせて修正し、NeoのTQLエディタで確認してからタイマーに登録してください。

## create_folder()

*Syntax*: `create_folder( folder_name )`

Machbase Neoのファイルシステムにフォルダーを作成します。

- `folder_name` *string* 必須、作成するフォルダーのパス。アカウントフォルダーの下に作成され、上位フォルダーも一緒に作成されます

## list_files()

*Syntax*: `list_files( [path] )`

Machbase Neoのファイルシステムにあるファイルとフォルダーの一覧を取得します。

- `path` *string* ディレクトリのパス。デフォルト値：`/`。まずアカウントフォルダーの下を探し、なければ指定したパスをそのまま参照します

### 例：ファイル一覧の取得

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

> 現在どの質問フローにも開放されていないため、モデルは使用しません。削除はNeo Webコンソールで行います。

Machbase Neoのファイルシステムからファイルまたは空のフォルダーを削除します。

- `filename` *string* 必須、削除するファイルのパス。まずアカウントフォルダーの下を探し、なければ指定したパスから削除します

## list_available_documents()

*Syntax*: `list_available_documents()`

Machbase Neoで利用できるすべてのマニュアル文書の一覧を取得します。文書カタログ（パス、タイトル、キーワード）を返します。

## search_documents()

*Syntax*: `search_documents( keyword )`

キーワードで文書カタログを検索し、一致した文書のパスを返します。`get_full_document_content`で文書を開く前に、このツールで正しい文書を探します。一致するものがなければ、近い候補の文書もあわせて案内します。

- `keyword` *string* 必須、検索キーワード（例：`PIVOT`、`ROLLUP`、`TQL`、`chart`）

### 例：文書の検索

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

マニュアル文書の内容を取得します。文書が大きい場合、`section`キーワードを渡すとそのセクションだけを切り詰めずに返すため、大きなDDL文書の奥にあるセクション（例：`ADD COLUMN`）も途中で切れません。`section`なしで大きな文書を取得すると、セクション一覧を返して選べるようにします。

- `file_identifier` *string* 必須、カタログにある文書のパス（そのままコピー）
- `section` *string* そのセクションだけを切り詰めずに返すためのセクション見出しキーワード（例：`ADD COLUMN`、`RETENTION`、`TO_CHAR`）

### 例：特定のセクションを読む

```text
get_full_document_content(file_identifier="sql/sql-rollup.md", section="ADD COLUMN")
```

一致するセクションだけを切り詰めずに返します。

## get_document_sections()

*Syntax*: `get_document_sections( file_identifier [, section_filter] )`

マニュアル文書の内容をセクションごとにまとめて返します。キーワードで絞り込むこともできます。

- `file_identifier` *string* 必須、ファイルのパス
- `section_filter` *string* このテキストを含むセクションだけに絞り込む

### 例：特定のセクションを読む

```text
get_document_sections(file_identifier="tql/tql-sink.md", section_filter="CHART")
```

タイトルまたは内容に「CHART」を含むセクションだけを返します。

## extract_code_blocks()

*Syntax*: `extract_code_blocks( file_identifier [, language] )`

マニュアル文書からすべてのコードブロックを抽出します。言語で絞り込むこともできます。

- `file_identifier` *string* 必須、ファイルのパス
- `language` *string* 言語フィルター（例：`js`、`sql`）

### 例：SQLサンプルの抽出

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

パッケージとMachbase Neoサーバーのバージョン情報を取得します。

## debug_mcp_status()

*Syntax*: `debug_mcp_status()`

Machbase Neoのシステムテーブルにクエリを実行し、現在の状態と接続を確認します。

### 例：状態の確認

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

## ページ移動

- [前へ：Chatの使い方](./chat-usage.ja.md)
- [目次に戻る](./index.ja.md)
- [次へ：HTTP APIとWebSocket](./http-api-and-websocket.ja.md)
