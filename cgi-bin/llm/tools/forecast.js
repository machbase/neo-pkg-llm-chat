// forecast_table — 특정 테이블 태그의 "이후 데이터" 예측 도구.
//
// compile_tql_from_spec(순수 spec→TQL)와 달리, 예측은 데이터에 의존한다:
//   ① 워커가 버킷 이력을 조회해 forecast_algo 엔진으로 모델을 **자동 선택**하고 추세/예측/신뢰밴드 계산(텍스트 요약)
//   ② TIR 컴파일러(kind="forecast")가 **라이브 재계산 .tql**을 생성 — 같은 엔진(algoSource)을 SCRIPT에 구워넣어
//      차트를 열 때마다 현재 데이터로 다시 적합한다(워커와 동일 코드 → 차트==요약, 대시보드에서 안 낡음).
//
// 예측 기법(v1.2, method="auto"): 자기상관으로 주기 탐지 후 홀드아웃 검증으로 최적 모델 선택.
//   linear(추세선) / quadratic(가속·감속 곡선) / holtwinters(계절성 → 예측이 주기대로 출렁임). 전부 마지막값 앵커링.
//
// 출력: filename 있음 → .tql 저장(대시보드 tql_path), 없음 → ```tql 블록(프론트 자동 렌더=인라인 차트). 둘 다 텍스트 요약 동반.
// 태그 미지정(테이블만): 1개→자동 / 2~5개→태그별 추세 요약표 / 5개 초과→되묻기.
//
// ⚠️ 이 빌드 SCRIPT의 Time 객체엔 .UnixNano()/.Unix()가 없음(라이브 확정 2026-06-18) →
//    .tql SCRIPT는 시각 문자열을 Date.UTC로 파싱(compile.js). 워커는 timeformat='ms'라 무관.

var { compileSafe, buildSource } = require('./tir/compile');
var { argStr } = require('./registry');
var tqlSpec = require('./tql_spec');
var { fcRun } = require('./forecast_algo');

var CAP = 5;             // 동시 예측 상한(초과 시 자동실행 금지 → 되묻기)
var MIN_BUCKETS = 10;    // 최소 학습 버킷(미만이면 거절/데이터 부족)
var R2_STRONG = 0.7, R2_WEAK = 0.3;

// 시각 값 → epoch ms. timeformat='ms' 결과는 보통 숫자/숫자열, 아니면 시각 문자열 파싱.
function toMs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  var s = String(v).trim();
  if (/^\d{10,19}$/.test(s)) return (s.length <= 11) ? parseInt(s, 10) * 1000 : (s.length <= 13) ? parseInt(s, 10) : parseInt(s.substring(0, 13), 10);
  var m = s.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  var t = new Date(s).getTime();
  return isNaN(t) ? NaN : t;
}
function num(x) { var n = Number(x); return isFinite(n) ? n : NaN; }

// 버킷 이력 행 [버킷시각, AVG] → 유효한 {ts, ys, n}
function parseRows(rows) {
  var ts = [], ys = [];
  for (var i = 0; i < rows.length; i++) {
    var t = toMs(rows[i][0]), v = num(rows[i][1]);
    if (isFinite(t) && isFinite(v)) { ts.push(t); ys.push(v); }
  }
  return { ts: ts, ys: ys, n: ts.length };
}

