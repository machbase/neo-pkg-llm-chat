---
title: 기술 참고
weight: 40
---

이 문서는 LLM Chat 패키지가 내부적으로 사용하는 도구, 자동화 기능, 템플릿, 파일/문서 접근 기능을 정리한 기술 참고 문서입니다.

## 공통 규칙

아래 도구들에 공통으로 적용되는 규칙입니다.

**실행 주체와 접근 범위** — 모든 조회는 Settings에 입력한 API 토큰의 계정으로 실행되며, 접근 가능 여부는 Machbase가 판정합니다. 보이는 테이블은 그 계정이 **소유한 것과 `GRANT`로 권한을 받은 것**이고, `CONNECT` 권한이 있는 **모든 데이터베이스**가 대상입니다.

**테이블 이름** — 도구는 `DATABASE.OWNER.TABLE` 형태(예: `MACHBASEDB.SYS.EXAMPLE`)로 이름을 돌려줍니다. 접두를 뗀 이름은 접속 계정의 스키마에서 찾으므로, 남이 소유한 테이블은 권한이 있어도 조회되지 않습니다. 접두 없는 이름이 들어오면 도구가 실행 직전에 소유자를 채워 넣습니다(같은 이름이 여러 소유자에 있으면 채우지 않고 어느 것인지 되묻습니다).

**산출물 저장 위치** — `.tql`·`.dsh`·리포트는 **계정 폴더 아래**에 저장됩니다. `filename="GOLD/chart.tql"`로 호출하면 실제 경로는 `{user}/GOLD/chart.tql`이 되고, 대시보드·리포트 링크도 같은 규칙을 따릅니다. 계정별로 폴더가 나뉘어 같은 이름의 산출물이 서로 덮어써지지 않습니다(파일 자체는 다른 계정도 열람할 수 있습니다).

**쓸 수 있는 도구** — 질문 흐름마다 모델에게 주는 도구가 정해져 있습니다. 목록에 없는 도구는 모델이 이름으로 불러도 실행되지 않습니다.

| 흐름 | 도구 |
| :--- | :--- |
| 데이터 조회 | `list_tables`, `list_table_tags`, `describe_table`, `execute_sql_query`, `compile_tql_from_spec`, `forecast_table` |
| 기본 분석 | `list_tables`, `list_table_tags`, `describe_table`, `execute_sql_query`, `create_dashboard_with_charts`, `preview_dashboard`, `forecast_table`, `list_available_documents`, `get_full_document_content` |
| 고급 분석 | 기본 분석의 도구 + `compile_tql_from_spec`, `create_folder` |
| 리포트 | `save_html_report` |
| 문서 검색 | `search_documents`, `list_available_documents`, `get_full_document_content`, `get_document_sections`, `extract_code_blocks`, `list_tables`, `describe_table`, `list_table_tags`, `compile_tql_from_spec` |
| 시스템 정보 | `get_version`, `debug_mcp_status`, `execute_sql_query` |
| 일반 | 삭제 도구 3개(`remove_chart_from_dashboard`, `delete_dashboard`, `delete_file`)를 뺀 모든 도구 |

삭제 도구 3개는 어느 흐름에도 없습니다. 대시보드·파일 삭제는 Neo 웹 콘솔에서 합니다. 대시보드 편집 도구(`get_dashboard`, `add_chart_to_dashboard`, `update_chart_in_dashboard`, `update_dashboard_time_range`)는 일반 흐름에만 있어, 분석 흐름으로 분류되는 수정 요청("차트 추가해줘")에는 쓰이지 않습니다.

## list_tables()

*Syntax*: `list_tables()`

접근 가능한 TAG 테이블 목록을 조회합니다. 데이터베이스와 테이블 두 열로 이루어진 표와 테이블 수를 돌려주며, SQL·TQL에 쓸 전체 이름(`DATABASE.OWNER.TABLE`)을 함께 제공합니다.

### 예제: 테이블 목록 조회

채팅에서 질문: "테이블 리스트 조회 해줘"

도구가 내부적으로 실행하는 SQL(소유자 조건을 걸지 않습니다 — 세션 사용자가 접근할 수 있는 것만 카탈로그에 나오므로, 조건을 걸면 `GRANT`로 접근 가능한 테이블이 빠집니다):

```sql
SELECT st.DATABASE_NAME, su.NAME, st.NAME FROM m$sys_tables AS st
JOIN m$sys_users AS su ON st.USER_ID = su.USER_ID
WHERE st.FLAG = 0
ORDER BY st.DATABASE_NAME, su.NAME, st.NAME
```

