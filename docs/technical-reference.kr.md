---
title: 기술 참고
weight: 40
---

# 기술 참고

이 문서는 LLM Chat 패키지가 내부적으로 사용하는 도구, 자동화 기능, 템플릿, 파일/문서 접근 기능을 정리한 기술 참고 문서입니다.

## list_tables()

*Syntax*: `list_tables()`

Machbase Neo에서 사용 가능한 테이블 목록을 조회합니다. 현재 사용자가 소유한 모든 테이블 이름을 한 줄에 하나씩 반환합니다.

### 예제: 테이블 목록 조회

채팅에서 질문: "테이블 리스트 조회 해줘"

도구가 내부적으로 실행하는 SQL(소유자는 현재 접속 사용자로 결정):

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

태그 테이블의 태그 메타데이터를 조회합니다. `_tablename_meta` 테이블을 쿼리하여 모든 태그(센서)명을 반환합니다.

- `table_name` *string* 필수, 태그 테이블명

### 예제: 태그 목록 조회

```text
list_table_tags(table_name="EXAMPLE")
```

```text
[EXAMPLE] temperature, humidity, pressure
```

## describe_table()

*Syntax*: `describe_table( table_name [, profile] )`

테이블 유형(TAG / LOG)과 컬럼 구조(이름, 타입, 역할: PRIMARY KEY / BASETIME / SUMMARIZED), ROLLUP 테이블 존재 여부를 조회합니다. 에이전틱 루프는 TQL/SQL을 생성하기 전에 실제 컬럼명을 파악하기 위해 이 도구를 먼저 호출합니다. 소유권 검사를 포함합니다.

- `table_name` *string* 필수, 조회할 테이블명
- `profile` *boolean* TAG 테이블일 때 태그 목록, 태그별 통계(건수 / 평균 / 최소 / 최대), 데이터 시간 범위(밀리초)까지 함께 반환합니다. 대시보드 구성 시 유용합니다. 기본값: `false`

### 예제: 테이블 구조 조회

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

Machbase Neo에서 SQL 쿼리를 직접 실행합니다.

- `sql_query` *string* 필수, 실행할 SQL 쿼리
- `format` *string* 출력 형식: `csv`(기본) 또는 `json`
- `timeformat` *string* 시간 형식: `default`, `ms`, `us`, `ns`
- `timezone` *string* 타임존 (예: `UTC`, `Asia/Seoul`)
- `limit` *integer* 반환할 최대 행 수. 기본값: `500`

> 참고: 안전을 위해 `UPDATE`, `DELETE`, `DROP` 구문은 차단됩니다. SQL 실행 실패 시 파싱된 에러 메시지를 반환합니다.

### 예제: 태그별 통계

```text
execute_sql_query(sql_query="SELECT NAME, COUNT(*), AVG(VALUE) FROM EXAMPLE GROUP BY NAME")
```

```csv
NAME,COUNT(*),AVG(VALUE)
temperature,15230,23.456
humidity,15230,65.123
pressure,15230,1013.25
```

### 예제: 시간 범위 조회

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

Machbase Neo에서 TQL (Transforming Query Language) 스크립트를 실행합니다. 스크립트에 사용된 SINK 함수에 따라 차트 HTML 또는 CSV 데이터를 반환합니다. 출력이 5000자를 넘으면 잘립니다.

- `tql_content` *string* 필수, TQL 스크립트 내용

### 예제: CSV 출력으로 TQL 실행

```text
execute_tql_script(tql_content="SQL(`SELECT NAME, COUNT(*) FROM EXAMPLE GROUP BY NAME`)\nCSV()")
```

```csv
temperature,15230
humidity,15230
pressure,15230
```

### 예제: 차트 출력으로 TQL 실행

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

도구는 렌더링된 차트를 HTML 프래그먼트로 반환합니다.

## save_tql_file()

*Syntax*: `save_tql_file( filename, tql_content )`

Machbase Neo에 TQL 또는 SQL 스크립트 파일을 저장합니다. TQL 파일은 저장 전에 실행하여 검증합니다.

