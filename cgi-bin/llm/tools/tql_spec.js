// compile_tql_from_spec — TIR(의도 JSON) → 실행 검증된 TQL 도구
// · filename 있음(대시보드): 컴파일 → save_tql_file로 검증·저장 → charts의 tql_path
// · filename 없음(답변): 컴파일 → execute_tql_script로 실행 검증 → TQL 텍스트 반환

var { compileSafe, toDateLiteral, fitBucket, metricsBucket, ohlcBucket, bucketLabel, rangeMs, UNIT_WINDOW_H } = require('./tir/compile');
var { parseTableRef, resolveTableRef, readTagNames, statViewName, countRollups } = require('./table_access');
var { argStr } = require('./registry');
var { zoneName } = require('../machbase/timezone');
var rangeCache = require('./range_cache');

// 같은 차트(동일 TQL, 이름만 다름) 반복 저장 차단용 기록, TTL로 자동 리셋
// · 저장 성공 TQL만 기록 — 컴파일만·저장 실패 뒤의 저장 재시도 차단 방지
var _savedTQL = {};
var SEEN_TTL = 3 * 60 * 1000;
var _dupeStreak = 0; // 연속 중복 횟수(약한 모델 중복 루프 차단용). 고유 차트 통과 시 리셋.
function tqlKey(tql) { return String(tql).replace(/\s+/g, ' ').trim(); }
function savedRecently(tql) {
  var now = Date.now(), k = tqlKey(tql);
  for (var key in _savedTQL) { if (now - _savedTQL[key] > SEEN_TTL) delete _savedTQL[key]; }
  return !!_savedTQL[k];
}
function markSaved(tql) { _savedTQL[tqlKey(tql)] = Date.now(); }

var POINT_BUCKET_THRESHOLD = 50000; // 실제 점 개수가 이보다 많으면 적응형 버킷, 이하면 raw(+lttb 렌더)

// 잘린(EOF) JSON 부분 복구: 마지막 완전한 최상위 필드까지 자르고 열린 브래킷 닫음
function salvageTruncatedJSON(s) {
  s = String(s);
  if (s.charAt(0) !== '{') return null;
  var inStr = false, esc = false, stack = [], lastSafe = -1, i, c;
  for (i = 0; i < s.length; i++) {
    c = s.charAt(i);
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',' && stack.length === 1) lastSafe = i; // 최상위 필드 경계(쉼표)
  }
  if (lastSafe < 0) return null;
  var head = s.substring(0, lastSafe);
  // head 안의 열린 브래킷 닫기(문자열 내부 무시)
  var st = [], inS = false, es = false, j, ch;
  for (j = 0; j < head.length; j++) {
    ch = head.charAt(j);
    if (inS) { if (es) es = false; else if (ch === '\\') es = true; else if (ch === '"') inS = false; continue; }
    if (ch === '"') { inS = true; continue; }
    if (ch === '{') st.push('}'); else if (ch === '[') st.push(']');
    else if (ch === '}' || ch === ']') st.pop();
  }
  var closed = head;
  for (var k = st.length - 1; k >= 0; k--) closed += st[k];
  try { return JSON.parse(closed); } catch (e) {
    try { return JSON.parse(closed.replace(/([{,]\s*)([A-Za-z_][\w]*)(\s*:)/g, '$1"$2"$3')); } catch (e2) { return null; }
  }
}

// spec JSON 관대 파싱 — strict 파싱 실패 시에만 보정(유효 JSON은 불변), 잘못 고쳐도 validator가 다시 거름
function parseSpecLenient(s) {
  try { return { spec: JSON.parse(s) }; } catch (e0) {
    var t = String(s)
      .replace(/,\s*([}\]])/g, '$1')                            // 트레일링 콤마 제거
      .replace(/([{,]\s*)([A-Za-z_][\w]*)(\s*:)/g, '$1"$2"$3');  // 따옴표 없는 객체 키 → 따옴표 부착
    try { return { spec: JSON.parse(t), repaired: true }; } catch (e1) {
      var salv = salvageTruncatedJSON(s);                        // 잘린 JSON 부분 복구
      if (salv) return { spec: salv, repaired: true, truncated: true };
      return { spec: null, error: e0.message }; // 원본(더 정확한) 에러 메시지 유지
    }
  }
}

// 최상위 인자로 쪼개 들어올 수 있는 spec 필드 — 객체·문자열·잘린 문자열 spec과 합쳐 하나로 재조립
var SPEC_FIELDS = ['table', 'kind', 'tag', 'tags', 'rollup', 'rollupN', 'timeRange', 'metrics', 'agg',
  'ohlc', 'nameCol', 'valueCol', 'timeCol', 'output', 'title', 'subtitle', 'chartType', 'bucket'];

function maybeJSON(v) {
  if (typeof v !== 'string') return v;
  var t = v.trim();
  if (t && (t.charAt(0) === '{' || t.charAt(0) === '[')) {
    var pr = parseSpecLenient(t);
    if (pr.spec != null) return pr.spec;
  }
  return v;
}

// 최후 폴백: 심하게 깨진/잘린 JSON에서 정규식으로 핵심 필드 추출
function extractFieldsRegex(s) {
  var out = {};
  if (typeof s !== 'string') return out;
  var reStr = /"(table|kind|tag|nameCol|valueCol|timeCol|rollup|chartType|title|subtitle)"\s*:\s*"([^"\\]*)"/g, m;
  while ((m = reStr.exec(s))) if (out[m[1]] === undefined) out[m[1]] = m[2];
  var tm = /"tags"\s*:\s*\[([^\]]*)/.exec(s); // 닫는 ] 잘려도 부분 수집
  if (tm) { var arr = tm[1].match(/"([^"\\]+)"/g); if (arr && arr.length) out.tags = arr.map(function (x) { return x.replace(/^"|"$/g, ''); }); }
  var ts = /"start"\s*:\s*(\d{10,19})/.exec(s), te = /"end"\s*:\s*(\d{10,19})/.exec(s);
  if (ts || te) { out.timeRange = {}; if (ts) out.timeRange.start = parseInt(ts[1], 10); if (te) out.timeRange.end = parseInt(te[1], 10); }
  return out;
}

