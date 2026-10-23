// forecast_algo — 순수 ES5 예측 엔진, 워커와 .tql SCRIPT(라이브 차트)가 동일 코드로 실행
// · algoSource()가 런타임 함수 소스(toString) 반환 → compile.js가 SCRIPT에 구워 넣음
// · 모든 x는 버킷 인덱스(균등 간격 가정), 미래 시각은 lastT + h·step·DAY(step=평균 일 간격)
// · 예측은 전부 마지막 실측값에 앵커링
// ⚠️ 런타임 함수는 반드시 ES5(var/function만, 화살표·const·let·템플릿 금지), 모듈 스코프 변수 참조 금지(서로의 이름 + Math + 인자만)

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
  if (!(m >= 2) || n < 2 * m + 2) return { fc: [], invalid: true, name: 'holtwinters' };
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
  var sd = fcRmse(errs), lastV = ys[n - 1], sLast = season[(n - 1) % m];
  // 추세/계절 분리: fc(h) = lastV + (h*trend) + (season[h] - season[last]) → fcRun이 추세에만 댐핑 적용.
  var fc = [], fcT = [], fcS = [];
  for (i = 1; i <= h; i++) {
    var dT = i * trend, dS = season[(n - 1 + i) % m] - sLast;
    fcT.push(dT); fcS.push(dS); fc.push(lastV + dT + dS);
  }
  // pseudo-R²: 1 - SSE/SST (계절 시작 이후)
  var mean = 0, cnt = 0; for (i = m; i < n; i++) { mean += ys[i]; cnt++; } if (cnt > 0) mean /= cnt;
  var sse = 0, sst = 0; for (i = 0; i < errs.length; i++) sse += errs[i] * errs[i];
  for (i = m; i < n; i++) sst += (ys[i] - mean) * (ys[i] - mean);
  var r2 = sst > 0 ? 1 - sse / sst : 0;
  return { fc: fc, fcTrend: fcT, fcSeason: fcS, sd: sd, r2: r2, slopePerStep: trend, period: m, name: 'holtwinters' };
}