- `filename` *string* 필수, 파일 경로 (예: `GOLD/chart.tql`)
- `tql_content` *string* 필수, TQL 스크립트 내용

저장 전 수행되는 검증:

1. TQL 스크립트를 실행하여 정확성을 검증합니다(검증 실패 시 저장하지 않음).
2. 조회 결과가 0행이면 시간 범위를 테이블 실제 MIN/MAX(TIME) 경계에 맞춰 자동 조정한 뒤 재시도합니다.
3. 필요시 상위 폴더를 자동 생성합니다.

### 예제: 차트 TQL 저장

```text
save_tql_file(
    filename="GOLD/avg_trend.tql",
    tql_content="SQL(`SELECT ...`)\nCHART(...)"
)
```

```text
File saved successfully: GOLD/avg_trend.tql
```

검증 실패 시:

```text
TQL validation failed (not saved): MACH-ERR 2044 ...
```

## compile_tql_from_spec()

*Syntax*: `compile_tql_from_spec( spec [, filename] )`

raw TQL을 직접 작성하는 대신, 분석 의도(IR JSON)로부터 실행 검증된 TQL을 컴파일합니다. 도구가 DB에서 실제 컬럼명과 ROLLUP 가용성을 자동 주입하고, 태그명을 검증하며, 시간 범위를 실제 데이터 경계로 보정해 반드시 실행되는 TQL을 반환합니다. 차트 TQL 생성 시 권장되는 방식입니다.

- `spec` *object* 필수, 분석 의도. 주요 필드:
  - `kind` — `metrics`(단일 태그, 1개 이상 집계), `tags`(여러 태그 비교), `ohlc`(캔들차트 / 시세), `geomap`(좌표 / 지도)
  - `table`, `tag` / `tags`, `timeRange: { start, end }`
  - `rollup` — 버킷 단위(`sec`, `min`, `hour`, `day`, `week`, `month`) 또는 raw면 `null`
  - `metrics` — `kind=metrics`용, 예: `[{ "agg": "avg", "label": "..." }]` (agg: avg / max / min / sum / count / sumsq / raw)
  - `output` *선택* — `{ chartType: "line" | "bar", title, subtitle }`
- `filename` *string* 선택, 저장 경로 `"TABLE/name.tql"`(영어만). 주면 대시보드용으로 저장(`charts`의 `tql_path`로 참조), 생략하면 검증된 TQL 텍스트를 답변으로 반환합니다.

### 예제: 차트 컴파일 및 저장

```text
compile_tql_from_spec(
    spec={"kind":"metrics","table":"GOLD","tag":"close","rollup":"day",
          "metrics":[{"agg":"avg","label":"Average"}]},
    filename="GOLD/avg_trend.tql"
)
```

## forecast_table()

*Syntax*: `forecast_table( spec [, filename] )`

특정 테이블 태그의 이후 값을 예측합니다. 도구가 여러 후보 모델(SES / 선형 / 2차 / Holt / Theta / AR / Holt-Winters 가법·곱셈 / 하모닉 / Prophet식)을 모두 적합하고 홀드아웃 백테스트로 순위를 매겨 최적 모델을 자동 선택합니다. 마지막 관측값에서 이어지도록 앵커링하고 신뢰밴드를 추가합니다. **호출하면 태그별·모델별 예측 곡선(신뢰구간·백테스트 포함)을 드롭다운으로 모두 열람할 수 있는 HTML 리포트를 생성·저장하고 링크를 반환합니다.** 태그 1개면 그 태그를, 2~5개면 전부 예측하며, 5개 초과면 데이터가 많은 순 상위 5개를 자동 선정합니다(되묻지 않고 안내를 함께 표시).

