// forecast_report — 예측 결과를 **HTML 리포트**로 굽는다(템플릿 R-4-forecast).
//
// 왜 리포트인가: 채팅의 마크다운 표는 태그 5개 × 모델 10개를 담을 수 없다(눌리고, 모델이 자기 말로 다시 쓴다).
// 리포트는 **태그 드롭다운 × 모델 드롭다운**으로 계산해둔 걸 전부 열람시킨다 — 리더보드에서 점수만 매기고
// 버리던 나머지 9개 모델의 예측 곡선을 살려서 보여주는 게 핵심(fcRun opts.allModels).
//
// 차트는 외부 라이브러리 없이 canvas 2D(기존 리포트 관례 — 오프라인 안전, CDN 불가 환경 대응).
// 분석문은 **결정론적으로 생성**한다(LLM 2차 호출 없음): 리포트 저장을 모델에게 맡기면 2차 호출을 건너뛰고
// 가짜 URL을 지어내는 사례가 있었다(report-save-fabrication 계열). 숫자는 도구가, 서술은 템플릿이 책임진다.

// ★템플릿은 **neo/forecast/** 에 둔다 — neo/report/ 가 아니다.
//   neo/report/ 에 넣었더니 리포트 생태계 전체에 자동 등록돼 3군데서 샜다:
//     ① listReportTemplates() → LLM에게 "사용 가능한 리포트 템플릿"으로 노출 → save_html_report가 고름
//     ② matchBuiltinByQuery("예측 리포트") → 제목 토큰 매칭
//     ③ 그 경로로 가면 {FORECAST_DATA_JSON}이 미치환 → `var D = {FORECAST_DATA_JSON};` JS 문법오류 → **빈 페이지**
//   플래그(internal:true)로 걸러내는 건 opt-out이라 새 소비자가 생기면 또 샌다.
//   **폴더를 분리하면 리포트 스캐너가 애초에 못 본다**(구조적으로 불가능). 그래서 로더도 여기서 따로 갖는다.
var fs = require('fs');
var path = require('path');

var _tmplCache = null, _tmplTs = 0;
var TMPL_TTL = 30000;

// neo/forecast/*.md 의 ```html 블록을 템플릿으로 로드. custom/ 이 있으면 그게 우선(고객사 재스타일링 경로).
function loadTemplate() {
  var now = Date.now();
  if (_tmplCache && (now - _tmplTs) < TMPL_TTL) return _tmplCache;
  var baseDir = path.resolve(__dirname, '..', 'neo', 'forecast');
  var picked = null;
  [path.join(baseDir, 'custom'), baseDir].forEach(function (dir) {
    if (picked) return;
    var names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (var i = 0; i < names.length; i++) {
      if (!/\.md$/i.test(names[i])) continue;
      var body;
      try { body = fs.readFileSync(path.join(dir, names[i]), 'utf8'); } catch (e) { continue; }
      var m = /```html\n([\s\S]*?)\n```/.exec(body.replace(/\r\n/g, '\n'));
      if (m) { picked = m[1].trim(); console.println('[forecast] template loaded: ' + names[i] + (dir.indexOf('custom') >= 0 ? ' (custom)' : '')); break; }
    }
  });
  if (!picked) throw new Error('예측 리포트 템플릿을 찾을 수 없습니다 (neo/forecast/*.md 의 ```html 블록)');
  _tmplCache = picked; _tmplTs = now;
  return picked;
}

function expandTemplate(params) {
  var html = loadTemplate(), keys = Object.keys(params);
  for (var i = 0; i < keys.length; i++) {
    html = html.replace(new RegExp('\\{' + keys[i] + '\\}', 'g'), params[keys[i]]);
  }
  return html;
}

