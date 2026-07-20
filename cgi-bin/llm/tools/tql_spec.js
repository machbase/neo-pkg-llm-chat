// compile_tql_from_spec — TIR(의도 JSON) → 검증된 TQL 도구.
//
// 하나의 컴파일러(tir/compile)를 두 소비자에게 노출:
//   ① 대시보드 경로 (filename 있음) → 컴파일 → save_tql_file 백스톱으로 저장 → charts의 tql_path
//   ② "TQL 알려줘" 답변 경로 (filename 없음) → 컴파일 → execute_tql_script로 실행 검증 → TQL 텍스트 반환
//
// 양쪽 다 실행 검증을 거치므로 "실행 안 되는 TQL"이 나갈 수 없다(커버된 의도 한정).
// raw TQL 작성/문법 함정은 컴파일러가 보장 → LLM은 의도(JSON)만 책임.

var { compileSafe, toDateLiteral } = require('./tir/compile');
var { argStr } = require('./registry');
var rangeCache = require('./range_cache');

// 같은 차트(동일 TQL, 이름만 다름)를 반복 생성하는 것 차단 → 다양성 유도. TTL 자동 리셋(턴 경계 추적 불필요).
var _seenTQL = {};
var SEEN_TTL = 3 * 60 * 1000;
var _dupeStreak = 0; // 연속 중복 횟수(약한 모델 중복 루프 차단용). 고유 차트 통과 시 리셋.
function seenRecentlyTQL(tql) {
  var now = Date.now(), k = String(tql).replace(/\s+/g, ' ').trim();
  for (var key in _seenTQL) { if (now - _seenTQL[key] > SEEN_TTL) delete _seenTQL[key]; }
  if (_seenTQL[k] && (now - _seenTQL[k]) <= SEEN_TTL) return true;
  _seenTQL[k] = now;
  return false;
}

var POINT_BUCKET_THRESHOLD = 50000; // 실제 점 개수가 이보다 많으면 적응형 버킷, 이하면 raw(+lttb 렌더)

// 약한 모델이 긴 spec 문자열에서 흔히 내는 JSON 오류를 보정해 살린다(strict 파싱 실패 시에만 → 유효 JSON은 불변).
// 대표 오류: 따옴표 없는 키(예: `,tag:` → "invalid character 't' looking for beginning of object key string").
// 보정은 best-effort 폴백 — 잘못 고쳐도 validator/컴파일러가 다시 잡으므로 순손해 없음(원래 실패하던 입력만 대상).
// 잘린(EOF) JSON 살리기: 문자열을 스캔해 마지막 완전한 최상위 필드까지 자르고 열린 브래킷을 닫는다.
// 모델이 긴 spec 문자열을 중간에 끊어 보내는 경우(Unexpected end of JSON input) 부분 복구.
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
  // head 안의 열린 브래킷을 계산해 닫는다(문자열 내부 무시).
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