function assembleSpec(args) {
  var out = {};
  var s = args.spec;
  if (s && typeof s === 'object') {
    for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) out[k] = s[k];
  } else if (typeof s === 'string' && s.trim()) {
    var pr = parseSpecLenient(s);
    if (pr.spec && typeof pr.spec === 'object') {
      for (var k2 in pr.spec) if (Object.prototype.hasOwnProperty.call(pr.spec, k2)) out[k2] = pr.spec[k2];
    }
    // 파싱 완전 실패면 out 비어있음 → 아래 최상위 인자로 복구
  }
  // 최상위로 쪼개 들어온 spec 필드 보충(spec에 이미 유효값 있으면 유지)
  for (var i = 0; i < SPEC_FIELDS.length; i++) {
    var f = SPEC_FIELDS[i];
    var v = args[f];
    if (v === undefined || v === null || v === '') continue;
    var cur = out[f];
    if (cur !== undefined && cur !== null && cur !== '' && !(Array.isArray(cur) && cur.length === 0)) continue;
    out[f] = maybeJSON(v);
  }
  // 여전히 핵심 필드가 없고 spec이 문자열이면(심한 깨짐/잘림) 정규식으로 최후 복구.
  if (!out.table && !out.kind && !out.tag && !out.tags && !out.metrics && typeof args.spec === 'string') {
    var ext = extractFieldsRegex(args.spec);
    for (var ek in ext) if (Object.prototype.hasOwnProperty.call(ext, ek) && (out[ek] === undefined || out[ek] === null || out[ek] === '')) out[ek] = ext[ek];
  }
  return out;
}

