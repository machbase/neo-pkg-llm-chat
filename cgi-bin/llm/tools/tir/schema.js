// TIR (TQL Intermediate Representation) — schema + validator.
//
// 뉴로-심볼릭 분업의 "심볼릭 게이트키퍼":
//   신경망(LLM)은 분석 의도를 TIR(제약된 JSON)로만 emit하고,
//   compile.js가 그걸 결정론적으로 보장된 TQL로 번역한다.
//   이 파일은 "구조적으로 유효한 의도란 무엇인가"를 소유한다.
//
// IR은 직교하는 두 축:
//   - kind        : 데이터 의도(metrics=단일태그 집계/원시, tags=여러태그) → SQL + 기본 SCRIPT
//   - output.sink : 출력 의도(chart / [later] csv / insert / json ...)     → 최종 싱크
// 현재 구현된 sink는 compile.js의 SINKS 레지스트리가 결정한다(미지원이면 compile이 거절).

var ROLLUP_UNITS = ['sec', 'min', 'hour', 'day', 'week', 'month']; // 'ms' 불가
var ROLLUP_AGGS = ['avg', 'sum', 'min', 'max', 'count', 'sumsq'];   // ROLLUP 지원 집계 (STDDEV 미지원)
var CHART_TYPES = ['line', 'bar'];        // kind=metrics/tags
var OHLC_CHART = 'candlestick';           // kind=ohlc 전용 (line/bar와 배타적)

// 도구 파라미터 와이어링/문서용 JSON-schema 서술 (LLM에게 보여줄 형태)
var IR_SCHEMA = {
  type: 'object',
  required: ['kind', 'table', 'timeRange'],
  properties: {
    // ── 데이터 의도 ──
    kind: {
      type: 'string', enum: ['metrics', 'tags', 'ohlc', 'forecast'],
      description: 'metrics=단일 태그의 집계/원시 시리즈(밴드·ROLLUP통계), tags=여러 태그 비교, ohlc=OHLC 캔들차트(open/high/low/close 태그가 있는 주가/시세 데이터), forecast=단일 태그의 이후 데이터 예측(선형회귀+신뢰밴드)',
    },
    table: { type: 'string', description: '테이블명' },
    timeRange: {
      type: 'object', required: ['start', 'end'],
      properties: {
        start: { type: 'string', description: "TO_DATE 문자열, 예 '2026-02-01 00:00:00'" },
        end: { type: 'string', description: 'TO_DATE 문자열' },
      },
    },
    tag: { type: 'string', description: 'kind=metrics 일 때 단일 태그명' },
    rollup: {
      type: ['string', 'null'], enum: ROLLUP_UNITS.concat([null]),
      description: '집계 시간버킷 단위(sec/min/hour/day/week/month). 집계(avg/max/min 등)에 필요하지만 **생략 가능 — 생략 시 서버가 데이터 범위에 맞춰 자동 선택**. ROLLUP 테이블 유무는 신경 쓸 필요 없음(서버가 ROLLUP/DATE_TRUNC로 자동 처리). 원시값만 원하면 null + agg="raw".',
    },
    metrics: {
      type: 'array', description: 'kind=metrics: 각 항목이 하나의 시리즈',
      items: {
        type: 'object',
        properties: {
          agg: { type: 'string', description: ROLLUP_AGGS.join('/') + ' (rollup 필요) 또는 raw (rollup=null)' },
          label: { type: 'string', description: '시리즈/범례 이름' },
        },
      },
    },
    tags: { type: 'array', items: { type: 'string' }, description: 'kind=tags: 비교할 태그명들 (ROLLUP과 동시 불가)' },
    ohlc: {
      type: 'object',
      description: 'kind=ohlc: 시가/고가/저가/종가 태그명 {open,high,low,close}. 보통 생략 가능 — 도구가 open/high/low/close 태그를 자동 인식. rollup=캔들 버킷 단위(기본 day).',
      properties: {
        open: { type: 'string' }, high: { type: 'string' }, low: { type: 'string' }, close: { type: 'string' },
      },
    },
    horizon: {
      type: ['integer', 'null'],
      description: 'kind=forecast: 예측할 미래 버킷 개수. 생략 시 학습 길이의 25%(자동). 상한=학습 버킷 수.',
    },
    lookback: {
      type: ['integer', 'null'],
      description: 'kind=forecast: 최근 추세를 추정할 최근 버킷 수(local linear trend). 생략 시 학습의 33%(최소 10). 짧을수록 최근 변화에 민감, 길수록 완만.',
    },
    method: {
      type: 'string', enum: ['auto', 'linear', 'quadratic', 'holtwinters'],
      description: 'kind=forecast: 예측 방법. auto(기본, 데이터 보고 자동 선택) / linear(선형추세) / quadratic(2차 곡률) / holtwinters(계절성). 생략 시 auto.',
    },

    // ── 출력 의도 ──
    output: {
      type: 'object',
      description: '출력처. 생략 시 chart.',
      properties: {
        sink: { type: 'string', description: 'chart (현재 지원). later: csv/insert/json' },
        chartType: { type: 'string', enum: CHART_TYPES.concat([OHLC_CHART]), description: '기본 line (sink=chart). candlestick은 kind=ohlc 전용.' },
        title: { type: 'string', description: '차트 제목(생략 시 자동)' },
        subtitle: { type: 'string', description: '부제(단위 등). y축 이름 대신 여기에.' },
        yWide: { type: 'boolean', description: '6자리 이상 큰 값이면 true → grid.left 확대' },
      },
    },
  },
};