// 모델이 spec을 (a)객체 (b)문자열 (c)잘린문자열 (d)필드를 최상위 인자로 쪼개서 — 다양하게 넘긴다.
// 어떤 형태든 하나의 spec 객체로 재조립. 잘린 spec 문자열은 부분복구 + 최상위 인자로 보충.
var SPEC_FIELDS = ['table', 'kind', 'tag', 'tags', 'rollup', 'timeRange', 'metrics', 'agg',
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

// 최후 폴백: 심하게 깨진/잘린 JSON에서도 정규식으로 핵심 필드를 긁어낸다(table/kind/tag/tags/timeRange).
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

// raw 차트(tags / metrics+rollup=null)의 실제 점 개수를 COUNT로 추정 → 5만 초과면 spec.bucket=true.
// (범위만으론 부정확 — 밀도가 다르므로. 실제 점 수가 진짜 기준.)
function detectPointCount(mc, spec, cb) {
  var nameCol = spec.nameCol || 'NAME', timeCol = spec.timeCol || 'TIME';
  var tags = (spec.kind === 'tags') ? (spec.tags || []) : (spec.tag != null ? [spec.tag] : []);
  if (tags.length === 0) return cb(0);
  var inList = tags.map(function (t) { return "'" + String(t).replace(/'/g, "''") + "'"; }).join(', ');
  var sql = 'SELECT COUNT(*) FROM ' + String(spec.table).toUpperCase() + ' WHERE ' + nameCol + ' IN (' + inList + ')';
  var tr = spec.timeRange || {};
  if (tr.start && tr.end) sql += ' AND ' + timeCol + ' BETWEEN ' + toDateLiteral(tr.start) + ' AND ' + toDateLiteral(tr.end);
  mc.querySQL(sql, '', '', '', function (err, res) {
    if (err) return cb(0); // 못 세면 raw 유지(과잉버킷 방지)
    var n = 0;
    try { var p = JSON.parse(res); if (p && p.success && p.data && p.data.rows && p.data.rows.length) n = parseInt(String(p.data.rows[0][0]), 10) || 0; } catch (e) {}
    cb(n);
  });
}

// 테이블의 실제 컬럼명 탐지 (PK/BASETIME/SUMMARIZED). cb({n,t,v}). describe_table와 동일 로직.
// 모델은 컬럼명을 몰라도 됨 — 커스텀 컬럼(NAME/TIME/VALUE 아닌) 테이블 자동 대응.
function detectColumns(mc, table, cb) {
  var u = String(table).toUpperCase();
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

// 입력 정규화: 모델이 tag에 쉼표로 여러 태그를 넣으면("a,b,c") 다중태그 비교 의도 → kind="tags"로 변환.
// (table-based 차트의 "high,low" 쉼표 관례를 IR에도 쓰는 약한 모델 대응 — 의도는 명확하니 컴파일러가 수용)
function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  if (typeof spec.tag === 'string' && spec.tag.indexOf(',') >= 0) {
    var parts = spec.tag.split(',').map(function (s) { return String(s).trim(); }).filter(Boolean);
    if (parts.length > 1) {
      spec.kind = 'tags'; spec.tags = parts;
      delete spec.tag; delete spec.rollup; delete spec.metrics; // tags는 raw 비교
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
  // kind=metrics(또는 tag만 준 경우)인데 metrics 배열 누락/빈 경우 → 단일 시리즈 기본값 자동 채움.
  // 의도("이 태그를 차트로")는 명확하니 컴파일러가 합리적 기본을 채운다(rollup 있으면 avg, 없으면 raw).
  // → 약한 모델이 metrics를 빠뜨려도 검증 거부 무한루프에 빠지지 않는다.
  if ((spec.kind === 'metrics' || (!spec.kind && spec.tag && !spec.tags)) && spec.tag &&
      (!Array.isArray(spec.metrics) || spec.metrics.length === 0)) {
    spec.kind = 'metrics';
    spec.metrics = [{ agg: (spec.rollup != null ? 'avg' : 'raw'), label: String(spec.tag) }];
  }
  // raw/rollup 모순 자동 해소: rollup이 지정되면 raw(원시)는 불가 → avg로 강등.
  // 이로써 "raw는 rollup=null만" + "raw는 단일 시리즈만" 두 위반이 동시에 해소됨(avg는 다중 시리즈/rollup 허용).
  if (spec.kind === 'metrics' && spec.rollup != null && Array.isArray(spec.metrics)) {
    for (var _mi = 0; _mi < spec.metrics.length; _mi++) {
      var _mm = spec.metrics[_mi];
      if (_mm && String(_mm.agg).toLowerCase() === 'raw') _mm.agg = 'avg';
    }
  }
  // output.chartType 그레이스풀 보정: 미지원 값은 거절 대신 강등(scatter/area/pie 등도 막히지 않게).
  if (spec.output && spec.output.chartType != null) {
    var _ct = String(spec.output.chartType).toLowerCase();
    if (spec.kind === 'ohlc') spec.output.chartType = 'candlestick';
    else if (_ct.indexOf('bar') >= 0) spec.output.chartType = 'bar';
    else spec.output.chartType = 'line'; // line/scatter/area/pie/candlestick(비ohlc)/미상 → line
  }
  return spec;
}

// 테이블의 실제 태그 목록 탐지 (_table_meta의 태그명 컬럼). cb([tags]).
function detectTags(mc, table, nameCol, cb) {
  var u = String(table).toLowerCase();
  mc.querySQL('SELECT ' + nameCol + ' FROM _' + u + '_meta', '', '', '', function (err, res) {
    var tags = [];
    if (!err) {
      try { var p = JSON.parse(res); if (p && p.success && p.data && p.data.rows) { for (var i = 0; i < p.data.rows.length; i++) tags.push(String(p.data.rows[i][0])); } } catch (e) {}
    }
    cb(tags);
  });
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

// 테이블에 ROLLUP 테이블이 있는지 탐지 (describe_table와 동일 쿼리). cb(boolean).
// 탐지 실패 시 false(DATE_TRUNC) — DATE_TRUNC는 ROLLUP 테이블에서도 동작하므로 안전한 기본값.
function detectRollupAvailable(mc, table, cb) {
  var u = String(table).toUpperCase();
  mc.querySQL("SELECT COUNT(*) FROM M$SYS_TABLES WHERE NAME LIKE '_" + u + "_ROLLUP_%' AND FLAG = 2", '', '', '', function (err, res) {
    if (err) return cb(false);
    var n = 0;
    try { var p = JSON.parse(res); if (p && p.success && p.data && p.data.rows && p.data.rows.length) n = parseInt(String(p.data.rows[0][0]), 10); } catch (e) {}
    cb(n > 0);
  });
}

// timeRange 값(ms 숫자/날짜문자열/TO_DATE) → ms
function trMs(v) {
  if (v == null) return 0;
  var s = String(v).trim();
  var m = s.match(/^TO_DATE\s*\(\s*'?([^')]+)'?\s*\)$/i); if (m) s = m[1].trim();
  if (/^\d{10,19}$/.test(s)) return (s.length <= 11) ? parseInt(s, 10) * 1000 : (s.length <= 13) ? parseInt(s, 10) : parseInt(s.substring(0, 13), 10);
  var t = new Date(s).getTime(); return isNaN(t) ? 0 : t;
}

// 범위(ms) → 집계 시간버킷 단위 (compile.js pickUnit과 동일 기준; 점 수를 수백~수천으로 유지). 범위 모르면 'hour'.
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

// 집계 metric인데 rollup이 누락된 경우 → 범위 기반 기본 단위를 자동 주입(검증 거부 없이 첫 호출 통과).
// normalizeSpec의 자동보정 철학 연장 — 서버는 어차피 ROLLUP/DATE_TRUNC로 자동 집계하니 "단위만" 정하면 됨.
// 단, raw가 섞였으면(=실제 모델 실수) 건드리지 않고 validator가 표면화하게 둔다. timeRange 해소 후 호출(범위 기반 단위 선택).
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

// spec.timeRange를 테이블 실제 데이터 경계로 보정(0건 방지). describe_table가 채운 range_cache 우선(조회 0회), 미스면 1회 조회.
//  - timeRange 누락 → 데이터 전체 범위로 자동 채움
//  - 요청 끝이 데이터 밖(미래꼬리/완전과거) → 데이터 끝 기준 기간유지 시프트(dashboard B 규칙과 동일)
//  - 그 외(범위 안) → 그대로 존중
function resolveTimeRange(mc, spec, cb) {
  if (!spec || !spec.table) return cb();
  function apply(bounds) {
    if (!bounds || !(bounds.min > 0) || !(bounds.max > 0)) return cb();
    var tr = spec.timeRange || {};
    var s = trMs(tr.start), e = trMs(tr.end);
    if (!(s > 0) || !(e > 0)) { spec.timeRange = { start: bounds.min, end: bounds.max }; return cb(); }
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
            'kind="metrics"(단일태그): {table, tag, rollup(sec~month 또는 null), timeRange:{start,end}, metrics:[{agg,label}]} (agg: avg/max/min/sum/count/sumsq=rollup 필요, raw=rollup null). ' +
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

      // 컴파일 전 DB에서 자동 주입: ① 실제 컬럼명(커스텀 컬럼 대응) ② 집계면 ROLLUP 가용성(ROLLUP/DATE_TRUNC).
      // 모델은 컬럼명도 ROLLUP 유무도 몰라도 됨 — 도구가 채운다.
      if (spec && typeof spec === 'object' && spec.table) {
        detectColumns(mc, spec.table, function (c) {
          spec.nameCol = c.n; spec.timeCol = c.t; spec.valueCol = c.v;
          resolveTimeRange(mc, spec, function () { // timeRange 누락/범위밖 → 캐시 경계로 자동 보정(0건 방지)
          defaultRollupIfNeeded(spec); // 집계 metric인데 rollup 누락 → 범위 기반 단위 자동 주입(검증거부 대신 첫 호출 통과)
          // 태그 존재 검증 — 잘못된 태그면 컴파일 전에 유사 태그 제안과 함께 거절(0건 헛수고 방지)
          detectTags(mc, spec.table, c.n, function (allTags) {
            // OHLC(캔들): open/high/low/close 태그 자동 확정(또는 명시값 검증). 실패 시 거절.
            // 캔들은 DATE_TRUNC 고정 + 버킷이라 ROLLUP 가용성/점수 탐지 불필요 → 바로 컴파일.
            if (spec.kind === 'ohlc') {
              var oerr = resolveOHLC(spec, allTags);
              if (oerr) return cb(null, 'Error: ' + oerr);
              return proceed();
            }
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
      } else {
        proceed();
      }

      function proceed() {
        // ── 컴파일 (심볼릭 코어) ──
        var r = compileSafe(spec);
        if (!r.ok) {
          return cb(null, 'Error: ' + r.error + '\n→ spec(JSON)을 고쳐 다시 호출하세요(TQL을 직접 작성하지 마세요).');
        }

        // 같은 차트(동일 TQL, 이름만 다름) 반복 생성 차단 → 대시보드에 동일 차트가 6개씩 들어가는 것 방지.
        // ⚠️ 'Error:'로 시작하지 않는다 — 중복은 "컴파일 실패"가 아니라 "건너뛰기"이므로 agent의 compileFailStreak(하드캡)에
        //    안 잡히게 한다(약한 모델이 중복 몇 번에 조기 finalize로 떠밀려 차트가 적어지는 것 방지). 반복 중복은 별도 _dupeStreak로 차단.
        if (seenRecentlyTQL(r.tql)) {
          _dupeStreak++;
          if (_dupeStreak >= 3) { // 중복이 반복되면 더 끌지 말고 결정론적으로 마무리 유도
            return cb(null, '건너뜀: 같은 차트가 계속 중복됩니다(' + _dupeStreak + '회). **더 만들지 말고**, 지금까지 저장에 성공한 .tql들로 즉시 create_dashboard_with_charts를 호출해 대시보드를 완성하세요.');
          }
          return cb(null, '건너뜀: 직전과 동일한 차트라 저장하지 않았습니다(중복, 에러 아님). 이 차트는 잊고 **다음 차트(다른 태그/집계/rollup/kind)로 넘어가거나**, 이미 충분하면 create_dashboard_with_charts로 대시보드를 생성하세요.');
        }
        _dupeStreak = 0; // 고유 차트 통과 → 중복 스트릭 리셋

        var filename = argStr(args, 'filename', '');

        if (filename) {
          // ── ① 대시보드 경로: 기존 save_tql_file 백스톱 재사용(소유권/executeTQL/0건/레이아웃/쓰기) ──
          var saveTool = registry.get('save_tql_file');
          if (!saveTool) return cb(null, 'Error: save_tql_file 도구를 찾을 수 없습니다.');
          return saveTool.fn({ filename: filename, tql_content: r.tql }, cb);
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
              '\n(커버된 의도가 아닐 수 있음 — spec을 단순화하거나 특수 분석은 raw 폴백)');
          }
          cb(null, '실행 검증됨(executeTQL 성공). 아래 TQL을 그대로 답변에 ```tql 코드블록으로 제시하세요:\n\n```tql\n' + r.tql + '```');
        });
      }
    },
  });
}

module.exports = {
  register, detectColumns, detectTags,
  // forecast_table 등 다른 도구에서 재사용하는 DB 탐지/보정 헬퍼
  resolveTimeRange, pickRollupUnit, detectRollupAvailable, trMs,
};