// raw 차트(tags / metrics+rollup=null)의 점 개수 추정 → 5만 초과면 spec.bucket=true.
// · 통계 뷰 태그별 ROW_COUNT × 요청 기간 겹침 비율(균등 밀도 가정, 전체 스캔 회피)
// · 통계 뷰 실패 시 COUNT 집계
function detectPointCount(mc, spec, cb) {
  var nameCol = spec.nameCol || 'NAME', timeCol = spec.timeCol || 'TIME';
  var tags = (spec.kind === 'tags') ? (spec.tags || []) : (spec.tag != null ? [spec.tag] : []);
  if (tags.length === 0) return cb(0);
  var inList = tags.map(function (t) { return "'" + String(t).replace(/'/g, "''") + "'"; }).join(', ');
  var tr = spec.timeRange || {};
  var statSQL = 'SELECT ROW_COUNT, MIN_TIME, MAX_TIME FROM ' + statViewName(parseTableRef(spec.table)) + ' WHERE NAME IN (' + inList + ')';
  mc.querySQL(statSQL, 'ms', '', '', function (errS, resS) {
    var rows = null;
    if (!errS) {
      try { var ps = JSON.parse(resS); if (ps && ps.success && ps.data && ps.data.rows && ps.data.rows.length) rows = ps.data.rows; } catch (e) {}
    }
    if (!rows) return countByScan();
    var s = trMs(tr.start), e = trMs(tr.end), n = 0;
    for (var i = 0; i < rows.length; i++) {
      var c = parseInt(String(rows[i][0]), 10) || 0;
      var mn = parseInt(String(rows[i][1]), 10), mx = parseInt(String(rows[i][2]), 10);
      if (!(s > 0 && e > 0) || !(mx > mn)) { n += c; continue; }
      var lo = Math.max(s, mn), hi = Math.min(e, mx);
      if (hi > lo) n += c * (hi - lo) / (mx - mn);
    }
    cb(Math.round(n));
  });
  function countByScan() {
    var sql = 'SELECT COUNT(*) FROM ' + String(spec.table).toUpperCase() + ' WHERE ' + nameCol + ' IN (' + inList + ')';
    if (tr.start && tr.end) sql += ' AND ' + timeCol + ' BETWEEN ' + toDateLiteral(tr.start) + ' AND ' + toDateLiteral(tr.end);
    mc.querySQL(sql, '', '', '', function (err, res) {
      if (err) return cb(0); // 못 세면 raw 유지(과잉버킷 방지)
      var n = 0;
      try { var p = JSON.parse(res); if (p && p.success && p.data && p.data.rows && p.data.rows.length) n = parseInt(String(p.data.rows[0][0]), 10) || 0; } catch (e) {}
      cb(n);
    });
  }
}

// 테이블의 실제 컬럼명 탐지 (PK/BASETIME/SUMMARIZED) → cb({n,t,v}), 커스텀 컬럼 테이블 대응
function detectColumns(mc, table, cb) {
  // M$SYS_TABLES.NAME은 소유자 없는 테이블 이름 — 'SYS.BITCOIN' 그대로면 못 찾음
  var u = parseTableRef(table).table;
  var sql = "SELECT m2.NAME, m2.FLAG FROM M$SYS_TABLES m1, M$SYS_COLUMNS m2 " +
    "WHERE m1.ID = m2.TABLE_ID AND m1.DATABASE_ID = m2.DATABASE_ID AND m1.NAME = '" + u + "' AND m1.FLAG = 0";
  mc.querySQL(sql, '', '', '', function (err, res) {
    var c = { n: 'NAME', t: 'TIME', v: 'VALUE' };
    if (!err) {
      try {
        var p = JSON.parse(res);
        if (p && p.success && p.data && p.data.rows) {
          for (var i = 0; i < p.data.rows.length; i++) {
            var nm = p.data.rows[i][0], fl = p.data.rows[i][1];
            // 비트 AND — ROLLUP 테이블은 SUMMARIZED에 rollup 비트가 더해져(예 570425344) 정확비교로는 못 잡음
            if (fl & 134217728) c.n = nm;        // PRIMARY KEY (태그명)
            else if (fl & 16777216) c.t = nm;    // BASETIME (시간)
            else if (fl & 33554432) c.v = nm;    // SUMMARIZED (값)
          }
        }
      } catch (e) {}
    }
    cb(c);
  });
}

// 입력 정규화(normalizeSpec): 쉼표 tag("a,b,c") → kind="tags", rollup 별칭("5min" 등) → 표준 단위
var ROLLUP_ALIAS = { s: 'sec', sec: 'sec', secs: 'sec', second: 'sec', seconds: 'sec', m: 'min', min: 'min', mins: 'min', minute: 'min', minutes: 'min',
  h: 'hour', hr: 'hour', hour: 'hour', hours: 'hour', d: 'day', day: 'day', days: 'day', w: 'week', week: 'week', weeks: 'week', month: 'month', months: 'month' };

function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  delete spec.unitPinned; // 버킷 확정은 도구만 함
  // rollup "5min"·"10s"·"minute" → rollup + rollupN
  if (typeof spec.rollup === 'string') {
    var _rm = /^\s*(\d+)?\s*([a-z]+)\s*$/i.exec(spec.rollup);
    if (_rm && ROLLUP_ALIAS[_rm[2].toLowerCase()]) {
      spec.rollup = ROLLUP_ALIAS[_rm[2].toLowerCase()];
      if (_rm[1] && parseInt(_rm[1], 10) > 1 && spec.rollupN == null) spec.rollupN = parseInt(_rm[1], 10);
    }
  }
  if (typeof spec.tag === 'string' && spec.tag.indexOf(',') >= 0) {
    var parts = spec.tag.split(',').map(function (s) { return String(s).trim(); }).filter(Boolean);
    if (parts.length > 1) {
      spec.kind = 'tags'; spec.tags = parts;
      delete spec.tag; delete spec.rollup; delete spec.metrics; // tags는 ROLLUP 불가
    } else if (parts.length === 1) {
      spec.tag = parts[0];
    }
  }
  if (Array.isArray(spec.tags)) { // tags 배열 항목 안 쉼표도 평탄화
    var flat = [];
    for (var i = 0; i < spec.tags.length; i++) {
      String(spec.tags[i]).split(',').forEach(function (s) { s = s.trim(); if (s) flat.push(s); });
    }
    spec.tags = flat;
  }
  // metrics 누락(kind=metrics 또는 tag만) → 단일 시리즈 기본값(rollup 있으면 avg, 없으면 raw) — 검증 거부 루프 방지
  if ((spec.kind === 'metrics' || (!spec.kind && spec.tag && !spec.tags)) && spec.tag &&
      (!Array.isArray(spec.metrics) || spec.metrics.length === 0)) {
    spec.kind = 'metrics';
    spec.metrics = [{ agg: (spec.rollup != null ? 'avg' : 'raw'), label: String(spec.tag) }];
  }
  // rollup 지정 시 raw는 불가 → avg로 강등
  if (spec.kind === 'metrics' && spec.rollup != null && Array.isArray(spec.metrics)) {
    for (var _mi = 0; _mi < spec.metrics.length; _mi++) {
      var _mm = spec.metrics[_mi];
      if (_mm && String(_mm.agg).toLowerCase() === 'raw') _mm.agg = 'avg';
    }
  }
  // output.chartType 미지원 값은 거절 없이 강등(bar 계열 → bar, 그 외 → line)
  if (spec.output && spec.output.chartType != null) {
    var _ct = String(spec.output.chartType).toLowerCase();
    if (spec.kind === 'ohlc') spec.output.chartType = 'candlestick';
    else if (_ct.indexOf('bar') >= 0) spec.output.chartType = 'bar';
    else spec.output.chartType = 'line'; // line/scatter/area/pie/candlestick(비ohlc)/미상 → line
  }
  return spec;
}

// 테이블의 실제 태그 목록 탐지 — 메타 우선·실패 시 통계 뷰(readTagNames). 못 얻으면 []. cb([tags]).
function detectTags(mc, table, nameCol, cb) {
  readTagNames(mc, parseTableRef(table), nameCol, function (err, tags) { cb(err ? [] : tags); });
}

// 태그 자리에 컬럼 이름(이름·시간·값 컬럼)을 넣었으면 실제 태그로 바꿔 컴파일 — 같은 실수 반복 방지
// · 단일 태그(metrics·forecast): 첫 태그, 여러 태그(tags): 컬럼 이름만 빼고 비면 앞 COLUMN_TAG_FALLBACK개
// · 실제 태그 목록에 있는 이름은 그대로
// · columns: [이름 컬럼, 시간 컬럼, 값 컬럼]
var COLUMN_TAG_FALLBACK = 5;
function applyColumnTag(spec, allTags, columns, notes) {
  if (!allTags || allTags.length === 0) return;
  var colSet = {};
  (columns || []).forEach(function (c) { if (c) colSet[String(c).toLowerCase()] = true; });
  function isColumn(t) { return t != null && allTags.indexOf(String(t)) < 0 && !!colSet[String(t).toLowerCase()]; }
  var valueNote = columns && columns[2] ? '(값은 ' + columns[2] + ' 컬럼에서 읽음)' : '';
  if (spec.kind === 'tags' && Array.isArray(spec.tags)) {
    var dropped = spec.tags.filter(isColumn);
    if (!dropped.length) return;
    var kept = spec.tags.filter(function (t) { return !isColumn(t); });
    spec.tags = kept.length ? kept : allTags.slice(0, COLUMN_TAG_FALLBACK);
    notes.push('[주의] ' + dropped.join(', ') + '은(는) 태그가 아니라 컬럼 이름이라 태그 ' + spec.tags.join(', ') + '(으)로 만들었습니다' + valueNote + '.');
    return;
  }
  if (!isColumn(spec.tag)) return;
  var was = spec.tag;
  spec.tag = allTags[0];
  notes.push('[주의] ' + was + '은(는) 태그가 아니라 컬럼 이름이라 첫 태그 ' + allTags[0] + '(으)로 만들었습니다' + valueNote + '.' +
    (allTags.length > 1 ? ' 다른 태그: ' + allTags.slice(1, 6).join(', ') + (allTags.length > 6 ? ' …' : '') : ''));
}

// spec의 태그가 실제 존재하는지 검증. 없으면 유사 태그 제안 메시지 반환(있으면 null).
function validateTags(spec, allTags) {
  if (!allTags || allTags.length === 0) return null; // 태그목록 못 얻으면 통과(과잉차단 방지)
  var want = (spec.kind === 'tags') ? (spec.tags || []) : (spec.tag != null ? [spec.tag] : []);
  var missing = [];
  for (var i = 0; i < want.length; i++) { if (allTags.indexOf(String(want[i])) < 0) missing.push(String(want[i])); }
  if (missing.length === 0) return null;
  var sugg = missing.map(function (m) {
    var ml = String(m).toLowerCase();
    var toks = m.split(':'); var key = toks[toks.length - 1] || m;
    // 1) 마지막 ':' 세그먼트 substring 매치(가장 정확)
    var cand = allTags.filter(function (t) { return key && String(t).toLowerCase().indexOf(key.toLowerCase()) >= 0; });
    // 2) 못 찾으면 토큰 기반 fuzzy: 영숫자 토큰(>=2) 공유 + p\d+(백분위) 가족 보너스 (p95_percentile → p50/p90/p99)
    if (cand.length === 0) {
      var wantToks = ml.split(/[^a-z0-9]+/).filter(function (x) { return x.length >= 2; });
      var isPct = /p\d+/.test(ml);
      var scored = [];
      for (var ti = 0; ti < allTags.length; ti++) {
        var tl = String(allTags[ti]).toLowerCase(), sc = 0;
        for (var wi = 0; wi < wantToks.length; wi++) if (tl.indexOf(wantToks[wi]) >= 0) sc++;
        if (isPct && /p\d+/.test(tl)) sc++;
        if (sc > 0) scored.push({ t: allTags[ti], s: sc });
      }
      scored.sort(function (a, b) { return b.s - a.s; });
      cand = scored.slice(0, 6).map(function (o) { return o.t; });
    } else {
      cand = cand.slice(0, 6);
    }
    return '"' + m + '"' + (cand.length ? ' → ' + cand.join(', ') : ' (유사 태그 없음)');
  }).join(' | ');
  return '존재하지 않는 태그입니다: ' + sugg +
    '\n→ describe_table에 나온 **정확한 태그명**을 쓰세요(약어/추측 금지). 여러 태그 비교는 kind="tags".' +
    '\n전체 ' + allTags.length + '개 중 일부: ' + allTags.slice(0, 12).join(', ') + (allTags.length > 12 ? ' …' : '');
}

// OHLC 캔들: open/high/low/close 태그를 확정. spec.ohlc에 명시 안 된 키는 실제 태그목록에서 자동 인식
// (정확히 일치(대소문자무시) 우선 → 없으면 해당 단어 포함). 4개 다 확정 못하면 에러 메시지 반환(있으면 null).
function matchTag(allTags, key) {
  var i;
  for (i = 0; i < allTags.length; i++) { if (String(allTags[i]).toLowerCase() === key) return allTags[i]; }
  for (i = 0; i < allTags.length; i++) { if (String(allTags[i]).toLowerCase().indexOf(key) >= 0) return allTags[i]; }
  return null;
}
function resolveOHLC(spec, allTags) {
  spec.ohlc = spec.ohlc || {};
  var keys = ['open', 'high', 'low', 'close'];
  for (var i = 0; i < keys.length; i++) {
    if (!spec.ohlc[keys[i]] && allTags.length) { var hit = matchTag(allTags, keys[i]); if (hit) spec.ohlc[keys[i]] = hit; }
  }
  var missing = [], bad = [];
  for (var j = 0; j < keys.length; j++) {
    var v = spec.ohlc[keys[j]];
    if (!v) missing.push(keys[j]);
    else if (allTags.length && allTags.indexOf(String(v)) < 0) bad.push(keys[j] + ':"' + v + '"');
  }
  if (missing.length === 0 && bad.length === 0) return null;
  return 'kind="ohlc"(캔들차트): open/high/low/close 태그를 확정할 수 없습니다' +
    (missing.length ? ' (자동 인식 실패: ' + missing.join(',') + ')' : '') +
    (bad.length ? ' (존재하지 않는 태그: ' + bad.join(', ') + ')' : '') +
    '. 이 테이블에 OHLC 태그가 없으면 candlestick 대신 일반 line/bar(kind="metrics"/"tags")를 쓰세요.' +
    (allTags.length ? ' 사용 가능 태그: ' + allTags.slice(0, 12).join(', ') + (allTags.length > 12 ? ' …' : '') : '');
}

// 테이블에 ROLLUP 테이블이 있는지 탐지 → cb(boolean)
// · 탐지 실패 시 false(DATE_TRUNC) — ROLLUP 테이블에서도 동작하는 안전한 기본값
function detectRollupAvailable(mc, table, cb) {
  countRollups(mc, table, function (n) { cb(n > 0); });
}

// timeRange 값(ms 숫자/날짜문자열/TO_DATE) → ms
function trMs(v) {
  if (v == null) return 0;
  var s = String(v).trim();
  var m = s.match(/^TO_DATE\s*\(\s*'?([^')]+)'?\s*\)$/i); if (m) s = m[1].trim();
  if (/^\d{10,19}$/.test(s)) return (s.length <= 11) ? parseInt(s, 10) * 1000 : (s.length <= 13) ? parseInt(s, 10) : parseInt(s.substring(0, 13), 10);
  var t = new Date(s).getTime(); return isNaN(t) ? 0 : t;
}

// 범위(ms) → 집계 시간버킷 단위(점 수 수백~수천 유지), 범위 모르면 'hour'
function pickRollupUnit(spec) {
  var tr = spec.timeRange || {};
  var a = trMs(tr.start), b = trMs(tr.end);
  var ms = (a > 0 && b > 0 && b > a) ? (b - a) : 0;
  if (!ms) return 'hour';
  var h = ms / 1000 / 3600;
  if (h < 1) return 'sec';
  if (h < 48) return 'min';
  if (h < 720) return 'hour';
  if (h < 8760) return 'day';
  return 'month';
}

// 집계 metric인데 rollup 누락 → 범위 기반 단위 자동 주입(검증 거부 방지)
// · raw가 섞이면 그대로 둠(validator가 거절)
// · timeRange 확정 후 호출
function defaultRollupIfNeeded(spec) {
  if (!spec || spec.kind !== 'metrics' || spec.rollup != null || !Array.isArray(spec.metrics)) return;
  var hasAgg = false, hasRaw = false;
  for (var i = 0; i < spec.metrics.length; i++) {
    var agg = (spec.metrics[i] && spec.metrics[i].agg) ? String(spec.metrics[i].agg).toLowerCase() : '';
    if (agg === 'raw') hasRaw = true;
    else if (agg) hasAgg = true; // avg/max/min/sum/count/sumsq 등(또는 미지원 agg — 그건 validator가 따로 잡음)
  }
  if (hasAgg && !hasRaw) {
    spec.rollup = pickRollupUnit(spec);
    console.println('[tql_spec] auto rollup="' + spec.rollup + '" 주입 (집계 metric인데 rollup 누락)');
  }
}

// ── 기간·단위 우선순위 (기간 > 단위) ──
// question_time = 사용자 질문에서 뽑은 {period, unit, n} (fixer 주입, 모델 값 아님)
// · 단위만   → 그 단위·배수 유지, 데이터 끝에서 단위 허용 범위만큼 기간을 자름
// · 기간+단위 → 기간 유지, 단위가 기간에 비해 잘면 올림(finalizeBucket)
// · 기간만·없음 → 모델 단위를 범위에 맞게 자동 조절
// 대상: metrics(집계)·ohlc는 단위+기간, tags는 기간 자르기만
var UNIT_MS = { sec: 1000, min: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };

function readQuestionTime(v) {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return null; } }
  if (!v || typeof v !== 'object') return null;
  var unit = UNIT_MS[v.unit] ? v.unit : null;
  var n = parseInt(v.n, 10);
  var out = { period: !!v.period, unit: unit, n: unit && n > 1 ? n : 1 };
  var s = Number(v.start), e = Number(v.end);
  if (s > 0 && e > s) { out.start = s; out.end = e; out.kind = v.kind === 'relative' ? 'relative' : 'calendar'; out.label = String(v.label || ''); }
  return out;
}