```text
| 데이터베이스 | 테이블 |
|---|---|
| FACTORY_A | SENSOR_A |
| MACHBASEDB | EXAMPLE |
| MACHBASEDB | GOLD |

(3 tables)
```

표는 채팅 답변에 그대로 표시됩니다.

## list_table_tags()

*Syntax*: `list_table_tags( table_name )`

태그 테이블의 태그 메타데이터를 조회합니다. `_tablename_meta` 테이블을 쿼리하여 모든 태그(센서)명을 반환합니다.

- `table_name` *string* 필수, 태그 테이블명. 전체 이름(`MACHBASEDB.SYS.EXAMPLE`)을 받으며, 태그 메타 테이블도 같은 접두로 조회합니다

### 예제: 태그 목록 조회

```text
list_table_tags(table_name="EXAMPLE")
```

```text
[EXAMPLE] temperature, humidity, pressure
```

## describe_table()

*Syntax*: `describe_table( table_name [, profile] )`

테이블 유형(TAG / LOG)과 컬럼 구조(이름, 타입, 역할: PRIMARY KEY / BASETIME / SUMMARIZED), ROLLUP 테이블 존재 여부를 조회합니다. 에이전틱 루프는 TQL/SQL을 생성하기 전에 실제 컬럼명을 파악하기 위해 이 도구를 먼저 호출합니다. 접근 권한 검사를 포함하며, 전체 이름을 받으면 부속 객체(태그 메타·통계 뷰)도 같은 접두로 조회합니다.

- `table_name` *string* 필수, 조회할 테이블명
- `profile` *boolean* TAG 테이블일 때 태그 목록, 태그별 통계(건수 / 평균 / 최소 / 최대), 데이터 시간 범위(밀리초)까지 함께 반환합니다. 대시보드 구성 시 유용합니다. 시간 범위에는 사용자 시간대의 읽기형 시각을 함께 적습니다. 기본값: `false`

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
- `timezone` *string* 타임존 (예: `UTC`, `Asia/Seoul`). 사용자가 시간대를 따로 요청할 때만 전달 — 생략하면 사용자 브라우저 시간대
- `limit` *integer* 반환할 최대 행 수. 기본값: `500`

> 참고: 안전을 위해 `UPDATE`, `DELETE`, `DROP` 구문은 차단됩니다. SQL 실행 실패 시 파싱된 에러 메시지를 반환합니다.
>
> 쿼리는 API 토큰의 계정으로 실행되며, 권한 없는 테이블은 Machbase가 거부합니다. `FROM`/`JOIN` 뒤에 접두 없는 이름이 있으면 실행 직전에 소유자를 채워 넣습니다(예: `FROM EXAMPLE` → `FROM MACHBASEDB.SYS.EXAMPLE`).
>
> 결과의 시각은 읽기형(`Default`)으로, 사용자 시간대 기준으로 표시합니다. 순수 기간 조회(`MIN(TIME)`, `MAX(TIME)`)를 `timeformat="ms"`로 하면 숫자 옆에 사용자 시간대 시각을 함께 적습니다.
>
> ROLLUP 쿼리가 실패하면(ROLLUP이 없는 테이블의 `ERR-2264`, ROLLUP이 계산하지 못하는 집계의 `ERR-2816`) 같은 단위의 `DATE_TRUNC` 식을 안내합니다.
>
> 로컬 모델(Ollama)은 한 질문에서 이 도구를 8번까지 실행합니다.

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

TQL 스크립트를 실행하는 **내부 전용** 도구입니다. 모델에게는 노출되지 않으며, 모델이 이름으로 호출해도 실행되지 않습니다. `compile_tql_from_spec`이 컴파일한 TQL을 실행 검증할 때 내부에서 사용합니다.

- 사용자가 채팅에 붙여 넣은 TQL은 실행하지 않습니다. Neo 웹 콘솔의 TQL 편집기에서 실행합니다.
- 붙여 넣은 SQL은 `execute_sql_query`로 실행합니다.

## save_tql_file()

*Syntax*: `save_tql_file( filename, tql_content )`

TQL 파일을 저장하는 **내부 전용** 도구입니다. 모델에게는 노출되지 않으며, 모델이 이름으로 호출해도 실행되지 않습니다. `compile_tql_from_spec`과 `forecast_table`이 파일을 저장할 때 내부에서 사용합니다.

저장 전 수행되는 검증:

1. TQL 스크립트를 실행하여 정확성을 검증합니다(검증 실패 시 저장하지 않음).
2. 조회 결과가 0행이면 시간 범위를 테이블 실제 MIN/MAX(TIME) 경계에 맞춰 자동 조정한 뒤 재시도합니다.
3. 필요시 상위 폴더를 자동 생성합니다.

