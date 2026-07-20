// compileTIR — TIR(의도 JSON) → 보장된 TQL.
//
// 이 파일이 TQL 문법/함정 "지식"을 소유한다.
// 모든 TQL 함정이 여기 코드로 한 번씩만 박혀 있어, 출력은 항상 검증된 패턴을 따른다:
//   - SRC→MAP→SINK 순서 (SQL → SCRIPT → 싱크)
//   - 시간축 [timestamp, value] 페어 → column(0) (TIME 객체 직접 산술 안 함)
//   - ROLLUP: 표현식을 GROUP BY/ORDER BY에 직접(alias 금지), STDDEV 안 씀, 단위 sec~month
//   - ROLLUP 쿼리에 NAME 컬럼 안 넣음(MACH-ERR 2264) — 여러 태그는 raw 비교
//   - SCRIPT 3-block 누적, $.foreach/$.yield(time,name,value) 안 씀
//   - chart 싱크: white 테마 상속, 제목/부제 좌상단, yAxis.name 없음, 겹침 방지 레이아웃, tz
//
// 구조(컴파일러 프론트엔드/백엔드 분리):
//   buildSource(spec)  → SQL          ← 싱크 무관, 공유
//   SINKS[sink]        → script+sink  ← 플러그형 백엔드 (현재 chart만, 차후 csv/insert/json 추가)

var validate = require('./schema').validate;
var algoSource = require('../forecast_algo').algoSource; // forecast 예측 엔진 소스(SCRIPT에 구워넣음 → 워커와 동일 로직, 라이브 재계산)

// --- 레이아웃 상수 (conventions.md 6차/8차/9차 확정값) ---
var LAYOUT = {
  gridLeft: 72, gridLeftWide: 90, gridRight: 30, gridTop: 66, gridBottom: 78,
  legendBottom: 30, zoomBottom: 6, zoomHeight: 16,
};

function up(s) { return String(s).toUpperCase(); }
function q(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }  // SQL 작은따옴표 + 이스케이프(O'Brien→'O''Brien')

// 실제 컬럼명 — 도구(tql_spec.js)가 describe로 탐지해 주입. 미지정 시 표준 NAME/TIME/VALUE.
// (모델은 컬럼명을 몰라도 됨 — 커스텀 컬럼 테이블도 자동 대응)
function colset(spec) {
  return { n: spec.nameCol || 'NAME', t: spec.timeCol || 'TIME', v: spec.valueCol || 'VALUE' };
}

// timeRange 값 → TO_DATE 리터럴 정규화. 모델이 epoch ms 숫자 / 날짜 문자열 / 이미 TO_DATE(...) 무엇을 줘도 안전.
function fmtDate(d) { function p(n) { return (n < 10 ? '0' : '') + n; } return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
function toDateLiteral(v) {
  var s = (v == null ? '' : String(v)).trim();
  var m = s.match(/^TO_DATE\s*\(\s*'?([^')]+)'?\s*\)$/i); // 이미 TO_DATE(...) → 내부만 추출(이중 래핑 방지)
  if (m) s = m[1].trim();
  if (/^\d{10,19}$/.test(s)) { // epoch 숫자(초/ms/us/ns) → 날짜 문자열. 앞 13자리=ms로 정밀도 보존(JS 안전정수 초과 회피)
    var ms = (s.length <= 11) ? parseInt(s, 10) * 1000 : (s.length <= 13) ? parseInt(s, 10) : parseInt(s.substring(0, 13), 10);
    s = fmtDate(new Date(ms));
  }
  return "TO_DATE('" + s + "')";
}

// ── 적응형 해상도: 범위에 맞춰 버킷 단위를 조정해 점(point) 폭주 방지 ──
function toMs(v) {
  var s = (v == null ? '' : String(v)).trim();
  var m = s.match(/^TO_DATE\s*\(\s*'?([^')]+)'?\s*\)$/i); if (m) s = m[1].trim();
  if (/^\d{10,19}$/.test(s)) return (s.length <= 11) ? parseInt(s, 10) * 1000 : (s.length <= 13) ? parseInt(s, 10) : parseInt(s.substring(0, 13), 10);
  var t = new Date(s).getTime(); return isNaN(t) ? 0 : t;
}
function rangeMs(spec) {
  var a = toMs(spec.timeRange && spec.timeRange.start), b = toMs(spec.timeRange && spec.timeRange.end);
  return (a && b && b > a) ? (b - a) : 0;
}
// 범위 길이 → 시간버킷 단위 (report.js pickRollupUnit 이식; 점 수를 ~수백~수천으로 유지). 모르면 null(미적용).
function pickUnit(ms) {
  if (!ms || ms <= 0) return null;
  var h = ms / 1000 / 3600;
  if (h < 1) return 'sec'; if (h < 48) return 'min'; if (h < 720) return 'hour'; if (h < 8760) return 'day'; return 'month';
}
var UNIT_ORDER = { sec: 0, min: 1, hour: 2, day: 3, week: 4, month: 5 };
function coarser(a, b) { return (UNIT_ORDER[a] || 0) >= (UNIT_ORDER[b] || 0) ? a : b; }
// 모델이 고른 단위를 "범위가 허용하는 것보다 잘게는 못 가게" 클램프(점 폭주 방지). 더 거친 단위는 의도 존중.
function effectiveUnit(spec) {
  var pu = pickUnit(rangeMs(spec));
  return pu ? coarser(spec.rollup, pu) : spec.rollup;
}