// 질문에 그대로 적힌 테이블의 실제 태그 — 대소문자 무시, 앞뒤가 태그 글자(영숫자·_·-·.·:)가 아닐 때만
// · 한 글자·숫자뿐인 태그는 제외("1분 평균"의 "1" 오인 방지)
var TAG_CHAR = /[a-z0-9_.:\-]/;
function mentionedTags(question, allTags) {
  var q = String(question || '').toLowerCase(), out = [];
  (allTags || []).forEach(function (t) {
    var k = String(t).toLowerCase();
    if (k.length < 2 || /^\d+$/.test(k)) return;
    for (var at = q.indexOf(k); at >= 0; at = q.indexOf(k, at + 1)) {
      if (!TAG_CHAR.test(q.charAt(at - 1) || ' ') && !TAG_CHAR.test(q.charAt(at + k.length) || ' ')) { out.push(String(t)); break; }
    }
  });
  return out;
}

// 질문에 적힌 태그가 있으면 모델이 고른 태그 대신 그 태그를 씀
// · metrics: 질문에 적힌 태그가 하나이고 모델 태그가 그게 아닐 때
// · tags: 질문에 둘 이상 적혀 있고 모델 태그와 하나도 안 겹칠 때
function applyQuestionTags(spec, allTags, question, notes) {
  var m = mentionedTags(question, allTags);
  if (!m.length) return;
  if (spec.kind === 'metrics') {
    if (m.length !== 1 || String(spec.tag) === m[0]) return;
    if (spec.tag && String(spec.tag).toLowerCase() !== m[0].toLowerCase()) {
      notes.push('[주의] 질문에 적힌 태그 ' + m[0] + '(으)로 만들었습니다(모델이 고른 태그: ' + spec.tag + ').');
    }
    spec.tag = m[0];
  } else if (spec.kind === 'tags') {
    var cur = Array.isArray(spec.tags) ? spec.tags.map(String) : [];
    if (m.length < 2 || cur.some(function (t) { return m.indexOf(t) >= 0; })) return;
    notes.push('[주의] 질문에 적힌 태그 ' + m.join(', ') + '(으)로 만들었습니다(모델이 고른 태그: ' + cur.join(', ') + ').');
    spec.tags = m;
  }
}