- `spec` *object* 필수, 예측 의도. 주요 필드:
  - `table` *필수*
  - `tag` — 예측할 단일 태그(생략 시 도구가 자동 결정), 또는 `tags: ["a","b"]`로 여러 태그 비교(최대 5개)
  - `rollup` — 버킷 단위(`sec` … `month`), 생략 시 범위 기반 자동 선택
  - `timeRange: { start, end }` — 학습 기간(생략 시 데이터 전체)
  - `horizon` — 예측할 미래 버킷 수(생략 시 학습 길이의 20%)
  - `method` — 모델 지정(생략 시 `auto` = 리더보드 1위 자동 선택). 값: `auto`, `ses`, `linear`, `quadratic`, `holt`, `theta`, `ar`, `holtwinters`, `holtwinters_mult`, `harmonic`, `prophet`. 한국어 별칭(`선형` / `2차` / `계절성`)과 순위 문자열(`2위` / `rank2`)도 허용
  - `rank` — 리더보드 순위로 모델 지정(1-based, 예: `2`)
  - `lookback` — 추세 윈도우 버킷 수(생략 시 자동)
  - `output` *선택* — `{ title, subtitle }`
- `filename` *string* 선택, 저장 경로 `"TABLE/name.tql"`(영어만). 주면 리포트에 **추가로** 라이브 재계산 `.tql`도 저장합니다(대시보드 `tql_path`용). 생략하면 HTML 리포트만 생성합니다.

### 예제: 예측 및 저장

```text
forecast_table(
    spec={"table":"GOLD","tag":"close","rollup":"day","horizon":30},
    filename="GOLD/close_forecast.tql"
)
```

## create_dashboard_with_charts()

*Syntax*: `create_dashboard_with_charts( filename, title, charts [, time_start, time_end, refresh] )`

여러 차트 패널을 포함한 대시보드를 한 번에 생성합니다.

- `filename` *string* 필수, 대시보드 경로 (예: `GOLD/Gold_Analysis.dsh`)
- `title` *string* 필수, 대시보드 제목
- `charts` *string* 필수, 차트 정의 JSON 배열
- `time_start` *string* 시간 범위 시작 (epoch ms 문자열). 생략 시 데이터에 맞게 자동 조정
- `time_end` *string* 시간 범위 종료 (epoch ms 문자열). 생략 시 데이터에 맞게 자동 조정
- `refresh` *string* 자동 새로고침 간격 (`Off`, `3 seconds`, `10 seconds`, `1 minute`, `1 hour` 등). 기본값: `Off`

`charts` 배열의 각 차트 객체. 권장 형태는 `compile_tql_from_spec` / `forecast_table`로 컴파일한 TQL 파일을 참조하는 방식입니다:

```json
{ "title": "평균 추세", "tql_path": "GOLD/avg_trend.tql" }
```

컴파일된 `.tql` 없이 간단한 임시 차트를 넣을 때는 인라인 정의를 사용합니다. `column`, name/time 컬럼은 테이블 메타데이터에서 자동 감지되므로 재정의가 필요할 때만 명시하세요:

```json
{ "title": "온도", "type": "Line", "table": "EXAMPLE", "tag": "temperature" }
```

지원하는 차트 유형: `Line`, `Bar`, `Scatter`, `Pie`, `Gauge`, `Text`, `Geomap`, `Video`, `Tql chart`

> 참고: 캔들차트 / OHLC 및 모든 컴파일된 차트는 반드시 `tql_path`를 사용해야 합니다(인라인 OHLC 패널은 렌더되지 않음). 인라인(기본 분석) 차트는 실재 태그를 가진 `Line` / `Bar` / `Scatter`로 제한됩니다.

### 예제: TQL 차트로 대시보드 생성

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

기존 대시보드에 차트 패널을 추가합니다. 패널 크기·위치·색상은 도구가 자동으로 배치합니다.

- `filename` *string* 필수, 대시보드 파일명
- `chart_title` *string* 필수, 차트 제목
- `chart_type` *string* 필수, 차트 유형 (예: `Line`, `Bar`, `Scatter`, `Tql chart`)
- `table` *string* 태그 테이블명
- `tag` *string* 태그명, 쉼표로 구분
- `column` *string* 컬럼명. 기본값: `VALUE`
- `tql_path` *string* TQL 파일 경로 (`Tql chart` 유형용)

### 예제: 라인 차트 추가

