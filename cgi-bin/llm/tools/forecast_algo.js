// forecast_algo — 순수 ES5 예측 엔진. **워커(요약)와 .tql SCRIPT(라이브 차트)가 동일 코드로 실행**된다.
//
// 핵심 트릭: 런타임 함수들을 ES5로 작성하고 algoSource()가 그 소스(toString)를 돌려준다 →
//   compile.js가 SCRIPT 블록에 그대로 구워넣어, 차트가 렌더될 때마다 워커와 **바이트 동일한 로직**으로
//   회귀를 다시 돈다. 중복 구현/불일치가 구조적으로 불가능.
//
// 모델(전부 마지막 실측값에 앵커링 → 끊김 0):
//   - linear      : 최근 L개 버킷 1차 회귀(추세선)
//   - quadratic   : 최근 L개 버킷 2차 회귀(가속/감속 → 곡선)
//   - holtwinters : 가법 삼중지수평활(추세+계절성 → 예측이 주기대로 출렁임)
//   - auto        : 자기상관으로 주기 탐지 → 후보(linear/quadratic[/holtwinters]) 중 **홀드아웃 MAE 최소** 선택
//
// 모든 x는 "버킷 인덱스"(균등 간격 가정 — ROLLUP 버킷은 실시간 간격이 불균등해도 버킷 단위 예측엔 인덱스가 맞다).
// 미래 시각은 lastT + h·step·DAY (step=평균 일 간격)으로 배치.
//
// ⚠️ 여기 함수는 SCRIPT에 통째로 구워지므로 **반드시 ES5**(var/function만, 화살표·const·let·템플릿 금지)이고
//    모듈 스코프 변수에 의존하면 안 된다(서로의 이름 + Math + 인자만 참조). 새 함수 추가 시 RUNTIME 배열에도 등록.

