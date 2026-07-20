// forecast_table — 특정 테이블 태그의 "이후 데이터" 예측 도구. **산출물은 HTML 리포트.**
//
// 흐름: 태그별 버킷 이력 조회 → forecast_algo 엔진이 후보 모델을 **전부 적합·홀드아웃 검증**(allModels)
//       → 태그×모델 전체 예측 곡선을 담은 **HTML 리포트** 생성/저장 → 채팅엔 요약표 + 리포트 링크.
//
// 왜 리포트인가: 채팅 마크다운 표는 태그 5개 × 모델 10개를 못 담는다(눌리고, 모델이 자기 말로 다시 쓴다).
//   리포트는 **태그 드롭다운 × 모델 드롭다운**으로 계산해둔 걸 전부 열람시킨다 — 리더보드에서 점수만 매기고
//   버리는 나머지 모델들의 예측 곡선까지 볼 수 있다.
//
// filename을 주면 **추가로** 대시보드용 .tql도 저장한다(tql_path 참조 → 열 때마다 라이브 재계산).
// 태그 미지정(테이블만): 1개→자동 / 2~5개→전부 / 5개 초과→**데이터 많은 순 상위 5개 자동 + 안내**(되묻지 않음).
//
// ⚠️ 이 빌드 SCRIPT의 Time 객체엔 .UnixNano()/.Unix()가 없음 →
//    .tql SCRIPT는 시각 문자열을 Date.UTC로 파싱(compile.js). 워커는 timeformat='ms'라 무관.

var { compileSafe, buildSource, forecastUnit } = require('./tir/compile');
var { argStr } = require('./registry');
var tqlSpec = require('./tql_spec');
var { fcRun } = require('./forecast_algo');
var fcReport = require('./forecast_report');

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
// ── 지표 2종: 둘 다 필요하지만 **재는 대상이 다르다**. 라벨만 보고 헷갈리지 않게 매번 한 줄 설명을 붙인다.
//    (R²를 "신뢰도"라고만 적었더니 모델이 "검증 정확도 0.78 — 좋은 수준"이라 답한 적 있음. 같은 데이터 MAPE는 27.6%.)
var METRIC_LEGEND =
  '**지표 읽는 법** — `R²`: 모델이 **과거** 데이터를 얼마나 잘 설명하는지 (1에 가까울수록 잘 맞음, 미래 정확도 아님) · ' +
  '`MAPE`: 홀드아웃 구간에서 **실제로 빗나간 평균 오차율** (낮을수록 정확, **이게 진짜 예측 정확도**)';
// ⚠️는 붙이지 않는다 — 표의 ⚠️는 "R²↑인데 MAPE↑(추세 지속 보장 없음)" **한 가지 뜻**으로 고정해야 각주가 성립한다.
// (R²가 낮은 건 그 자체로 경고가 아니다: 보합 데이터는 R² 0이어도 예측이 정확하다.)
function r2label(r2) { return r2 >= R2_STRONG ? '강함' : (r2 >= R2_WEAK ? '보통' : '약함'); }
// 이 모델들은 엔진이 R²를 계산하지 않고 0을 반환(fcSES/fcHolt/fcAR) → "0.00 (약함)"으로 표시하면
// 과거 적합이 나쁘다는 오독을 유발(holt 선택된 라이브 스크린샷에서 확인) → 표시는 '—'.
var NO_R2 = { ses: 1, holt: 1, ar: 1 };
// 모델 한 줄 설명(리포트 리더보드용). 모델명은 **영어 그대로** — 그대로 복사해 오버라이드에 쓸 수 있게.
function methodDesc(m) {
  if (m === 'ses') return '무변화 기준선 — 단순지수평활(이걸 못 이기면 예측 무의미)';
  if (m === 'linear') return '최소제곱 추세선(최근 구간)';
  if (m === 'quadratic') return '2차 회귀 — 가속·감속 곡선';
  if (m === 'holt') return '지수평활 레벨+추세';
  if (m === 'theta') return 'Theta — 추세 절반 드리프트(고전 강자)';
  if (m === 'ar') return '자기회귀 AR(p)+차분 — 자기상관 구조';
  if (m === 'holtwinters') return '가법 삼중지수평활 — 추세+계절(진폭 일정)';
  if (m === 'holtwinters_mult') return '곱셈형 삼중지수평활 — 계절 진폭 ∝ 레벨';
  if (m === 'harmonic') return 'Fourier 하모닉 회귀 — 다중 주기 동시';
  if (m === 'prophet') return '구간별 추세 + 변화점 + 계절성';
  return m;
}