```text
add_chart_to_dashboard(
    filename="GOLD/Gold_Analysis.dsh",
    chart_title="Temperature Trend",
    chart_type="Line",
    table="EXAMPLE",
    tag="temperature"
)
```

### 예제: TQL 차트 추가

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

대시보드에서 차트 패널을 제거합니다. 패널 UUID 또는 제목으로 지정합니다.

- `filename` *string* 필수, 대시보드 파일명
- `panel_id` *string* 제거할 패널 UUID
- `panel_title` *string* 제거할 패널 제목

## update_chart_in_dashboard()

*Syntax*: `update_chart_in_dashboard( filename [, panel_id, panel_title, new_title] )`

대시보드의 기존 차트 패널 제목을 수정합니다. 대상 패널은 UUID 또는 제목으로 지정합니다.

- `filename` *string* 필수, 대시보드 파일명
- `panel_id` *string* 패널 UUID
- `panel_title` *string* 패널 제목 (첫 번째 매칭)
- `new_title` *string* 새 패널 제목

## get_dashboard()

*Syntax*: `get_dashboard( filename )`

대시보드의 전체 설정을 JSON으로 조회합니다.

- `filename` *string* 필수, 대시보드 파일명

## delete_dashboard()

*Syntax*: `delete_dashboard( filename )`

Machbase Neo에서 대시보드 파일을 삭제합니다.

- `filename` *string* 필수, 삭제할 대시보드 파일명

## update_dashboard_time_range()

*Syntax*: `update_dashboard_time_range( filename [, time_start, time_end, refresh] )`

대시보드의 시간 범위를 변경합니다.

- `filename` *string* 필수, 대시보드 파일명
- `time_start` *string* 시작 시간 (생략 시 빈 값으로 설정)
- `time_end` *string* 종료 시간 (생략 시 빈 값으로 설정)
- `refresh` *string* 자동 새로고침 간격. 기본값: `Off`

## preview_dashboard()

*Syntax*: `preview_dashboard( filename )`

대시보드 미리보기와 Neo 웹 UI 직접 링크를 반환합니다.

- `filename` *string* 필수, 대시보드 파일명

## save_html_report()

*Syntax*: `save_html_report( table [, template_id, tag_name, analysis, recommendations, rollup_unit, time_start, time_end, tag_count, data_count, time_range] )`

차트와 심층 분석이 포함된 HTML 분석 리포트를 생성합니다. 도구 내부에서 데이터 조회, FFT/통계 계산, 차트 생성, HTML 파일 생성을 모두 수행합니다.

- `table` *string* 필수, 테이블명 (예: `GOLD`)
- `template_id` *string* 리포트 템플릿 ID. 생략 시 데이터를 보고 빌트인 템플릿을 자동 판별
- `tag_name` *string* 분석 대상 태그명 또는 종목명. 사용자가 특정 대상을 언급하면 반드시 전달 — 생략하면 테이블 전체(수천 태그)를 조회해 느려지거나 컨텍스트를 초과할 수 있음
- `analysis` *string* 심층 분석 텍스트(마크다운). 1차 호출 시 비워두고, 2차 호출 시 작성
- `recommendations` *string* 종합 소견 및 권고(마크다운). 1차 호출 시 비워둠
- `rollup_unit` *string* `sec`, `min`, `hour`, `day`, `week`, `month` 중 하나
- `time_start` *string* 분석 시작(epoch ms). 사용자가 기간을 명시할 때만 전달
- `time_end` *string* 분석 끝(epoch ms), `time_start`와 함께 전달
- `tag_count` / `data_count` / `time_range` *string* 선택, 설명용 메타데이터

### 리포트 템플릿

빌트인 템플릿은 `neo/report/` 아래에 있으며, 커스텀 `C-*` 템플릿은 `neo/report/custom/`에 드롭할 수 있습니다.