// 시간버킷 집계 표현식: ROLLUP 있으면 ROLLUP(빠름), 없으면 DATE_TRUNC(범용 — 동일 단위명). timeCol은 실제 BASETIME 컬럼.
// unit은 effectiveUnit으로 클램프된 단위. 표현식 직접 GROUP BY/ORDER BY(alias 금지).
function aggTimeExpr(spec, unit) {
  var t = colset(spec).t;
  if (spec.rollupAvailable === false) return "DATE_TRUNC('" + unit + "', " + t + ")";
  return "ROLLUP('" + unit + "', 1, " + t + ")";
}

// ════════════════════════════════════════════════════
// SOURCE 빌더 (싱크 무관, 공유) — 백틱으로 감쌈, 큰따옴표 금지
// ════════════════════════════════════════════════════

function sqlMetricsRollup(spec) {
  var c = colset(spec);
  var cols = [];
  for (var i = 0; i < spec.metrics.length; i++) cols.push(up(spec.metrics[i].agg) + '(' + c.v + ')');
  var rx = aggTimeExpr(spec, effectiveUnit(spec)); // 범위에 맞게 클램프된 단위로 ROLLUP/DATE_TRUNC
  // 집계 쿼리: SELECT엔 시간버킷 표현식 + 집계만 (태그컬럼 금지). 단일 태그는 WHERE로만 필터.
  return 'SELECT ' + rx + ', ' + cols.join(', ') +
    ' FROM ' + up(spec.table) +
    ' WHERE ' + c.n + ' = ' + q(spec.tag) +
    ' AND ' + c.t + ' BETWEEN ' + toDateLiteral(spec.timeRange.start) + ' AND ' + toDateLiteral(spec.timeRange.end) +
    ' GROUP BY ' + rx + ' ORDER BY ' + rx;
}

function sqlMetricsRaw(spec) {
  var c = colset(spec);
  var whereC = ' WHERE ' + c.n + ' = ' + q(spec.tag) +
    ' AND ' + c.t + ' BETWEEN ' + toDateLiteral(spec.timeRange.start) + ' AND ' + toDateLiteral(spec.timeRange.end);
  if (spec.bucket) { // 점 많음(>임계, 도구가 COUNT로 판정) → DATE_TRUNC 버킷 평균
    var bx = "DATE_TRUNC('" + (pickUnit(rangeMs(spec)) || 'hour') + "', " + c.t + ")";
    return 'SELECT ' + bx + ', AVG(' + c.v + ') FROM ' + up(spec.table) + whereC + ' GROUP BY ' + bx + ' ORDER BY ' + bx;
  }
  // raw(GROUP BY 불필요) + lttb 렌더
  return 'SELECT ' + c.t + ', ' + c.v + ' FROM ' + up(spec.table) + whereC + ' ORDER BY ' + c.t;
}

// ── OHLC(캔들) ──
// FIRST(t,v)/LAST(t,v)/MIN/MAX 지원. ROLLUP은 NAME과 불가(2264)이고 FIRST/LAST는
// ROLLUP 집계도 아니므로 **항상 DATE_TRUNC + GROUP BY NAME**. 버킷 라벨은 TO_CHAR로 SQL이 문자열 생성(category 축 →
// 시간축 나노초 오버플로우 함정 회피). 단위별 포맷 토큰은 버킷이 유일하게 식별되도록.
var OHLC_FMT = { sec: 'YYYY-MM-DD HH24:MI:SS', min: 'YYYY-MM-DD HH24:MI', hour: 'YYYY-MM-DD HH24', day: 'YYYY-MM-DD', week: 'YYYY-MM-DD', month: 'YYYY-MM' };
function ohlcUnit(spec) { return spec.rollup || 'day'; } // 캔들 기본 일봉(점 폭주 우려 적음 — clamp 안 함)
function sqlOHLC(spec) {
  var c = colset(spec), o = spec.ohlc, unit = ohlcUnit(spec);
  var inList = [q(o.open), q(o.high), q(o.low), q(o.close)];
  // 버킷 라벨 = TO_CHAR(DATE_TRUNC(unit, t), fmt). SELECT/GROUP BY/ORDER BY 동일 표현식(2044 회피).
  var bx = "TO_CHAR(DATE_TRUNC('" + unit + "', " + c.t + "), '" + (OHLC_FMT[unit] || OHLC_FMT.day) + "')";
  return 'SELECT ' + bx + ', ' + c.n +
    ', FIRST(' + c.t + ', ' + c.v + '), LAST(' + c.t + ', ' + c.v + '), MIN(' + c.v + '), MAX(' + c.v + ')' +
    ' FROM ' + up(spec.table) +
    ' WHERE ' + c.n + ' IN (' + inList.join(', ') + ')' +
    ' AND ' + c.t + ' BETWEEN ' + toDateLiteral(spec.timeRange.start) + ' AND ' + toDateLiteral(spec.timeRange.end) +
    ' GROUP BY ' + bx + ', ' + c.n + ' ORDER BY ' + bx + ', ' + c.n;
}