// 헤더 로고 → base64 data URI. 리포트는 단일 HTML로 저장·이동되므로 외부 파일 참조가 통하지 않는다(오프라인/CSP 대응).
//
// 🐛 **PNG를 런타임에 인코딩하면 안 된다**: jsh 워커의 `fs.readFileSync(png)`는 Buffer가 아니라 **문자열**을 돌려줘
//    `.toString('base64')`가 **아무 일도 하지 않는다** → 원시 PNG 바이트가 그대로 img src에 박혀 깨진 글자가 쏟아졌다
//    (node에선 Buffer라 정상 동작해 로컬 미리보기에선 안 잡혔다).
// → **미리 인코딩된 텍스트 파일(.b64)** 을 utf8로 읽는다. 런타임에 바이너리를 다루지 않는다.
//    로고 교체 시: node -e "require('fs').writeFileSync('machbase-logo-header.b64', require('fs').readFileSync('machbase-logo-header.png').toString('base64'))"
var _logoCache = null;
function logoDataURI() {
  if (_logoCache !== null) return _logoCache;
  var p = path.resolve(__dirname, '..', 'neo', 'forecast', 'machbase-logo-header.b64');
  try {
    var b64 = String(fs.readFileSync(p, 'utf8')).replace(/\s+/g, '');
    _logoCache = b64 ? ('data:image/png;base64,' + b64) : '';
  } catch (e) {
    console.println('[forecast] logo b64 not found (' + p + ') — rendering without it');
    _logoCache = '';
  }
  return _logoCache;
}

// 버킷 단위 → 사람이 읽는 표현. "학습 3625버킷(day)"는 (ⓐ 태그 5개를 **합친 수**라 오해를 부르고
// ⓑ '버킷'이 내부 용어라) 쓰지 않는다. "일 단위 데이터"처럼 **무슨 간격의 데이터를 썼는지**만 말한다.
function unitKo(u) {
  if (u === 'sec') return '초';
  if (u === 'min') return '분';
  if (u === 'hour') return '시간';
  if (u === 'week') return '주';
  if (u === 'month') return '월';
  return '일';
}

var MAX_ACTUAL = 400;   // 실측선 점 수(리포트 JSON 크기 억제)
var MAX_FC = 60;        // 모델당 예측 곡선 점 수
var MAX_BT = 60;        // 모델당 백테스트 점 수