| 템플릿 ID | 유형 | 설명 |
| :--- | :--- | :--- |
| `R-0-general` | 범용 | 기본 통계 분석 및 추세 차트 |
| `R-1-finance` | 금융 | 가격 밴드, 변동성, 로그 스케일 분석 |
| `R-2-vibration` | 진동 | RMS, FFT 스펙트럼, 엔벨로프, 크레스트 팩터 |
| `R-3-driving` | 운전 | 속도/RPM 상관관계, 주행 패턴 분석 |
| `C-1-energy` | 커스텀(예시) | 에너지 분석 커스텀 리포트 템플릿 |

### 예제: 금융 분석 리포트 생성

1차 호출 — 도구가 데이터를 조회하고 차트 분석 요약을 반환합니다(`analysis`는 비워둠):

```text
save_html_report(table="GOLD", template_id="R-1-finance", tag_name="close")
```

```text
Chart analysis summary: 금 가격은 2023-09-20부터 2025-12-13까지 ...
Please call again with this summary in the analysis parameter.
```

2차 호출 — 도구가 최종 HTML 리포트를 생성합니다:

```text
save_html_report(
    table="GOLD",
    template_id="R-1-finance",
    tag_name="close",
    analysis="금 가격은 2023-09-20부터 2025-12-13까지 ...",
    recommendations="1. ..."
)
```

```text
Report saved: GOLD/GOLD_financial_report.html
```

## list_timers()

*Syntax*: `list_timers()`

Machbase Neo에 등록된 모든 타이머(스케줄러) 목록을 조회합니다. 각 타이머의 이름, 상태(RUNNING/STOP), 스케줄, TQL 경로를 반환합니다.

### 예제: 타이머 목록 조회

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

TQL 스크립트를 일정에 따라 실행하는 새 타이머(스케줄러)를 생성합니다.

- `name` *string* 필수, 타이머 이름 (고유 식별자)
- `schedule` *string* 필수, 실행 스케줄
- `path` *string* 필수, 실행할 TQL 스크립트 경로
- `auto_start` *boolean* 서버 재시작 시 자동 시작. 기본값: `false`

스케줄 형식 예시:

| 표현식 | 설명 |
| :--- | :--- |
| `@every 10s` | 10초마다 |
| `@every 1h30m` | 1시간 30분마다 |
| `@daily` | 매일 자정 |
| `0 30 * * * *` | 매시 30분 |

> 참고: 타이머를 생성해도 자동으로 시작되지 않습니다. `start_timer`를 별도로 호출해야 합니다.

### 예제: 타이머 생성 및 시작

권장 워크플로우:

1. 대상 TAG 테이블 생성

```sql
CREATE TAG TABLE IF NOT EXISTS SENSOR_DATA (
    name VARCHAR(80) PRIMARY KEY,
    time DATETIME BASETIME,
    value DOUBLE SUMMARIZED
) WITH ROLLUP;
```

2. `save_tql_file`로 TQL 스크립트 생성
3. 타이머 등록

```text
add_timer(name="SENSOR_DATA", schedule="@every 10s", path="SENSOR_DATA/SENSOR_DATA.tql")
```

```text
Timer 'SENSOR_DATA' created successfully. (schedule: @every 10s, path: SENSOR_DATA/SENSOR_DATA.tql)
NOTE: The timer is NOT running yet. Call start_timer with name='SENSOR_DATA' to begin execution.
```

4. 타이머 시작

```text
start_timer(name="SENSOR_DATA")
```

```text
Timer 'SENSOR_DATA' started.
```

## start_timer()

*Syntax*: `start_timer( name )`

기존 타이머를 시작합니다. 이미 실행 중이면 해당 메시지를 반환합니다.

- `name` *string* 필수, 시작할 타이머 이름

## stop_timer()

*Syntax*: `stop_timer( name )`

실행 중인 타이머를 중지합니다.

- `name` *string* 필수, 중지할 타이머 이름

## delete_timer()

*Syntax*: `delete_timer( name )`

Machbase Neo에서 타이머를 삭제합니다. 타이머가 실행 중이면 삭제 전에 자동으로 중지합니다.

- `name` *string* 필수, 삭제할 타이머 이름

타이머와 관련 리소스를 완전히 정리하는 방법:

```text
stop_timer(name="SENSOR_DATA")
delete_timer(name="SENSOR_DATA")
delete_file(filename="SENSOR_DATA/SENSOR_DATA.tql")
delete_file(filename="SENSOR_DATA/")
execute_sql_query(sql_query="DROP TABLE SENSOR_DATA CASCADE")
```

## create_folder()

*Syntax*: `create_folder( folder_name )`

Machbase Neo 파일 시스템에 폴더를 생성합니다.

- `folder_name` *string* 필수, 생성할 폴더 경로

## list_files()

*Syntax*: `list_files( [path] )`

Machbase Neo 파일 시스템의 파일과 폴더 목록을 조회합니다.

- `path` *string* 디렉토리 경로. 기본값: `/`

### 예제: 파일 목록 조회

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

Machbase Neo 파일 시스템에서 파일 또는 빈 폴더를 삭제합니다.

- `filename` *string* 필수, 삭제할 파일 경로

## list_available_documents()

*Syntax*: `list_available_documents()`

Machbase Neo에서 사용 가능한 모든 메뉴얼 문서 목록을 조회합니다. 문서 카탈로그(경로, 제목, 키워드)를 반환합니다.

## search_documents()

*Syntax*: `search_documents( keyword )`

키워드로 문서 카탈로그를 검색해 일치하는 문서 경로를 반환합니다. `get_full_document_content`로 문서를 열기 전에 이 도구로 올바른 문서를 찾습니다. 일치가 없으면 근접한 후보 문서를 함께 안내합니다.

- `keyword` *string* 필수, 검색 키워드 (예: `PIVOT`, `ROLLUP`, `TQL`, `chart`)

### 예제: 문서 검색

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

메뉴얼 문서 내용을 조회합니다. 문서가 크면 `section` 키워드를 주어 해당 섹션만 전체 길이로 반환하므로, 큰 DDL 문서 안의 깊은 섹션(예: `ADD COLUMN`)이 잘리지 않습니다. `section` 없이 큰 문서를 조회하면 섹션 목록을 반환해 고르게 합니다.

- `file_identifier` *string* 필수, 카탈로그의 문서 경로(그대로 복사)
- `section` *string* 해당 섹션만 전체 길이로 반환할 섹션 헤더 키워드 (예: `ADD COLUMN`, `RETENTION`, `TO_CHAR`)

### 예제: 특정 섹션 읽기

```text
get_full_document_content(file_identifier="sql/sql-rollup.md", section="ADD COLUMN")
```

일치하는 섹션만 전체 길이로 반환합니다.

## get_document_sections()

*Syntax*: `get_document_sections( file_identifier [, section_filter] )`

메뉴얼 문서 내용을 섹션별로 구성하여 반환합니다. 키워드로 필터링할 수 있습니다.

- `file_identifier` *string* 필수, 파일 경로
- `section_filter` *string* 해당 텍스트가 포함된 섹션만 필터링

### 예제: 특정 섹션 읽기

```text
get_document_sections(file_identifier="tql/tql-sink.md", section_filter="CHART")
```

제목이나 내용에 "CHART"가 포함된 섹션만 반환합니다.

## extract_code_blocks()

*Syntax*: `extract_code_blocks( file_identifier [, language] )`

메뉴얼 문서에서 모든 코드 블록을 추출합니다. 언어별로 필터링할 수 있습니다.

- `file_identifier` *string* 필수, 파일 경로
- `language` *string* 언어 필터 (예: `js`, `sql`)

### 예제: SQL 예제 추출

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

패키지 및 Machbase Neo 서버의 버전 정보를 조회합니다.

## debug_mcp_status()

*Syntax*: `debug_mcp_status()`

Machbase Neo 시스템 테이블을 쿼리하여 현재 상태와 연결을 확인합니다.

### 예제: 상태 확인

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

## 문서 이동

- [이전: Chat 사용 방법](./chat-usage.kr.md)
- [목차로 돌아가기](./index.kr.md)
- [다음: HTTP API와 WebSocket](./http-api-and-websocket.kr.md)