function sqlTags(spec) {
  var c = colset(spec);
  var inList = [];
  for (var i = 0; i < spec.tags.length; i++) inList.push(q(spec.tags[i]));
  var whereT = ' WHERE ' + c.n + ' IN (' + inList.join(', ') + ')' +
    ' AND ' + c.t + ' BETWEEN ' + toDateLiteral(spec.timeRange.start) + ' AND ' + toDateLiteral(spec.timeRange.end);
  if (spec.bucket) { // 점 많음(>임계) → DATE_TRUNC 버킷 집계(AVG). ROLLUP은 NAME과 불가(2264)지만 DATE_TRUNC는 됨(rollup 유무 무관).
    var bx = "DATE_TRUNC('" + (pickUnit(rangeMs(spec)) || 'hour') + "', " + c.t + ")";
    return 'SELECT ' + bx + ', ' + c.n + ', AVG(' + c.v + ') FROM ' + up(spec.table) + whereT +
      ' GROUP BY ' + bx + ', ' + c.n + ' ORDER BY ' + bx;
  }
  // 점 적음(≤임계) → raw 비교 (lttb가 렌더 처리). SELECT 순서 = time, name, value → SCRIPT $.values[0/1/2] 위치 기반.
  return 'SELECT ' + c.t + ', ' + c.n + ', ' + c.v + ' FROM ' + up(spec.table) + whereT + ' ORDER BY ' + c.t;
}

// ── forecast(예측) ── 단일 태그의 버킷 평균 이력. SCRIPT가 이 이력으로 회귀를 라이브 재계산하므로
// 차트를 열 때마다 현재 데이터로 예측이 갱신된다(스냅샷 아님). 버킷 단위는 범위에 맞춰 클램프.
// 예측용 버킷 단위 — **차트용 pickUnit보다 잘게** 잡는다.
//   차트는 점 폭주를 막으려 거칠게(2.4년 → month=30점) 잡지만, 예측은 **버킷이 많아야 모델이 배운다**
//   (30점으론 10개 모델을 학습·검증할 수 없어 MAPE가 30~47%로 뭉갬). 목표: 대략 100~1500 버킷.
//   사용자가 rollup을 명시하면 그대로 존중.
function forecastUnit(spec) {
  if (spec.rollup) return spec.rollup;
  var ms = rangeMs(spec);
  if (!ms) return 'day';
  var h = ms / 1000 / 3600;
  if (h < 0.5) return 'sec';           // ~30분 미만 (BEARING 3.4분 실측 데이터 → min이면 4버킷뿐, sec이면 206버킷)
  if (h < 48) return 'min';            // ~2일 미만
  if (h < 24 * 60) return 'hour';      // ~2개월 미만
  if (h < 24 * 365 * 3) return 'day';  // ~3년 미만 (SILVER 2.4년 → 725버킷)
  return 'week';                       // 그 이상
}
function sqlForecast(spec) {
  var c = colset(spec);
  var rx = aggTimeExpr(spec, forecastUnit(spec)); // ROLLUP 있으면 ROLLUP, 없으면 DATE_TRUNC
  return 'SELECT ' + rx + ', AVG(' + c.v + ')' +
    ' FROM ' + up(spec.table) +
    ' WHERE ' + c.n + ' = ' + q(spec.tag) +
    ' AND ' + c.t + ' BETWEEN ' + toDateLiteral(spec.timeRange.start) + ' AND ' + toDateLiteral(spec.timeRange.end) +
    ' GROUP BY ' + rx + ' ORDER BY ' + rx;
}