// 리포트 링크 블록. 예측의 **본체는 리포트**다(태그 × 모델 전부 열람) — 채팅은 요약과 진입점 역할만.
function REPORT_BLOCK(rep, nTags) {
  return '\n\n---\n\n### 📄 예측 리포트 생성됨\n' +
    '**[리포트 열기](' + rep.url + ')** — `' + rep.filename + '` (' + rep.sizeKB + 'KB)\n\n' +
    '리포트 안에서 **태그 드롭다운 × 모델 드롭다운**으로 ' + nTags + '개 태그 × 후보 모델 전부의 예측 곡선을 볼 수 있습니다 ' +
    '(실측·백테스트·95% 신뢰구간 포함, 모델 비교표 행 클릭으로도 전환).\n' +
    '\n[지시·답변에 옮기지 말 것] 위 요약표와 리포트 링크를 그대로 전달하고, 링크를 지어내지 마세요.';
}

// 태그가 CAP 초과 + 미지정 → **되묻지 않고** 데이터 많은 순 상위 CAP개를 도구가 직접 골라 진행한다.
// 되묻기는 답할 수 없는 질문이었다(태그 500개면 사용자도 뭐가 있는지 모른다 — 앞 20개 나열은 선택 근거가 못 됨).
// 모델 선택과 같은 철학: 합리적 기본값으로 즉시 결과 + 무엇을 골랐는지 명시 + 한마디로 정정("X, Y 예측해줘").
// 데이터 많은 순 = 배울 재료가 많은 태그 = 예측 가치 있는 태그. SQL은 라이브 검증됨(ORDER BY COUNT(*) DESC LIMIT).
function pickTopTags(mc, spec, cb) {
  var sql = 'SELECT ' + spec.nameCol + ', COUNT(*) FROM ' + String(spec.table).toUpperCase() +
    ' GROUP BY ' + spec.nameCol + ' ORDER BY COUNT(*) DESC LIMIT ' + CAP;
  mc.querySQL(sql, '', '', '', function (err, res) {
    if (err) return cb([]);
    try {
      var p = JSON.parse(res);
      var rows = (p && p.success !== false && p.data && p.data.rows) ? p.data.rows : [];
      cb(rows.map(function (r) { return String(r[0]); }));
    } catch (e) { cb([]); }
  });
}
function tooMany(table, want) {
  return '한 번에 예측 가능한 태그는 최대 ' + CAP + '개입니다(요청 ' + want.length + '개). 줄여서 다시 요청하세요: ' + want.slice(0, CAP).join(', ');
}
function tagNotFound(missing, allTags) {
  return '존재하지 않는 태그입니다: ' + missing.join(', ') +
    '\n→ describe_table에 나온 정확한 태그명을 쓰세요. 사용 가능: ' + allTags.slice(0, 15).join(', ') + (allTags.length > 15 ? ' …' : '');
}