function push(list, msg) { list.push(msg); }

// validate(spec) → { ok, errors:[string] }
// 데이터 의도 + chart 옵션의 구조적 유효성만 본다. sink 구현 여부는 compile.js가 판정.
// errors는 LLM에게 그대로 돌려줄 수 있는 actionable 메시지(JSON 수정은 TQL 재작성보다 훨씬 싸다).
function validate(spec) {
  var errors = [];
  if (!spec || typeof spec !== 'object') {
    return { ok: false, errors: ['TIR spec이 객체가 아닙니다.'] };
  }

  if (spec.kind !== 'metrics' && spec.kind !== 'tags' && spec.kind !== 'ohlc' && spec.kind !== 'geomap' && spec.kind !== 'forecast') {
    push(errors, 'kind는 "metrics"(단일 태그의 집계/원시), "tags"(여러 태그 비교), "ohlc"(OHLC 캔들차트), "geomap"(지도/좌표), "forecast"(이후 데이터 예측) 중 하나여야 합니다.');
  }
  // geomap: 테이블 명시 없으면 FAKE 좌표 예제 → table·timeRange 불필요(공간 데이터, 시간 무관).
  if (spec.kind !== 'geomap') {
    if (!spec.table) push(errors, 'table은 필수입니다.');
    if (!spec.timeRange || !spec.timeRange.start || !spec.timeRange.end) {
      push(errors, 'timeRange.start / timeRange.end (TO_DATE 문자열)는 필수입니다. describe_table의 실제 데이터 기간(ms)을 사용하세요.');
    }
  }
  if (spec.rollup != null && ROLLUP_UNITS.indexOf(spec.rollup) < 0) {
    push(errors, 'rollup 단위는 ' + ROLLUP_UNITS.join(' / ') + ' 만 가능합니다(ms 불가). ROLLUP 없는 테이블이면 rollup=null(원시 조회).');
  }

  // 출력 의도(chart 옵션) — output은 선택, chartType만 검증 (kind=ohlc는 candlestick 전용)
  var out = spec.output || {};
  if (out.chartType) {
    if (spec.kind === 'ohlc') {
      if (out.chartType !== OHLC_CHART) push(errors, 'kind="ohlc"의 output.chartType은 ' + OHLC_CHART + '만 가능합니다(생략 가능).');
    } else if (out.chartType === OHLC_CHART) {
      push(errors, 'candlestick은 kind="ohlc"에서만 가능합니다(open/high/low/close 태그 데이터). 일반 차트는 line / bar.');
    } else if (CHART_TYPES.indexOf(out.chartType) < 0) {
      push(errors, 'output.chartType은 ' + CHART_TYPES.join(' / ') + ' 만 지원합니다.');
    }
  }

  if (spec.kind === 'metrics') {
    if (!spec.tag) push(errors, 'kind="metrics"는 tag(단일 태그명)가 필수입니다.');
    if (!Array.isArray(spec.metrics) || spec.metrics.length === 0) {
      push(errors, 'kind="metrics"는 metrics 배열(>=1)이 필수입니다. 각 항목 = 하나의 시리즈.');
    } else {
      var rawCount = 0;
      for (var i = 0; i < spec.metrics.length; i++) {
        var m = spec.metrics[i] || {};
        var agg = m.agg ? String(m.agg).toLowerCase() : '';
        if (agg === 'stddev' || agg === 'variance') {
          push(errors, 'metrics[' + i + '].agg="' + agg + '": ROLLUP은 STDDEV/VARIANCE를 지원하지 않습니다. 변동성은 max/min 밴드 또는 sumsq(RMS)로 표현하세요.');
        } else if (agg === 'raw') {
          rawCount++;
          if (spec.rollup != null) push(errors, 'metrics[' + i + '].agg="raw"는 rollup=null(원시 조회)일 때만 사용합니다.');
        } else if (/^p\d+$/i.test(agg)) {
          push(errors, 'metrics[' + i + '].agg="' + agg + '": 백분위(p50/p90/p99 등)는 집계 함수가 아닙니다. 이런 메트릭은 보통 **별도 태그**(예: machbase:...:p90)이니, agg가 아니라 **tag로 지정**하세요(여러 백분위 비교는 kind="tags").');
        } else if (ROLLUP_AGGS.indexOf(agg) < 0) {
          push(errors, 'metrics[' + i + '].agg="' + (m.agg) + '"는 지원하지 않습니다. 사용 가능: ' + ROLLUP_AGGS.join('/') + ' (rollup 필요) 또는 raw (rollup=null).');
        } else if (spec.rollup == null) {
          push(errors, 'metrics[' + i + '].agg="' + agg + '"(집계)는 rollup(시간버킷 단위 sec~month)을 지정해야 합니다. **ROLLUP 테이블 유무와 무관 — 서버가 ROLLUP/DATE_TRUNC로 자동 집계하니 일단 단위만 정하세요**(예: rollup="hour"). 원시값만 원하면 agg="raw"로.');
        }
      }
      if (rawCount > 0 && spec.metrics.length > 1) {
        push(errors, 'agg="raw"는 단일 metric으로만 사용합니다(원시 시계열은 시리즈 1개). 여러 시리즈는 rollup 집계를 쓰세요.');
      }
    }
  } else if (spec.kind === 'tags') {
    if (!Array.isArray(spec.tags) || spec.tags.length === 0) {
      push(errors, 'kind="tags"는 tags 배열(>=1)이 필수입니다.');
    }
    if (spec.rollup != null) {
      // ROLLUP 쿼리에 NAME 컬럼 → MACH-ERR 2264
      push(errors, 'kind="tags"(여러 태그 비교)는 ROLLUP과 동시 사용 불가입니다(MACH-ERR 2264). rollup=null로 원시 비교하거나, 태그별로 차트를 분리해 각각 rollup을 쓰세요.');
    }
  } else if (spec.kind === 'ohlc') {
    // ohlc:{open,high,low,close} 태그명 필요. 보통 도구가 자동 인식해 주입(미지정이면 도구 단계에서 거절).
    var o = spec.ohlc || {};
    var miss = ['open', 'high', 'low', 'close'].filter(function (k) { return !o[k]; });
    if (miss.length) {
      push(errors, 'kind="ohlc"는 ohlc:{open,high,low,close} 태그명이 필요합니다(누락: ' + miss.join(',') + '). 보통 도구가 open/high/low/close 태그를 자동 인식하므로 생략 가능 — 테이블에 해당 태그가 없으면 candlestick을 만들 수 없습니다.');
    }
    // rollup=캔들 버킷 단위(기본 day). agg/metrics 불필요 — first/max/min/last는 컴파일러가 고정.
  } else if (spec.kind === 'geomap') {
    // table 있으면 lat/lon 컬럼명 필요. 없으면 FAKE 좌표 예제 → 추가 검증 없음.
    if (spec.table && (!spec.lat || !spec.lon)) {
      push(errors, 'kind="geomap"에 table을 주면 lat/lon(위도/경도 컬럼명)이 필요합니다. 특정 테이블 없이 예제만 원하면 table을 생략하세요(FAKE 좌표 샘플).');
    }
  } else if (spec.kind === 'forecast') {
    // 단일 태그 예측. 여러 태그는 도구(forecast_table)가 태그별로 분해해 각각 forecast로 호출.
    if (!spec.tag) push(errors, 'kind="forecast"는 tag(예측할 단일 태그명)가 필수입니다. 여러 태그를 예측하려면 도구가 태그별로 나눠 처리합니다.');
    // method는 별칭("계절성","선형","2차","hw")·순위("2위","rank2")도 허용 — 도구(forecast_algo.fcNormMethod)가 정규화하고
    // 해석 불가면 자동선택으로 폴백하므로 여기서 거절하지 않는다(과잉차단 방지).
    if (spec.horizon != null) {
      var hz = parseInt(spec.horizon, 10);
      if (isNaN(hz) || hz < 1) push(errors, 'kind="forecast"의 horizon은 1 이상의 정수(예측할 미래 버킷 수)여야 합니다. 생략하면 학습 길이의 10%가 자동 적용됩니다.');
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

module.exports = { validate, IR_SCHEMA, ROLLUP_UNITS, ROLLUP_AGGS, CHART_TYPES, OHLC_CHART };