// ── geomap(지도/좌표) ── 좌표 기반 GEOMAP() 싱크. table 없으면 FAKE 샘플 좌표(데이터 의존 없음, 항상 실행).
function fakeGeomapSource() {
  return 'FAKE(json({\n' +
    '    [37.5665, 126.9780],\n' +
    '    [35.1796, 129.0756],\n' +
    '    [37.4563, 126.7052],\n' +
    '    [35.8714, 128.6014],\n' +
    '    [35.1595, 126.8526],\n' +
    '    [36.3504, 127.3845]\n' +
    '}))';
}
function sqlGeomap(spec) {
  var c = colset(spec);
  var cols = spec.lat + ', ' + spec.lon + (spec.value ? ', ' + spec.value : '');
  var sql = 'SELECT ' + cols + ' FROM ' + up(spec.table);
  if (spec.timeRange && spec.timeRange.start && spec.timeRange.end) {
    sql += ' WHERE ' + c.t + ' BETWEEN ' + toDateLiteral(spec.timeRange.start) + ' AND ' + toDateLiteral(spec.timeRange.end);
  }
  return sql;
}
function scriptGeomap(spec) {
  var mt = spec.markerType || 'circleMarker';
  // 입력 행 [lat, lon, (value)] → GEOMAP 레이어 객체. value 있으면 radius에 반영.
  return 'SCRIPT({\n' +
    '    var v = $.values;\n' +
    '    $.yield({ type: ' + JSON.stringify(mt) + ', coordinates: [v[0], v[1]], properties: { radius: (v.length > 2 ? Math.max(4, Number(v[2]) || 8) : 8), color: "#2b6cb0", fillColor: "#3182ce", fillOpacity: 0.6, weight: 1 } });\n' +
    '})';
}
function geomapBlock(spec) {
  return 'GEOMAP(\n    size(\'900px\', \'600px\')\n)';
}

function buildSource(spec) {
  if (spec.kind === 'geomap') return sqlGeomap(spec);
  if (spec.kind === 'forecast') return sqlForecast(spec);
  if (spec.kind === 'ohlc') return sqlOHLC(spec);
  if (spec.kind === 'tags') return sqlTags(spec);
  return (spec.rollup == null) ? sqlMetricsRaw(spec) : sqlMetricsRollup(spec);
}

// 다중태그 범례 라벨 단축: 공통 접두사(마지막 ':' 경계까지)를 제거해 겹침 방지.
// 데이터/SQL/SCRIPT는 전체 태그명 그대로(데이터 매칭 유지) — 오직 CHART series.name(범례)만 짧게.
// machbase:netstat:tcp_established / ...tcp_listen → tcp_established / tcp_listen
function shortLabels(tags) {
  if (!tags || tags.length <= 1) return (tags || []).slice();
  var first = String(tags[0]);
  var pre = first.length;
  for (var i = 1; i < tags.length; i++) {
    var t = String(tags[i]), j = 0;
    while (j < pre && j < t.length && first.charAt(j) === t.charAt(j)) j++;
    pre = j;
  }
  var cut = first.lastIndexOf(':', pre - 1);
  if (cut < 1) return tags.slice(); // 공통 ':' 접두사 없음 → 원본
  var strip = cut + 1, out = [];
  for (var k = 0; k < tags.length; k++) {
    var s = String(tags[k]).substring(strip);
    if (!s) return tags.slice(); // 빈 라벨 방지(한 태그가 다른 태그의 접두사)
    out.push(s);
  }
  return out;
}

// 시리즈 정보 (공유) — 시리즈 개수 + 이름(범례 라벨). tags는 공통접두사 제거로 단축.
function seriesInfo(spec) {
  if (spec.kind === 'geomap') return { names: ['geomap'], count: 1 };
  if (spec.kind === 'forecast') return { names: ['실측', '예측', '상한(95%)', '하한(95%)'], count: 4 };
  if (spec.kind === 'ohlc') return { names: ['OHLC'], count: 1 }; // candlestick 단일 시리즈
  if (spec.kind === 'tags') return { names: shortLabels(spec.tags), count: spec.tags.length };
  var names = [];
  for (var i = 0; i < spec.metrics.length; i++) names.push(spec.metrics[i].label || spec.metrics[i].agg);
  return { names: names, count: spec.metrics.length };
}

// ════════════════════════════════════════════════════
// SCRIPT 빌더 (한 시리즈=단일 라인, 여러 시리즈=3-block 누적)
// ════════════════════════════════════════════════════

// SQL 문자열 컬럼(NAME 등)은 SCRIPT(goja)에 NullString 구조체 {string, valid}로 들어온다 —
// String()/valueOf()/==/=== 전부 "[object Object]"가 되어 키·비교가 조용히 전부 miss(빈 차트).
// 유일한 추출 경로는 .string. 숫자 컬럼·집계값은 순수 숫자, TIME은 페어에 그대로 넣으면 직렬화됨.
var STR_HELPER = 'function _str(v){ return (v && typeof v === "object" && v.string !== undefined) ? v.string : String(v); }';

function scriptSingle() {
  return 'SCRIPT({ $.yield([$.values[0], $.values[1]]) })';
}

function scriptMultiSeries(n) {
  // 시리즈 k는 values[k+1] 사용 (values[0]=시간). deinit에서 인덱스별 yield → column(k)=시리즈k.
  var init = [], main = [];
  for (var k = 0; k < n; k++) {
    init.push('var s' + k + ' = [];');
    main.push('    s' + k + '.push([$.values[0], $.values[' + (k + 1) + ']]);');
  }
  var yieldArgs = [];
  for (var j = 0; j < n; j++) yieldArgs.push('s' + j + '[i]');
  return 'SCRIPT({\n' +
    '    ' + init.join(' ') + '\n' +
    '},{\n' +
    main.join('\n') + '\n' +
    '},{\n' +
    '    for (var i = 0; i < s0.length; i++) $.yield(' + yieldArgs.join(', ') + ');\n' +
    '})';
}