## compile_tql_from_spec()

*Syntax*: `compile_tql_from_spec( spec [, filename] )`

raw TQL을 직접 작성하는 대신, 분석 의도(IR JSON)로부터 실행 검증된 TQL을 컴파일합니다. 도구가 DB에서 실제 컬럼명과 ROLLUP 가용성을 자동 주입하고, 태그명을 검증하며, 시간 범위를 실제 데이터 경계로 보정해 반드시 실행되는 TQL을 반환합니다. 모델이 TQL을 만들고 저장하는 방법은 이 도구뿐입니다. IR로 표현할 수 없는 특수 차트(히트맵, FFT, 3D 등)는 지원하지 않습니다.

- `spec` *object* 필수, 분석 의도. 주요 필드:
  - `kind` — `metrics`(단일 태그, 1개 이상 집계), `tags`(여러 태그 비교), `ohlc`(캔들차트 / 시세), `geomap`(좌표 / 지도)
  - `table`, `tag` / `tags`, `timeRange: { start, end }`
  - `rollup` — 버킷 단위(`sec`, `min`, `hour`, `day`, `week`, `month`) 또는 raw면 `null`
  - `rollupN` *선택* — 버킷 배수. 예: 5분 평균은 `rollup: "min"`, `rollupN: 5`. `"5min"`, `"10s"`처럼 써도 자동으로 나눕니다
  - `metrics` — `kind=metrics`용, 예: `[{ "agg": "avg", "label": "..." }]` (agg: avg / max / min / sum / count / sumsq / raw)
  - `output` *선택* — `{ chartType: "line" | "bar", title, subtitle }`
- `filename` *string* 선택, 저장 경로 `"TABLE/name.tql"`(영어만). 주면 대시보드용으로 저장(`charts`의 `tql_path`로 참조), 생략하면 검증된 TQL 텍스트를 답변으로 반환합니다.

### 기간과 버킷 단위

사용자 질문에 기간과 단위가 있는지에 따라 차트의 기간과 버킷 단위가 정해집니다. 기간이 단위보다 우선합니다.

| 질문 | 예 | 결과 |
| :--- | :--- | :--- |
| 단위만 있음 | "BITCOIN 1분 평균" | 단위를 지키고, 데이터 마지막 시각부터 단위에 맞는 길이만큼 기간을 자릅니다 |
| 기간과 단위 | "최근 6개월 1분 평균" | 기간을 지키고, 단위가 기간에 비해 너무 잘면 올립니다 |
| 기간만 있음 | "최근 1주 추이" | 기간에 맞춰 단위를 자동으로 정합니다 |
| 둘 다 없음 | "BITCOIN 추이" | 전체 기간, 단위 자동 |

- 질문의 단위는 "1분 평균", "5분 단위", "10초 간격", "1시간마다", "5분봉", "시간별", "일별"처럼 숫자와 버킷 표현이 함께 있을 때 인정합니다.
- 단위별로 그릴 수 있는 기간: 초 1시간, 분 48시간, 시간 30일, 일·주 1년 미만. 배수를 쓰면 그 배수만큼 길어집니다(5분이면 240시간).
- 데이터 끝 기준으로 자르므로, 데이터 적재가 멈춘 테이블도 빈 차트가 되지 않습니다.
- 캔들(`ohlc`)은 질문에 기간과 단위가 함께 있을 때만 단위를 올립니다. 태그 비교(`tags`)는 단위만 있을 때 기간 자르기만 적용합니다.
- 배수: ROLLUP이 있는 테이블은 모든 단위에서 쓸 수 있습니다. ROLLUP이 없는 테이블과 캔들은 `DATE_TRUNC`를 쓰므로 하루 이내 배수만 됩니다(초 86400·분 1440·시간 24까지, 일·주·월은 1).
- 단위나 기간을 바꾸면 도구 결과에 `[주의] …` 안내가 붙고, 차트 제목에는 실제 적용된 단위가 들어갑니다. 로컬 모델(Ollama)의 답변에 바뀐 값이 빠지면 답변 끝에 `※ 적용 기준:` 한 줄이 붙습니다.
- 차트의 시간축은 사용자(브라우저) 시간대로 그립니다.

### 질문의 기간

질문에 기간이 있으면 모델이 넣은 값 대신 질문에서 읽은 기간을 씁니다. 기준은 서버 현지 시간이고, 주는 월요일에 시작합니다.

