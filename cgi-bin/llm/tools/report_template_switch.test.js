// Node unit test for report template routing (report.js):
//  1) auto-detect uses TABLE NAME too (BEARING + tags C1/C2 → R-2-vibration)
//  2) 2차 호출의 명시적 template_id가 캐시(_templateID)와 다르면 캐시 무효화 + 풀 재실행(compute 포함)
//  3) 같은 template이면 기존처럼 캐시 히트(재조회 없음)
//  4) 템플릿 전환 재실행 시 이전 호출에서 모아둔 analysis 조각 승계
// Run: node cgi-bin/llm/tools/report_template_switch.test.js
var path = require('path');
process.chdir(path.join(__dirname, '..')); // cgi-bin/llm so template loader locates ./neo

if (!console.println) console.println = function (s) { console.log(s); };

// ── mock mc ────────────────────────────────────────────────────────────────
var queryLog = [];      // all SQL issued
var savedFiles = [];    // { filename, html }

function rowsJSON(rows) { return JSON.stringify({ success: true, data: { rows: rows } }); }

var mockMc = {
  baseURL: 'http://localhost:5654',
  querySQL: function (sql, fmt, tz, opt, cb) {
    queryLog.push(sql);
    // column detection (tql_spec.detectColumns)
    if (sql.indexOf('M$SYS_COLUMNS') >= 0) {
      return cb(null, rowsJSON([['NAME', 134217728], ['TIME', 16777216], ['VALUE', 33554432]]));
    }
    // tag list
    if (sql.indexOf('V$') >= 0 && sql.indexOf('_STAT') >= 0) {
      return cb(null, rowsJSON([['C1'], ['C2']]));
    }
    // per-tag stats
    if (sql.indexOf('COUNT(*) as cnt') >= 0) {
      return cb(null, rowsJSON([['C1', 100, 1.0, -2.0, 2.0], ['C2', 100, 1.1, -2.1, 2.1]]));
    }
    // vibration rollup (SUMSQ) — compute가 돌았는지의 증거
    if (sql.indexOf('SUMSQ') >= 0) {
      return cb(null, rowsJSON([
        ['2026-07-10 00:00:00', 1.0, -2.0, 2.0, 400, 100],
        ['2026-07-10 00:01:00', 1.1, -2.1, 2.1, 440, 100],
      ]));
    }
    // MIN/MAX time: refineRollupFromData(fmt='ms') / step-3 time range(fmt='Default')
    if (sql.indexOf('SELECT MIN(') >= 0 && sql.indexOf('MAX(') >= 0) {
      if (fmt === 'ms') return cb(null, rowsJSON([[1752000000000, 1752003600000]])); // 1h span
      return cb(null, rowsJSON([['2026-07-10 00:00:00', '2026-07-10 01:00:00']]));
    }
    // raw waveform / FFT source
    if (sql.indexOf('LIMIT 4096') >= 0 || sql.indexOf('LIMIT 131072') >= 0) {
      var rows = [];
      for (var i = 0; i < 64; i++) {
        var t = fmt === 'ms' ? (1752000000000 + i * 10) : (1752000000000000000 + i * 10000000);
        rows.push([t, Math.sin(i / 4)]);
      }
      return cb(null, rowsJSON(rows));
    }
    return cb(null, rowsJSON([]));
  },
  writeFile: function (filename, html, cb) { savedFiles.push({ filename: filename, html: html }); cb(null); },
  createFolder: function (name, cb) { cb(null); },
};

var report = require('./report');
var tools = {};
report.register({ register: function (t) { tools[t.name] = t; } }, mockMc);
function call(args) {
  var out;
  tools.save_html_report.fn(args, function (e, r) { out = r; });
  return out;
}
function sumsqCount() { return queryLog.filter(function (q) { return q.indexOf('SUMSQ') >= 0; }).length; }

var pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('ok  - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}

// ── T1: 테이블명 기반 자동감지 (BEARING, 태그 C1/C2, template_id 없음) ──────
var r1 = call({ table: 'BEARING' });
check('T1 auto-detect: 1차 응답이 analysis 작성 요청', r1.indexOf('다시 호출') >= 0);
check('T1 auto-detect: vibration compute 실행됨(요약에 계산 결과 포함)', r1.indexOf('RMS') >= 0);
check('T1 auto-detect: SUMSQ 롤업 조회 발생', sumsqCount() > 0);

// ── T2: 템플릿 전환 — 1차 R-0 캐시 후 2차에서 명시적 R-2 (ornith 시나리오) ──
// PUMP는 태그(C1/C2)도 테이블명도 vibration 키워드 불일치 → 1차는 R-0-general로 캐시됨
var r2a = call({ table: 'PUMP' });
check('T2 1차: R-0로 캐시됨(compute 요약 없음)', r2a.indexOf('RMS 추이') < 0);
var before = sumsqCount();
var r2b = call({ table: 'PUMP', template_id: 'R-2-vibration', analysis: '## 분석\n본문', recommendations: '1. **항목**' });
check('T2 2차: 리포트 저장됨', String(r2b).indexOf('Report saved') >= 0);
check('T2 2차: 캐시 무효화로 compute 재실행(SUMSQ 재조회)', sumsqCount() > before);
var saved2 = savedFiles[savedFiles.length - 1];
check('T2 2차: R-2 진동 템플릿으로 렌더링', saved2 && saved2.html.indexOf('진동 데이터 분석 리포트') >= 0);

// ── T3: 같은 template 재호출은 캐시 히트(재조회 없음) ──────────────────────
var before3 = sumsqCount();
var r3 = call({ table: 'PUMP', template_id: 'R-2-vibration', analysis: '## 분석2\n본문', recommendations: '1. **항목2**' });
check('T3 동일 템플릿: 저장됨', String(r3).indexOf('Report saved') >= 0);
check('T3 동일 템플릿: 캐시 히트(SUMSQ 재조회 없음)', sumsqCount() === before3);

// ── T4: 전환 재실행 시 이전에 모아둔 analysis 조각 승계 ────────────────────
call({ table: 'FAN' });                                   // R-0 캐시
var r4a = call({ table: 'FAN', analysis: '유일한분석본문AAA' }); // 조각 축적 (template 미지정 → 캐시 유지)
check('T4 조각 축적: recommendations 요청 응답', String(r4a).indexOf('recommendations') >= 0);
var r4b = call({ table: 'FAN', template_id: 'R-2-vibration', recommendations: '1. **권고**' });
check('T4 전환+승계: 저장됨', String(r4b).indexOf('Report saved') >= 0);
var saved4 = savedFiles[savedFiles.length - 1];
check('T4 전환+승계: 이전 analysis가 리포트에 포함', saved4 && saved4.html.indexOf('유일한분석본문AAA') >= 0);
check('T4 전환+승계: R-2 템플릿', saved4 && saved4.html.indexOf('진동 데이터 분석 리포트') >= 0);

// ── T5: 질문 문구 기반 빌트인 라우팅 (matchBuiltinByQuery) ──────────────────
var mt = require('./report_templates');
check('T5 "진동 분석 리포트" → R-2', mt.matchBuiltinByQuery('BEARING 테이블 진동 분석 리포트 만들어줘') === 'R-2-vibration');
check('T5 "종합"은 불용어(전 템플릿 공통어라 매칭 무효화 방지)', mt.matchBuiltinByQuery('BEARING 진동 종합 분석 리포트') === 'R-2-vibration');
check('T5 주제어 없으면 미매칭(자동감지로 폴백)', mt.matchBuiltinByQuery('BEARING 테이블 분석 리포트 만들어줘') === '');
check('T5 "운전 행동 리포트" → R-3', mt.matchBuiltinByQuery('운전 행동 리포트 작성') === 'R-3-driving');
check('T5 "금융 리포트" → R-1', mt.matchBuiltinByQuery('금융 리포트 만들어줘') === 'R-1-finance');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