// 질문에서 해석된 기간이 있으면 모델이 넣은 기간 대신 사용 — 데이터가 없을 때 처리는 checkQuestionPeriod
function applyQuestionPeriod(spec, qt) {
  if (!qt || !qt.start || !qt.end || !spec) return;
  if (spec.kind !== 'metrics' && spec.kind !== 'tags' && spec.kind !== 'ohlc') return;
  spec.timeRange = { start: qt.start, end: qt.end };
  spec._period = { kind: qt.kind, label: qt.label, start: qt.start, end: qt.end };
}

// 질문 기간 사후 점검(resolveTimeRange 뒤). 반환 문자열이 있으면 컴파일하지 않고 그대로 결과로
// · calendar: 데이터와 전혀 안 겹치면 안내만(기간을 옮기지 않음), 겹치면 그대로 + 저장 시 0건 스냅 금지(_keepRange)
// · relative: 데이터 끝으로 옮겨졌으면 안내
function checkQuestionPeriod(spec, notes) {
  var p = spec._period, b = spec._bounds;
  delete spec._period; delete spec._bounds;
  if (!p) return '';
  var tr = spec.timeRange || {}, s = trMs(tr.start), e = trMs(tr.end);
  var asked = '"' + p.label + '"(' + fmtTime(p.start) + ' ~ ' + fmtTime(p.end) + ')';
  if (p.kind === 'calendar') {
    spec._keepRange = true;
    if (b && (e < b.min || s > b.max)) {
      return '기간에 데이터 없음: 질문의 기간 ' + asked + '에 이 테이블 데이터가 없습니다(데이터 기간: ' +
        fmtTime(b.min) + ' ~ ' + fmtTime(b.max) + '). 다른 기간으로 바꾸지 말고, 차트를 만들지 않은 채 사용자에게 그 기간에 데이터가 없다고 알리세요.';
    }
    return '';
  }
  if (b && (s !== p.start || e !== p.end)) {
    notes.push('[주의] ' + asked + '은(는) 지금 기준인데 데이터가 ' + fmtTime(b.max) + '까지라, 데이터 마지막 ' +
      fmtDur(e - s) + '(' + fmtTime(s) + ' ~ ' + fmtTime(e) + ')로 옮겼습니다.');
  }
  return '';
}