| 종류 | 표현 예 | 해석 |
| :--- | :--- | :--- |
| 지금 기준 길이 | "최근 6개월", "지난 3일", "last 2 weeks" | 지금부터 그 길이만큼 거슬러 올라감 |
| 날짜·달력 | "오늘", "어제", "그제", "3일 전" | 그날 하루 (오늘은 지금까지) |
| 날짜·달력 | "이번 주", "지난주", "이번 달", "지난달" | 그 주(월~일)·그 달 (이번 주·이번 달은 지금까지) |
| 날짜·달력 | "올해", "작년", "재작년", "2025년" | 그해 1년 (올해는 지금까지) |
| 날짜·달력 | "2025년 3월", "2025-03", "작년 3월", "3월" | 그 달. 연도가 없으면 올해, 아직 안 온 달이면 작년 |
| 날짜·달력 | "2025년 3월 5일", "3월 5일", "2025-03-05" | 그날 하루 |
| 날짜·달력 | "3월부터 5월까지", "어제~오늘", "2025-01-01 ~ 2025-03-01" | 앞 표현의 시작부터 뒤 표현의 끝까지. "3월부터"처럼 끝이 없으면 지금까지 |
| 영어 | "yesterday", "last week", "this month", "March 2025", "in 2025" | 위와 같은 규칙 |

그 기간에 데이터가 없을 때는 종류에 따라 다르게 처리합니다.

- 지금 기준 길이: 데이터 마지막 시각으로 같은 길이만큼 옮기고 `[주의] …` 안내를 붙입니다. 데이터 적재가 멈춘 테이블에서도 차트를 보여 주기 위해서입니다.
- 날짜·달력: 기간을 옮기지 않습니다. 테이블에 그 기간 데이터가 전혀 없으면 차트를 만들지 않고 "기간에 데이터 없음"과 테이블의 데이터 기간을 알려 줍니다. 저장할 때 해당 차트의 데이터가 0건이어도 저장하지 않고 같은 안내를 돌려줍니다.

같은 해석이 분석·리포트 요청의 기간 안내에도 쓰입니다. 예를 들어 "2025년 BITCOIN 리포트"는 2025년 기간으로 리포트를 만듭니다.

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
Dashboard created: sys/GOLD/Gold_Analysis_20260910_143022.dsh (3 charts)
```

## add_chart_to_dashboard()

*Syntax*: `add_chart_to_dashboard( filename, chart_title, chart_type [, table, tag, column, tql_path] )`

> 일반 흐름에서만 쓸 수 있습니다.

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

> 현재 어느 질문 흐름에도 열려 있지 않아 모델이 쓰지 않습니다. 삭제는 Neo 웹 콘솔에서 합니다.

대시보드에서 차트 패널을 제거합니다. 패널 UUID 또는 제목으로 지정합니다.

- `filename` *string* 필수, 대시보드 파일명
- `panel_id` *string* 제거할 패널 UUID
- `panel_title` *string* 제거할 패널 제목

## update_chart_in_dashboard()

*Syntax*: `update_chart_in_dashboard( filename [, panel_id, panel_title, new_title] )`

> 일반 흐름에서만 쓸 수 있습니다.

대시보드의 기존 차트 패널 제목을 수정합니다. 대상 패널은 UUID 또는 제목으로 지정합니다.

- `filename` *string* 필수, 대시보드 파일명
- `panel_id` *string* 패널 UUID
- `panel_title` *string* 패널 제목 (첫 번째 매칭)
- `new_title` *string* 새 패널 제목

## get_dashboard()

*Syntax*: `get_dashboard( filename )`

> 일반 흐름에서만 쓸 수 있습니다.

대시보드의 전체 설정을 JSON으로 조회합니다.

- `filename` *string* 필수, 대시보드 파일명

## delete_dashboard()

*Syntax*: `delete_dashboard( filename )`

> 현재 어느 질문 흐름에도 열려 있지 않아 모델이 쓰지 않습니다. 삭제는 Neo 웹 콘솔에서 합니다.

Machbase Neo에서 대시보드 파일을 삭제합니다.

- `filename` *string* 필수, 삭제할 대시보드 파일명

## update_dashboard_time_range()

*Syntax*: `update_dashboard_time_range( filename [, time_start, time_end, refresh] )`

> 일반 흐름에서만 쓸 수 있습니다.

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

*Syntax*: `save_html_report( table [, template_id, tag_name, analysis, recommendations, rollup_unit, time_start, time_end, timezone, tag_count, data_count, time_range] )`

차트와 심층 분석이 포함된 HTML 분석 리포트를 생성합니다. 도구 내부에서 데이터 조회, FFT/통계 계산, 차트 생성, HTML 파일 생성을 모두 수행합니다.

금융(`R-1`)·진동(`R-2`)·운전(`R-3`) 템플릿의 추이 집계는 테이블에 ROLLUP이 있으면 `ROLLUP`, 없으면 같은 단위의 `DATE_TRUNC`로 계산합니다. 리포트의 시각(기간, 통계, 차트 라벨, 생성 시각)은 사용자 시간대로 표시합니다.

- `table` *string* 필수, 테이블명 (예: `GOLD`)
- `template_id` *string* 리포트 템플릿 ID. 생략 시 데이터를 보고 빌트인 템플릿을 자동 판별
- `tag_name` *string* 분석 대상 태그명 또는 종목명. 사용자가 특정 대상을 언급하면 반드시 전달 — 생략하면 테이블 전체(수천 태그)를 조회해 느려지거나 컨텍스트를 초과할 수 있음
- `analysis` *string* 심층 분석 텍스트(마크다운). 1차 호출 시 비워두고, 2차 호출 시 작성
- `recommendations` *string* 종합 소견 및 권고(마크다운). 1차 호출 시 비워둠
- `rollup_unit` *string* `sec`, `min`, `hour`, `day`, `week`, `month` 중 하나
- `time_start` *string* 분석 시작(epoch ms). 사용자가 기간을 명시할 때만 전달
- `time_end` *string* 분석 끝(epoch ms), `time_start`와 함께 전달
- `timezone` *string* 시각 표시 시간대(IANA 이름, 예: `UTC`). 사용자가 시간대를 따로 요청할 때만 전달 — 생략하면 사용자 브라우저 시간대
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
Report saved: sys/GOLD/GOLD_financial_report.html
```