function fmtN(x) {
  if (!isFinite(x)) return 'NaN';
  var a = Math.abs(x);
  if (a >= 1000) return x.toFixed(0);
  if (a >= 1) return x.toFixed(2);
  if (a >= 0.01) return x.toFixed(4);
  if (a === 0) return '0';
  return x.toExponential(2);
}
function r2label(r2) { return r2 >= R2_STRONG ? '강함' : (r2 >= R2_WEAK ? '보통' : '약함 ⚠️'); }
function fmtDate(ms) { var d = new Date(ms); function p(n) { return (n < 10 ? '0' : '') + n; } return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
function methodLabel(m, period) {
  if (m === 'quadratic') return '2차 곡선(가속/감속 반영)';
  if (m === 'holtwinters') return '계절성(Holt-Winters, 주기 ' + period + ' 버킷)';
  return '선형 추세';
}

function askWhich(table, allTags) {
  return '이 테이블에 태그가 ' + allTags.length + '개라 한 번에 예측할 수 없습니다(상한 ' + CAP + '개). 어떤 태그를 예측할지 알려주세요.' +
    '\n태그: ' + allTags.slice(0, 20).join(', ') + (allTags.length > 20 ? ' …' : '');
}
function tooMany(table, want) {
  return '한 번에 예측 가능한 태그는 최대 ' + CAP + '개입니다(요청 ' + want.length + '개). 줄여서 다시 요청하세요: ' + want.slice(0, CAP).join(', ');
}
function tagNotFound(missing, allTags) {
  return '존재하지 않는 태그입니다: ' + missing.join(', ') +
    '\n→ describe_table에 나온 정확한 태그명을 쓰세요. 사용 가능: ' + allTags.slice(0, 15).join(', ') + (allTags.length > 15 ? ' …' : '');
}

// 예측 대상 태그 결정. {tags, mode} 또는 {ask}
function decideTargets(spec, allTags) {
  var want = null;
  if (Array.isArray(spec.tags) && spec.tags.length) want = spec.tags.map(String);
  else if (spec.tag) want = [String(spec.tag)];

  if (!want) {
    if (!allTags.length) return { ask: 'Error: 테이블에 태그가 없어 예측할 수 없습니다.' };
    if (allTags.length === 1) return { tags: allTags.slice(), mode: 'single' };
    if (allTags.length <= CAP) return { tags: allTags.slice(), mode: 'multi' };
    return { ask: askWhich(spec.table, allTags) };
  }
  if (allTags.length) {
    var missing = want.filter(function (t) { return allTags.indexOf(t) < 0; });
    if (missing.length) return { ask: tagNotFound(missing, allTags) };
  }
  if (want.length > CAP) return { ask: tooMany(spec.table, want) };
  return { tags: want, mode: want.length === 1 ? 'single' : 'multi' };
}

// 인라인 스냅샷에 박을 예측점 다운샘플(≤max). TQL 텍스트를 작게 유지(모델이 답변에 통째로 복사하므로).
function downForecast(points, max) {
  var n = points.length; if (n <= max) return points;
  var stride = Math.ceil(n / max), out = [], i;
  for (i = 0; i < n; i += stride) out.push(points[i]);
  if (out.length === 0 || out[out.length - 1] !== points[n - 1]) out.push(points[n - 1]);
  return out;
}

// 단일 태그 spec 빌드(컴파일용). 워커가 auto로 확정한 모델/주기/기간을 주입 → 라이브 엔진이 같은 모델로 재적합.
function tagSpec(base, tag, res) {
  var s = {};
  for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) s[k] = base[k];
  s.kind = 'forecast'; s.tag = tag; delete s.tags;
  s.method = res.method; s.period = res.period;
  s.horizon = res.stats.H; s.lookback = res.stats.L;
  s._trainEndMs = res.stats.lastT;
  return s;
}