function scriptTags(tags) {
  // 태그별 [time,value] 페어 누적 → 인덱스별 yield. 절대 (time,name,value)로 내보내지 않음.
  var decls = [], lenExprs = [], yieldArgs = [];
  for (var k = 0; k < tags.length; k++) {
    var v = 'a' + k;
    // JS 객체 키는 JSON.stringify로(쌍따옴표 + JS 이스케이프). q()는 SQL용이라 JS 문자열엔 부적합.
    decls.push('var ' + v + ' = s[' + JSON.stringify(String(tags[k])) + '] || [];');
    lenExprs.push(v + '.length');
    yieldArgs.push(v + '[i] || null');
  }
  return 'SCRIPT({\n' +
    '    var s = {};\n' +
    '    ' + STR_HELPER + '\n' +
    '},{\n' +
    '    var k = _str($.values[1]);\n' +
    '    if (!s[k]) s[k] = [];\n' +
    '    s[k].push([$.values[0], $.values[2]]);\n' +
    '},{\n' +
    '    ' + decls.join(' ') + '\n' +
    '    var n = Math.max(' + lenExprs.join(', ') + ');\n' +
    '    for (var i = 0; i < n; i++) $.yield(' + yieldArgs.join(', ') + ');\n' +
    '})';
}

// OHLC 피벗: SQL 행 [버킷라벨, NAME, FIRST, LAST, MIN, MAX]을 버킷별로 모아 ECharts candlestick 순서 [open,close,low,high]로.
//   open = open태그의 FIRST(values[2]) / close = close태그의 LAST(values[3]) / low = low태그의 MIN(values[4]) / high = high태그의 MAX(values[5])
// SQL이 버킷라벨로 ORDER BY → order 배열이 시간순. yield [버킷라벨, [o,c,l,h]] → column(0)=라벨(category축), column(1)=OHLC배열.
function scriptOHLC(o) {
  return 'SCRIPT({\n' +
    '    var M = {}, order = [];\n' +
    '    var T_O = ' + JSON.stringify(String(o.open)) + ', T_H = ' + JSON.stringify(String(o.high)) + ', T_L = ' + JSON.stringify(String(o.low)) + ', T_C = ' + JSON.stringify(String(o.close)) + ';\n' +
    '    ' + STR_HELPER + '\n' +
    '},{\n' +
    // ⚠️ d(TO_CHAR 버킷라벨)와 nm(NAME) 둘 다 문자열 컬럼 = NullString 구조체 —
    //    String()은 "[object Object]"라 키잉/비교 전 _str(.string 추출) 필수. 값(FIRST/LAST/MIN/MAX)은 캔들이 숫자를 요구해 Number() 정규화.
    '    var d = _str($.values[0]), nm = _str($.values[1]);\n' +
    '    if (!M[d]) { M[d] = { o: null, c: null, l: null, h: null }; order.push(d); }\n' +
    '    if (nm === T_O) M[d].o = Number($.values[2]);\n' +   // FIRST
    '    if (nm === T_C) M[d].c = Number($.values[3]);\n' +   // LAST
    '    if (nm === T_L) M[d].l = Number($.values[4]);\n' +   // MIN
    '    if (nm === T_H) M[d].h = Number($.values[5]);\n' +   // MAX
    '},{\n' +
    '    for (var i = 0; i < order.length; i++) { var r = M[order[i]]; $.yield(order[i], [r.o, r.c, r.l, r.h]); }\n' +
    '})';
}

// forecast SCRIPT — 두 모드:
//   ① spec._forecast 있으면 **스냅샷(작음)**: SQL로 실측은 라이브로 받고 예측값만 리터럴로 박는다.
//      → 인라인(모델이 답변에 ```tql 통째로 복사)용. 엔진(11KB)을 답변에 넣으면 모델이 잘라먹어 깨짐 → 작게 유지.
//   ② 없으면 **라이브 엔진(큼)**: forecast_algo 엔진을 baking해 렌더마다 재적합.
//      → 저장/대시보드(tql_path로 참조, 모델이 복사 안 함)용. 데이터 늘면 자동 갱신.
//   공통: column(0)=실측, (1)=예측, (2)=하한(투명 base), (3)=구간폭(stack→채움). 시간축 나노초 함정 회피.
function fcLit(x) { if (x == null || !isFinite(x)) return 'null'; return String(parseFloat(x.toPrecision(5))); } // 5유효숫자(인라인 리터럴 길이 축소)
function buildForecastScript(spec) {
  return spec._forecast ? buildForecastSnapshot(spec) : buildForecastLive(spec);
}