// 자기상관 기반 주기 탐지 — 선형 추세 제거 후 ACF 피크(차분은 장주기를 놓침)
function fcPeriod(ys, minLag, maxLag) {
  var n = ys.length, i;
  if (n < 2 * minLag + 4) return 0;
  var x = []; for (i = 0; i < n; i++) x.push(i);
  var cf = fcFitPoly(x, ys, 1);
  var d = []; for (i = 0; i < n; i++) d.push(ys[i] - (cf[0] + cf[1] * i));
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

// 일반 최소제곱(임의 설계행렬). X=행벡터 배열, y=관측. 정규방정식 + 가우스소거.
function fcOLS(X, y) {
  var n = X.length, p = X[0].length, i, j, k;
  var A = [], b = [];
  for (i = 0; i < p; i++) { var row = []; for (j = 0; j < p; j++) row.push(0); A.push(row); b.push(0); }
  for (k = 0; k < n; k++) {
    for (i = 0; i < p; i++) {
      for (j = 0; j < p; j++) A[i][j] += X[k][i] * X[k][j];
      b[i] += X[k][i] * y[k];
    }
  }
  return fcSolve(A, b);
}
// 설계행렬 기반 모델의 공통 마무리: 앵커링 + 잔차sd + R²
// · nTrend = 앞쪽 추세 성분 계수 개수(나머지는 계절/Fourier) → fcTrend/fcSeason 분리 반환(추세에만 댐핑용)
function fcFromDesign(ys, rowFn, coef, h, name, period, nTrend) {
  var n = ys.length, i, q;
  function part(t, from, to) { var r = rowFn(t), s = 0; for (q = from; q < to && q < r.length; q++) s += coef[q] * r[q]; return s; }
  function pred(t) { return part(t, 0, coef.length); }
  if (!(nTrend >= 1)) nTrend = coef.length; // 분리 정보 없으면 전부 추세로 취급
  var errs = [], mean = 0;
  for (i = 0; i < n; i++) mean += ys[i]; mean /= n;
  var sr = 0, st = 0;
  for (i = 0; i < n; i++) { var e = ys[i] - pred(i); errs.push(e); sr += e * e; st += (ys[i] - mean) * (ys[i] - mean); }
  var sd = fcRmse(errs), lastV = ys[n - 1];
  var bT = part(n - 1, 0, nTrend), bS = part(n - 1, nTrend, coef.length);
  var fc = [], fcT = [], fcS = [];
  for (i = 1; i <= h; i++) {
    var dT = part(n - 1 + i, 0, nTrend) - bT;
    var dS = part(n - 1 + i, nTrend, coef.length) - bS;
    fcT.push(dT); fcS.push(dS); fc.push(lastV + dT + dS);
  }
  return {
    fc: fc, fcTrend: fcT, fcSeason: fcS, sd: sd,
    r2: (st > 0 ? 1 - sr / st : 0), slopePerStep: (pred(n - 1) - pred(n - 2)),
    period: period || 0, name: name,
  };
}

// SES(단순지수평활) — 마지막값에서 평평한 무변화 기준선
function fcSES(ys, h, a) {
  var n = ys.length, level = ys[0], errs = [], i;
  for (i = 1; i < n; i++) { errs.push(ys[i] - level); level = a * ys[i] + (1 - a) * level; }
  var lastV = ys[n - 1], fc = [];
  for (i = 1; i <= h; i++) fc.push(lastV);
  return { fc: fc, sd: fcRmse(errs), r2: 0, slopePerStep: 0, name: 'ses' };
}

// Holt(선형추세 지수평활) — level+trend 지수가중 추정
function fcHolt(ys, h, a, b) {
  var n = ys.length, level = ys[0], trend = (n > 1 ? ys[1] - ys[0] : 0), errs = [], i;
  for (i = 1; i < n; i++) {
    var f = level + trend; errs.push(ys[i] - f);
    var pl = level;
    level = a * ys[i] + (1 - a) * (level + trend);
    trend = b * (level - pl) + (1 - b) * trend;
  }
  var lastV = ys[n - 1], fc = [];
  for (i = 1; i <= h; i++) fc.push(lastV + trend * i);
  return { fc: fc, sd: fcRmse(errs), r2: 0, slopePerStep: trend, name: 'holt' };
}

// Theta(단순화형) — 마지막값 + OLS 드리프트의 절반, 오차는 SES 기준
function fcTheta(ys, h, a) {
  var n = ys.length, i, x = [];
  for (i = 0; i < n; i++) x.push(i);
  var c = fcFitPoly(x, ys, 1), b = c[1];
  var level = ys[0], errs = [];
  for (i = 1; i < n; i++) { errs.push(ys[i] - level); level = a * ys[i] + (1 - a) * level; }
  var lastV = ys[n - 1], fc = [];
  for (i = 1; i <= h; i++) fc.push(lastV + 0.5 * b * i);
  return { fc: fc, sd: fcRmse(errs), r2: fcR2(x, ys, c), slopePerStep: 0.5 * b, name: 'theta' };
}

// 곱셈형 Holt-Winters — 계절 진폭이 레벨에 비례하는 데이터(값이 전부 양수여야 함).
function fcHWmult(ys, m, h, a, b, g) {
  var n = ys.length, i;
  if (!(m >= 2) || n < 2 * m + 2) return { fc: [], invalid: true, name: 'holtwinters_mult' };
  for (i = 0; i < n; i++) { if (!(ys[i] > 0)) return { fc: [], invalid: true, name: 'holtwinters_mult' }; }
  var s1 = 0, s2 = 0;
  for (i = 0; i < m; i++) s1 += ys[i]; s1 /= m;
  for (i = 0; i < m; i++) s2 += ys[m + i]; s2 /= m;
  var level = s1, trend = (s2 - s1) / m, season = [];
  for (i = 0; i < m; i++) season.push(s1 !== 0 ? ys[i] / s1 : 1);
  var errs = [];
  for (i = 0; i < n; i++) {
    var si = i % m, pl = level, sv = (season[si] !== 0 ? season[si] : 1);
    var f = (level + trend) * sv;
    if (i >= m) errs.push(ys[i] - f);
    level = a * (ys[i] / sv) + (1 - a) * (level + trend);
    trend = b * (level - pl) + (1 - b) * trend;
    season[si] = (level !== 0 ? g * (ys[i] / level) : season[si]) + (1 - g) * season[si];
  }
  var sd = fcRmse(errs), lastV = ys[n - 1], sLast = season[(n - 1) % m];
  // 곱셈형 분리: (level + h·trend)·s_h − level·s_last = [h·trend·s_h](추세) + [level·(s_h − s_last)](계절)
  var fc = [], fcT = [], fcS = [];
  for (i = 1; i <= h; i++) {
    var sh = season[(n - 1 + i) % m];
    var dT = i * trend * sh, dS = level * (sh - sLast);
    fcT.push(dT); fcS.push(dS); fc.push(lastV + dT + dS);
  }
  var mean = 0, cnt = 0; for (i = m; i < n; i++) { mean += ys[i]; cnt++; } if (cnt > 0) mean /= cnt;
  var sse = 0, sst = 0;
  for (i = 0; i < errs.length; i++) sse += errs[i] * errs[i];
  for (i = m; i < n; i++) sst += (ys[i] - mean) * (ys[i] - mean);
  return { fc: fc, fcTrend: fcT, fcSeason: fcS, sd: sd, r2: (sst > 0 ? 1 - sse / sst : 0), slopePerStep: trend, period: m, name: 'holtwinters_mult' };
}

// 2차 주기 탐지(1차 주기의 배수/약수는 제외) → 다중 계절성(예: 일 + 주)용.
function fcPeriod2(ys, p1, minLag, maxLag) {
  var n = ys.length, i;
  if (!(p1 >= 2) || n < 2 * minLag + 4) return 0;
  var x = []; for (i = 0; i < n; i++) x.push(i);
  var cf = fcFitPoly(x, ys, 1);
  var d = []; for (i = 0; i < n; i++) d.push(ys[i] - (cf[0] + cf[1] * i));
  var nd = d.length, mean = 0; for (i = 0; i < nd; i++) mean += d[i]; mean /= nd;
  var den = 0; for (i = 0; i < nd; i++) { var e = d[i] - mean; den += e * e; }
  if (den <= 0) return 0;
  var best = 0, bestAcf = 0, hi = Math.min(maxLag, Math.floor(nd / 2));
  for (var lag = minLag; lag <= hi; lag++) {
    if (lag % p1 === 0 || p1 % lag === 0 || Math.abs(lag - p1) <= 1) continue; // 같은 주기의 하모닉 제외
    var num = 0; for (i = lag; i < nd; i++) num += (d[i] - mean) * (d[i - lag] - mean);
    var acf = num / den;
    if (acf > bestAcf) { bestAcf = acf; best = lag; }
  }
  return (bestAcf >= 0.25) ? best : 0;
}

// 하모닉(Fourier) 회귀 — 추세 + 주기별 sin/cos K항, 다중 주기 동시 처리
// · n ≥ 2×주기인 주기만 사용
function fcHarmonic(ys, periods, h, K) {
  var n = ys.length, i, j, k, ps = [];
  for (i = 0; i < periods.length; i++) { if (periods[i] >= 2 && n >= 2 * periods[i]) ps.push(periods[i]); }
  if (ps.length === 0) return { fc: [], invalid: true, name: 'harmonic' };
  if (!(K >= 1)) K = 2;
  function rowFn(t) {
    var r = [1, t];
    for (j = 0; j < ps.length; j++) {
      var Kj = Math.max(1, Math.min(K, Math.floor(ps[j] / 2)));
      for (k = 1; k <= Kj; k++) { r.push(Math.sin(2 * Math.PI * k * t / ps[j])); r.push(Math.cos(2 * Math.PI * k * t / ps[j])); }
    }
    return r;
  }
  var X = []; for (i = 0; i < n; i++) X.push(rowFn(i));
  if (X[0].length >= n) return { fc: [], invalid: true, name: 'harmonic' }; // 파라미터 과다
  var c = fcOLS(X, ys);
  return fcFromDesign(ys, rowFn, c, h, 'harmonic', ps[0], 2); // nTrend=2([1,t]), 나머지는 Fourier(계절)
}

// Prophet식 — 구간별 선형추세(변화점 basis) + Fourier 계절성
// · 외삽은 마지막 구간의 기울기 유지
function fcProphetLike(ys, period, h, nCP) {
  var n = ys.length, i, j, k;
  if (n < 30) return { fc: [], invalid: true, name: 'prophet' };
  if (!(nCP >= 1)) nCP = Math.min(6, Math.max(2, Math.floor(n / 40)));
  var cps = []; for (j = 1; j <= nCP; j++) cps.push(Math.floor(n * 0.8 * j / (nCP + 1)));
  var K = (period >= 4 && n >= 2 * period) ? Math.max(1, Math.min(2, Math.floor(period / 2))) : 0;
  function rowFn(t) {
    var r = [1, t];
    for (j = 0; j < cps.length; j++) r.push(Math.max(0, t - cps[j]));
    for (k = 1; k <= K; k++) { r.push(Math.sin(2 * Math.PI * k * t / period)); r.push(Math.cos(2 * Math.PI * k * t / period)); }
    return r;
  }
  var X = []; for (i = 0; i < n; i++) X.push(rowFn(i));
  if (X[0].length >= n) return { fc: [], invalid: true, name: 'prophet' };
  var c = fcOLS(X, ys);
  // nTrend = [1, t] + 변화점 basis → 그 뒤가 Fourier(계절)
  return fcFromDesign(ys, rowFn, c, h, 'prophet', (K > 0 ? period : 0), 2 + cps.length);
}

// AR(p) + 차분(d) — ARIMA(p,d,0), MA항 없음
// · sd는 원래 스케일 1-step 잔차로 계산(차분 스케일 sd는 밴드 왜곡)
function fcAR(ys, p, d, h) {
  var n = ys.length, i, j;
  if (!(p >= 1)) p = 2;
  d = (d === 1) ? 1 : 0;
  var y = ys;
  if (d === 1) { var z = []; for (i = 1; i < n; i++) z.push(ys[i] - ys[i - 1]); y = z; }
  var ny = y.length;
  if (ny < p + 8) return { fc: [], invalid: true, name: 'ar' };
  var X = [], Y = [];
  for (i = p; i < ny; i++) { var r = [1]; for (j = 1; j <= p; j++) r.push(y[i - j]); X.push(r); Y.push(y[i]); }
  var c = fcOLS(X, Y);
  var errs = [];
  for (i = p; i < ny; i++) {
    var s2 = c[0]; for (j = 1; j <= p; j++) s2 += c[j] * y[i - j];
    var actual, predOrig;
    if (d === 1) { actual = ys[i + 1]; predOrig = ys[i] + s2; } else { actual = ys[i]; predOrig = s2; }
    if (isFinite(actual) && isFinite(predOrig)) errs.push(actual - predOrig);
  }
  var sd = fcRmse(errs);
  var hist = y.slice(), fd = [];
  for (i = 0; i < h; i++) {
    var s = c[0]; for (j = 1; j <= p; j++) s += c[j] * hist[hist.length - j];
    if (!isFinite(s)) s = 0;
    fd.push(s); hist.push(s);
  }
  var lastV = ys[n - 1], fc = [], acc = lastV;
  if (d === 1) { for (i = 0; i < h; i++) { acc += fd[i]; fc.push(acc); } }
  else { for (i = 0; i < h; i++) fc.push(fd[i]); }
  return { fc: fc, sd: sd, r2: 0, slopePerStep: (fc.length ? fc[0] - lastV : 0), name: 'ar' };
}

// 모델 지정 별칭 → 표준 method. 영문/한국어/약칭 모두 수용("계절성","선형","2차","hw","holt-winters"…).
// ''(빈문자)=모름 → 호출부가 자동선택으로 처리.
function fcNormMethod(m) {
  if (m == null || m === '') return 'auto';
  var A = {
    'auto': 'auto', '자동': 'auto',
    'linear': 'linear', '선형': 'linear', '추세': 'linear', '추세선': 'linear', 'trend': 'linear', 'ols': 'linear', '회귀': 'linear', '선형회귀': 'linear',
    'quadratic': 'quadratic', 'quad': 'quadratic', '2차': 'quadratic', '이차': 'quadratic', '곡선': 'quadratic', '가속': 'quadratic', 'poly': 'quadratic', '다항': 'quadratic', '2차회귀': 'quadratic',
    'holtwinters': 'holtwinters', 'holtwinter': 'holtwinters', 'hw': 'holtwinters', '계절성': 'holtwinters', '계절': 'holtwinters', '주기': 'holtwinters',
    'seasonal': 'holtwinters', '홀트윈터스': 'holtwinters', '가법계절성': 'holtwinters', 'hwadd': 'holtwinters',
    'holtwintersmult': 'holtwinters_mult', 'holtwinters_mult': 'holtwinters_mult', 'hwmult': 'holtwinters_mult', 'hwm': 'holtwinters_mult',
    '곱셈형': 'holtwinters_mult', '곱셈계절성': 'holtwinters_mult', 'multiplicative': 'holtwinters_mult', '승법': 'holtwinters_mult',
    'ses': 'ses', 'naive': 'ses', '기준선': 'ses', '무변화': 'ses', '단순지수평활': 'ses', '평활': 'ses', 'flat': 'ses',
    'holt': 'holt', '홀트': 'holt', '지수평활추세': 'holt', 'expsmoothing': 'holt', '지수평활': 'holt',
    'theta': 'theta', '세타': 'theta',
    'harmonic': 'harmonic', 'fourier': 'harmonic', '하모닉': 'harmonic', '푸리에': 'harmonic', '다중주기': 'harmonic', '조화': 'harmonic',
    'prophet': 'prophet', '프로핏': 'prophet', '변화점': 'prophet', 'changepoint': 'prophet', '구간추세': 'prophet',
    'ar': 'ar', 'arima': 'ar', 'sarima': 'ar', '자기회귀': 'ar', '차분': 'ar'
  };
  var s = String(m).trim();
  var k = s.toLowerCase().replace(/[\s_\-().]/g, '').replace(/(모델|방식|법|으로|로)$/, '');
  return A[k] || A[s] || '';
}
// "2위" / "2등" / "2번째" / "rank2" → 2. 없으면 0.
function fcParseRank(m) {
  if (m == null) return 0;
  var s = String(m);
  var r = /rank\s*(\d+)/i.exec(s);
  if (!r) r = /(\d+)\s*(위|등|번째|순위)/.exec(s);
  return r ? parseInt(r[1], 10) : 0;
}

// 메인: ts(ms)/ys + opts → { method, period, points:[{t,v,lo,hi}], backtest, leaderboard, note, stats }
// · opts: { method(별칭/순위 가능), rank(1-based), horizon, lookback, period, alpha,beta,gamma, board:false=리더보드 생략, allModels }
// · leaderboard = 후보별 홀드아웃 MAPE 순위
function fcRun(ts, ys, opts) {
  opts = opts || {};
  var n = ys.length, DAY = 86400000, i;
  // 기본 호라이즌 = 학습의 20%
  var H = opts.horizon; if (!(H >= 1)) H = Math.max(1, Math.round(n * 0.20));
  var L = opts.lookback; if (!(L >= 2)) L = Math.max(10, Math.round(n * 0.33)); if (L > n) L = n; if (L < 2) L = n;
  var step = (n > 1) ? (ts[n - 1] - ts[0]) / (n - 1) / DAY : 1; if (!(step > 0)) step = 1;
  var lastT = ts[n - 1], lastV = ys[n - 1];
  var a = opts.alpha || 0.4, b = opts.beta || 0.05, g = opts.gamma || 0.3;

  var per2 = 0; // 2차 주기(다중 계절성용) — 아래서 채움
  var fixed = (opts.alpha != null); // 사용자가 파라미터를 명시하면 튜닝 생략
  var tuneCache = {};

  // 모델별 파라미터 후보 그리드
  function gridFor(method) {
    var As = [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9];
    var Bs = [0.02, 0.05, 0.1, 0.2, 0.4];
    var Gs = [0.05, 0.1, 0.2, 0.4];
    var out = [], i, j, k;
    if (method === 'ses' || method === 'theta') { for (i = 0; i < As.length; i++) out.push({ a: As[i] }); return out; }
    if (method === 'holt') { for (i = 0; i < As.length; i++) for (j = 0; j < Bs.length; j++) out.push({ a: As[i], b: Bs[j] }); return out; }
    if (method === 'holtwinters' || method === 'holtwinters_mult') {
      for (i = 0; i < As.length; i++) for (j = 0; j < Bs.length; j++) for (k = 0; k < Gs.length; k++) out.push({ a: As[i], b: Bs[j], g: Gs[k] });
      return out;
    }
    if (method === 'ar') { for (i = 1; i <= 5; i++) { out.push({ p: i, d: 0 }); out.push({ p: i, d: 1 }); } return out; }
    if (method === 'harmonic') { for (i = 1; i <= 3; i++) out.push({ K: i }); return out; }
    if (method === 'prophet') { var cs = [2, 4, 6, 8]; for (i = 0; i < cs.length; i++) out.push({ cp: cs[i] }); return out; }
    if (method === 'linear' || method === 'quadratic') {
      if (opts.lookback >= 2) return [{ L: L }];
      var Ls = [Math.round(n * 0.25), Math.round(n * 0.33), Math.round(n * 0.5), n];
      for (i = 0; i < Ls.length; i++) { if (Ls[i] >= 5) out.push({ L: Ls[i] }); }
      return out.length ? out : [{ L: L }];
    }
    return [{}];
  }

  function fitWith(method, data, h, per, P) {
    var dn = data.length;
    var Ld = (P && P.L >= 2) ? Math.min(P.L, dn) : Math.min(L, dn); if (Ld < 2) Ld = dn;
    if (method === 'quadratic') return fcQuad(data, Ld, h);
    if (method === 'ses') return fcSES(data, h, P.a);
    if (method === 'holt') return fcHolt(data, h, P.a, P.b);
    if (method === 'theta') return fcTheta(data, h, P.a);
    if (method === 'ar') return fcAR(data, P.p, P.d, h);
    if (method === 'holtwinters') return fcHW(data, per, h, P.a, P.b, P.g);
    if (method === 'holtwinters_mult') return fcHWmult(data, per, h, P.a, P.b, P.g);
    if (method === 'harmonic') return fcHarmonic(data, (per2 >= 2 ? [per, per2] : [per]), h, P.K);
    if (method === 'prophet') return fcProphetLike(data, per, h, P.cp);
    return fcLinear(data, Ld, h);
  }

  // 파라미터 튜닝 — data 안에서 다시 20%를 떼어 다단계 예측 MAPE(댐핑 포함)로 선택
  // · 리더보드 홀드아웃은 안 봄(누수 방지)
  function tuneFor(method, data, h, per) {
    var key = method + '|' + data.length + '|' + (per || 0) + '|' + h;
    if (tuneCache[key]) return tuneCache[key];
    var G = gridFor(method), best = G[0], bestErr = Infinity, q, j;
    if (G.length > 1) {
      var dn = data.length;
      var Ti = Math.max(3, Math.round(dn * 0.2)); if (Ti > Math.floor(dn / 2)) Ti = Math.floor(dn / 2);
      var itr = data.slice(0, dn - Ti), ival = data.slice(dn - Ti), ibase = itr[itr.length - 1];
      for (q = 0; q < G.length; q++) {
        var r; try { r = fitWith(method, itr, Ti, per, G[q]); } catch (e) { continue; }
        if (!r || r.invalid || !r.fc || !r.fc.length) continue;
        var dd = dampFit(r, ibase), sp = 0, c = 0;
        for (j = 0; j < Ti && j < dd.length; j++) {
          var pv = dd[j], av = ival[j];
          if (!isFinite(pv) || av === 0) continue;
          sp += Math.abs((pv - av) / av); c++;
        }
        if (c === 0) continue;
        var err = sp / c;
        if (err < bestErr) { bestErr = err; best = G[q]; }
      }
    }
    // 2단계: 같은 inner-split에서 댐핑 강도 φ 선택(1.0 = 댐핑 없음)
    if (data.length > 12) {
      var PH = [0.80, 0.90, 0.95, 0.98, 1.0], bestPhi = null, bestPErr = Infinity, pi;
      var dn2 = data.length;
      var Ti2 = Math.max(3, Math.round(dn2 * 0.2)); if (Ti2 > Math.floor(dn2 / 2)) Ti2 = Math.floor(dn2 / 2);
      var itr2 = data.slice(0, dn2 - Ti2), iv2 = data.slice(dn2 - Ti2), ib2 = itr2[itr2.length - 1];
      var rr; try { rr = fitWith(method, itr2, Ti2, per, best); } catch (e3) { rr = null; }
      if (rr && !rr.invalid && rr.fc && rr.fc.length) {
        for (pi = 0; pi < PH.length; pi++) {
          var d2 = dampFit(rr, ib2, PH[pi]), s2 = 0, c2 = 0, j2;
          for (j2 = 0; j2 < Ti2 && j2 < d2.length; j2++) {
            var pv2 = d2[j2], av2 = iv2[j2];
            if (!isFinite(pv2) || av2 === 0) continue;
            s2 += Math.abs((pv2 - av2) / av2); c2++;
          }
          if (c2 === 0) continue;
          var er2 = s2 / c2;
          if (er2 < bestPErr) { bestPErr = er2; bestPhi = PH[pi]; }
        }
      }
      if (bestPhi != null) best.phi = bestPhi;
    }
    tuneCache[key] = best;
    return best;
  }

  function fitOn(method, data, h, per) {
    var P = fixed ? { a: a, b: b, g: g, p: 2, d: 1, K: 2, cp: 0 } : tuneFor(method, data, h, per);
    var r = fitWith(method, data, h, per, P);
    if (r) r._phi = P.phi; // 튜닝된 댐핑 강도를 결과에 실어 dampFit이 쓰게
    return r;
  }

  // 댐핑(damped trend): 단계별 증분에 φ^(h-1) 가중 → 먼 미래 폭주 방지
  // · 백테스트에도 동일 적용(리더보드 성적 = 실제 예측 모델 성적)
  function dampInc(inc, phiIn) { // 누적증분 배열에 φ^j 가중 → 댐핑된 누적증분
    var H2 = inc.length, phi = (phiIn != null) ? phiIn : opts.damp, out = [], acc = 0, j;
    if (!(phi > 0 && phi <= 1)) phi = Math.max(0.90, Math.min(0.99, 1 - 1.5 / Math.max(2, H2)));
    for (j = 0; j < H2; j++) {
      var prev = (j === 0) ? 0 : inc[j - 1], marg = inc[j] - prev;
      if (!isFinite(marg)) marg = 0;
      acc += Math.pow(phi, j) * marg; out.push(acc);
    }
    return out;
  }
  function dampSeries(rawFc, baseV, phi) { // 비계절 모델: 전체 증분에 댐핑
    var inc = [], j;
    for (j = 0; j < rawFc.length; j++) inc.push(rawFc[j] - baseV);
    var d = dampInc(inc, phi), out = [];
    for (j = 0; j < d.length; j++) out.push(baseV + d[j]);
    return out;
  }
  // 계절 모델은 추세 성분에만 댐핑(계절 출렁임 보존)
  // · φ 우선순위: phiOverride > 튜닝값 fr._phi > 기본 공식
  function dampFit(fr, baseV, phiOverride) {
    var phi = (phiOverride != null) ? phiOverride : fr._phi;
    if (fr.fcTrend && fr.fcSeason && fr.fcTrend.length === fr.fc.length) {
      var dt = dampInc(fr.fcTrend, phi), out = [], j;
      for (j = 0; j < dt.length; j++) out.push(baseV + dt[j] + fr.fcSeason[j]);
      return out;
    }
    return dampSeries(fr.fc, baseV, phi);
  }

  // ── 주기 탐지(1차·2차) + 후보 목록(데이터가 허용하는 모델만) ──
  var period = opts.period; if (!(period >= 2)) period = fcPeriod(ys, 2, Math.min(Math.floor(n / 3), 60));
  per2 = (period >= 2) ? fcPeriod2(ys, period, 2, Math.min(Math.floor(n / 3), 60)) : 0;
  // 단순→복잡 순. 계절 모델은 주기가 잡히고 데이터가 2주기 이상일 때만.
  var cands = ['ses', 'linear', 'theta', 'holt', 'quadratic'];
  if (n >= 20) cands.push('ar');
  if (n >= 30) cands.push('prophet');
  if (period >= 2 && n >= 2 * period + 2) {
    cands.push('holtwinters');
    cands.push('holtwinters_mult');
    cands.push('harmonic');
  }

  // 홀드아웃 크기 + 과거 범위(폭발 판정용)
  var Tb = Math.round(n * 0.2); if (Tb < 3) Tb = 3; if (Tb > Math.floor(n / 2)) Tb = Math.floor(n / 2); if (Tb < 1) Tb = 1;
  var hmin = ys[0], hmax = ys[0];
  for (i = 1; i < n; i++) { if (ys[i] < hmin) hmin = ys[i]; if (ys[i] > hmax) hmax = ys[i]; }
  var hrange = hmax - hmin; if (!(hrange > 0)) hrange = Math.abs(hmax) || 1;

  // 후보 1개의 백테스트: 최근 Tb를 가려 학습→예측해 MAPE/MAE + 오버레이 포인트 + 폭발 여부
  function backtestOf(method) {
    var e = { method: method, mape: -1, mae: -1, points: [], exploded: false, ok: false };
    var trb = ys.slice(0, n - Tb), bbase = ys[n - Tb - 1], bf;
    try { bf = fitOn(method, trb, Tb, period); } catch (e1) { return e; }
    if (!bf || bf.invalid || !bf.fc || !bf.fc.length) return e; // 데이터 부족·조건 미달 모델은 후보에서 자동 제외
    var bdc = dampFit(bf, bbase), se = 0, sp = 0, c = 0, j;
    for (j = 0; j < Tb; j++) {
      var pv = bdc[j], av = ys[n - Tb + j];
      if (!isFinite(pv)) continue;
      e.points.push({ t: ts[n - Tb + j], v: pv });
      se += Math.abs(pv - av);
      if (av !== 0) { sp += Math.abs((pv - av) / av); c++; }
    }
    if (e.points.length) { e.ok = true; e.mae = se / e.points.length; e.mape = c ? (sp / c * 100) : -1; }
    // 폭발(과대외삽) 판정 — 댐핑 적용 H-step 예측 기준 실격 표시
    var rf; try { rf = fitOn(method, ys, H, period); } catch (e2) { rf = null; }
    if (rf && rf.fc && rf.fc.length) {
      var dc = dampFit(rf, lastV), ext = dc[dc.length - 1];
      // 이동폭은 추세 성분만 — 계절 출렁임의 폭주 오판 방지
      var dev;
      if (rf.fcTrend && rf.fcSeason && rf.fcTrend.length === rf.fc.length) {
        var dt = dampInc(rf.fcTrend, rf._phi);
        dev = Math.abs(dt[dt.length - 1]);
      } else {
        dev = Math.abs(ext - lastV);
      }
      if (!isFinite(ext) ||
          ext > hmax + hrange || ext < hmin - hrange ||   // 과거 범위를 1구간 이상 벗어남
          dev > 0.8 * hrange) e.exploded = true;          // 추세가 과거 전체 변동폭의 80% 넘게 이동
    }
    return e;
  }

  // ── 리더보드: 후보 전부 백테스트해 MAPE 오름차순(실격은 뒤로) ──
  var forcedRank = opts.rank || fcParseRank(opts.method);
  var forcedName = fcNormMethod(opts.method);
  var wantBoard = (opts.board !== false) || forcedRank >= 1 || forcedName === 'auto' || forcedName === '';
  var board = [];
  if (wantBoard) {
    for (i = 0; i < cands.length; i++) { var e3 = backtestOf(cands[i]); if (e3.ok) board.push(e3); }
    board.sort(function (x, y) {
      if (x.exploded !== y.exploded) return x.exploded ? 1 : -1;
      var mx = (x.mape >= 0) ? x.mape : 1e9, my = (y.mape >= 0) ? y.mape : 1e9;
      return mx - my;
    });
  }

  // ── 모델 결정: 순위 지정 > 이름 지정 > 자동(단순모델 선호 + 폭발 제외) ──
  var method = '', note = '';
  if (forcedRank >= 1) {
    if (board.length >= forcedRank) { method = board[forcedRank - 1].method; note = '리더보드 ' + forcedRank + '위 모델 지정'; }
    else { note = '리더보드에 ' + forcedRank + '위가 없어 자동선택'; }
  }
  if (!method && forcedName && forcedName !== 'auto') {
    if (cands.indexOf(forcedName) >= 0) { method = forcedName; note = '사용자 지정 모델'; }
    else { note = forcedName + '은(는) 이 데이터에 적용 불가(주기 미검출 등) → 자동선택'; }
  }
  if (!method) {
    // 기준선 = 단순 모델(ses, linear) 중 최고, 복잡 모델은 MAPE가 기준선보다 20% 이상 낮을 때만 채택(과적합·과대외삽 방지)
    var SIMPLE = ['ses', 'linear'];
    var base0 = null, best = null, k, c2;
    for (k = 0; k < board.length; k++) {
      c2 = board[k];
      if (c2.exploded || c2.mape < 0) continue;
      if (SIMPLE.indexOf(c2.method) >= 0) { if (!base0 || c2.mape < base0.mape) base0 = c2; }
    }
    for (k = 0; k < board.length; k++) {
      c2 = board[k];
      if (c2.exploded || c2.mape < 0 || SIMPLE.indexOf(c2.method) >= 0) continue;
      if (!base0) { if (!best || c2.mape < best.mape) best = c2; continue; }
      if (c2.mape < base0.mape * 0.80) { if (!best || c2.mape < best.mape) best = c2; }
    }
    method = best ? best.method : (base0 ? base0.method : (board.length ? board[0].method : 'linear'));
    if (!note) {
      // 1위(MAPE 최소) 미채택 시 이유 명시
      var top = null;
      for (k = 0; k < board.length; k++) { if (!board[k].exploded && board[k].mape >= 0) { top = board[k]; break; } }
      if (top && top.method !== method && top.mape >= 0) {
        note = '자동 선택 — 1위 ' + top.method + '(' + top.mape.toFixed(1) + '%)이 단순모델(' +
          (base0 ? base0.method + ' ' + base0.mape.toFixed(1) + '%' : '-') + ') 대비 20% 마진에 못 미쳐 미채택(과적합·과대외삽 방지). 원하면 "1위 모델로 예측해줘"로 강제 가능';
      } else {
        note = '자동 선택(홀드아웃 MAPE 최소)';
      }
    }
  }

  // ── 신뢰밴드 캘리브레이션(롤링 오리진) ──
  // 여러 원점에서 h-step 예측 오차를 측정해 horizon별 σ(h) 산출 — in-sample 잔차 sd의 과신 방지
  function calibrateSigma(method, per, P, Hh) {
    // 학습 최소량 = 절반 — 너무 이른 원점의 σ 부풀림 방지, 관측 가능 horizon 0.5n이 기본 H 0.2n을 덮음
    var minTrain = Math.max(20, Math.round(n * 0.5));
    if (n - minTrain < 5) return null;
    var NORIG = 6, errByH = [], o, h2, q;
    for (o = 0; o < NORIG; o++) {
      var cut = minTrain + Math.floor((n - minTrain) * o / Math.max(1, NORIG - 1));
      if (cut > n - 2) cut = n - 2;
      var tr = ys.slice(0, cut), maxH = Math.min(Hh, n - cut);
      if (maxH < 1 || tr.length < 10) continue;
      var r; try { r = fitWith(method, tr, maxH, per, P); } catch (e) { continue; }
      if (!r || r.invalid || !r.fc || !r.fc.length) continue;
      r._phi = P.phi;
      var dd = dampFit(r, tr[tr.length - 1]);
      for (h2 = 0; h2 < maxH && h2 < dd.length; h2++) {
        var e2 = dd[h2] - ys[cut + h2];
        if (!isFinite(e2)) continue;
        if (!errByH[h2]) errByH[h2] = [];
        errByH[h2].push(e2);
      }
    }

    // 관측 (h, RMSE) 점에 멱함수 σ(h) = a·h^b를 표본수 가중 log-log 최소제곱으로 적합 — horizon별 표본 수 변화로 인한 계단형 밴드 방지
    // · b는 [0.3, 1.2]로 클램프, 점이 4개 미만이면 √h 고정
    var pts = [];
    for (h2 = 0; h2 < Hh; h2++) {
      var arr = errByH[h2];
      if (!arr || arr.length < 2) continue;
      var ss = 0; for (q = 0; q < arr.length; q++) ss += arr[q] * arr[q];
      var s = Math.sqrt(ss / arr.length);
      if (s > 0 && isFinite(s)) pts.push({ h: h2 + 1, s: s, w: arr.length });
    }
    if (!pts.length) return null;

    var a, b;
    if (pts.length < 4) {
      b = 0.5;                                   // 점이 적으면 √h 고정
      var sw = 0, sn = 0;
      for (q = 0; q < pts.length; q++) { sw += pts[q].w * pts[q].s / Math.sqrt(pts[q].h); sn += pts[q].w; }
      a = sw / sn;
    } else {
      var Sw = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
      for (q = 0; q < pts.length; q++) {
        var lx = Math.log(pts[q].h), ly = Math.log(pts[q].s), w = pts[q].w;
        Sw += w; Sx += w * lx; Sy += w * ly; Sxx += w * lx * lx; Sxy += w * lx * ly;
      }
      var den = Sw * Sxx - Sx * Sx;
      b = (Math.abs(den) < 1e-12) ? 0.5 : (Sw * Sxy - Sx * Sy) / den;
      if (!isFinite(b) || b < 0.3) b = 0.3;
      if (b > 1.2) b = 1.2;
      a = Math.exp((Sy - b * Sx) / Sw);
    }
    if (!isFinite(a) || a <= 0) return null;

    var sig = [];
    for (h2 = 0; h2 < Hh; h2++) sig[h2] = a * Math.pow(h2 + 1, b);
    return sig;
  }

  // ── 최종 적합 + 예측 (적합 불가 모델이면 선형으로 폴백) ──
  var fr = fitOn(method, ys, H, period);
  if (!fr || fr.invalid || !fr.fc || !fr.fc.length) {
    note += ' / ' + method + ' 적합 불가 → 선형 대체';
    method = 'linear';
    fr = fitOn('linear', ys, H, period);
  }
  var sd = fr.sd || 0;
  fr.fc = dampFit(fr, lastV);
  // 앵커점: 예측선·밴드가 마지막 실측점에서 출발(밴드 폭 0)
  var sigma = fixed ? null : calibrateSigma(method, period, tuneFor(method, ys, H, period), H);
  var pts = [{ t: lastT, v: lastV, lo: lastV, hi: lastV }];
  for (i = 1; i <= H; i++) {
    var v = fr.fc[i - 1]; if (!isFinite(v)) v = lastV;
    // 밴드 = 1.96 × σ(h), 캘리브레이션 실패 시 in-sample 잔차 폴백
    var sg = (sigma && isFinite(sigma[i - 1])) ? sigma[i - 1] : (sd * Math.sqrt(1 + i / n));
    var band = 1.96 * sg, t = Math.round(lastT + i * step * DAY);
    pts.push({ t: t, v: v, lo: v - band, hi: v + band });
  }

  // 선택 모델의 백테스트(요약 MAPE + 차트 오버레이) — 리더보드에서 재사용, 없으면 계산
  var chosen = null;
  for (i = 0; i < board.length; i++) { if (board[i].method === method) { chosen = board[i]; break; } }
  if (!chosen) chosen = backtestOf(method);

  // ── opts.allModels: 후보 전 모델의 미래 곡선(밴드 포함)도 반환 ──
  // · e.points는 백테스트라 모델마다 전체 데이터 재적합 + σ(h) 캘리브레이션, 실격 모델도 포함
  if (opts.allModels) {
    for (i = 0; i < board.length; i++) {
      var bm = board[i].method, bfr;
      try { bfr = fitOn(bm, ys, H, period); } catch (e4) { bfr = null; }
      if (!bfr || bfr.invalid || !bfr.fc || !bfr.fc.length) { board[i].forecast = []; continue; }
      var bsd = bfr.sd || 0;
      bfr.fc = dampFit(bfr, lastV);
      var bsig = calibrateSigma(bm, period, tuneFor(bm, ys, H, period), H);
      var bpts = [{ t: lastT, v: lastV, lo: lastV, hi: lastV }];
      for (var k2 = 1; k2 <= H; k2++) {
        var bv = bfr.fc[k2 - 1]; if (!isFinite(bv)) bv = lastV;
        var bsg = (bsig && isFinite(bsig[k2 - 1])) ? bsig[k2 - 1] : (bsd * Math.sqrt(1 + k2 / n));
        var bb = 1.96 * bsg;
        bpts.push({ t: Math.round(lastT + k2 * step * DAY), v: bv, lo: bv - bb, hi: bv + bb });
      }
      board[i].forecast = bpts;
      board[i].r2 = bfr.r2 || 0;
      board[i].slopePerStep = bfr.slopePerStep || 0;
    }
  }

  var SEASONAL = ['holtwinters', 'holtwinters_mult', 'harmonic', 'prophet'];
  return {
    method: method, period: (SEASONAL.indexOf(method) >= 0 ? (fr.period || period) : 0), period2: per2,
    points: pts, backtest: chosen.points || [],
    leaderboard: board, note: note,
    stats: {
      n: n, H: H, L: L, step: step, lastV: lastV, lastT: lastT, sd: sd,
      r2: fr.r2 || 0, slopePerStep: fr.slopePerStep || 0,
      mape: (chosen.mape != null) ? chosen.mape : -1,
      mae: (chosen.mae != null) ? chosen.mae : -1,
      testN: (chosen.points || []).length,
      detectedPeriod: period,
    },
  };
}

// SCRIPT에 구워질 런타임 함수 집합(서로만 참조 + Math), 새 런타임 함수는 여기 등록 필수
var RUNTIME = [
  fcSolve, fcFitPoly, fcPoly, fcResidSd, fcR2, fcRmse, fcOLS, fcFromDesign,
  fcLinear, fcQuad, fcSES, fcHolt, fcTheta, fcHW, fcHWmult, fcHarmonic, fcProphetLike, fcAR,
  fcPeriod, fcPeriod2, fcNormMethod, fcParseRank, fcRun,
];
function algoSource() {
  var out = []; for (var i = 0; i < RUNTIME.length; i++) out.push(RUNTIME[i].toString());
  return out.join('\n');
}

module.exports = { fcRun: fcRun, fcNormMethod: fcNormMethod, algoSource: algoSource };