function register(registry, mc) {
  registry.register({
    name: 'forecast_table',
    description:
      '특정 테이블 태그의 이후 데이터를 예측한다(모델 자동 선택: 선형/2차곡률/계절성 + 95% 신뢰밴드, 마지막값에서 이어짐). ' +
      '추세·신뢰도(R²)·예측값 요약과 함께, filename을 주면 라이브 재계산 .tql로 저장(대시보드 tql_path용), 생략하면 인라인 예측 차트를 답변에 렌더한다. ' +
      '태그를 안 주면: 1개→자동, 2~5개→태그별 추세 요약표, 5개 초과→되묻기.',
    parameters: {
      type: 'object',
      properties: {
        spec: {
          type: 'object',
          description:
            '예측 의도 JSON: {table(필수), tag(예측할 단일 태그 — 생략 시 자동/요약/되묻기), ' +
            'rollup(버킷 단위 sec/min/hour/day/week/month — 생략 시 범위 기반 자동), ' +
            'timeRange:{start,end}(학습 기간 — 생략 시 데이터 전체), ' +
            'horizon(예측할 미래 버킷 수 — 생략 시 학습의 25%), ' +
            'method("auto"=데이터 보고 자동 선택[기본] / "linear" / "quadratic" / "holtwinters"), ' +
            'lookback(추세 윈도우 버킷 수 — 생략 시 자동), output:{title,subtitle}}. ' +
            '여러 태그 비교 예측은 tags:["a","b"](최대 ' + CAP + '개).',
        },
        filename: {
          type: 'string',
          description: '(선택) 저장 경로 "TABLE/name.tql"(영어만). 주면 .tql 저장(대시보드용), 생략하면 인라인 차트 답변용.',
        },
      },
      required: ['spec'],
    },
    fn: function (args, cb) {
      var spec = assemble(args);
      var filename = argStr(args, 'filename', '') || (spec.filename ? String(spec.filename) : '');
      delete spec.filename;
      if (!spec.table) {
        return cb(null, 'Error: spec.table(예측할 테이블명)이 필요합니다.');
      }
      if (typeof spec.tag === 'string' && spec.tag.indexOf(',') >= 0) {
        var parts = spec.tag.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        if (parts.length > 1) { spec.tags = parts; delete spec.tag; }
        else if (parts.length === 1) { spec.tag = parts[0]; }
      }

      tqlSpec.detectColumns(mc, spec.table, function (c) {
        spec.nameCol = c.n; spec.timeCol = c.t; spec.valueCol = c.v;
        tqlSpec.resolveTimeRange(mc, spec, function () {
          if (spec.rollup == null) spec.rollup = tqlSpec.pickRollupUnit(spec);
          tqlSpec.detectTags(mc, spec.table, c.n, function (allTags) {
            var dec = decideTargets(spec, allTags);
            if (dec.ask) return cb(null, dec.ask);
            tqlSpec.detectRollupAvailable(mc, spec.table, function (avail) {
              spec.rollupAvailable = avail;
              if (dec.mode === 'single') return runSingle(spec, dec.tags[0]);
              return runMulti(spec, dec.tags);
            });
          });
        });
      });

      // forecast_algo 엔진을 워커에서 실행(요약 + 모델 자동선택). opts는 사용자 override만 전달(나머지 엔진 기본).
      function runForecast(parsed, s) {
        var opts = { method: s.method || 'auto' };
        if (s.horizon != null) opts.horizon = parseInt(s.horizon, 10);
        if (s.lookback != null) opts.lookback = parseInt(s.lookback, 10);
        return fcRun(parsed.ts, parsed.ys, opts);
      }

      // ── 단일 태그: 워커 회귀(모델 자동선택+요약) → 컴파일 → 저장 또는 인라인 차트 ──
      function runSingle(base, tag) {
        var s = {};
        for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) s[k] = base[k];
        s.tag = tag; delete s.tags;
        queryHistory(mc, s, function (qerr, rows) {
          if (qerr) return cb(null, 'Error: 이력 조회 실패: ' + qerr.message);
          var parsed = parseRows(rows);
          if (parsed.n < MIN_BUCKETS) {
            return cb(null, 'Error: 학습 데이터가 부족합니다(' + parsed.n + '개 버킷 < 최소 ' + MIN_BUCKETS +
              '). 버킷 단위(rollup)를 더 잘게 하거나 더 긴 기간을 지정하세요.');
          }
          var res = runForecast(parsed, s);
          var cspec = tagSpec(s, tag, res);
          var summary = summarizeSingle(s.table, tag, res, s.rollup);

          if (filename) {
            // 저장/대시보드: 라이브 엔진(.tql은 tql_path로 참조되어 모델이 복사 안 함 → 커도 OK, 데이터 늘면 자동 갱신)
            var rLive = compileSafe(cspec);
            if (!rLive.ok) return cb(null, 'Error: 예측 TQL 컴파일 실패: ' + rLive.error);
            var saveTool = registry.get('save_tql_file');
            if (!saveTool) return cb(null, 'Error: save_tql_file 도구를 찾을 수 없습니다.');
            return saveTool.fn({ filename: filename, tql_content: rLive.tql }, function (se, sres) {
              var sr = String(sres || '');
              if (sr.indexOf('Error:') === 0) return cb(null, sr);
              cb(null, summary + '\n\n' + sr +
                '\n→ 대시보드에 넣으려면 이 .tql을 create_dashboard_with_charts의 charts에 {title, tql_path}로 추가하세요(열 때마다 현재 데이터로 예측 재계산).');
            });
          }

          // 인라인: 작은 스냅샷(SQL 실측 라이브 + 예측·백테스트 리터럴, 다운샘플) — 모델이 답변에 통째로 복사하므로
          // **일반 차트만큼 짧게** 유지(점 적게+정수ms+5유효숫자). 길면 모델이 배열을 잘라먹어 깨짐.
          cspec._forecast = downForecast(res.points, 12);
          cspec._backtest = downForecast(res.backtest || [], 8);
          var rSnap = compileSafe(cspec);
          if (!rSnap.ok) return cb(null, 'Error: 예측 TQL 컴파일 실패: ' + rSnap.error);
          var execTool = registry.get('execute_tql_script');
          if (!execTool) return cb(null, 'Error: execute_tql_script 도구를 찾을 수 없습니다.');
          execTool.fn({ tql_content: rSnap.tql }, function (ee, eres) {
            var es = String(eres || ''), low = es.toLowerCase();
            if (es.indexOf('Error:') === 0 || es.indexOf('MACH-ERR') >= 0 ||
                low.indexOf('"success":false') >= 0 || low.indexOf('"success": false') >= 0) {
              return cb(null, 'Error: 예측 TQL 실행 검증 실패: ' + es.substring(0, 300));
            }
            cb(null, summary + '\n\n아래 예측 차트를 답변에 그대로 포함하세요(```tql 블록 — 자동 렌더됩니다):\n\n```tql\n' + rSnap.tql + '```');
          });
        });
      }

      // ── 다중 태그(2~5): 태그별 추세 요약표 + **대표 태그(R² 최고) 인라인 예측 차트**(드릴다운 유도). ──
      function runMulti(base, tags) {
        var out = [], okData = [], idx = 0;
        (function next() {
          if (idx >= tags.length) return finishMulti();
          var tag = tags[idx++];
          var s = {};
          for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) s[k] = base[k];
          s.tag = tag; delete s.tags;
          queryHistory(mc, s, function (qerr, rows) {
            if (qerr) { out.push({ tag: tag, ok: false, reason: '조회 실패' }); return next(); }
            var parsed = parseRows(rows);
            if (parsed.n < MIN_BUCKETS) { out.push({ tag: tag, ok: false, reason: '데이터 부족(' + parsed.n + ')' }); return next(); }
            var res = runForecast(parsed, s);
            var st = res.stats, lastFc = res.points[res.points.length - 1];
            out.push({
              tag: tag, ok: true, method: res.method, period: res.period, r2: st.r2, mape: st.mape,
              slope: st.slopePerStep, arrow: st.slopePerStep > 0 ? '↑' : (st.slopePerStep < 0 ? '↓' : '→'),
              last: st.lastV, forecast: lastFc.v, H: st.H,
            });
            okData.push({ tag: tag, res: res, s: s });
            next();
          });
        })();

        // 요약표 + 대표 태그 차트. 대표 = R² 최고(가장 신뢰도 높은 예측). 차트 실패해도 표는 항상 반환.
        function finishMulti() {
          var table = summarizeMulti(base.table, base.rollup, out);
          if (okData.length === 0) return cb(null, table);
          var best = okData[0];
          for (var i = 1; i < okData.length; i++) {
            if ((okData[i].res.stats.r2 || 0) > (best.res.stats.r2 || 0)) best = okData[i];
          }
          var cspec = tagSpec(best.s, best.tag, best.res);
          cspec._forecast = downForecast(best.res.points, 12);
          cspec._backtest = downForecast(best.res.backtest || [], 8);
          var r = compileSafe(cspec);
          if (!r.ok) return cb(null, table);
          var execTool = registry.get('execute_tql_script');
          if (!execTool) return cb(null, table);
          execTool.fn({ tql_content: r.tql }, function (ee, eres) {
            var es = String(eres || ''), low = es.toLowerCase();
            if (es.indexOf('Error:') === 0 || es.indexOf('MACH-ERR') >= 0 ||
                low.indexOf('"success":false') >= 0 || low.indexOf('"success": false') >= 0) {
              return cb(null, table);
            }
            cb(null, table + '\n\n아래는 대표 태그 **' + best.tag + '**(R² 가장 높음) 예측 차트입니다. 답변에 ```tql 블록을 그대로 포함하세요. 다른 태그는 "<태그> 예측해줘"로 개별 차트를 볼 수 있습니다:\n\n```tql\n' + r.tql + '```');
          });
        }
      }
    },
  });
}

