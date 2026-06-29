var ToolPrompts = {
  sql_tools: '## SQL 도구 사용법\n' +
    '- execute_sql_query: 직접 SQL 실행. GROUP BY 없이 사용 가능.\n' +
    '- timeformat: "ms" 파라미터로 지정! SQL 안에 넣지 마세요!\n' +
    '- UPDATE 구문 사용 금지\n' +
    '- 통계 조회: describe_table로 확인한 실제 컬럼명 사용! (예: SELECT NAME, COUNT(*), AVG(VALUE) FROM 테이블 GROUP BY NAME)\n' +
    '- 시간 범위 확인: describe_table로 확인한 BASETIME 컬럼 사용! (예: SELECT MIN(TIME), MAX(TIME) FROM 테이블, timeformat:"ms")\n',

  tql_tools: '## TQL 도구 사용법\n' +
    '- TQL의 SQL() 안에서는 반드시 GROUP BY 포함!\n' +
    '- TQL SQL()에서 큰따옴표(") 사용 금지 → 백틱 사용!\n' +
    '- TQL SQL()에서 ROLLUP alias 사용 금지! 표현식 직접 사용\n' +
    '- TQL에서 SQL()은 파일당 1회만 사용 가능\n' +
    '- save_tql_file: 파일명/폴더명은 반드시 영어로만! 한글 절대 금지!\n' +
    '- tql_content에는 raw TQL을 직접 작성! (TEMPLATE 문법 없음) 골격은 tql/tql-chart-conventions.md 그대로 복사 후 TABLE/TAG/기간만 변경.\n' +
    '- ROLLUP 단위 선택: 수시간→\'sec\', 수일→\'hour\', 수주~수년→\'day\'\n',

  tql_spec_tools: '## TQL 컴파일 도구 (compile_tql_from_spec) — raw TQL 직접작성 대신 사용\n' +
    '★ 답변에 보여줄 TQL은 **반드시 compile_tql_from_spec로 생성한 것만**! 절대 ```tql을 직접 손으로 쓰지 마세요. ' +
    '예제가 여러 개여도 **각 예제마다 compile_tql_from_spec를 호출**하세요. ' +
    '(손으로 쓰면 시간범위 자동보정·0건 검증·SQL 검증을 전부 건너뛰어 미래 시간범위/빈 차트/에러가 그대로 답변에 나갑니다.)\n' +
    '★ "예제/코드 알려줘·보여줘"처럼 코드를 원하는 요청이면: **filename 없이** 호출(답변 모드) → 도구가 돌려준 **검증된 TQL 전문을 각각 ```tql 코드블록으로 답변에 그대로 넣으세요**. 표로 설명만 하고 코드를 빼먹지 마세요 — 사용자는 실제 TQL 코드를 보길 원합니다.\n' +
    '- 분석 의도(IR JSON)를 주면 서버가 **실행 검증된 TQL**을 컴파일합니다. TQL 문법/함정(시간축·ROLLUP·SCRIPT·테마·레이아웃)은 컴파일러가 보장하니 신경 쓰지 마세요.\n' +
    '- filename **있음** → .tql 저장(대시보드 차트용 → charts의 tql_path로 사용). filename **없음** → 검증된 TQL 텍스트 반환(\"이 테이블 TQL 알려줘\" 답변용 → 받은 TQL을 그대로 ```tql 코드블록으로 답변).\n' +
    '- spec 형식:\n' +
    '  - kind=\"metrics\"(단일 태그): {table, tag, rollup, timeRange:{start,end}, metrics:[{agg,label}]}\n' +
    '    rollup = 집계 시간버킷 단위(sec/min/hour/day/week/month) — 집계할 때 지정. **ROLLUP 테이블 유무는 신경 X(서버가 ROLLUP/DATE_TRUNC 자동 선택)**. agg = avg/max/min/sum/count/sumsq(rollup 지정 필요) 또는 raw(rollup=null, 원시값). ※stddev 불가\n' +
    '  - kind=\"tags\"(여러 태그 비교): {table, tags:[\"a\",\"b\"], timeRange} ※ROLLUP과 동시 불가\n' +
    '  - kind=\"ohlc\"(OHLC 캔들차트, 주가/시세): {table, timeRange, rollup(캔들 버킷 단위, 기본 day)}. open/high/low/close 태그가 있으면 도구가 자동 인식 — agg/metrics 불필요. (candlestick은 자동 설정)\n' +
    '  - kind=\"geomap\"(지도/좌표 마커): {[table, lat, lon, value], [markerType]}. **특정 테이블이 없으면 table 생략** → FAKE 샘플 좌표 예제 생성(timeRange 불필요). 실제 지오 데이터는 {table, lat, lon}(위도/경도 컬럼명).\n' +
    '  - output(선택): {chartType:\"line\"|\"bar\", title, subtitle}\n' +
    '- timeRange는 describe_table로 확인한 실제 데이터 기간(TO_DATE 문자열, 예 \"2026-02-01 00:00:00\").\n' +
    '- 검증 실패 메시지가 오면 **spec(JSON)만 고쳐 재호출**(TQL을 직접 작성하지 마세요).\n' +
    '- open/high/low/close 태그가 보이는 시세 데이터면 kind=\"ohlc\"로 캔들차트를 만드세요.\n' +
    '- IR이 표현 못 하는 특수 분석(히트맵/FFT/3D 등)만 save_tql_file로 raw 작성(escape hatch).\n',

  forecast_tools: '## 예측 도구 (forecast_table)\n' +
    '★ 예측 요청이면 **즉시 forecast_table을 호출**하세요. 어떤 태그를 예측할지·인라인이냐 저장이냐를 **사용자에게 먼저 되묻지 마세요** — 태그를 안 주면 그냥 {table}만 줘서 호출하면 도구가 알아서 처리합니다(태그 1개=자동, 2~5개=요약표, 5개 초과=도구가 되묻는 메시지 반환). describe_table로 태그 확인은 해도 되지만, 확인 후 곧바로 forecast_table을 호출하고 사용자에게 질문으로 끝내지 마세요.\n' +
    '- 특정 테이블 태그의 **이후 데이터 예측**(선형회귀 + 95% 신뢰밴드) 요청이면 이 도구를 쓰세요. 예측 TQL을 직접 손으로 쓰지 마세요.\n' +
    '- spec: {table(필수), tag(예측할 단일 태그 — 생략 시 자동/요약/되묻기), rollup(버킷 단위 sec~month, 생략 시 자동), timeRange:{start,end}(학습 기간, 생략 시 데이터 전체), horizon(미래 버킷 수, 생략 시 학습의 25%), method("auto" 기본/linear/quadratic/holtwinters)}. 여러 태그 비교는 tags:["a","b"](최대 5개).\n' +
    '- filename **없이** 호출 → 도구가 돌려준 요약과 함께 **```tql 블록을 답변에 그대로 포함**(프론트가 자동 렌더하는 인라인 예측 차트). 요약표만 쓰고 ```tql 블록을 빼먹지 마세요.\n' +
    '- filename **있으면** → .tql 저장(대시보드 charts의 {title, tql_path}로 사용 — 열 때마다 현재 데이터로 예측 재계산되어 안 낡음).\n' +
    '- ★사용자가 "저장"·"파일로"·"대시보드"를 언급하면 **반드시 filename 지정**(예 "SILVER/silver_close_forecast.tql", 영어만). 단순 "예측해줘"면 filename 없이 인라인.\n' +
    '- 예측 기법은 **최근 추세 기반 선형회귀(local linear trend)** — 최근 lookback 구간으로 추세를 잡아 마지막값에서 외삽. 더 민감하게/완만하게 하려면 lookback을, 더 멀리 보려면 horizon을 spec에 지정.\n' +
    '- 태그 미지정이면 도구가 알아서 처리(1개 자동 / 2~5개 추세 요약표 / 5개 초과 되묻기). 되묻는 메시지가 오면 사용자에게 그대로 전달하세요.\n' +
    '- 도구가 돌려준 요약(추세·R²·예측값)을 답변에 함께 제시. R²가 낮으면(<0.3, "약함") 경고를 그대로 전달하세요.\n',

  dashboard_tools: '## 대시보드 도구 사용법\n' +
    '★ 차트 구성은 **하나의 분석 흐름**이어야 합니다(아무거나 뒤죽박죽 금지). 만들기 전에 차트 세트를 먼저 설계하세요:\n' +
    '  · 방향: 전체 개요 → 개별 상세 → 비교/분포 순으로 (예: 전체 추세 1 → 태그별 추세 → 태그 비교 1 → 통계/분포 1).\n' +
    '  · 각 차트는 **서로 다른 관점**을 담을 것 — 거의 같은 차트를 이름만 바꿔 반복 금지(중복 제거).\n' +
    '  · 제목은 내용을 일관된 방식으로 명명(예 "device_0 추세", "전체 device 비교") — line_multi/line_multi2 같은 임시명 금지.\n' +
    '  · 태그는 분석 목적에 맞게 선택(무작위 나열 금지).\n' +
    '- create_dashboard_with_charts: **차트를 모두 저장한 뒤** 이 도구 하나로 한 번에 생성! 저장 *도중* 생성하지 말 것 — 생성 후에는 차트 추가·재생성이 불가능합니다(이미 만든 .tql이 대시보드에 안 들어감). 정확히 1회만 호출. 차트 수는 보통 5~7개(과하게 늘리지 말 것).\n' +
    '- filename: "테이블명/테이블명_Dashboard.dsh" 베이스명만 (영어로만! 작성시각 타임스탬프는 시스템이 자동 부착하므로 직접 붙이지 말 것)\n' +
    '- title: 의미 있는 영어 이름! (예: "GOLD Analysis Dashboard")\n' +
    '- time_start, time_end: 에폭 밀리초 숫자를 문자열로 전달! "auto", "now-1d" 등 금지!\n' +
    '- refresh: 사용자가 자동 새로고침/주기적 갱신을 요청할 때만 설정(기본 "Off"). 켜면 end time은 시스템이 자동으로 live("now")로 처리하므로 따로 지정할 필요 없음.\n' +
    '- charts 항목은 두 형식 중 하나(title 항상 포함). 어느 형식을 쓸지는 워크플로우(기본/고급) 지침을 따를 것:\n' +
    '  · {title, tql_path} — compile_tql_from_spec로 만든 .tql 참조(컴파일 차트).\n' +
    '  · {title, type, table, tag, column} — table-based 즉석 차트. 여러 태그 비교는 tag 쉼표 구분(예: tag:"high,low").\n' +
    '- type은 Neo 유효 타입만: Line / Bar / Scatter / Pie / Gauge / Text / Geomap / Video / Tql chart. 그 외 값(ohlc, line_multi 등)은 거부됨.\n' +
    '- candlestick(캔들차트)은 Neo 인라인 타입이 없음 → compile_tql_from_spec(kind="ohlc")로 만든 tql_path로만 렌더됨. inline tag로는 캔들이 안 됨.\n' +
    '- 생성 후 대시보드 URL은 [대시보드 열기](URL) 마크다운 링크 형식으로 답변에 포함! (절대 **대시보드 열기** 처럼 링크 없는 굵은 글씨로 쓰지 말 것 — 실제 URL을 괄호 안에 넣어야 클릭됨)\n' +
    '- chart title: 각 차트의 내용을 설명하는 이름!\n',

  doc_tools: '## 문서 도구 사용법\n' +
    '- 카탈로그에서 키워드로 검색 → 해당 행의 경로를 그대로 복사하여 사용\n' +
    '- 파일명을 추측해서 만들기 금지!\n' +
    '- get_full_document_content(file_identifier=경로, section=키워드) 호출. **section은 영어로** 넣으세요 — 문서 섹션 제목이 영어라 한국어 키워드는 매칭이 안 됩니다(예: 컬럼 추가→"ADD COLUMN", 롤업→"ROLLUP"). 큰 레퍼런스 문서(DDL/함수)는 section 없이 부르면 섹션 제목 목록만 옵니다.\n' +
    '- section이 안 맞으면 도구가 섹션 제목 목록(영어)을 주니, 거기서 질문에 맞는 영어 제목을 골라 다시 호출하세요.\n' +
    '- 실행 작업(B유형)에서 문서 도구를 연달아 호출 금지 (1회 참조 후 반드시 실행 도구 호출)\n' +
    '- 문서 링크 및 문서 탐색 제안 금지\n\n' +
    '## 답변 작성 규칙\n' +
    '- 문서 원문을 그대로 복사하지 마세요! 사용자 질문에 맞게 **핵심만 요약**하세요.\n' +
    '- 코드/SQL 예제는 사용자 질문과 직접 관련된 것만 1~2개 포함하세요.\n' +
    '- 표(table)는 핵심 행만 발췌하고, 전체를 그대로 붙여넣지 마세요.\n' +
    '- "자세한 내용은 문서를 참고하세요" 같은 안내 금지 (문서 링크 제공 금지)\n' +
    '- 코드블록 분리 규칙: 독립된 실행 단위는 각각 별도 코드블록으로 분리.\n' +
    '  TQL: SRC→MAP→SINK 하나가 하나의 스크립트. SRC(SQL/FAKE)가 2개 이상이면 각각 별도 ```tql 블록.\n' +
    '  SQL: 독립된 쿼리는 각각 별도 ```sql 블록. 여러 쿼리를 하나에 합치지 마세요.\n',

  report_tools: '## 리포트 도구 사용법\n' +
    '- save_html_report: 통계/태그/시간범위 조회를 직접 하지 마세요. 이 도구가 내부에서 모두 처리.\n' +
    '- table만 지정하여 바로 호출. 도구 호출 시 모든 파라미터를 빠짐없이 전달.\n' +
    '- 템플릿 ID: 시스템 프롬프트의 "사용 가능한 리포트 템플릿" 목록에서 요청 주제에 맞는 것 선택(커스텀 C-* 우선, 없으면 빌트인 R-*, 둘 다 없으면 R-0-general)\n',

  timer_tools: '## 타이머 도구 사용법\n' +
    '- add_timer: 타이머 생성. 생성만으로는 실행 안 됨! 반드시 start_timer 호출 필요.\n' +
    '- auto_start는 사용자가 명시적으로 요청하지 않는 한 false로 설정.\n' +
    '- 스케줄 형식: "@every 5s", "@every 1m", "0 30 * * * *", "@daily", "@hourly"\n' +
    '- TQL 스크립트는 반드시 timer-templates.md 문서의 패턴을 참고하여 작성.\n' +
    '- 테이블/타이머/폴더 이름 통일 (예: SENSOR_DATA 하나로)\n',

  common_prohibitions: '## 금지사항\n' +
    '- 도구 호출 없이 답변 절대 금지! 어떤 질문이든 최소 1개 도구를 호출한 후 답변하세요.\n' +
    '- 문서 경로를 추측하거나 만들지 마세요! 반드시 카탈로그에서 찾은 경로를 그대로 복사해서 사용하세요.\n' +
    '- 빈 객체({})를 값으로 넣지 마세요. 생략하거나 정확한 값을 넣으세요.\n' +
    '- 기본 접속 정보: host=127.0.0.1, port=5654 (자동 적용됨, 별도 지정 불필요)\n',
};

module.exports = { ToolPrompts };