## 타이머 요청

타이머(스케줄러)의 등록·시작·중지·삭제·목록 조회는 LLM Chat에서 지원하지 않습니다.

타이머 관련 질문은 매뉴얼 검색으로 답합니다. 다음 질문이 대상입니다.

- "타이머", "timer", "cron", "스케줄러", "scheduler"가 들어간 질문
- "스케줄"이 들어가고 만들기·추가·등록·시작·중지·삭제·목록 같은 동작을 요청하는 질문

답변은 Neo 매뉴얼을 근거로 다음을 안내합니다.

- 웹 콘솔 Timer 메뉴에서 타이머를 등록·시작·중지·삭제하는 방법
- 셸 명령: `timer add <name> <timer_spec> <tql-path>;`, `timer list;`, `timer start|stop <name>;`, `timer del <name>;`
- 스케줄 표현식(`@every 10s`, cron 형식 등)과 타이머용 TQL 템플릿

질문 예: "10초마다 센서 데이터를 수집하는 타이머 만들어줘", "타이머 목록 보여줘", "SENSOR_DATA 타이머 꺼줘"

> 답변에 나오는 TQL은 매뉴얼 템플릿을 참고한 예시이며 실행 검증을 거치지 않았습니다. 실제 테이블·태그 이름에 맞게 고친 뒤 Neo의 TQL 편집기에서 확인하고 타이머에 등록하세요.

## create_folder()

*Syntax*: `create_folder( folder_name )`

Machbase Neo 파일 시스템에 폴더를 생성합니다.

- `folder_name` *string* 필수, 생성할 폴더 경로. 계정 폴더 아래에 만들어지며 상위 폴더도 함께 생성됩니다

## list_files()

*Syntax*: `list_files( [path] )`

Machbase Neo 파일 시스템의 파일과 폴더 목록을 조회합니다.

- `path` *string* 디렉토리 경로. 기본값: `/`. 계정 폴더를 먼저 찾고, 없으면 준 경로를 그대로 조회합니다

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

> 현재 어느 질문 흐름에도 열려 있지 않아 모델이 쓰지 않습니다. 삭제는 Neo 웹 콘솔에서 합니다.

Machbase Neo 파일 시스템에서 파일 또는 빈 폴더를 삭제합니다.

- `filename` *string* 필수, 삭제할 파일 경로. 계정 폴더를 먼저 찾고, 없으면 준 경로에서 삭제합니다

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
  "tools_count": 27,
  "tools": ["list_tables", "list_table_tags", "describe_table", "..."],
  "runtime": "JSH",
  "machbase": "connected"
}
```

## 문서 이동

- [이전: Chat 사용 방법]({{< relref "chat-usage" >}})
- [목차로 돌아가기]({{< relref "/" >}})
- [다음: HTTP API와 WebSocket]({{< relref "http-api-and-websocket" >}})
