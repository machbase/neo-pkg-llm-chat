// forecast_report — 예측 결과 HTML 리포트 생성(템플릿 R-4-forecast)
// · 태그 드롭다운 × 모델 드롭다운으로 전 모델 예측 곡선 열람(fcRun opts.allModels)
// · 차트는 외부 라이브러리 없이 canvas 2D(오프라인·CDN 불가 환경 대응)
// · 분석문은 결정론 생성(LLM 2차 호출 없음 — 모델의 저장 생략·가짜 URL 방지)
// · 템플릿은 neo/forecast/에 둠 — neo/report/면 리포트 스캐너에 노출돼 {FORECAST_DATA_JSON} 미치환 빈 페이지
var fs = require('fs');
var path = require('path');
var { withUserRoot, ensureParentOf, shortTableName } = require('./paths');
var { wallTime, userZone } = require('../machbase/timezone');

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

// 헤더 로고 → base64 data URI(단일 HTML 리포트라 외부 파일 참조 불가)
// · 미리 인코딩된 .b64를 utf8로 읽음 — jsh fs.readFileSync(png)는 Buffer가 아닌 문자열이라 런타임 base64 인코딩 불가
// · 로고 교체: node -e "require('fs').writeFileSync('machbase-logo-header.b64', require('fs').readFileSync('machbase-logo-header.png').toString('base64'))"
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

// 버킷 단위 → 한국어 간격 표현("일 단위 데이터" 등)
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
// 날짜·생성 시각은 사용자 시간대 기준
function fmtDate(ms, zone) { return wallTime(ms, zone.offsetMin).slice(0, 10); }
function stamp(zone) { return wallTime(Date.now(), zone.offsetMin).slice(0, 16); }
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
  // 자동 선택 모델이 리더보드에 없으면(폴백 등) 직접 추가
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

// 결정론적 분석문(HTML) — 수치 근거만, 예측값을 확정된 미래처럼 서술 안 함
// · 라벨 + 한 줄 행(.a-row): 방향 / 예측값 / 신뢰도 / 제외 / 한계
// · '데이터' 행 없음(스펙 패널과 중복), 모델 선택 근거는 모델 비교표 담당
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

  // ② 예측값 — 대표 태그(검증 오차 최소) 하나만 값·95% 범위로
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

  // ⑤ 한계 — 추세 연장 기법임을 한 줄, 앰버 콜아웃(a-caution)
  out.push(row('한계', '과거의 추세·주기를 앞으로 연장하는 통계 기법입니다 — 특정 값이 아니라 <strong>범위와 방향</strong>으로 읽으세요. 모델별 성적·제외 사유는 아래 모델 비교표 참고.', 'a-caution'));

  return out.join('\n');
}

// 위험 판정 기준: 검증 오차(MAPE)가 이 값을 넘으면 "예측 사실상 무의미" — 표의 ● 점·MAPE 강조·분석문이 전부 공유.
var RISK_MAPE = 40;
// 위험 행 호버 안내 문구(뜻 먼저, 기준은 뒤)
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
    // 위험 행(MAPE >= RISK_MAPE)만 상태 점 + MAPE 강조, 뜻은 행 호버로 안내
    // · title 대신 data-tip — 템플릿 즉석 툴팁(tr[data-tip])용, 네이티브 title은 표시 지연
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
  var horizonLabel = horizon + uKo;               // 예: "181일"
  var data = { horizonLabel: horizonLabel, unit: uKo, tags: tags, perTag: perTag };

  var logo = logoDataURI();
  var zone = userZone(mc);
  var params = {
    TABLE: table,
    LOGO_IMG: logo ? '<img class="logo" src="' + logo + '" alt="Machbase">' : '',
    GENERATED_DATE: stamp(zone),
    // CAP 초과 자동 선정이면 "5 / 312"로 전체 규모 표시
    TAG_COUNT: String(tags.length) + ((opts.topTotal > tags.length) ? '<span class="unit"> / ' + opts.topTotal + '</span>' : ''),
    // 보조 줄 = 태그 선정 기준
    TAG_PICK_NOTE: (opts.topTotal > tags.length) ? '데이터 많은 순 상위 선정' : '테이블 전체 태그',
    DATA_UNIT: uKo + ' 단위 데이터',              // 데이터 간격 표시(버킷 수는 태그 합산이라 오해 유발)
    TIME_RANGE: isFinite(minT) ? (fmtDate(minT, zone) + ' ~ ' + fmtDate(maxT, zone)) : '-',
    ROLLUP_LABEL: uKo,
    HORIZON_LABEL: horizonLabel,
    TAG_STATS_ROWS: statsRows(rows),
    FORECAST_DATA_JSON: JSON.stringify(data),
    ANALYSIS: analysisHtml(horizonLabel, rows, items),
  };

  var html;
  try { html = expandTemplate(params); } catch (e) { return cb(e); }

  // 계정 폴더 아래 저장 — url도 이 이름 기준
  var pathName = shortTableName(table);
  var filename = withUserRoot(mc, pathName + '/' + pathName + '_Forecast_Report_' + fileStamp() + '.html');
  ensureParentOf(mc, filename, function () {
    mc.writeFile(filename, html, function (err) {
      if (err) return cb(err);
      cb(null, { filename: filename, url: mc.baseURL + '/db/tql/' + filename, sizeKB: Math.round(html.length / 1024) });
    });
  });
}

module.exports = { buildAndSave: buildAndSave };