// 버킷 이력 조회(timeformat='ms'). 컴파일러와 동일한 SQL(buildSource)을 써 차트와 같은 소스 보장.
function queryHistory(mc, spec, cb) {
  var sql = buildSource(spec);
  mc.querySQL(sql, 'ms', '', '', function (err, res) {
    if (err) return cb(err);
    try {
      var p = JSON.parse(res);
      if (p && p.success === false) return cb(new Error(p.reason || '쿼리 실패'));
      var rows = (p && p.data && p.data.rows) ? p.data.rows : [];
      return cb(null, rows);
    } catch (e) { return cb(e); }
  });
}

function summarizeSingle(table, tag, res, unit) {
  var st = res.stats, lastFc = res.points[res.points.length - 1];
  var arrow = st.slopePerStep > 0 ? '↑ 상승' : (st.slopePerStep < 0 ? '↓ 하락' : '→ 보합');
  var lines = [];
  lines.push('**' + String(table).toUpperCase() + ' ' + tag + ' 예측** (' + unit + ' 버킷)');
  lines.push('- 모델(자동 선택): ' + methodLabel(res.method, res.period));
  lines.push('- 학습: ' + st.n + '개 버킷 (~' + fmtDate(st.lastT) + ' 기준)');
  lines.push('- 최근값: ' + fmtN(st.lastV));
  lines.push('- 추세: ' + arrow + ' ' + fmtN(st.slopePerStep) + ' /' + unit);
  lines.push('- 신뢰도 R² = ' + st.r2.toFixed(2) + ' (' + r2label(st.r2) + ')');
  if (st.testN > 0 && st.mape >= 0) {
    var acc = st.mape < 5 ? '양호' : (st.mape < 15 ? '보통' : '주의');
    lines.push('- 검증 정확도(최근 ' + st.testN + '버킷 백테스트): MAPE ' + st.mape.toFixed(1) + '% (' + acc + ')');
  }
  if (st.sd < 1e-9) {
    lines.push('- ' + st.H + unit + ' 후 예측: **' + fmtN(lastFc.v) + '** (잔차 0 → 신뢰밴드 생략)');
  } else {
    lines.push('- ' + st.H + unit + ' 후 예측: **' + fmtN(lastFc.v) + '** (95% 구간 ' + fmtN(lastFc.lo) + ' ~ ' + fmtN(lastFc.hi) + ')');
  }
  if (st.r2 < R2_WEAK) {
    lines.push('- ⚠️ R²가 낮아(' + st.r2.toFixed(2) + ') 추세로 잘 설명되지 않습니다 — 참고용으로만(변동성↑/비정형). method나 lookback을 바꿔볼 수 있습니다.');
  }
  return lines.join('\n');
}