function down(arr, max) {
  var n = arr.length;
  if (n <= max) return arr.slice();
  var stride = Math.ceil(n / max), out = [], i;
  for (i = 0; i < n; i += stride) out.push(arr[i]);
  if (out[out.length - 1] !== arr[n - 1]) out.push(arr[n - 1]);
  return out;
}
function r5(x) { return (isFinite(x)) ? Number(Number(x).toPrecision(5)) : null; }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtN(x) {
  if (!isFinite(x)) return '-';
  var a = Math.abs(x);
  if (a >= 1000) return x.toFixed(0);
  if (a >= 1) return x.toFixed(2);
  if (a >= 0.01) return x.toFixed(4);
  return x === 0 ? '0' : x.toExponential(2);
}
function fmtDate(ms) {
  var d = new Date(ms);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function stamp() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fileStamp() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// 태그 하나의 예측 결과 → 리포트용 데이터. res는 fcRun(..., {allModels:true}) 결과.
function tagPayload(parsed, res, descOf) {
  var lb = res.leaderboard || [], models = {}, order = [], i;
  for (i = 0; i < lb.length; i++) {
    var e = lb[i], fc = e.forecast || [], bt = e.points || [];
    var last = fc.length ? fc[fc.length - 1] : null;
    models[e.method] = {
      mape: (e.mape >= 0) ? Number(e.mape.toFixed(2)) : -1,
      exploded: !!e.exploded,
      desc: descOf(e.method),
      endV: last ? r5(last.v) : null,
      endLo: last ? r5(last.lo) : null,
      endHi: last ? r5(last.hi) : null,
      fc: down(fc, MAX_FC).map(function (p) { return [p.t, r5(p.v), r5(p.lo), r5(p.hi)]; }),
      bt: down(bt, MAX_BT).map(function (p) { return [p.t, r5(p.v)]; }),
    };
    order.push(e.method);
  }
  // 자동 선택 모델이 리더보드에 없을 수도 있다(폴백 등) → 그 경우 선택 모델을 직접 얹는다.
  if (!models[res.method]) {
    var pts = res.points || [], lastP = pts.length ? pts[pts.length - 1] : null;
    models[res.method] = {
      mape: (res.stats.mape >= 0) ? Number(res.stats.mape.toFixed(2)) : -1,
      exploded: false, desc: descOf(res.method),
      endV: lastP ? r5(lastP.v) : null, endLo: lastP ? r5(lastP.lo) : null, endHi: lastP ? r5(lastP.hi) : null,
      fc: down(pts, MAX_FC).map(function (p) { return [p.t, r5(p.v), r5(p.lo), r5(p.hi)]; }),
      bt: down(res.backtest || [], MAX_BT).map(function (p) { return [p.t, r5(p.v)]; }),
    };
    order.unshift(res.method);
  }
  var act = [];
  var stride = Math.max(1, Math.ceil(parsed.ts.length / MAX_ACTUAL));
  for (i = 0; i < parsed.ts.length; i += stride) act.push([parsed.ts[i], r5(parsed.ys[i])]);
  var lastI = parsed.ts.length - 1;
  if (!act.length || act[act.length - 1][0] !== parsed.ts[lastI]) act.push([parsed.ts[lastI], r5(parsed.ys[lastI])]);

  return { auto: res.method, order: order, actual: act, models: models };
}

// 결정론적 분석문(HTML). LLM 없이 **수치 근거로** 쓴다. 예측값을 확정된 미래처럼 서술하지 않는다.
//
// ★가볍게 + 라벨 행으로(2026-07-13/14 사용자 확정):
//   ① 내용은 "방향 / 예측값(대표) / 얼마나 믿을지 / 한계"만 — 추세 연장 기법이 말할 수 있는 전부다.
//      섹션을 잘게 쪼개 길게 쓰면 과잉 분석("추세만 보는 내용을 잘게 쪼갤 필요 있나").
//      '데이터' 행은 **삭제**(스펙 패널과 100% 중복 — 분석이 요약표 바로 아래로 오면서 스펙 패널과 붙었다).
//   ② 형식은 **라벨 + 한 줄 행**(.a-row) — 산문 문단을 이어 붙였더니 "내용은 적절한데 가독성이 떨어진다".
//      항목별로 끊어야 스캔이 된다. 모델 선택 근거·제외 사유 상세는 아래 모델 비교표가 담당(반복 금지).
function analysisHtml(horizonLabel, rows, items) {
  var ok = [], bad = [], i;
  for (i = 0; i < rows.length; i++) (rows[i].ok ? ok : bad).push(rows[i]);
  if (!ok.length) return '<p>예측 가능한 태그가 없습니다.</p>';

  var byTag = {};
  for (i = 0; i < (items || []).length; i++) if (items[i].res) byTag[items[i].tag] = items[i];

  function row(label, html, cls) {
    return '<div class="a-row' + (cls ? ' ' + cls : '') + '"><span class="a-k">' + label + '</span><span class="a-v">' + html + '</span></div>';
  }
  function codes(arr) { return arr.map(function (t) { return '<code>' + esc(t) + '</code>'; }).join(', '); }

  var out = [];

  // ① 방향 — 같은 방향끼리 묶어 한 줄.
  var DIRS = ['오름세', '내림세', '보합세'], dirTags = { '오름세': [], '내림세': [], '보합세': [] };
  for (i = 0; i < ok.length; i++) {
    var d = ok[i].slope > 0 ? '오름세' : (ok[i].slope < 0 ? '내림세' : '보합세');
    dirTags[d].push(ok[i].tag);
  }
  var dirParts = [];
  for (i = 0; i < DIRS.length; i++) {
    if (!dirTags[DIRS[i]].length) continue;
    dirParts.push('<strong>' + DIRS[i] + '</strong> ' + codes(dirTags[DIRS[i]]));
  }
  out.push(row('방향', dirParts.join(' &nbsp;·&nbsp; ')));

  // ② 예측값 — 대표 태그(검증 오차 최소) 하나만 값·범위로. "점이 아니라 범위"를 숫자로 보여준다.
  //    라벨은 '예시'가 아니라 '예측값'(사용자 지적) — 예시가 아니라 실제 예측 수치를 읽는 행이다.
  var rep = null;
  for (i = 0; i < ok.length; i++) {
    if (!byTag[ok[i].tag] || !(ok[i].mape >= 0)) continue;
    if (!rep || ok[i].mape < rep.mape) rep = ok[i];
  }
  if (rep) {
    var pts = byTag[rep.tag].res.points || [];
    if (pts.length) {
      var last = pts[pts.length - 1];
      out.push(row('예측값', '<code>' + esc(rep.tag) + '</code> 지금 <strong>' + fmtN(rep.last) + '</strong> → ' +
        esc(horizonLabel) + ' 뒤 <strong>' + fmtN(last.v) + '</strong> 부근 · 95% 구간 <strong>' +
        fmtN(last.lo) + ' ~ ' + fmtN(last.hi) + '</strong>'));
    }
  }

  // ③ 신뢰도 — 검증 오차(MAPE) 범위와 판정, 무의미 태그.
  var mMin = Infinity, mMax = -Infinity, dead = [];
  for (i = 0; i < ok.length; i++) {
    if (ok[i].mape >= 0) { if (ok[i].mape < mMin) mMin = ok[i].mape; if (ok[i].mape > mMax) mMax = ok[i].mape; }
    if (ok[i].mape >= RISK_MAPE) dead.push(ok[i].tag); // 표의 ● 점과 같은 기준(RISK_MAPE) 공유
  }
  if (isFinite(mMin)) {
    var rel = '검증 오차(MAPE) <strong>' +
      ((mMax - mMin < 0.5) ? mMin.toFixed(1) + '%' : mMin.toFixed(0) + '~' + mMax.toFixed(0) + '%') + '</strong> — ' +
      (mMax >= 20 ? '값보다 <strong>방향만</strong> 참고할 수준' : '값도 참고할 만한 수준');
    if (dead.length) rel += ' &nbsp;·&nbsp; ' + codes(dead) + '는 오차 ' + RISK_MAPE + '% 초과로 예측이 사실상 무의미';
    out.push(row('신뢰도', rel));
  }

  // ④ 제외 — 예측 못 한 태그(있을 때만).
  if (bad.length) {
    out.push(row('제외', bad.map(function (b) { return '<code>' + esc(b.tag) + '</code> — ' + esc(b.reason); }).join(' &nbsp;·&nbsp; ')));
  }

  // ⑤ 한계 — 추세 연장 기법이라는 것 한 줄. 앰버 콜아웃(a-caution)으로 강조 — 빨강(오류 의미론)은 과함(사용자 확정).
  out.push(row('한계', '과거의 추세·주기를 앞으로 연장하는 통계 기법입니다 — 특정 값이 아니라 <strong>범위와 방향</strong>으로 읽으세요. 모델별 성적·제외 사유는 아래 모델 비교표 참고.', 'a-caution'));

  return out.join('\n');
}

// 위험 판정 기준: 검증 오차(MAPE)가 이 값을 넘으면 "예측 사실상 무의미" — 표의 ● 점·MAPE 강조·분석문이 전부 공유.
var RISK_MAPE = 40;
// 안내는 **호버 전용**(행 전체 title) — 표 밑 범례 행도 달아봤으나 "지저분하고 없으면 필요 없는 설명"(사용자)이라 철회.
// 짧게: 뜻(무의미)이 먼저, 기준(40%)은 괄호로.
var RISK_TIP = '예측이 사실상 무의미 — 검증 오차(MAPE) ' + RISK_MAPE + '% 초과';

// rows: [{ok, tag, method, slope, r2, mape, last, reason}] (요약표용)
function statsRows(rows) {
  var out = [], i;
  for (i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r.ok) {
      out.push('<tr><td>' + esc(r.tag) + '</td><td colspan="5">' + esc(r.reason) + '</td></tr>');
      continue;
    }
    var arrow = r.slope > 0 ? '&#8593;' : (r.slope < 0 ? '&#8595;' : '&#8594;');
    // 위험 행(MAPE >= RISK_MAPE, "예측 사실상 무의미")만 앞에 상태 점 하나 + MAPE 강조.
    // 모든 셀에 뿌리면 경고 인플레이션이 되므로 **믿기 어려운 행에만** 한정한다(숫자 자체가 이미 신호).
    // 뜻은 **행 전체 호버**로만 안내. ⚠️ 네이티브 title이 아니라 data-tip — title은 커서를 ~1초 정지해야
    // 떠서 사실상 발견 불가(라이브 피드백). 템플릿의 즉석 툴팁 스크립트(tr[data-tip])가 커서 따라 바로 띄운다.
    var risk = (r.mape >= RISK_MAPE);
    out.push('<tr' + (risk ? ' data-tip="' + RISK_TIP + '"' : '') + '>' +
      '<td>' + (risk ? '<span class="dot"></span>' : '') + esc(r.tag) + '</td>' +
      '<td><code>' + esc(r.method) + '</code></td>' +
      '<td class="num">' + arrow + ' ' + fmtN(r.slope) + '</td>' +
      '<td class="num">' + fmtN(r.last) + '</td>' +
      '<td class="num">' + (r.r2na ? '&mdash;' : r.r2.toFixed(2)) + '</td>' +
      '<td class="num' + (risk ? ' warn' : '') + '">' + (r.mape >= 0 ? r.mape.toFixed(1) + '%' : '-') + '</td>' +
      '</tr>');
  }
  return out.join('\n');
}