// 스냅샷(인라인): 실측은 SQL에서 누적, 예측·백테스트는 워커가 계산한 값을 리터럴로. 작아서 모델이 답변에 안전히 복사.
//   column(0)=실측, (1)=예측, (2)=하한 base, (3)=구간폭 stack, (4)=백테스트(최근 검증 예측선).
function buildForecastSnapshot(spec) {
  var F = spec._forecast || [], B = spec._backtest || [], fLit = [], bLit = [], i;
  // 타임스탬프를 절대 ms(13자리) 대신 기준시각(BT) 기준 **일 오프셋**(짧은 수)으로 → 리터럴 길이 절반↓(모델 복사 안정).
  var base = spec._trainEndMs || (F.length ? F[0].t : 0), DAY = 86400000;
  function off(t) { return Math.round((t - base) / DAY * 100) / 100; }
  for (i = 0; i < F.length; i++) fLit.push('[' + off(F[i].t) + ',' + fcLit(F[i].v) + ',' + fcLit(F[i].lo) + ',' + fcLit(F[i].hi) + ']');
  for (i = 0; i < B.length; i++) bLit.push('[' + off(B[i].t) + ',' + fcLit(B[i].v) + ']');
  return 'SCRIPT({\n' +
    '    var ts = [], ys = [], BT = ' + base + ', DAY = 86400000;\n' +
    '    function toMs(o){ var s = String(o); var m = s.match(/(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})/); return m ? Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]) : NaN; }\n' +
    '    var F = [' + fLit.join(',') + '];\n' +
    '    var B = [' + bLit.join(',') + '];\n' +
    '},{\n' +
    '    var _t = toMs($.values[0]), _v = Number($.values[1]); if (isFinite(_t) && isFinite(_v)) { ts.push(_t); ys.push(_v); }\n' +
    '},{\n' +
    '    var i; for (i = 0; i < ts.length; i++) $.yield([ts[i], ys[i]], null, null, null, null);\n' +
    '    for (i = 0; i < B.length; i++) { var bt = BT + B[i][0] * DAY; $.yield(null, null, null, null, [bt, B[i][1]]); }\n' +
    '    for (i = 0; i < F.length; i++) { var ft = BT + F[i][0] * DAY; $.yield(null, [ft, F[i][1]], [ft, F[i][2]], [ft, F[i][3] - F[i][2]], null); }\n' +
    '})';
}

// 라이브 엔진(저장/대시보드): forecast_algo를 baking해 렌더마다 현재 데이터로 재적합.
function buildForecastLive(spec) {
  var opts = {
    method: spec.method || 'auto',
    horizon: (spec.horizon != null && parseInt(spec.horizon, 10) >= 1) ? parseInt(spec.horizon, 10) : null,
    lookback: (spec.lookback != null && parseInt(spec.lookback, 10) >= 2) ? parseInt(spec.lookback, 10) : null,
    period: (spec.period != null && parseInt(spec.period, 10) >= 2) ? parseInt(spec.period, 10) : 0,
    board: false, // 저장 .tql은 렌더 시 리더보드 불필요(모델이 이미 확정) → 후보 전부 백테스트하는 비용 생략
  };
  return 'SCRIPT({\n' +
    '    var ts = [], ys = [];\n' +
    '    function toMs(o){ var s = String(o); var m = s.match(/(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})/); return m ? Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]) : NaN; }\n' +
    algoSource() + '\n' +
    '},{\n' +
    '    var _t = toMs($.values[0]), _v = Number($.values[1]); if (isFinite(_t) && isFinite(_v)) { ts.push(_t); ys.push(_v); }\n' +
    '},{\n' +
    '    var i; for (i = 0; i < ts.length; i++) $.yield([ts[i], ys[i]], null, null, null, null);\n' +
    '    if (ts.length >= 2) {\n' +
    '        var R = fcRun(ts, ys, ' + JSON.stringify(opts) + ');\n' +
    '        var p = R.points, bt = R.backtest || [], k;\n' +
    '        for (k = 0; k < bt.length; k++) $.yield(null, null, null, null, [bt[k].t, bt[k].v]);\n' +
    '        for (k = 0; k < p.length; k++) $.yield(null, [p[k].t, p[k].v], [p[k].t, p[k].lo], [p[k].t, p[k].hi - p[k].lo], null);\n' +
    '    }\n' +
    '})';
}

// ════════════════════════════════════════════════════
// CHART 싱크 백엔드
// ════════════════════════════════════════════════════

function seriesLine(names, chartType) {
  var lines = [];
  for (var i = 0; i < names.length; i++) {
    // sampling:"lttb" — 점이 많으면 렌더 시 다운샘플(raw 단일 대비), 적으면 no-op. line에만 적용.
    var extra = (chartType === 'line') ? ', smooth: true, sampling: "lttb"' : '';
    lines.push('            { name: ' + JSON.stringify(names[i]) + ', type: ' + JSON.stringify(chartType) + extra + ', data: column(' + i + ') }');
  }
  return lines.join(',\n');
}