// 예측 대상 태그 결정. {tags, mode} / {pickTop, total}(CAP 초과 → 상위 자동선정) / {ask}(오류·초과지정)
function decideTargets(spec, allTags) {
  var want = null;
  if (Array.isArray(spec.tags) && spec.tags.length) want = spec.tags.map(String);
  else if (spec.tag) want = [String(spec.tag)];

  if (!want) {
    if (!allTags.length) return { ask: 'Error: 테이블에 태그가 없어 예측할 수 없습니다.' };
    if (allTags.length === 1) return { tags: allTags.slice(), mode: 'single' };
    if (allTags.length <= CAP) return { tags: allTags.slice(), mode: 'multi' };
    return { pickTop: true, total: allTags.length };
  }
  if (allTags.length) {
    var missing = want.filter(function (t) { return allTags.indexOf(t) < 0; });
    if (missing.length) return { ask: tagNotFound(missing, allTags) };
  }
  if (want.length > CAP) return { ask: tooMany(spec.table, want) };
  return { tags: want, mode: want.length === 1 ? 'single' : 'multi' };
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
      '후보 모델을 전부 적합·홀드아웃 검증한 뒤 **HTML 리포트를 생성·저장**하고 링크를 돌려준다 — 리포트에서 태그 드롭다운 × 모델 드롭다운으로 태그별·모델별 예측 곡선(95% 신뢰구간·백테스트 포함)을 전부 열람할 수 있다. ' +
      'filename을 주면 추가로 대시보드용 .tql도 저장한다(tql_path — 열 때마다 예측 재계산). ' +
      '태그를 안 주면: 1개→자동, 2~5개→전부, 5개 초과→데이터 많은 순 상위 5개 자동 선정(안내 포함, 되묻지 않음).',
    parameters: {
      type: 'object',
      properties: {
        spec: {
          type: 'object',
          description:
            '예측 의도 JSON: {table(필수), tag(예측할 단일 태그 — 생략 시 도구가 자동 결정), ' +
            'rollup(버킷 단위 sec/min/hour/day/week/month — 생략 시 범위 기반 자동), ' +
            'timeRange:{start,end}(학습 기간 — 생략 시 데이터 전체), ' +
            'horizon(예측할 미래 버킷 수 — 생략 시 학습의 20%), ' +
            'method(모델 지정 — 생략 시 "auto"=리더보드 1위 자동선택. **별칭 그대로 넣어도 됨**: "linear"/"선형", "quadratic"/"2차", "holtwinters"/"계절성". 순위로도 가능: "2위"/"rank2"), ' +
            'rank(리더보드 순위로 모델 지정, 1-based. 예: 사용자가 "2위 모델로" 하면 rank:2), ' +
            'lookback(추세 윈도우 버킷 수 — 생략 시 자동), output:{title,subtitle}}. ' +
            '여러 태그 비교 예측은 tags:["a","b"](최대 ' + CAP + '개).',
        },
        filename: {
          type: 'string',
          description: '(선택) 대시보드용 .tql 저장 경로 "TABLE/name.tql"(영어만). 주면 리포트에 **추가로** .tql도 저장(tql_path 참조 — 열 때마다 예측 재계산). 생략하면 HTML 리포트만 생성.',
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
          // 예측용 버킷 단위(차트용보다 잘게 — 버킷이 많아야 모델이 배움). 사용자가 rollup 지정 시 존중.
          if (spec.rollup == null) spec.rollup = forecastUnit(spec);
          tqlSpec.detectTags(mc, spec.table, c.n, function (allTags) {
            var dec = decideTargets(spec, allTags);
            if (dec.ask) return cb(null, dec.ask);
            function proceed(tags) {
              tqlSpec.detectRollupAvailable(mc, spec.table, function (avail) {
                spec.rollupAvailable = avail;
                return runAll(spec, tags);
              });
            }
            if (dec.pickTop) {
              // CAP 초과 → 데이터 많은 순 상위 CAP개 자동 선정(되묻지 않음). 통계 조회 실패 시 목록 앞 CAP개 폴백.
              return pickTopTags(mc, spec, function (top) {
                var byCount = top.length > 0;
                spec._topNote = { total: dec.total, byCount: byCount };
                proceed(byCount ? top.slice(0, CAP) : allTags.slice(0, CAP));
              });
            }
            proceed(dec.tags);
          });
        });
      });

      // forecast_algo 엔진을 워커에서 실행(리더보드 + 모델 선택). method는 별칭/순위 문자열 그대로 넘김(엔진이 정규화).
      function runForecast(parsed, s, allModels) {
        var opts = { method: (s.method != null && s.method !== '') ? s.method : 'auto' };
        if (s.rank != null && parseInt(s.rank, 10) >= 1) opts.rank = parseInt(s.rank, 10);
        if (s.horizon != null) opts.horizon = parseInt(s.horizon, 10);
        if (s.lookback != null) opts.lookback = parseInt(s.lookback, 10);
        if (allModels) opts.allModels = true; // 후보 전 모델의 미래 곡선까지(리포트 드롭다운용, +~30ms/태그)
        return fcRun(parsed.ts, parsed.ys, opts);
      }

      // ── 전 태그 예측 → **HTML 리포트** (단일/다중 동일 경로) ──
      // 채팅 마크다운은 태그 5개 × 모델 10개를 담지 못한다(눌리고, 모델이 자기 말로 다시 쓴다).
      // → 계산은 전부 하고(allModels), **리포트에서 태그·모델 드롭다운으로 열람**시킨다. 채팅엔 요약표 + 링크만.
      function runAll(base, tags) {
        var items = [], idx = 0;
        (function next() {
          if (idx >= tags.length) return finish();
          var tag = tags[idx++];
          var s = {};
          for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) s[k] = base[k];
          s.tag = tag; delete s.tags;
          queryHistory(mc, s, function (qerr, rows) {
            if (qerr) { items.push({ tag: tag, row: { tag: tag, ok: false, reason: '조회 실패' } }); return next(); }
            var parsed = parseRows(rows);
            if (parsed.n < MIN_BUCKETS) {
              items.push({ tag: tag, row: { tag: tag, ok: false, reason: '데이터 부족(' + parsed.n + '버킷 < 최소 ' + MIN_BUCKETS + ')' } });
              return next();
            }
            var res = runForecast(parsed, s, true); // allModels — 리포트 드롭다운이 모델별 곡선을 보여줘야 함
            var st = res.stats;
            items.push({
              tag: tag, parsed: parsed, res: res, s: s,
              row: {
                tag: tag, ok: true, method: res.method, r2: st.r2, r2na: NO_R2[res.method] === 1, mape: st.mape,
                slope: st.slopePerStep, arrow: st.slopePerStep > 0 ? '↑' : (st.slopePerStep < 0 ? '↓' : '→'),
                last: st.lastV, forecast: res.points[res.points.length - 1].v, H: st.H,
              },
            });
            next();
          });
        })();

        // CAP 초과 자동 선정 안내 — **무엇을 골랐는지 + 한마디 정정 경로**를 요약표 위에 명시(빈손 되묻기 대체).
        function topNote() {
          var tn = base._topNote;
          if (!tn) return '';
          return '전체 태그 ' + tn.total + '개 중 ' +
            (tn.byCount ? '**데이터가 많은 순 상위 ' + tags.length + '개**' : '목록 앞 ' + tags.length + '개(통계 조회 실패 폴백)') +
            '만 예측했습니다(한 번에 최대 ' + CAP + '개). 다른 태그가 필요하면 **"태그명1, 태그명2 예측해줘"** 로 지목하세요.\n\n';
        }

        function finish() {
          var okItems = [], i;
          for (i = 0; i < items.length; i++) if (items[i].row.ok) okItems.push(items[i]);
          var rows = items.map(function (it) { return it.row; });
          // 전 태그 데이터 부족: 버킷 단위는 이미 구간에 맞춰 최소(sec까지)로 잡은 결과다 — rollup을 바꿔도 안 는다.
          // 약한 모델이 rollup만 바꿔가며 재시도하는 루프를 막기 위해 지시를 명시(+agent의 부족 스트릭 차단이 결정론 백스톱).
          if (!okItems.length) {
            return cb(null, topNote() + summarizeMulti(base.table, base.rollup, rows) +
              '\n\n이 테이블은 예측에 필요한 데이터가 부족합니다(학습 최소 10버킷). ' +
              'rollup·기간을 바꿔 **재시도하지 마세요** — 위 표를 그대로 사용자에게 전달하고, 데이터가 더 쌓인 뒤 다시 시도하라고 안내하세요.');
          }

          // 대시보드용 .tql은 filename을 준 경우에만(리포트와 별개 산출물 — 열 때마다 라이브 재계산).
          function saveTqlIfAsked(next2) {
            if (!filename) return next2('');
            var pick = okItems[0];
            for (i = 1; i < okItems.length; i++) {
              var bm = pick.res.stats.mape, cm = okItems[i].res.stats.mape;
              if (((cm >= 0) ? cm : 1e9) < ((bm >= 0) ? bm : 1e9)) pick = okItems[i];
            }
            var rLive = compileSafe(tagSpec(pick.s, pick.tag, pick.res));
            var saveTool = registry.get('save_tql_file');
            if (!rLive.ok || !saveTool) return next2('');
            saveTool.fn({ filename: filename, tql_content: rLive.tql }, function (se, sres) {
              var sr = String(sres || '');
              if (sr.indexOf('Error:') === 0) return next2('');
              next2('\n\n' + sr + '\n→ 대시보드에 넣으려면 이 .tql을 create_dashboard_with_charts의 charts에 {title, tql_path}로 추가하세요(열 때마다 예측 재계산).');
            });
          }

          fcReport.buildAndSave(mc, {
            table: base.table, unit: base.rollup, descOf: methodDesc,
            topTotal: base._topNote ? base._topNote.total : 0, // 리포트 분석문에도 "전체 N개 중 상위 5개" 명시
          }, items, function (rerr, rep) {
            var head = topNote() + summarizeMulti(base.table, base.rollup, rows);
            saveTqlIfAsked(function (tqlNote) {
              if (rerr || !rep) {
                // 리포트 실패해도 요약표는 반드시 준다(빈손 금지).
                return cb(null, head + '\n\n⚠️ 리포트 생성 실패: ' + (rerr ? rerr.message : '데이터 없음') + tqlNote);
              }
              cb(null, head + REPORT_BLOCK(rep, okItems.length) + tqlNote);
            });
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

function summarizeMulti(table, unit, rows) {
  var head = '**' + String(table).toUpperCase() + ' 태그별 예측 요약** (모델 자동 선택, ' + unit + ' 버킷 · 추세 = ' + unit + '당 변화량)\n\n';
  // 셀 안에는 **숫자만** — 문장을 셀에 넣으면 열이 벌어져 헤더까지 줄바꿈돼 표가 깨진다.
  // 경고는 ⚠️ 기호로만 표시하고, 그 뜻은 **표 아래 한 줄**로 설명한다. 헤더도 짧게(단위는 캡션으로).
  var tbl = '| 태그 | 모델 | 추세 | 최근값 | R² | MAPE |\n|---|---|---|---|---|---|\n';
  var anyDiverge = false, anyNoR2 = false;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r.ok) { tbl += '| ' + r.tag + ' | — | — | — | — | ' + r.reason + ' |\n'; continue; }
    var mp = (r.mape >= 0) ? r.mape.toFixed(1) + '%' + (r.mape >= 20 ? ' ⚠️' : '') : '—';
    // ⚠️는 **"과거는 잘 맞는데 미래는 빗나감"(R²↑ + MAPE↑)** 일 때만. R²가 낮아도 예측이 정확하면(보합) 경고 아님.
    var dv = (r.r2 >= R2_STRONG && r.mape >= 20) ? ' ⚠️' : '';
    if (dv) anyDiverge = true;
    // 강/보통/약 라벨을 셀에 **직접** 박는다 — 라벨을 안 주면 모델이 "R² 0.78(약함)"처럼 제멋대로 붙인다(0.78은 강함).
    // R² 미계산 모델(ses/holt/ar)은 '—' — 0.00으로 내면 "과거 적합이 최악"으로 오독된다.
    var r2txt = r.r2na ? '—' : r.r2.toFixed(2) + ' (' + r2label(r.r2) + ')' + dv;
    if (r.r2na) anyNoR2 = true;
    tbl += '| ' + r.tag + ' | `' + r.method + '` | ' + r.arrow + ' ' + fmtN(r.slope) +
      ' | ' + fmtN(r.last) + ' | ' + r2txt + ' | ' + mp + ' |\n';
  }
  var foot = '\n' + METRIC_LEGEND;
  if (anyNoR2) foot += '\n\n`—` = 평활·자기회귀 계열 모델(ses/holt/ar)은 R²를 계산하지 않습니다.';
  if (anyDiverge) foot += '\n\n⚠️ = **과거는 잘 설명하지만(R²↑) 미래로 뻗으면 크게 빗나갑니다(MAPE↑)** — 추세가 계속된다는 보장이 없다는 뜻.';
  // (인라인 차트 안내는 없다 — 차트는 리포트 안에 있고, 태그·모델 전환도 리포트 드롭다운으로 한다.)
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
  var fields = ['table', 'tag', 'tags', 'rollup', 'timeRange', 'horizon', 'lookback', 'method', 'rank', 'output'];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if ((spec[f] === undefined || spec[f] === null || spec[f] === '') && args[f] != null && args[f] !== '') spec[f] = args[f];
  }
  spec.kind = 'forecast';
  return spec;
}

module.exports = { register };