// 메인: 태그별 {parsed, res} → HTML 저장 → cb(null, {url, filename})
// items: [{tag, parsed, res, row}]
function buildAndSave(mc, opts, items, cb) {
  var table = String(opts.table).toUpperCase();
  var unit = opts.unit || 'day';
  var descOf = opts.descOf || function (m) { return m; };

  var tags = [], perTag = {}, rows = [], i;
  var totalBuckets = 0, minT = Infinity, maxT = -Infinity, horizon = 0;
  for (i = 0; i < items.length; i++) {
    var it = items[i];
    rows.push(it.row);
    if (!it.row.ok) continue;
    tags.push(it.tag);
    perTag[it.tag] = tagPayload(it.parsed, it.res, descOf);
    totalBuckets += it.parsed.n;
    if (it.parsed.ts[0] < minT) minT = it.parsed.ts[0];
    if (it.parsed.ts[it.parsed.ts.length - 1] > maxT) maxT = it.parsed.ts[it.parsed.ts.length - 1];
    if (it.res.stats.H > horizon) horizon = it.res.stats.H;
  }
  if (!tags.length) return cb(null, null); // 그릴 게 없으면 리포트 생략

  var uKo = unitKo(unit);
  var horizonLabel = horizon + uKo;               // "181일" — "181 day"보다 자연스럽다
  var data = { horizonLabel: horizonLabel, unit: uKo, tags: tags, perTag: perTag };

  var logo = logoDataURI();
  var params = {
    TABLE: table,
    LOGO_IMG: logo ? '<img class="logo" src="' + logo + '" alt="Machbase">' : '',
    GENERATED_DATE: stamp(),
    // CAP 초과 자동 선정이면 "5 / 312개"로 전체 규모를 스펙 패널에 명시(분석의 '데이터' 행이 삭제돼 여기가 유일한 자리).
    TAG_COUNT: String(tags.length) + ((opts.topTotal > tags.length) ? '<span class="unit"> / ' + opts.topTotal + '</span>' : ''),
    // 보조 줄 = 선정 기준(태그 이름 나열은 긴 이름이 칸을 침범해 삭제 — 대신 "왜 이 태그들인가"를 짧게).
    TAG_PICK_NOTE: (opts.topTotal > tags.length) ? '데이터 많은 순 상위 선정' : '테이블 전체 태그',
    DATA_UNIT: uKo + ' 단위 데이터',              // 버킷 수(태그 합산이라 오해 유발) 대신 데이터 간격을 말한다
    TIME_RANGE: isFinite(minT) ? (fmtDate(minT) + ' ~ ' + fmtDate(maxT)) : '-',
    ROLLUP_LABEL: uKo,
    HORIZON_LABEL: horizonLabel,
    TAG_STATS_ROWS: statsRows(rows),
    FORECAST_DATA_JSON: JSON.stringify(data),
    ANALYSIS: analysisHtml(horizonLabel, rows, items),
  };

  var html;
  try { html = expandTemplate(params); } catch (e) { return cb(e); }

  var filename = table + '/' + table + '_Forecast_Report_' + fileStamp() + '.html';
  mc.createFolder(table, function () {
    mc.writeFile(filename, html, function (err) {
      if (err) return cb(err);
      cb(null, { filename: filename, url: mc.baseURL + '/db/tql/' + filename, sizeKB: Math.round(html.length / 1024) });
    });
  });
}

module.exports = { buildAndSave: buildAndSave };