function defaultTitle(spec) {
  if (spec.kind === 'ohlc') return up(spec.table) + ' OHLC (' + ohlcUnit(spec) + ' 캔들)';
  if (spec.kind === 'forecast') {
    var fm = spec.method === 'quadratic' ? '2차' : spec.method === 'holtwinters' ? '계절성' : spec.method === 'auto' ? 'auto' : '선형';
    return up(spec.table) + ' ' + spec.tag + ' 예측 (' + forecastUnit(spec) + ', ' + fm + ')';
  }
  if (spec.kind === 'tags') return up(spec.table) + ' 태그 비교';
  return up(spec.table) + ' ' + spec.tag + (spec.rollup ? ' (' + spec.rollup + ' 집계)' : '');
}

function chartBlock(spec, seriesNames) {
  var out = spec.output || {};
  var chartType = out.chartType || 'line';
  var title = out.title || defaultTitle(spec);
  var subtitle = out.subtitle || '';
  var gridLeft = out.yWide ? LAYOUT.gridLeftWide : LAYOUT.gridLeft;

  var titleObj = '{ text: ' + JSON.stringify(title) +
    (subtitle ? ', subtext: ' + JSON.stringify(subtitle) : '') +
    ', left: 10, top: 5 }';

  return 'CHART(\n' +
    "    tz('Asia/Seoul'),\n" +
    '    chartOption({\n' +
    '        title: ' + titleObj + ',\n' +
    '        grid: { left: ' + gridLeft + ', right: ' + LAYOUT.gridRight + ', top: ' + LAYOUT.gridTop + ', bottom: ' + LAYOUT.gridBottom + ' },\n' +
    '        legend: { bottom: ' + LAYOUT.legendBottom + ' },\n' +
    '        tooltip: { trigger: "axis" },\n' +
    '        xAxis: { type: "time" },\n' +
    '        yAxis: { type: "value" },\n' +
    '        dataZoom: [{ type: "slider", bottom: ' + LAYOUT.zoomBottom + ', height: ' + LAYOUT.zoomHeight + ' }, { type: "inside" }],\n' +
    '        series: [\n' +
    seriesLine(seriesNames, chartType) + '\n' +
    '        ]\n' +
    '    })\n' +
    ')';
}

// OHLC candlestick 싱크. x축=category(버킷 라벨 문자열, column(0)) → 시간축 나노초 함정 회피.
// yAxis.scale=true(가격은 0 기준 아님). 단일 candlestick 시리즈(범례 불필요). 상승/하락 표준 색.
function candlestickBlock(spec) {
  var out = spec.output || {};
  var title = out.title || defaultTitle(spec);
  var subtitle = out.subtitle || '';
  var titleObj = '{ text: ' + JSON.stringify(title) +
    (subtitle ? ', subtext: ' + JSON.stringify(subtitle) : '') +
    ', left: 10, top: 5 }';
  return 'CHART(\n' +
    '    chartOption({\n' +
    '        title: ' + titleObj + ',\n' +
    '        grid: { left: ' + LAYOUT.gridLeft + ', right: ' + LAYOUT.gridRight + ', top: ' + LAYOUT.gridTop + ', bottom: ' + LAYOUT.gridBottom + ' },\n' +
    '        tooltip: { trigger: "axis", axisPointer: { type: "cross" } },\n' +
    '        xAxis: { type: "category", data: column(0), scale: true, boundaryGap: true },\n' +
    '        yAxis: { type: "value", scale: true },\n' +
    '        dataZoom: [{ type: "slider", bottom: ' + LAYOUT.zoomBottom + ', height: ' + LAYOUT.zoomHeight + ' }, { type: "inside" }],\n' +
    '        series: [\n' +
    '            { type: "candlestick", data: column(1),\n' +
    '              itemStyle: { color: "#ef5350", color0: "#26a69a", borderColor: "#ef5350", borderColor0: "#26a69a" } }\n' +
    '        ]\n' +
    '    })\n' +
    ')';
}