// 선형방정식 Ax=b (가우스 소거, n×n)
function fcSolve(A, b) {
  var n = A.length, i, j, k;
  for (i = 0; i < n; i++) {
    var p = i;
    for (k = i + 1; k < n; k++) { if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k; }
    var tA = A[i]; A[i] = A[p]; A[p] = tA; var tb = b[i]; b[i] = b[p]; b[p] = tb;
    if (Math.abs(A[i][i]) < 1e-12) continue;
    for (k = i + 1; k < n; k++) { var f = A[k][i] / A[i][i]; for (j = i; j < n; j++) A[k][j] -= f * A[i][j]; b[k] -= f * b[i]; }
  }
  var x = []; for (i = 0; i < n; i++) x.push(0);
  for (i = n - 1; i >= 0; i--) {
    var s = b[i]; for (j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = (Math.abs(A[i][i]) < 1e-12) ? 0 : s / A[i][i];
  }
  return x;
}

// 다항 최소제곱 (차수 d=1 또는 2). 정규방정식.
function fcFitPoly(xs, ys, d) {
  var n = xs.length, terms = d + 1, i, j, k;
  var A = [], b = [];
  for (i = 0; i < terms; i++) { var row = []; for (j = 0; j < terms; j++) row.push(0); A.push(row); b.push(0); }
  for (k = 0; k < n; k++) {
    var pw = [1]; for (i = 1; i <= 2 * d; i++) pw.push(pw[i - 1] * xs[k]);
    for (i = 0; i < terms; i++) { for (j = 0; j < terms; j++) A[i][j] += pw[i + j]; b[i] += pw[i] * ys[k]; }
  }
  return fcSolve(A, b);
}
function fcPoly(c, x) { var s = 0, p = 1, i; for (i = 0; i < c.length; i++) { s += c[i] * p; p *= x; } return s; }
function fcResidSd(xs, ys, c) { var ss = 0, i; for (i = 0; i < xs.length; i++) { var e = ys[i] - fcPoly(c, xs[i]); ss += e * e; } return Math.sqrt(ss / Math.max(1, xs.length - c.length)); }
function fcR2(xs, ys, c) {
  var m = 0, i, nn = ys.length; for (i = 0; i < nn; i++) m += ys[i]; m /= nn;
  var sr = 0, st = 0; for (i = 0; i < nn; i++) { var e = ys[i] - fcPoly(c, xs[i]); sr += e * e; st += (ys[i] - m) * (ys[i] - m); }
  return st > 0 ? 1 - sr / st : 0;
}
function fcRmse(errs) { var n = errs.length, s = 0, i; for (i = 0; i < n; i++) s += errs[i] * errs[i]; return Math.sqrt(s / Math.max(1, n - 2)); }

// 최근 L개로 1차 회귀, 마지막값 앵커링 → h개 예측
function fcLinear(ys, L, h) {
  var n = ys.length, s0 = n - L, x = [], yy = [], i;
  for (i = 0; i < L; i++) { x.push(i); yy.push(ys[s0 + i]); }
  var c = fcFitPoly(x, yy, 1), slope = c[1], sd = fcResidSd(x, yy, c), r2 = fcR2(x, yy, c), lastV = ys[n - 1];
  var fc = []; for (i = 1; i <= h; i++) fc.push(lastV + slope * i);
  return { fc: fc, sd: sd, r2: r2, slopePerStep: slope, name: 'linear' };
}

// 최근 L개로 2차 회귀, 증분 앵커링(곡률 유지하며 마지막값에서 이어짐)
function fcQuad(ys, L, h) {
  var n = ys.length, s0 = n - L, x = [], yy = [], i;
  for (i = 0; i < L; i++) { x.push(i); yy.push(ys[s0 + i]); }
  var c = fcFitPoly(x, yy, 2), sd = fcResidSd(x, yy, c), r2 = fcR2(x, yy, c), lastV = ys[n - 1], xl = L - 1;
  var fc = []; for (i = 1; i <= h; i++) fc.push(lastV + (fcPoly(c, xl + i) - fcPoly(c, xl)));
  return { fc: fc, sd: sd, r2: r2, slopePerStep: (fcPoly(c, xl) - fcPoly(c, xl - 1)), name: 'quadratic' };
}

// 가법 Holt-Winters(level/trend/seasonal). 마지막값 앵커링 + 계절 위상 유지 → 예측이 주기대로 출렁임.
function fcHW(ys, m, h, a, b, g) {
  var n = ys.length, i;
  var s1 = 0, s2 = 0; for (i = 0; i < m; i++) s1 += ys[i]; s1 /= m;
  for (i = 0; i < m; i++) s2 += ys[m + i]; s2 /= m;
  var level = s1, trend = (s2 - s1) / m, season = [];
  for (i = 0; i < m; i++) season.push(ys[i] - s1);
  var errs = [];
  for (i = 0; i < n; i++) {
    var si = i % m, prevLevel = level, f = level + trend + season[si];
    if (i >= m) errs.push(ys[i] - f);
    level = a * (ys[i] - season[si]) + (1 - a) * (level + trend);
    trend = b * (level - prevLevel) + (1 - b) * trend;
    season[si] = g * (ys[i] - level) + (1 - g) * season[si];
  }
  var sd = fcRmse(errs), lastV = ys[n - 1], base = level + season[(n - 1) % m];
  var fc = []; for (i = 1; i <= h; i++) { var raw = level + i * trend + season[(n - 1 + i) % m]; fc.push(lastV + (raw - base)); }
  // pseudo-R²: 1 - SSE/SST (계절 시작 이후)
  var mean = 0, cnt = 0; for (i = m; i < n; i++) { mean += ys[i]; cnt++; } if (cnt > 0) mean /= cnt;
  var sse = 0, sst = 0; for (i = 0; i < errs.length; i++) sse += errs[i] * errs[i];
  for (i = m; i < n; i++) sst += (ys[i] - mean) * (ys[i] - mean);
  var r2 = sst > 0 ? 1 - sse / sst : 0;
  return { fc: fc, sd: sd, r2: r2, slopePerStep: trend, period: m, name: 'holtwinters' };
}

// 자기상관 기반 주기 탐지(1차 차분으로 추세 제거 후 ACF 피크). 없으면 0.
function fcPeriod(ys, minLag, maxLag) {
  var n = ys.length, i;
  if (n < 2 * minLag + 4) return 0;
  var d = []; for (i = 1; i < n; i++) d.push(ys[i] - ys[i - 1]);
  var nd = d.length, mean = 0; for (i = 0; i < nd; i++) mean += d[i]; mean /= nd;
  var denom = 0; for (i = 0; i < nd; i++) { var e = d[i] - mean; denom += e * e; }
  if (denom <= 0) return 0;
  var best = 0, bestAcf = 0, hi = Math.min(maxLag, Math.floor(nd / 2));
  for (var lag = minLag; lag <= hi; lag++) {
    var num = 0; for (i = lag; i < nd; i++) num += (d[i] - mean) * (d[i - lag] - mean);
    var acf = num / denom;
    if (acf > bestAcf) { bestAcf = acf; best = lag; }
  }
  return (bestAcf >= 0.3) ? best : 0;
}

// 메인: ts(ms)/ys 배열 + opts → { method, period, points:[{t,v,lo,hi}], stats }
// opts: { method:'auto'|'linear'|'quadratic'|'holtwinters', horizon, lookback, period, alpha,beta,gamma }
function fcRun(ts, ys, opts) {
  opts = opts || {};
  var n = ys.length, DAY = 86400000, i;
  var H = opts.horizon; if (!(H >= 1)) H = Math.max(1, Math.round(n * 0.25));
  var L = opts.lookback; if (!(L >= 2)) L = Math.max(10, Math.round(n * 0.33)); if (L > n) L = n; if (L < 2) L = n;
  var step = (n > 1) ? (ts[n - 1] - ts[0]) / (n - 1) / DAY : 1; if (!(step > 0)) step = 1;
  var lastT = ts[n - 1], lastV = ys[n - 1];
  var a = opts.alpha || 0.4, b = opts.beta || 0.05, g = opts.gamma || 0.3;

  function fitOn(method, data, h, per) {
    var dn = data.length, Ld = Math.min(L, dn); if (Ld < 2) Ld = dn;
    if (method === 'quadratic') return fcQuad(data, Ld, h);
    if (method === 'holtwinters') return fcHW(data, per, h, a, b, g);
    return fcLinear(data, Ld, h);
  }

  var method = opts.method || 'auto';
  var period = opts.period || 0;
  if (method === 'auto') {
    if (!period) period = fcPeriod(ys, 2, Math.min(Math.floor(n / 3), 60));
    var cands = ['linear', 'quadratic'];
    if (period >= 2 && n >= 2 * period + 2) cands.push('holtwinters');
    var T = Math.round(n * 0.2); if (T < 3) T = 3; if (T > n - 4) T = Math.floor((n - 1) / 2); if (T < 1) T = 1;
    var train = ys.slice(0, n - T), tail = ys.slice(n - T);
    // 폭발 가드: 예측이 과거 범위를 크게 벗어나면(2차 외삽 폭주) 후보 제외
    var hmin = ys[0], hmax = ys[0]; for (i = 1; i < n; i++) { if (ys[i] < hmin) hmin = ys[i]; if (ys[i] > hmax) hmax = ys[i]; }
    var hrange = hmax - hmin; if (!(hrange > 0)) hrange = Math.abs(hmax) || 1;
    var maes = {};
    for (var ci = 0; ci < cands.length; ci++) {
      var cm = cands[ci];
      if (cm === 'holtwinters' && train.length < 2 * period + 2) continue;
      var r; try { r = fitOn(cm, train, T, period); } catch (e) { continue; }
      if (!r || !r.fc) continue;
      var mae = 0, c2 = 0; for (i = 0; i < T; i++) { if (isFinite(r.fc[i])) { mae += Math.abs(r.fc[i] - tail[i]); c2++; } }
      if (c2 === 0) continue; mae /= c2;
      // 전체 구간 적합으로 폭발 검사: H-step 예측이 과거범위±3·range 벗어나면 큰 페널티
      var rf; try { rf = fitOn(cm, ys, H, period); } catch (e2) { rf = null; }
      if (rf && rf.fc && rf.fc.length) {
        var ext = rf.fc[rf.fc.length - 1];
        if (!isFinite(ext) || ext > hmax + 3 * hrange || ext < hmin - 3 * hrange) mae *= 100; // 폭주 → 사실상 탈락
      }
      maes[cm] = mae;
    }
    // 단순 모델 선호: linear 기준, 복잡 모델(quadratic/holtwinters)은 **15% 이상 나을 때만** 채택(과대외삽 억제).
    var linMae = (maes.linear != null) ? maes.linear : Infinity;
    var bestM = 'linear', bestErr = linMae;
    var others = ['holtwinters', 'quadratic'];
    for (var oi = 0; oi < others.length; oi++) {
      var om = others[oi];
      if (maes[om] != null && maes[om] < linMae * 0.70 && maes[om] < bestErr) { bestErr = maes[om]; bestM = om; }
    }
    if (linMae === Infinity && bestM === 'linear') { // linear 평가 실패 시 가용한 것 중 최선
      var fb = null; for (var fk in maes) if (maes.hasOwnProperty(fk) && (fb === null || maes[fk] < maes[fb])) fb = fk;
      if (fb) bestM = fb;
    }
    method = bestM;
  }
  if (method === 'holtwinters' && !(period >= 2)) {
    period = fcPeriod(ys, 2, Math.min(Math.floor(n / 3), 60));
    if (!(period >= 2) || n < 2 * period + 2) method = 'linear';
  }

  // 댐핑(damped trend): 단계별 증분에 φ^(h-1) 가중 → 근미래는 추세 유지, 먼 미래는 점차 완만(폭주 방지·현실적).
  // 계절성 출렁임도 근미래는 보존, 먼 미래만 약화. φ는 길이에 맞춰 자동. (백테스트도 동일 적용 → 배포 모델과 일치)
  function dampSeries(rawFc, baseV) {
    var H2 = rawFc.length, phi = opts.damp, out = [], acc = baseV, j;
    if (!(phi > 0 && phi < 1)) phi = Math.max(0.90, Math.min(0.99, 1 - 1.5 / Math.max(2, H2)));
    for (j = 0; j < H2; j++) {
      var prev = (j === 0) ? baseV : rawFc[j - 1], marg = rawFc[j] - prev;
      if (!isFinite(marg)) marg = 0;
      acc += Math.pow(phi, j) * marg; out.push(acc);
    }
    return out;
  }

  var fr = fitOn(method, ys, H, period), sd = fr.sd || 0;
  fr.fc = dampSeries(fr.fc, lastV);
  // 앵커점: 예측선·밴드가 **마지막 실측점에서 정확히 출발**(밴드 폭 0 → cone). 실측선과 시각적으로 빈틈없이 연결.
  var pts = [{ t: lastT, v: lastV, lo: lastV, hi: lastV }];
  for (i = 1; i <= H; i++) {
    var v = fr.fc[i - 1]; if (!isFinite(v)) v = lastV;
    var band = 1.96 * sd * Math.sqrt(1 + i / n), t = Math.round(lastT + i * step * DAY); // 정수 ms(인라인 리터럴 길이 축소)
    pts.push({ t: t, v: v, lo: v - band, hi: v + band });
  }

  // 백테스트: 최근 Tb를 가려 학습→예측해 정확도(MAPE/MAE) + 오버레이용 예측선. 배포 모델과 동일(같은 method+댐핑).
  var bt = [], mape = -1, mae = -1, testN = 0;
  var Tb = Math.round(n * 0.2); if (Tb < 3) Tb = 3; if (Tb > Math.floor(n / 2)) Tb = Math.floor(n / 2);
  if (Tb >= 1 && (method !== 'holtwinters' || (n - Tb) >= 2 * period + 2)) {
    var trb = ys.slice(0, n - Tb), bbase = ys[n - Tb - 1], bf;
    try { bf = fitOn(method, trb, Tb, period); } catch (e) { bf = null; }
    if (bf && bf.fc) {
      var bdc = dampSeries(bf.fc, bbase), se = 0, sp = 0, c = 0, j;
      for (j = 0; j < Tb; j++) {
        var pv = bdc[j], av = ys[n - Tb + j];
        if (!isFinite(pv)) continue;
        bt.push({ t: ts[n - Tb + j], v: pv });
        se += Math.abs(pv - av);
        if (av !== 0) { sp += Math.abs((pv - av) / av); c++; }
      }
      if (bt.length) { testN = bt.length; mae = se / bt.length; mape = c ? (sp / c * 100) : -1; }
    }
  }

  return {
    method: method, period: (method === 'holtwinters' ? period : 0), points: pts, backtest: bt,
    stats: { n: n, H: H, L: L, step: step, lastV: lastV, lastT: lastT, sd: sd, r2: fr.r2 || 0, slopePerStep: fr.slopePerStep || 0, mape: mape, mae: mae, testN: testN }
  };
}

// SCRIPT에 구워질 런타임 함수 집합(서로만 참조 + Math). 새 함수 추가 시 여기에도 등록!
var RUNTIME = [fcSolve, fcFitPoly, fcPoly, fcResidSd, fcR2, fcRmse, fcLinear, fcQuad, fcHW, fcPeriod, fcRun];
function algoSource() {
  var out = []; for (var i = 0; i < RUNTIME.length; i++) out.push(RUNTIME[i].toString());
  return out.join('\n');
}

module.exports = { fcRun: fcRun, fcPeriod: fcPeriod, algoSource: algoSource };