function fmtDur(ms) {
  var h = ms / 3600000;
  if (h < 1) return Math.round(ms / 60000) + '분';
  if (h < 72) return Math.round(h) + '시간';
  if (h < 24 * 60) return Math.round(h / 24) + '일';
  return '약 ' + Math.round(h / 24 / 30) + '개월';
}
function fmtTime(v) { return toDateLiteral(v).replace(/^TO_DATE\('|'\)$/g, ''); }

function applyQuestionTime(spec, qt, notes) {
  if (!qt || !qt.unit || !spec) return;
  if (spec.kind === 'metrics') {
    if (!Array.isArray(spec.metrics)) return;
    for (var i = 0; i < spec.metrics.length; i++) { // 단위를 말했으면 원시값 대신 그 단위 평균
      if (spec.metrics[i] && String(spec.metrics[i].agg).toLowerCase() === 'raw') spec.metrics[i].agg = 'avg';
    }
  }
  if (spec.kind === 'metrics' || spec.kind === 'ohlc') {
    spec.rollup = qt.unit;
    if (qt.n > 1) spec.rollupN = qt.n; else delete spec.rollupN;
  } else if (spec.kind !== 'tags') {
    return;
  }
  if (qt.period) return;
  if (spec.kind !== 'tags') spec.unitPinned = true;
  var winMs = UNIT_WINDOW_H[qt.unit] * qt.n * 3600000;
  if (!isFinite(winMs)) return;
  var bounds = rangeCache.get(spec.table);
  var tr = spec.timeRange || {};
  var end = bounds ? bounds.max : trMs(tr.end);
  var min = bounds ? bounds.min : trMs(tr.start);
  if (!(end > 0) || !(min > 0) || end - min < winMs) return; // 데이터 전체가 창보다 짧으면 그대로
  spec.timeRange = { start: end - winMs + 1, end: end };
  notes.push('[주의] 질문에 기간이 없어 ' + bucketLabel({ unit: qt.unit, n: qt.n }) + ' 단위에 맞춰 데이터 마지막 ' +
    fmtDur(winMs) + '(' + fmtTime(spec.timeRange.start) + ' ~ ' + fmtTime(end) + ')만 사용했습니다.');
}