// forecast 차트: 실측(파랑 실선) + 예측(주황 파선) + 95% 신뢰구간(주황 채움 밴드). 시간축. y는 0기준 아님(scale).
//   밴드는 ECharts stack 트릭으로 채움: column(2)=하한(투명 base) + column(3)=구간폭(상한-하한, stack로 쌓아 상한까지) areaStyle 채움.
//   '예측 시작' markLine = 학습 끝 시각(spec._trainEndMs) — 실측(실선)↔예측(파선) 경계 = "지금" 표시.
function forecastChartBlock(spec) {
  var out = spec.output || {};
  var title = out.title || defaultTitle(spec);
  var subtitle = out.subtitle || '';
  var gridLeft = out.yWide ? LAYOUT.gridLeftWide : LAYOUT.gridLeft;
  var titleObj = '{ text: ' + JSON.stringify(title) +
    (subtitle ? ', subtext: ' + JSON.stringify(subtitle) : '') +
    ', left: 10, top: 5 }';
  var markLine = '';
  if (spec._trainEndMs) {
    markLine = ',\n              markLine: { symbol: "none", silent: true, lineStyle: { type: "solid", color: "#999" }, ' +
      'data: [{ xAxis: ' + spec._trainEndMs + ', label: { formatter: "예측 시작", position: "insideEndTop" } }] }';
  }
  return 'CHART(\n' +
    "    tz('Asia/Seoul'),\n" +
    '    chartOption({\n' +
    '        title: ' + titleObj + ',\n' +
    '        grid: { left: ' + gridLeft + ', right: ' + LAYOUT.gridRight + ', top: ' + LAYOUT.gridTop + ', bottom: ' + LAYOUT.gridBottom + ' },\n' +
    '        legend: { bottom: ' + LAYOUT.legendBottom + ', data: ["실측", "예측", "95% 구간", "백테스트(검증)"] },\n' +
    '        tooltip: { trigger: "axis" },\n' +
    '        xAxis: { type: "time" },\n' +
    '        yAxis: { type: "value", scale: true },\n' +
    '        dataZoom: [{ type: "slider", bottom: ' + LAYOUT.zoomBottom + ', height: ' + LAYOUT.zoomHeight + ' }, { type: "inside" }],\n' +
    '        series: [\n' +
    '            { name: "실측", type: "line", smooth: true, sampling: "lttb", showSymbol: false, lineStyle: { color: "#2b6cb0" }, itemStyle: { color: "#2b6cb0" }, data: column(0) },\n' +
    '            { name: "예측", type: "line", smooth: true, showSymbol: false, lineStyle: { type: "dashed", color: "#dd6b20", width: 2 }, itemStyle: { color: "#dd6b20" }, data: column(1)' + markLine + ' },\n' +
    '            { name: "_lo", type: "line", stack: "ci", symbol: "none", silent: true, lineStyle: { opacity: 0 }, data: column(2) },\n' +
    '            { name: "95% 구간", type: "line", stack: "ci", symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: "rgba(221,107,32,0.16)" }, data: column(3) },\n' +
    '            { name: "백테스트(검증)", type: "line", smooth: true, showSymbol: false, lineStyle: { type: "dotted", color: "#26a69a", width: 1.5 }, itemStyle: { color: "#26a69a" }, data: column(4) }\n' +
    '        ]\n' +
    '    })\n' +
    ')';
}

// ════════════════════════════════════════════════════
// SINK 레지스트리 (확장 지점) — 차후 csv/insert/json은 여기에 추가만
// ════════════════════════════════════════════════════

var SINKS = {
  chart: {
    buildScript: function (spec, info) {
      if (spec.kind === 'forecast') return buildForecastScript(spec);
      if (spec.kind === 'ohlc') return scriptOHLC(spec.ohlc);
      if (spec.kind === 'tags') return scriptTags(spec.tags);
      if (spec.rollup == null) return scriptSingle();          // raw 단일 시리즈
      return (info.count === 1) ? scriptSingle() : scriptMultiSeries(info.count);
    },
    buildSink: function (spec, info) {
      if (spec.kind === 'forecast') return forecastChartBlock(spec);
      if (spec.kind === 'ohlc') return candlestickBlock(spec);
      return chartBlock(spec, info.names);
    },
  },
  geomap: {
    buildScript: function (spec, info) { return scriptGeomap(spec); },
    buildSink: function (spec, info) { return geomapBlock(spec); },
  },
  // csv:    { buildScript, buildSink },   ← 차후
  // insert: { buildScript, buildSink },   ← 차후
};

// ════════════════════════════════════════════════════
// 진입점
// ════════════════════════════════════════════════════

// compileTIR(spec) → TQL 문자열. 유효하지 않으면 Error를 던진다(결정론적, 메시지에 원인).
function compileTIR(spec) {
  var v = validate(spec);
  if (!v.ok) throw new Error('TIR invalid:\n- ' + v.errors.join('\n- '));

  var sinkName = (spec.output && spec.output.sink) || (spec.kind === 'geomap' ? 'geomap' : 'chart');
  var backend = SINKS[sinkName];
  if (!backend) {
    throw new Error('TIR invalid:\n- output.sink="' + sinkName + '"는 아직 미지원입니다(현재 지원: ' + Object.keys(SINKS).join('/') + ').');
  }

  var info = seriesInfo(spec);
  // SRC: geomap에 table 없으면 FAKE 좌표 예제, 그 외는 SQL(forecast 포함 — 이력 조회 후 SCRIPT가 라이브 재계산).
  var srcLine = (spec.kind === 'geomap' && !spec.table) ? fakeGeomapSource() : ('SQL(`' + buildSource(spec) + '`)');
  var script = backend.buildScript(spec, info); // MAP
  var sinkCode = backend.buildSink(spec, info); // SINK
  return srcLine + '\n' + script + '\n' + sinkCode + '\n';
}

// 안전 래퍼: 던지지 않고 {ok, tql, error} 반환 (도구 레이어에서 쓰기 좋음)
function compileSafe(spec) {
  try {
    return { ok: true, tql: compileTIR(spec), error: null };
  } catch (e) {
    return { ok: false, tql: null, error: e.message };
  }
}

module.exports = { compileTIR, compileSafe, buildSource, SINKS, toDateLiteral, forecastUnit };