function summarizeMulti(table, unit, rows) {
  var head = '**' + String(table).toUpperCase() + ' 태그별 예측 요약** (모델 자동 선택, ' + unit + ' 버킷)\n\n';
  var tbl = '| 태그 | 모델 | 추세/' + unit + ' | R² | 검증MAPE | 최근값 | 예측 |\n|---|---|---|---|---|---|---|\n';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r.ok) { tbl += '| ' + r.tag + ' | — | — | — | — | — | ' + r.reason + ' |\n'; continue; }
    var mlabel = r.method === 'quadratic' ? '2차' : r.method === 'holtwinters' ? '계절성' : '선형';
    var mp = (r.mape >= 0) ? r.mape.toFixed(1) + '%' : '—';
    tbl += '| ' + r.tag + ' | ' + mlabel + ' | ' + r.arrow + ' ' + fmtN(r.slope) + ' | ' + r.r2.toFixed(2) +
      ' | ' + mp + ' | ' + fmtN(r.last) + ' | ' + fmtN(r.forecast) + ' (' + r.H + unit + '후) |\n';
  }
  var foot = '\n특정 태그의 예측 차트를 보려면 "<태그> 예측해줘"처럼 하나만 지정하세요(그 태그의 인라인 차트를 그립니다).';
  return head + tbl + foot;
}

// spec(객체/문자열) + 최상위 인자 병합. kind=forecast 고정.
function assemble(args) {
  var spec = {};
  var s = args.spec;
  if (s && typeof s === 'object') {
    for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) spec[k] = s[k];
  } else if (typeof s === 'string' && s.trim()) {
    try { spec = JSON.parse(s); }
    catch (e) {
      try { spec = JSON.parse(s.replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)([A-Za-z_]\w*)(\s*:)/g, '$1"$2"$3')); }
      catch (e2) { spec = {}; }
    }
  }
  var fields = ['table', 'tag', 'tags', 'rollup', 'timeRange', 'horizon', 'lookback', 'method', 'output'];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if ((spec[f] === undefined || spec[f] === null || spec[f] === '') && args[f] != null && args[f] !== '') spec[f] = args[f];
  }
  spec.kind = 'forecast';
  return spec;
}

module.exports = { register };