// 컴파일 직전 버킷 확정 — 실제 쓸 {unit, n}을 spec에 고정(unitPinned)해 SQL·제목·안내가 같은 값을 쓰게 함
function finalizeBucket(spec, qt, notes) {
  var req, b;
  if (spec.kind === 'metrics' && spec.rollup != null) {
    req = { unit: spec.rollup, n: parseInt(spec.rollupN, 10) > 1 ? parseInt(spec.rollupN, 10) : 1 };
    b = metricsBucket(spec);
  } else if (spec.kind === 'ohlc') {
    req = { unit: spec.rollup || 'day', n: parseInt(spec.rollupN, 10) > 1 ? parseInt(spec.rollupN, 10) : 1 };
    // 캔들은 질문에 기간+단위가 함께 있을 때만 범위에 맞춰 올림(그 외엔 클램프 안 함)
    b = (qt && qt.unit && qt.period && !spec.unitPinned) ? fitBucket(rangeMs(spec), req.unit, req.n, true) : ohlcBucket(spec);
  } else {
    return;
  }
  if (b.unit !== req.unit || b.n !== req.n) {
    var ms = rangeMs(spec);
    var why = b.unit !== req.unit
      ? '기간 ' + fmtDur(ms) + '에 ' + bucketLabel(req) + ' 단위면 점이 약 ' + String(Math.round(ms / (UNIT_MS[req.unit] * req.n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '개'
      : 'ROLLUP을 쓸 수 없는 경로라 하루를 넘는 배수 불가';
    notes.push('[주의] 요청 단위 ' + bucketLabel(req) + ' → ' + bucketLabel(b) + '로 조정했습니다(' + why + ').');
  }
  spec.rollup = b.unit;
  if (b.n > 1) spec.rollupN = b.n; else delete spec.rollupN;
  spec.unitPinned = true;
}

// spec.timeRange를 테이블 실제 데이터 경계로 보정(0건 방지) — range_cache 우선, 미스면 1회 조회
// · timeRange 누락 → 데이터 전체 범위
// · 요청 끝이 데이터 밖 → 데이터 끝 기준으로 기간 길이 유지 시프트
// · 질문이 지정한 달력 기간·범위 안 → 그대로
function resolveTimeRange(mc, spec, cb) {
  if (!spec || !spec.table) return cb();
  function apply(bounds) {
    if (!bounds || !(bounds.min > 0) || !(bounds.max > 0)) return cb();
    spec._bounds = bounds;
    var tr = spec.timeRange || {};
    var s = trMs(tr.start), e = trMs(tr.end);
    if (!(s > 0) || !(e > 0)) { spec.timeRange = { start: bounds.min, end: bounds.max }; return cb(); }
    if (spec._period && spec._period.kind === 'calendar') return cb(); // 질문이 콕 집은 기간은 옮기지 않음
    if (e > bounds.max || e < bounds.min) {
      var dur = e - s; if (dur <= 0) dur = bounds.max - bounds.min;
      spec.timeRange = { start: Math.max(bounds.min, bounds.max - dur), end: bounds.max };
    }
    cb();
  }
  var cached = rangeCache.get(spec.table);
  if (cached) return apply(cached);
  var tcol = spec.timeCol || 'TIME';
  mc.querySQL('SELECT MIN(' + tcol + '), MAX(' + tcol + ') FROM ' + String(spec.table).toUpperCase(), 'ms', '', '', function (err, raw) {
    var bounds = null;
    if (!err) {
      try {
        var p = JSON.parse(raw);
        if (p && p.data && p.data.rows && p.data.rows.length) {
          var mn = parseInt(String(p.data.rows[0][0]), 10), mx = parseInt(String(p.data.rows[0][1]), 10);
          if (mn > 0 && mx > 0) { bounds = { min: mn, max: mx }; rangeCache.set(spec.table, mn, mx); }
        }
      } catch (e) {}
    }
    apply(bounds);
  });
}

function register(registry, mc) {
  registry.register({
    name: 'compile_tql_from_spec',
    description:
      '분석 의도(IR JSON)로 실행 검증된 TQL을 컴파일한다. raw TQL을 직접 쓰지 말 것(문법/함정은 서버가 보장). ' +
      'filename을 주면 .tql로 저장(대시보드 차트용, charts의 tql_path로 사용), 생략하면 검증된 TQL 텍스트를 반환("이 테이블 TQL 알려줘" 답변용).',
    parameters: {
      type: 'object',
      properties: {
        spec: {
          type: 'object',
          description:
            'TIR 의도 JSON. ' +
            'kind="metrics"(단일태그): {table, tag, rollup(sec~month 또는 null), rollupN(선택, 배수 — 5분 평균이면 rollup:"min", rollupN:5), timeRange:{start,end}, metrics:[{agg,label}]} (agg: avg/max/min/sum/count/sumsq=rollup 필요, raw=rollup null). ' +
            'kind="tags"(여러태그 비교): {table, tags:[...], timeRange} (ROLLUP과 동시 불가). ' +
            'kind="ohlc"(OHLC 캔들차트, 주가/시세): {table, timeRange, rollup(캔들 버킷 단위, 기본 day)}. open/high/low/close 태그는 도구가 자동 인식(필요 시 ohlc:{open,high,low,close}로 명시). agg/metrics 불필요. ' +
            'kind="geomap"(지도/좌표): 특정 테이블 없으면 table 생략 → FAKE 좌표 예제(timeRange 불필요). 실제데이터는 {table, lat, lon[, value], markerType}. ' +
            'output(선택): {chartType:"line"|"bar"(ohlc는 candlestick 자동), title, subtitle}.',
        },
        filename: {
          type: 'string',
          description: '(선택) 저장 경로 "TABLE/name.tql"(영어만). 주면 저장(대시보드), 생략하면 검증된 TQL만 반환(답변).',
        },
      },
      required: ['spec'],
    },
    fn: function (args, cb) {
      // spec(객체/문자열/잘린문자열) + 최상위로 쪼개진 필드를 하나로 재조립 — 모델의 다양한 호출 형태 흡수.
      var spec = assembleSpec(args);
      if (!spec.table && !spec.kind && !spec.tag && !spec.tags && !spec.metrics) {
        return cb(null, 'Error: spec을 해석하지 못했습니다(잘린 JSON일 수 있음: ' +
          (typeof args.spec === 'string' ? args.spec.length + '자 문자열' : typeof args.spec) + ').' +
          '\n→ spec을 문자열이 아니라 JSON 객체로 전달하세요. timeRange/valueCol/metrics 등을 별도 인자로 쪼개지 말고 spec 안에 넣으세요.');
      }
      spec = normalizeSpec(spec); // 쉼표 tag → kind=tags 등 입력 정규화
      spec._tz = zoneName(mc); // 차트 시간축 = 사용자 시간대
      var qt = readQuestionTime(args.question_time);
      var notes = []; // 단위·기간을 바꾼 내용 — 성공 결과에 붙여 모델이 답변에 반영

      // 컴파일 전 DB에서 자동 주입: 실제 컬럼명·데이터 기간·태그 보정·ROLLUP 가용성 또는 점 개수
      if (spec && typeof spec === 'object' && spec.table) {
        // 테이블 이름 정규화(DB.유저.테이블) — 아래 컬럼·태그·시간범위·점개수 조회가 공용
        // · 없음·모호는 컴파일 전에 오류 반환
        resolveTableRef(mc, spec.table, function (refErr, ref) {
        if (refErr) return cb(null, 'Error: ' + refErr.message);
        spec.table = ref.qualified;
        detectColumns(mc, spec.table, function (c) {
          spec.nameCol = c.n; spec.timeCol = c.t; spec.valueCol = c.v;
          applyQuestionPeriod(spec, qt); // 질문에 기간이 있으면 모델 값 대신 그 기간
          resolveTimeRange(mc, spec, function () { // timeRange 누락/범위밖 → 캐시 경계로 자동 보정(0건 방지)
          var periodMsg = checkQuestionPeriod(spec, notes);
          if (periodMsg) return cb(null, periodMsg);
          applyQuestionTime(spec, qt, notes); // 질문에 단위만 있으면 단위 유지 + 기간 자르기
          defaultRollupIfNeeded(spec); // 집계 metric인데 rollup 누락 → 범위 기반 단위 자동 주입
          // 태그 존재 검증 — 잘못된 태그면 컴파일 전에 유사 태그 제안과 함께 거절(0건 헛수고 방지)
          detectTags(mc, spec.table, c.n, function (allTags) {
            // OHLC(캔들): open/high/low/close 태그 자동 확정(또는 명시값 검증). 실패 시 거절.
            // 캔들은 DATE_TRUNC 고정 + 버킷이라 ROLLUP 가용성/점수 탐지 불필요 → 바로 컴파일.
            if (spec.kind === 'ohlc') {
              var oerr = resolveOHLC(spec, allTags);
              if (oerr) return cb(null, 'Error: ' + oerr);
              return proceed();
            }
            applyQuestionTags(spec, allTags, args.question, notes); // 질문에 적힌 실제 태그가 있으면 그 태그로
            applyColumnTag(spec, allTags, [c.n, c.t, c.v], notes); // 태그 자리의 컬럼 이름 → 실제 태그
            var tagErr = validateTags(spec, allTags);
            if (tagErr) return cb(null, 'Error: ' + tagErr);
            if (spec.kind === 'metrics' && spec.rollup != null) {
              detectRollupAvailable(mc, spec.table, function (avail) {
                spec.rollupAvailable = avail;
                proceed();
              });
            } else {
              // raw 산출(tags / metrics+rollup=null) → 실제 점 개수로 raw vs 적응형 버킷 결정
              detectPointCount(mc, spec, function (cnt) {
                if (cnt > POINT_BUCKET_THRESHOLD) spec.bucket = true;
                proceed();
              });
            }
          });
          }); // resolveTimeRange
        });
        }); // resolveTableRef
      } else {
        proceed();
      }

      // 성공 결과에만 단위·기간 조정 안내를 붙임
      // · 결과 맨 앞에 둠 — 약한 모델은 긴 결과(TQL 코드)의 뒷부분을 놓침
      function withNotes(res) {
        if (!notes.length) return res;
        return notes.join('\n') + '\n→ 답변에는 위의 실제 태그·단위·기간을 그대로 적으세요.\n\n' + String(res);
      }

      function proceed() {
        finalizeBucket(spec, qt, notes);
        var keepRange = !!spec._keepRange; // 질문이 콕 집은 기간 — 저장 시 0건이어도 기간을 옮기지 않음
        delete spec._keepRange;
        // ── 컴파일 (심볼릭 코어) ──
        var r = compileSafe(spec);
        if (!r.ok) {
          return cb(null, 'Error: ' + r.error + '\n→ spec(JSON)을 고쳐 다시 호출하세요(TQL을 직접 작성하지 마세요).');
        }

        var filename = argStr(args, 'filename', '');

        if (filename) {
          // 이미 저장한 차트(동일 TQL, 이름만 다름) 반복 저장 차단 — 대시보드 동일 차트 중복 방지
          // · 'Error:'로 시작 안 함 — 중복은 건너뛰기라 agent의 compileFailStreak(하드캡) 집계 제외
          // · 반복 중복은 _dupeStreak로 차단
          if (savedRecently(r.tql)) {
            _dupeStreak++;
            if (_dupeStreak >= 3) { // 중복이 반복되면 더 끌지 말고 결정론적으로 마무리 유도
              return cb(null, '건너뜀: 같은 차트가 계속 중복됩니다(' + _dupeStreak + '회). **더 만들지 말고**, 지금까지 저장에 성공한 .tql들로 즉시 create_dashboard_with_charts를 호출해 대시보드를 완성하세요.');
            }
            return cb(null, '건너뜀: 이미 저장한 차트와 같아 저장하지 않았습니다(중복, 에러 아님). 이 차트는 잊고 **다음 차트(다른 태그/집계/rollup/kind)로 넘어가거나**, 이미 충분하면 create_dashboard_with_charts로 대시보드를 생성하세요.');
          }
          _dupeStreak = 0; // 고유 차트 통과 → 중복 스트릭 리셋
          // ── ① 대시보드 경로: save_tql_file 백스톱 재사용(소유권/executeTQL/0건/레이아웃/쓰기) ──
          var saveTool = registry.get('save_tql_file');
          if (!saveTool) return cb(null, 'Error: save_tql_file 도구를 찾을 수 없습니다.');
          return saveTool.fn({ filename: filename, tql_content: r.tql, keep_range: keepRange }, function (serr, sres) {
            var saved = String(sres || '').indexOf('TQL file saved') === 0;
            if (saved) markSaved(r.tql);
            cb(serr, saved ? withNotes(sres) : sres);
          });
        }

        // ── ② 답변 경로: 저장 없이 실행 검증만 → 검증된 TQL 텍스트 반환 ──
        var execTool = registry.get('execute_tql_script');
        if (!execTool) return cb(null, 'Error: execute_tql_script 도구를 찾을 수 없습니다.');
        execTool.fn({ tql_content: r.tql }, function (eerr, eres) {
          var s = String(eres || '');
          var low = s.toLowerCase();
          // execute_tql_script는 에러를 'Error: '로 반환. Machbase는 쿼리에러를 HTTP200+{"success":false}로도 반환 가능 → 검출.
          if (s.indexOf('Error:') === 0 || s.indexOf('MACH-ERR') >= 0 ||
              low.indexOf('"success":false') >= 0 || low.indexOf('"success": false') >= 0) {
            return cb(null, 'Error: 컴파일된 TQL 실행 검증 실패: ' + s.substring(0, 300) +
              '\n(커버된 의도가 아닐 수 있음 — spec을 단순화하세요)');
          }
          cb(null, withNotes('실행 검증됨(executeTQL 성공). 아래 TQL을 그대로 답변에 ```tql 코드블록으로 제시하세요:\n\n```tql\n' + r.tql + '```'));
        });
      }
    },
  });
}

module.exports = {
  register,
  detectColumns,
  detectTags,
  // forecast_table 등 다른 도구에서 재사용하는 DB 탐지/보정 헬퍼
  resolveTimeRange,
  pickRollupUnit,
  detectRollupAvailable,
  // 기간·단위 우선순위(유닛 테스트용)
  normalizeSpec,
  readQuestionTime,
  applyQuestionTime,
  finalizeBucket,
  applyQuestionPeriod,
  checkQuestionPeriod,
  mentionedTags,
  applyQuestionTags,
  applyColumnTag,
  validateTags,
};
