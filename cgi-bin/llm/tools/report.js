var { argStr } = require('./registry');
var { expandReportTemplate, loadReportTemplates, getTemplateMeta, listReportTemplates } = require('./report_templates');
var { detectColumns } = require('./tql_spec');

// Cache DB-derived params from 1st call so 2nd call (with analysis) can reuse them
var _paramsCache = {};
var CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function cacheParams(tableName, params) {
  _paramsCache[tableName] = { params: params, ts: Date.now() };
}

function getCachedParams(tableName) {
  purgeExpiredCache();
  var entry = _paramsCache[tableName];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { delete _paramsCache[tableName]; return null; }
  return entry.params;
}

function purgeExpiredCache() {
  var now = Date.now();
  var keys = Object.keys(_paramsCache);
  for (var i = 0; i < keys.length; i++) {
    if (now - _paramsCache[keys[i]].ts > CACHE_TTL) delete _paramsCache[keys[i]];
  }
}

// Extract routing kind from a template ID: 'R-2-vibration' -> 'R-2', 'C-1-vibration' -> 'C-1', 'R-2' -> 'R-2'.
// Builtin compute dispatch keys on kind (R-1/R-2/R-3); custom (C-*) never matches -> generic path.
function templateKind(id) {
  var m = /^([A-Za-z]-\d+)/.exec(id || '');
  return m ? m[1] : (id || '');
}

// Topic slug of a template ID: 'R-2-vibration' / 'C-2-vibration' -> 'vibration'. '' if none.
function reportTopicOf(id) {
  var m = /^[A-Za-z]-\d+-(.+)$/.exec(id || '');
  return m ? m[1].toLowerCase() : '';
}

// Same template intent? Exact ID, else same topic (R-2-vibration ≒ C-2-vibration — 1차 호출의
// custom override로 kind만 바뀐 경우), else same kind. 2차 호출의 명시적 template_id가 캐시된
// 파이프라인 결과를 무효화해야 하는지 판정에 사용.
function sameTemplateIntent(a, b) {
  if (a === b) return true;
  var ta = reportTopicOf(a), tb = reportTopicOf(b);
  if (ta && tb) return ta === tb;
  return templateKind(a) === templateKind(b);
}

// ── Compute catalog ────────────────────────────────────────────────────────
// Named domain calculations (1st-party curated). A template declares `compute: <name>`
// in its .md frontmatter; the engine dispatches by lookup (no hardcoded template IDs),
// so builtin and custom templates are treated identically. Adding a new technique = one
// entry here (shared release), reused by any template that declares it.
//   run(ctx, done)    : fetch raw data + assign result into ctx.params, then done()
//   summarize(params) : build the computed-number summary the LLM reads to write analysis
// Analysis direction/tone is NOT here — it lives in each template's `guide:` text, and
// value-dependent tone is delegated to the LLM (given the numbers summarize() emits).
var COMPUTE = {
  driving: {
    run: function (ctx, done) {
      console.println('  [report] Fetching driving data for ' + ctx.tags.length + ' tags...');
      fetchDrivingData(ctx.mc, ctx.tableName, ctx.tags, ctx.rollupUnit, ctx.timeWhere, ctx.cols, function (dErr, dData) {
        ctx.params.DRIVING_DATA_JSON = dData ? JSON.stringify(dData) : '{"per_tag":{},"events":{"accel":[],"brake":[],"turn":[]},"safety_score":0,"summary":{},"thresholds":{}}';
        done();
      });
    },
    summarize: function (params) {
      var s = '';
      if (!params.DRIVING_DATA_JSON) return s;
      try {
        var dd = JSON.parse(params.DRIVING_DATA_JSON);
        s += '\n=== 차트/점수 계산 결과 (리포트에 이미 반영됨, 이 수치 기반으로 분석하세요) ===\n';
        s += '안전 점수: ' + (dd.safety_score || 0).toFixed(1) + ' / 100\n';
        var ev = dd.events || {}; var sm = dd.summary || {};
        s += '총 이벤트: ' + (sm.total_events || 0) + '건 (전체 샘플 ' + (sm.total_samples || 0) + '건 중)\n';
        s += '  - 급가속/급제동(ACCEL): ' + ((ev.accel || []).length) + '건 (' + ((sm.accel_pct || 0).toFixed(1)) + '%)\n';
        s += '  - 급정거(BRAKE): ' + ((ev.brake || []).length) + '건 (' + ((sm.brake_pct || 0).toFixed(1)) + '%)\n';
        s += '  - 급회전(TURN): ' + ((ev.turn || []).length) + '건 (' + ((sm.turn_pct || 0).toFixed(1)) + '%)\n';
        var th = dd.thresholds || {};
        if (th.accel) s += '이벤트 감지 임계값: AccX ±' + (th.accel || 0).toFixed(3) + 'g, AccY ±' + (th.brake || 0).toFixed(3) + 'g, GyroZ ±' + (th.turn || 0).toFixed(3) + 'rad/s\n';
        var pt = dd.per_tag || {}; var ptKeys = Object.keys(pt);
        if (ptKeys.length > 0) {
          s += '태그별 롤업 추이 데이터 포인트: ';
          ptKeys.forEach(function (k) { s += k + '=' + ((pt[k].rollup || {}).times || []).length + '건 '; });
          s += '\n';
        }
      } catch (e) {}
      return s;
    }
  },
  vibration: {
    run: function (ctx, done) {
      console.println('  [report] Fetching vibration data for ' + ctx.tags.length + ' tags...');
      fetchVibrationData(ctx.mc, ctx.tableName, ctx.tags, ctx.rollupUnit, ctx.timeWhere, ctx.cols, function (vErr, vData) {
        ctx.params.PER_TAG_DATA_JSON = vData ? JSON.stringify(vData) : '{}';
        done();
      });
    },
    summarize: function (params) {
      var s = '';
      if (!params.PER_TAG_DATA_JSON) return s;
      try {
        var vd = JSON.parse(params.PER_TAG_DATA_JSON);
        s += '\n=== 차트/분석 계산 결과 (리포트에 이미 반영됨, 이 수치 기반으로 분석하세요) ===\n';
        Object.keys(vd).forEach(function (k) {
          var tag = vd[k];
          s += '\n[' + k + ']\n';
          if (tag.stats) s += '  전체 통계: RMS=' + (tag.stats.rms || 0).toFixed(4) + ', P2P=' + (tag.stats.p2p || 0).toFixed(4) + ', Crest=' + (tag.stats.crest || 0).toFixed(2) + ', MIN=' + (tag.stats.min || 0).toFixed(4) + ', MAX=' + (tag.stats.max || 0).toFixed(4) + '\n';
          var rollup = tag.rollup || [];
          if (rollup.length > 0) {
            var rmsVals = rollup.map(function (r) { return r.rms || 0; });
            var rmsMin = Math.min.apply(null, rmsVals), rmsMax = Math.max.apply(null, rmsVals);
            var rmsAvg = rmsVals.reduce(function (a, b) { return a + b; }, 0) / rmsVals.length;
            s += '  RMS 추이(' + rollup.length + '포인트): 최소=' + rmsMin.toFixed(4) + ', 최대=' + rmsMax.toFixed(4) + ', 평균=' + rmsAvg.toFixed(4) + '\n';
            if (rmsMax > rmsAvg * 3 && rmsAvg > 0) {
              var spikeIdx = rmsVals.indexOf(rmsMax);
              var spikeTime = rollup[spikeIdx] ? rollup[spikeIdx].t : '?';
              s += '  ★ RMS 급등 감지! ' + spikeTime + ' 시점에서 ' + rmsMax.toFixed(4) + ' (평균 대비 ' + (rmsMax / rmsAvg).toFixed(1) + '배). 이 급등 원인을 반드시 분석하세요.\n';
            }
            var seg = Math.max(1, Math.floor(rmsVals.length * 0.2));
            var earlyAvg = rmsVals.slice(0, seg).reduce(function (a, b) { return a + b; }, 0) / seg;
            var lateAvg = rmsVals.slice(-seg).reduce(function (a, b) { return a + b; }, 0) / seg;
            if (earlyAvg > 0) {
              var trendRatio = lateAvg / earlyAvg;
              if (trendRatio > 1.5) s += '  ★ RMS 상승 추세! 초반 평균 ' + earlyAvg.toFixed(4) + ' → 후반 평균 ' + lateAvg.toFixed(4) + ' (' + trendRatio.toFixed(1) + '배 증가). 진동 악화 가능성을 분석하세요.\n';
              else if (trendRatio < 0.5) s += '  RMS 하락 추세: 초반 ' + earlyAvg.toFixed(4) + ' → 후반 ' + lateAvg.toFixed(4) + ' (감소)\n';
              else s += '  RMS 추세: 안정적 (초반 ' + earlyAvg.toFixed(4) + ' → 후반 ' + lateAvg.toFixed(4) + ')\n';
            }
            var p2pVals = rollup.map(function (r) { return r.p2p || 0; });
            var p2pMax = Math.max.apply(null, p2pVals);
            var p2pAvg = p2pVals.reduce(function (a, b) { return a + b; }, 0) / p2pVals.length;
            if (p2pMax > p2pAvg * 3 && p2pAvg > 0) {
              var p2pSpikeIdx = p2pVals.indexOf(p2pMax);
              var p2pSpikeTime = rollup[p2pSpikeIdx] ? rollup[p2pSpikeIdx].t : '?';
              s += '  ★ P2P 급등 감지! ' + p2pSpikeTime + ' 시점에서 ' + p2pMax.toFixed(4) + ' (평균 대비 ' + (p2pMax / p2pAvg).toFixed(1) + '배)\n';
            }
          }
          if (tag.fft) s += '  FFT: ' + (tag.fft.freqs || []).length + '개 주파수 대역, 샘플레이트=' + (tag.fft.sampleRate || 0).toFixed(1) + 'Hz\n';
        });
      } catch (e) {}
      return s;
    }
  },
  finance: {
    run: function (ctx, done) {
      console.println('  [report] Fetching finance data...');
      ctx.params.STOCK_NAME = ctx.stock || ctx.tableName;
      fetchFinanceData(ctx.mc, ctx.tableName, ctx.tags, ctx.stock, ctx.rollupUnit, ctx.timeWhere, ctx.cols, function (fErr, fData) {
        if (fData) {
          ctx.params.TREND_DATA_JSON = JSON.stringify(fData.trend || []);
          if (fData.stockName) ctx.params.STOCK_NAME = fData.stockName;
          if (fData.financeSummary) ctx.params._FINANCE_SUMMARY = fData.financeSummary;
        } else {
          ctx.params.TREND_DATA_JSON = '[]';
        }
        done();
      });
    },
    summarize: function (params) {
      var s = '\n=== 차트 데이터 기반 분석 요약 (리포트에 이미 반영됨, 이 수치 기반으로 분석하세요) ===\n';
      s += '종목명: ' + (params.STOCK_NAME || params.TABLE) + '\n';
      if (params._FINANCE_SUMMARY) s += params._FINANCE_SUMMARY + '\n';
      return s;
    }
  }
};

function register(registry, mc) {
  loadReportTemplates();

  registry.register({
    name: 'save_html_report',
    description: '데이터를 분석하여 HTML 리포트를 생성합니다. 차트와 심층 분석이 포함된 보고서를 자동으로 만들어줍니다. table을 지정해 호출하세요. 사용자가 특정 종목/태그를 언급하면 tag_name에 그 이름을 반드시 함께 전달하세요 — 생략하면 테이블 전체(수천 태그)를 조회해 느려지거나 컨텍스트 초과로 실패할 수 있습니다.',
    parameters: {
      type: 'object',
      properties: {
        template_id: { type: 'string', description: '리포트 템플릿 ID. 시스템 프롬프트의 "사용 가능한 리포트 템플릿" 목록에서 요청 주제에 맞는 ID 선택(주제 맞는 커스텀 C-* 우선, 없으면 빌트인 R-*, 둘 다 안 맞으면 R-0-general). 미지정 시 빌트인은 데이터로 자동 판별.' },
        table: { type: 'string', description: '테이블명 (필수)' },
        tag_count: { type: 'string' }, data_count: { type: 'string' }, time_range: { type: 'string' },
        analysis: { type: 'string', description: '심층 분석 (한국어). ★1차 호출 시 비워두세요!★ 2차 호출 시 심도 있는 분석으로 작성.\n\n' +
          '## 형식 요구사항:\n' +
          '- 마크다운 사용 필수 (## 섹션 헤더, **볼드**, - 리스트)\n' +
          '- 최소 5개 섹션 (## 헤더), 각 섹션 2~3문단 이상\n\n' +
          '## 내용 요구사항:\n' +
          '- 데이터 구조/품질 설명 금지!\n' +
          '- 태그 간 상관관계와 인과관계 분석\n' +
          '- 이상치의 원인 추정과 실무적 해석\n' +
          '- 시계열 패턴(추세/주기/변동성) 해석\n' +
          '- 통계값(평균/분산/범위)의 도메인 맥락 해석\n' +
          '- 산업 표준/기준값 대비 평가\n' +
          '- 구체적 수치를 근거로 제시 (예: AccX 최대 5.86g는 ISO 기준 위험 수준)' },
        recommendations: { type: 'string', description: '종합 소견 및 권고 (한국어). ★1차 호출 시 비워두세요!★ 심도 있는 분석 기반의 보고서 형식으로 작성.\n\n' +
          '## 형식: 마크다운, 최소 7개 번호 항목, 중요한 것부터 순서대로.\n' +
          '## 각 항목은 반드시 아래 골격 그대로 4줄(줄바꿈·하위 불릿 3칸 들여쓰기 포함, 전 항목 동일 형식):\n' +
          '1. **제목**: 핵심 요약 한 문장\n' +
          '   - **근거**: 조회한 데이터 수치를 인용한 판단 근거 (1~2문장)\n' +
          '   - **실행방안**: 구체적 행동 (누가·무엇을·언제·어떻게, 수치 포함)\n' +
          '   - **기대효과**: 그 행동의 예상 결과\n' +
          '※ 근거·실행방안·기대효과 세 불릿을 항목마다 **모두, 각각 별도 줄로** 포함. 제목은 분류 태그·접두어 없이 내용만.' },
        rollup_unit: { type: 'string', enum: ['sec', 'min', 'hour', 'day', 'week', 'month'] },
        tag_name: { type: 'string', description: '분석 대상 태그명 또는 종목명. 사용자가 특정 대상을 언급하면 반드시 전달.' },
        time_start: { type: 'string', description: '분석 기간 시작 (epoch 밀리초 숫자). ★사용자가 기간을 명시적으로 말할 때만 전달(예: "최근 1시간", "어제", "7월 데이터"). 기간 언급이 없으면 절대 넣지 말 것 — 임의의 기간을 추측해 넣지 마세요(전체 데이터 분석 + 자동 롤업).' },
        time_end: { type: 'string', description: '분석 기간 끝 (epoch 밀리초 숫자). time_start와 함께 전달.' },
      },
      required: ['table'],
    },
    fn: function (args, cb) { saveHtmlReport(mc, args, cb); },
  });
}

// cb(err, resultString)
function saveHtmlReport(mc, args, cb) {
  var norm = {};
  var keys = Object.keys(args);
  for (var i = 0; i < keys.length; i++) norm[keys[i].toLowerCase()] = args[keys[i]];

  var tableName = anyStr(norm, 'table') || anyStr(norm, 'table_name') || anyStr(norm, 'tablename') || anyStr(norm, 'name');
  if (!tableName) {
    var vals = Object.values(norm);
    for (var j = 0; j < vals.length; j++) {
      var s = String(vals[j]);
      if (s.length >= 2 && s.length <= 30 && s === s.toUpperCase() && s.indexOf(' ') < 0) { tableName = s; break; }
    }
  }
  if (!tableName) return cb(null, 'table 파라미터가 필요합니다. 예: table="GOLD"');
  tableName = tableName.toUpperCase();

  var templateID = anyStr(norm, 'template_id') || anyStr(norm, 'templateid') || 'R-0-general';
  var kind = templateKind(templateID);
  var now = new Date();
  var ts = now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) + '_' + pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
  var filename = anyStr(norm, 'filename') || (tableName + '/' + tableName + '_Analysis_Report_' + ts + '.html');
  if (!filename.toLowerCase().endsWith('.html')) filename += '.html';
  if (filename.indexOf('/') < 0) filename = tableName + '/' + filename;

  var params = { GENERATED_DATE: formatDateLocal(now), TABLE: tableName };
  console.println('[report] === saveHtmlReport called === table=' + tableName + ' templateID=' + templateID);
  console.println('[report] args keys: ' + Object.keys(norm).join(', '));
  console.println('[report] has analysis: ' + (!!anyStr(norm, 'analysis')) + ', has recommendations: ' + (!!anyStr(norm, 'recommendations')));

  // 2nd call: use cached DB params to skip re-querying
  var hasAnalysis = !!anyStr(norm, 'analysis');
  var hasReco = !!anyStr(norm, 'recommendations');
  var explicitTemplateID = anyStr(norm, 'template_id') || anyStr(norm, 'templateid');
  var carryAnalysis = '', carryReco = '';
  if (hasAnalysis || hasReco) {
    var cached = getCachedParams(tableName);
    // 2차 호출의 명시적 template_id가 캐시된 템플릿과 다른 의도면(예: 1차 template_id 누락으로
    // R-0-general 캐시 → 2차 R-2-vibration 지정) 캐시를 버리고 풀 파이프라인 재실행 — 새 템플릿의
    // compute(차트 데이터)까지 다시 뽑아야 하므로 templateID만 바꿔치기하면 안 됨.
    // 이전 호출에서 모아둔 analysis/recommendations 조각은 승계.
    if (cached && explicitTemplateID && cached._templateID && !sameTemplateIntent(explicitTemplateID, cached._templateID)) {
      console.println('  [report] Template switch: cached ' + cached._templateID + ' → requested ' + explicitTemplateID + ', re-running full pipeline');
      carryAnalysis = cached.ANALYSIS || '';
      carryReco = cached.RECOMMENDATIONS || '';
      delete _paramsCache[tableName];
      cached = null;
    }
    if (cached) {
      console.println('  [report] Cache hit for ' + tableName);
      // Accumulate analysis/recommendations across calls so the LLM needn't re-send the
      // other piece on each retry — store HTML into the cache, save once both are present.
      if (hasAnalysis) cached.ANALYSIS = mdToHTML(anyStr(norm, 'analysis'));
      if (hasReco) cached.RECOMMENDATIONS = mdToHTML(anyStr(norm, 'recommendations'));
      cacheParams(tableName, cached);
      if (cached.ANALYSIS && cached.RECOMMENDATIONS) {
        var ckeys = Object.keys(cached);
        for (var ci = 0; ci < ckeys.length; ci++) params[ckeys[ci]] = cached[ckeys[ci]];
        params.GENERATED_DATE = formatDateLocal(now);
        return saveToFile(mc, cached._templateID || templateID, params, filename, cb);
      }
      // Only one collected so far → ask ONLY for the missing piece (the other is saved).
      var stillMissing = cached.ANALYSIS ? 'recommendations' : 'analysis';
      var alreadyHave = cached.ANALYSIS ? 'analysis' : 'recommendations';
      return cb(null, alreadyHave + '는 저장됐습니다. 이제 ' + stillMissing + '만 보내면 리포트가 완성됩니다 (다른 파라미터 없이 ' + stillMissing + '만 포함해 다시 호출).');
    }
  }

  var timeStart = dateStrToNano(anyStr(norm, 'time_start') || anyStr(norm, 'timestart'));
  var timeEnd = dateStrToNano(anyStr(norm, 'time_end') || anyStr(norm, 'timeend'));
  var timeWhere = '', timeWhereBase = '';
  // 실제 컬럼명(PK/BASETIME/SUMMARIZED). detectColumns가 채우기 전 기본값. NAME/TIME/VALUE 하드코딩 대체.
  var cols = { n: 'NAME', t: 'TIME', v: 'VALUE' };
  function buildTimeWhere() {
    if (timeStart && timeEnd) {
      var tsNano = msToNano(timeStart), teNano = msToNano(timeEnd);
      timeWhere = ' AND ' + cols.t + ' BETWEEN ' + tsNano + ' AND ' + teNano;
      timeWhereBase = ' WHERE ' + cols.t + ' BETWEEN ' + tsNano + ' AND ' + teNano;
    }
  }

  var stock = anyStr(norm, 'tag_name') || anyStr(norm, 'stock') || anyStr(norm, 'tag') || '';
  if (stock) stock = extractStockPrefix(stock);
  var explicitRollup = !!anyStr(norm, 'rollup_unit');
  var rollupUnit = anyStr(norm, 'rollup_unit') || pickRollupUnit(timeStart, timeEnd);
  var statsCSV = '';

  // Fallback: if time filter set, check if data exists in that range
  function checkTimeRangeAndProceed() {
    if (!timeWhere) return doStep1();
    var checkSQL = 'SELECT COUNT(*) FROM ' + tableName + timeWhereBase;
    mc.querySQL(checkSQL, '', '', '', function (cerr, cntJSON) {
      var cnt = 0;
      if (!cerr && cntJSON) {
        try {
          var p = JSON.parse(cntJSON);
          if (p && p.data && p.data.rows && p.data.rows.length > 0) cnt = parseInt(p.data.rows[0][0], 10) || 0;
        } catch (e) {}
      }
      if (cnt > 0) return doStep1();
      // No data in requested range → shift to MAX(TIME)
      console.println('[report] No data in requested time range, shifting to data MAX(TIME)...');
      mc.querySQL('SELECT MAX(' + cols.t + ') FROM ' + tableName, '', '', '', function (merr, maxJSON) {
        if (!merr && maxJSON) {
          try {
            var p2 = JSON.parse(maxJSON);
            if (p2 && p2.data && p2.data.rows && p2.data.rows.length > 0 && p2.data.rows[0][0] != null) {
              var maxNano = parseInt(p2.data.rows[0][0], 10);
              if (maxNano > 0) {
                var tsMs = parseInt(timeStart, 10) || 0;
                var teMs = parseInt(timeEnd, 10) || 0;
                var durationMs = teMs - tsMs;
                var newEndMs = Math.floor(maxNano / 1000000);
                var newStartMs = newEndMs - durationMs;
                timeStart = String(newStartMs);
                timeEnd = String(newEndMs);
                var newTsNano = String(newStartMs) + '000000';
                var newTeNano = String(newEndMs) + '000000';
                timeWhere = ' AND ' + cols.t + ' BETWEEN ' + newTsNano + ' AND ' + newTeNano;
                timeWhereBase = ' WHERE ' + cols.t + ' BETWEEN ' + newTsNano + ' AND ' + newTeNano;
                console.println('[report] Adjusted time range to data: ' + newTsNano + ' ~ ' + newTeNano);
              }
            }
          } catch (e) {}
        }
        doStep1();
      });
    });
  }

  // No explicit rollup_unit & no user time range → pick rollup from the ACTUAL data span,
  // so short high-frequency data isn't stuck on the coarse 'min' default (only affects the
  // ROLLUP trend queries; raw waveform/FFT use LIMIT and are untouched).
  function refineRollupFromData(next) {
    if (explicitRollup || (timeStart && timeEnd)) return next();
    mc.querySQL('SELECT MIN(' + cols.t + '), MAX(' + cols.t + ') FROM ' + tableName, 'ms', '', '', function (e, json) {
      try {
        var p = JSON.parse(json);
        if (p && p.data && p.data.rows && p.data.rows.length > 0) {
          var mn = parseInt(p.data.rows[0][0], 10), mx = parseInt(p.data.rows[0][1], 10);
          if (mn && mx && mx > mn) {
            rollupUnit = pickRollupUnit(String(mn), String(mx));
            console.println('[report] rollup auto from data span (' + ((mx - mn) / 3600000).toFixed(2) + 'h) → ' + rollupUnit);
          }
        }
      } catch (_e) {}
      next();
    });
  }

  // Step 1: Get tags
  function doStep1() {
    mc.querySQL('SELECT NAME FROM V$' + tableName + '_STAT LIMIT 2600', '', '', '', function (err, tagCSV) {
    var tags = parseTagList(err ? '' : tagCSV);

    function afterTags(tags) {
      if (tags.length === 0) return cb(null, 'Error: failed to retrieve tags from table ' + tableName);

      var stockWhere = '';
      if (stock) {
        var upper = stock.toUpperCase();
        // 1) Prefix match: AMD → AMD_close, AMD_high, ...
        var prefix = upper + '_';
        var filtered = tags.filter(function (t) { return t.toUpperCase().indexOf(prefix) === 0; });
        // 2) Exact match fallback: AccX → AccX
        if (filtered.length === 0) {
          filtered = tags.filter(function (t) { return t.toUpperCase() === upper; });
        }
        // 3) Contains fallback: vibration → vibration_x, vibration_y
        if (filtered.length === 0) {
          filtered = tags.filter(function (t) { return t.toUpperCase().indexOf(upper) >= 0; });
        }
        if (filtered.length > 0) { tags = filtered; stockWhere = " AND " + cols.n + " IN ('" + filtered.join("','") + "')"; }
      }

      params.TAG_LIST_JSON = JSON.stringify(tags);

      if (kind === 'R-0') {
        var ohlcv = findOHLCVTags(tags, stock);
        if (ohlcv.close && ohlcv.open) {
          templateID = 'R-1-finance';
        } else if (detectIMUTags(tags)) {
          templateID = 'R-3-driving';
        } else if (detectVibrationTags(tags, tableName)) {
          templateID = 'R-2-vibration';
        }
        kind = templateKind(templateID);
        if (kind !== 'R-0') console.println('  [report] Auto-detected template: ' + templateID);
      }

      // Custom-over-builtin (same topic): if EXACTLY ONE custom C-*-<topic> exists for this
      // builtin's topic, route to it deterministically. If several claim the same exact topic it's
      // ambiguous → keep the model's choice (user disambiguates by name; variants should use
      // distinct topic slugs e.g. vibration-press / vibration-motor so they don't collide).
      if (/^R-/.test(templateID)) {
        var bTopic = reportTopicOf(templateID);
        if (bTopic) {
          var allTmpl = [];
          try { allTmpl = listReportTemplates(); } catch (e) {}
          var sameTopic = [];
          for (var ti = 0; ti < allTmpl.length; ti++) {
            if (allTmpl[ti].custom && reportTopicOf(allTmpl[ti].id) === bTopic) sameTopic.push(allTmpl[ti].id);
          }
          if (sameTopic.length === 1) {
            console.println('[report] custom override: ' + templateID + ' → ' + sameTopic[0] + ' (topic=' + bTopic + ')');
            templateID = sameTopic[0];
            kind = templateKind(templateID);
          } else if (sameTopic.length > 1) {
            console.println('[report] ambiguous: multiple customs for topic "' + bTopic + '" [' + sameTopic.join(', ') + '] — keeping model-chosen ' + templateID);
          }
        }
      }

      // Step 2: Get stats
      var statsSQL = 'SELECT ' + cols.n + ', COUNT(*) as cnt, ROUND(AVG(' + cols.v + '),2) as avg, ROUND(MIN(' + cols.v + '),2) as min, ROUND(MAX(' + cols.v + '),2) as max FROM ' + tableName;
      var whereClause = timeWhereBase || '';
      if (stockWhere) whereClause = whereClause ? whereClause + stockWhere : ' WHERE' + stockWhere.substring(4);
      statsSQL += whereClause + ' GROUP BY ' + cols.n;

      console.println('[report] Stats SQL: ' + statsSQL.substring(0, 200));
      mc.querySQL(statsSQL, '', '', '', function (err2, statsResult) {
        console.println('[report] Stats result: err=' + (err2 ? err2.message : 'null') + ' len=' + (statsResult ? statsResult.length : 0));
        statsCSV = err2 ? '' : statsResult;
        if (statsCSV) {
          try {
            var sr = parseStatsCSV(statsCSV);
            if (sr.rows.length > 0) {
              params.TAG_STATS_ROWS = sr.rows.join('\n');
              params.TAG_COUNT = String(sr.rows.length);
              params.CHART_DATA_JSON = JSON.stringify(sr.items);
            }
          } catch (e) { /* ignore */ }
        }

        // Step 3: Get time range (same as Go: no specific tag, Default timeformat)
        var timeRangeSQL = 'SELECT MIN(' + cols.t + '), MAX(' + cols.t + ') FROM ' + tableName + (timeWhereBase || '');
        console.println('[report] TimeRange SQL: ' + timeRangeSQL);
        mc.querySQL(timeRangeSQL, 'Default', 'Asia/Seoul', '', function (err3, timeCSV) {
          console.println('[report] TimeRange result: err=' + (err3 ? err3.message : 'null') + ' csv=' + (timeCSV ? timeCSV.substring(0, 200) : 'empty'));
          if (!err3 && timeCSV) {
            var tr = parseTimeRangeCSV(timeCSV);
            console.println('[report] TimeRange parsed: "' + tr + '"');
            if (tr) params.TIME_RANGE = tr;
          }

          var rollupLabels = { sec: '초별', min: '분별', hour: '시간별', day: '일별', week: '주별', month: '월별' };
          params.ROLLUP_LABEL = rollupLabels[rollupUnit] || rollupUnit;

          // Resolve this template's declared compute + guide (frontmatter) — builtin & custom alike.
          var tmplMeta = getTemplateMeta(templateID) || {};
          var spec = COMPUTE[tmplMeta.compute] || null;
          var templateGuide = tmplMeta.guide || '';

          // Step 4: Template-specific data then finalize
          function afterTemplateData() {
            // Cache all DB-derived params for 2nd call
            params._templateID = templateID;
            console.println('[report] Before cache: TAG_COUNT=' + (params.TAG_COUNT || 'MISSING') + ' DATA_COUNT=' + (params.DATA_COUNT || 'MISSING') + ' TIME_RANGE=' + (params.TIME_RANGE || 'MISSING'));
            console.println('[report] params keys: ' + Object.keys(params).join(', '));
            cacheParams(tableName, params);

            // LLM-provided params (fallback if DB didn't populate)
            if (!params.TAG_COUNT && anyStr(norm, 'tag_count')) params.TAG_COUNT = anyStr(norm, 'tag_count');
            if (!params.DATA_COUNT && anyStr(norm, 'data_count')) params.DATA_COUNT = anyStr(norm, 'data_count');
            if (!params.TIME_RANGE && anyStr(norm, 'time_range')) params.TIME_RANGE = anyStr(norm, 'time_range');
            if (anyStr(norm, 'analysis')) params.ANALYSIS = mdToHTML(anyStr(norm, 'analysis'));
            if (anyStr(norm, 'recommendations')) params.RECOMMENDATIONS = mdToHTML(anyStr(norm, 'recommendations'));
            // 템플릿 전환 재실행 시 이전 호출에서 모아둔 조각 승계 (이미 HTML 변환된 상태라 그대로 사용)
            if (!params.ANALYSIS && carryAnalysis) params.ANALYSIS = carryAnalysis;
            if (!params.RECOMMENDATIONS && carryReco) params.RECOMMENDATIONS = carryReco;

            if (!params.DATA_COUNT && statsCSV) {
              var total = calcTotalCount(statsCSV);
              if (total > 0) params.DATA_COUNT = String(total);
            }

            // If analysis missing, return stats + computed results for LLM to fill in
            if (!params.ANALYSIS || !params.RECOMMENDATIONS) {
              var summary = '테이블: ' + tableName + '\n';
              if (params.TAG_COUNT) summary += '태그 수: ' + params.TAG_COUNT + '\n';
              if (params.TIME_RANGE) summary += '조회 기간: ' + params.TIME_RANGE + '\n';
              if (params.DATA_COUNT) summary += '총 데이터 건수: ' + params.DATA_COUNT + '\n';
              if (statsCSV) summary += '태그별 통계:\n' + statsCSV + '\n';

              // 계산 결과 요약은 compute 카탈로그가 생성 (LLM이 이 수치로 분석 작성)
              if (spec && spec.summarize) summary += spec.summarize(params);

              // 분석 방향/톤 지침: 템플릿이 frontmatter guide로 선언 (값-의존 톤은 위 수치 보고 LLM이 스스로 판단)
              var domainGuide = templateGuide ? ('\n★ 분석 지침 (아래 방향으로, 위 수치 수준에 맞는 톤을 스스로 판단해 작성):\n' + templateGuide + '\n') : '';
              var msg = '데이터를 조회했습니다. 아래 통계와 계산 결과를 기반으로 analysis와 recommendations를 작성하여 다시 호출하세요.\n' +
                '★ analysis: 최소 5개 ## 섹션, 각 2~3문단. 마크다운 필수.\n' +
                '★ recommendations: 7개 이상 번호 항목, 중요한 것부터 순서대로. 각 항목은 "N. **제목**: 요약" 줄 + 3칸 들여쓴 "- **근거**:" "- **실행방안**:" "- **기대효과**:" 세 불릿을 **각각 별도 줄로 모두** 포함(전 항목 동일 형식, 제목은 분류 태그 없이 내용만).\n' +
                domainGuide + '\n' + summary;
              return cb(null, msg);
            }

            saveToFile(mc, templateID, params, filename, cb);
          }

          if (spec && spec.run) {
            spec.run({ mc: mc, tableName: tableName, tags: tags, rollupUnit: rollupUnit, timeWhere: timeWhere, cols: cols, stock: stock, params: params }, afterTemplateData);
          } else {
            afterTemplateData();
          }
        });
      });
    }

    if (tags.length === 0) {
      // Fallback tag query
      mc.querySQL('SELECT ' + cols.n + ' FROM ' + tableName + (timeWhereBase || '') + ' GROUP BY ' + cols.n, '', '', '', function (err1b, tagCSV2) {
        tags = parseTagList(err1b ? '' : tagCSV2);
        afterTags(tags);
      });
    } else {
      afterTags(tags);
    }
  });
  } // end doStep1

  detectColumns(mc, tableName, function (c) {
    cols = c;
    buildTimeWhere();
    refineRollupFromData(checkTimeRangeAndProceed);
  });
}

// --- Save to file ---
function saveToFile(mc, templateID, params, filename, cb) {
  // Ensure no placeholder is left unreplaced
  if (!params.TAG_COUNT) params.TAG_COUNT = '-';
  if (!params.DATA_COUNT) params.DATA_COUNT = '-';
  if (!params.TIME_RANGE) params.TIME_RANGE = '-';
  if (!params.TAG_STATS_ROWS) params.TAG_STATS_ROWS = '';
  if (!params.TAG_LIST_JSON) params.TAG_LIST_JSON = '[]';
  if (!params.CHART_DATA_JSON) params.CHART_DATA_JSON = '[]';
  if (!params.ROLLUP_LABEL) params.ROLLUP_LABEL = '';
  if (!params.STOCK_NAME) params.STOCK_NAME = params.TABLE || '';
  if (!params.DRIVING_DATA_JSON) params.DRIVING_DATA_JSON = '{"per_tag":{},"events":{"accel":[],"brake":[],"turn":[]},"safety_score":0,"summary":{},"thresholds":{}}';
  if (!params.PER_TAG_DATA_JSON) params.PER_TAG_DATA_JSON = '{}';
  if (!params.TREND_DATA_JSON) params.TREND_DATA_JSON = '[]';

  var html;
  try { html = expandReportTemplate(templateID, params); } catch (e) { return cb(null, 'Template error: ' + e.message); }
  var slashIdx = filename.indexOf('/');
  function doWrite() {
    mc.writeFile(filename, html, function (err) {
      if (err) return cb(null, 'File save failed: ' + err.message);
      var reportURL = mc.baseURL + '/db/tql/' + filename;
      cb(null, 'Report saved: ' + filename + '\n\n[리포트 열기](' + reportURL + ')');
    });
  }
  if (slashIdx > 0) {
    mc.createFolder(filename.substring(0, slashIdx), function () { doWrite(); });
  } else { doWrite(); }
}

// --- R-3 Driving Data Fetcher (aligned with Go report.go) ---
function fetchDrivingData(mc, tableName, tags, rollupUnit, timeWhere, cols, cb) {
  var perTag = {};
  var tagIdx = 0;

  // Step 1: Fetch rollup + raw waveform per tag (same as Go: 4096 for raw)
  function fetchNextTag() {
    if (tagIdx >= tags.length) return fetchThresholds();
    var tag = tags[tagIdx++];

    var rollupSQL = "SELECT ROLLUP('" + rollupUnit + "', 1, " + cols.t + ") as t, AVG(" + cols.v + ") as v FROM " + tableName +
      " WHERE " + cols.n + "='" + tag + "'" + (timeWhere || '') +
      " GROUP BY ROLLUP('" + rollupUnit + "', 1, " + cols.t + ") ORDER BY t";
    mc.querySQL(rollupSQL, 'Default', '', '', function (err, rollupJSON) {
      var rollup = [];
      if (!err && rollupJSON) {
        try {
          var p = JSON.parse(rollupJSON);
          if (p && p.data && p.data.rows) {
            for (var i = 0; i < p.data.rows.length; i++) {
              var r = p.data.rows[i];
              rollup.push({ t: String(r[0] || '').substring(0, 19), avg: r[1] });
            }
          }
        } catch (e) {}
      }

      // Raw waveform (4096 points, same as Go)
      var rawSQL = "SELECT " + cols.t + ", " + cols.v + " FROM " + tableName + " WHERE " + cols.n + "='" + tag + "'" + (timeWhere || '') + " ORDER BY " + cols.t + " LIMIT 4096";
      mc.querySQL(rawSQL, 'ms', '', '', function (err2, rawJSON) {
        var raw = parseRawCSV(rawJSON);
        perTag[tag] = { raw: raw, rollup: rollup };
        console.println('  [report] R-3 tag ' + tag + ': raw=' + raw.values.length + ', rollup=' + rollup.length);
        fetchNextTag();
      });
    });
  }

  // Step 2: Compute thresholds via SQL STDDEV (same as Go)
  var thresholds = {};
  var threshAxes = [
    { axis: 'AccX', events: ['accel', 'brake'] },
    { axis: 'AccY', events: ['turn'] }
  ];
  var threshIdx = 0;

  function fetchThresholds() {
    if (threshIdx >= threshAxes.length) return fetchEvents();
    var axisInfo = threshAxes[threshIdx++];
    var actualTag = findTagCI(tags, axisInfo.axis);
    if (!actualTag) return fetchThresholds();

    var statSQL = "SELECT ROUND(AVG(" + cols.v + "),6), ROUND(STDDEV(" + cols.v + "),6) FROM " + tableName + " WHERE " + cols.n + "='" + actualTag + "'" + (timeWhere || '');
    mc.querySQL(statSQL, '', '', '', function (err, statJSON) {
      if (!err && statJSON) {
        try {
          var p = JSON.parse(statJSON);
          if (p && p.data && p.data.rows && p.data.rows.length > 0) {
            var avg = p.data.rows[0][0] || 0;
            var sd = p.data.rows[0][1] || 0;
            thresholds[axisInfo.axis] = { upper: avg + 2 * sd, lower: avg - 2 * sd };
            console.println('  [report] R-3 threshold ' + axisInfo.axis + ': upper=' + (avg + 2 * sd).toFixed(4) + ' lower=' + (avg - 2 * sd).toFixed(4));
          }
        } catch (e) {}
      }
      fetchThresholds();
    });
  }

  // Step 3: Event detection from raw data (50000 limit, same as Go)
  var eventsData = { accel: [], brake: [], turn: [] };
  var eventAxIdx = 0;

  function fetchEvents() {
    if (eventAxIdx >= threshAxes.length) return countSamples();
    var axisInfo = threshAxes[eventAxIdx++];
    var actualTag = findTagCI(tags, axisInfo.axis);
    if (!actualTag || !thresholds[axisInfo.axis]) return fetchEvents();

    var th = thresholds[axisInfo.axis];
    var eventSQL = "SELECT " + cols.t + ", " + cols.v + " FROM " + tableName + " WHERE " + cols.n + "='" + actualTag + "'" + (timeWhere || '') + " ORDER BY " + cols.t + " LIMIT 50000";
    mc.querySQL(eventSQL, 'ms', '', '', function (err, eventJSON) {
      if (!err && eventJSON) {
        var parsed = parseRawCSV(eventJSON);
        for (var i = 0; i < parsed.values.length; i++) {
          var v = parsed.values[i], tMs = parsed.times_ms[i];
          if (axisInfo.axis === 'AccX' || axisInfo.axis.toLowerCase() === 'accx') {
            if (v > th.upper) eventsData.accel.push({ t_ms: tMs, value: v });
            else if (v < th.lower) eventsData.brake.push({ t_ms: tMs, value: v });
          } else {
            if (v > th.upper || v < th.lower) eventsData.turn.push({ t_ms: tMs, value: v });
          }
        }
      }
      fetchEvents();
    });
  }

  // Step 4: Count total samples via SQL (same as Go)
  var totalSamples = 0;
  var cntAxIdx = 0;
  var countAxes = ['AccX', 'AccY'];

  function countSamples() {
    if (cntAxIdx >= countAxes.length) return finalize();
    var actualTag = findTagCI(tags, countAxes[cntAxIdx++]);
    if (!actualTag) return countSamples();

    var cntSQL = "SELECT COUNT(*) FROM " + tableName + " WHERE " + cols.n + "='" + actualTag + "'" + (timeWhere || '');
    mc.querySQL(cntSQL, '', '', '', function (err, cntJSON) {
      if (!err && cntJSON) {
        try {
          var p = JSON.parse(cntJSON);
          if (p && p.data && p.data.rows && p.data.rows.length > 0) {
            totalSamples += (parseInt(p.data.rows[0][0], 10) || 0);
          }
        } catch (e) {}
      }
      countSamples();
    });
  }

  function finalize() {
    if (totalSamples === 0) totalSamples = 1;
    var totalEvents = eventsData.accel.length + eventsData.brake.length + eventsData.turn.length;
    var safetyScore = Math.round((1 - totalEvents / totalSamples) * 1000) / 10;
    safetyScore = Math.max(0, Math.min(100, safetyScore));

    var thresholdInfo = {};
    if (thresholds['AccX']) {
      thresholdInfo.accel_upper = Math.round(thresholds['AccX'].upper * 10000) / 10000;
      thresholdInfo.brake_lower = Math.round(thresholds['AccX'].lower * 10000) / 10000;
    }
    if (thresholds['AccY']) {
      thresholdInfo.turn_upper = Math.round(thresholds['AccY'].upper * 10000) / 10000;
      thresholdInfo.turn_lower = Math.round(thresholds['AccY'].lower * 10000) / 10000;
    }

    console.println('  [report] R-3 events: accel=' + eventsData.accel.length + ' brake=' + eventsData.brake.length + ' turn=' + eventsData.turn.length + ' samples=' + totalSamples + ' safety=' + safetyScore);

    cb(null, {
      per_tag: perTag,
      events: eventsData,
      safety_score: safetyScore,
      thresholds: thresholdInfo,
      summary: {
        total_events: totalEvents, 
        accel_count: eventsData.accel.length,
        brake_count: eventsData.brake.length,
        turn_count: eventsData.turn.length,
        accel_rate: roundRate(eventsData.accel.length, totalSamples),
        brake_rate: roundRate(eventsData.brake.length, totalSamples),
        turn_rate: roundRate(eventsData.turn.length, totalSamples),
        total_samples: totalSamples
      }
    });
  }

  fetchNextTag();
}

// Parse raw CSV/JSON response to {times_ms:[], values:[]}
function parseRawCSV(jsonStr) {
  var result = { times_ms: [], values: [] };
  if (!jsonStr) return result;
  try {
    var p = JSON.parse(jsonStr);
    if (p && p.data && p.data.rows) {
      for (var i = 0; i < p.data.rows.length; i++) {
        result.times_ms.push(p.data.rows[i][0]);
        result.values.push(p.data.rows[i][1]);
      }
    }
  } catch (e) {}
  return result;
}

// Case-insensitive tag find
function findTagCI(tags, name) {
  var lower = name.toLowerCase();
  for (var i = 0; i < tags.length; i++) {
    if (tags[i].toLowerCase() === lower) return tags[i];
  }
  return '';
}

// --- R-2 Vibration Data Fetcher ---
function fetchVibrationData(mc, tableName, tags, rollupUnit, timeWhere, cols, cb) {
  var perTag = {};
  var tagIdx = 0;

  function fetchNextTag() {
    if (tagIdx >= tags.length) return enrichStats();
    var tag = tags[tagIdx++];

    var rawSQL = "SELECT " + cols.t + ", " + cols.v + " FROM " + tableName + " WHERE " + cols.n + "='" + tag + "'" + (timeWhere || '') + " ORDER BY " + cols.t + " LIMIT 4096";
    mc.querySQL(rawSQL, 'ms', '', '', function (err, rawJSON) {
      var raw = parseRawCSV(rawJSON);

      // ROLLUP with AVG, MIN, MAX, SUMSQ, COUNT (same column order as Go)
      var rollupSQL = "SELECT ROLLUP('" + rollupUnit + "', 1, " + cols.t + ") as t, ROUND(AVG(" + cols.v + "),6) as avg_val, " +
        "ROUND(MIN(" + cols.v + "),6) as min_val, ROUND(MAX(" + cols.v + "),6) as max_val, " +
        "SUMSQ(" + cols.v + ") as sumsq, COUNT(" + cols.v + ") as cnt FROM " + tableName +
        " WHERE " + cols.n + "='" + tag + "'" + (timeWhere || '') +
        " GROUP BY ROLLUP('" + rollupUnit + "', 1, " + cols.t + ") ORDER BY ROLLUP('" + rollupUnit + "', 1, " + cols.t + ")";
      mc.querySQL(rollupSQL, 'Default', '', '', function (err2, rollupJSON) {
        var rollup = [];
        if (!err2 && rollupJSON) {
          try {
            var p2 = JSON.parse(rollupJSON);
            if (p2 && p2.data && p2.data.rows) {
              for (var i = 0; i < p2.data.rows.length; i++) {
                var r = p2.data.rows[i];
                var avg = r[1] || 0, mn = r[2] || 0, mx = r[3] || 0, ss = r[4] || 0, cnt = r[5] || 1;
                var rmsVal = cnt > 0 ? Math.sqrt(ss / cnt) : 0;
                var p2pVal = mx - mn;
                var peak = Math.max(Math.abs(mn), Math.abs(mx));
                var crestVal = rmsVal > 0 ? peak / rmsVal : 0;
                rollup.push({ t: String(r[0] || '').substring(0, 19), rms: Math.round(rmsVal * 1e6) / 1e6, p2p: Math.round(p2pVal * 1e6) / 1e6, crest: Math.round(crestVal * 1e4) / 1e4, avg: avg });
              }
            }
          } catch (e2) {}
        }

        // FFT: separate query with 131072 points (2^17), no timeformat → nanoseconds for sampleRate calc
        var fftSQL = "SELECT " + cols.t + ", " + cols.v + " FROM " + tableName + " WHERE " + cols.n + "='" + tag + "'" + (timeWhere || '') + " ORDER BY " + cols.t + " LIMIT 131072";
        mc.querySQL(fftSQL, '', '', '', function (err3, fftJSON) {
          var fftRaw = parseRawCSV(fftJSON);
          var fft = computeFFT(fftRaw.times_ms, fftRaw.values, 4096);

          perTag[tag] = { raw: raw, rollup: rollup, fft: fft };
          console.println('  [report] R-2 tag ' + tag + ': raw=' + raw.values.length + ', rollup=' + rollup.length + ', fft=' + (fft ? fft.freqs.length + ' bins from ' + fftRaw.values.length + ' pts' : 'none'));
          fetchNextTag();
        });
      });
    });
  }

  // Compute stats from rollup data (same as Go computeVibStats)
  function enrichStats() {
    var keys = Object.keys(perTag);
    for (var i = 0; i < keys.length; i++) {
      var d = perTag[keys[i]];
      var rollup = d.rollup || [];

      if (rollup.length > 0) {
        // Aggregate across all rollup buckets (Go method)
        var totalSumSq = 0, totalCount = rollup.length;
        var globalMin = Infinity, globalMax = -Infinity;
        var sumAvg = 0;
        for (var j = 0; j < rollup.length; j++) {
          var r = rollup[j];
          sumAvg += (r.avg || 0);
          if (r.rms !== undefined) totalSumSq += r.rms * r.rms;
          // rollup has per-bucket min/max via p2p calculation, but we need raw min/max
          // Use raw data for global min/max as rollup doesn't store individual min/max
        }
        // For global min/max, use raw data
        var vals = d.raw.values || [];
        for (var j = 0; j < vals.length; j++) {
          if (vals[j] < globalMin) globalMin = vals[j];
          if (vals[j] > globalMax) globalMax = vals[j];
        }
        if (globalMin === Infinity) globalMin = 0;
        if (globalMax === -Infinity) globalMax = 0;

        var overallRMS = totalCount > 0 ? Math.sqrt(totalSumSq / totalCount) : 0;
        var overallP2P = globalMax - globalMin;
        var peak = Math.max(Math.abs(globalMin), Math.abs(globalMax));
        var overallCrest = overallRMS > 0 ? peak / overallRMS : 0;

        // Peak RMS (1-bucket window max)
        var peakRMS = 0;
        for (var j = 0; j < rollup.length; j++) {
          if ((rollup[j].rms || 0) > peakRMS) peakRMS = rollup[j].rms;
        }

        // Trend: last 20% avg / first 20% avg
        var seg = Math.max(1, Math.floor(rollup.length * 0.2));
        var earlySum = 0, lateSum = 0;
        for (var j = 0; j < seg; j++) earlySum += (rollup[j].rms || 0);
        for (var j = rollup.length - seg; j < rollup.length; j++) lateSum += (rollup[j].rms || 0);
        var earlyAvg = earlySum / seg;
        var lateAvg = lateSum / seg;
        var trendRatio = earlyAvg > 0 ? lateAvg / earlyAvg : 1;

        // Severity grading per indicator
        function rmsGrade(v) { return v < 1.12 ? 0 : v < 2.8 ? 1 : v < 7.1 ? 2 : 3; }
        function crestGrade(v) { return v < 3 ? 0 : v < 5 ? 1 : v < 8 ? 2 : 3; }
        function trendGrade(v) { return v < 1.5 ? 0 : v < 3.0 ? 1 : v < 5.0 ? 2 : 3; }
        var gradeLabels = ['Good', 'Warning', 'Danger', 'Critical'];

        var g_avgRMS = rmsGrade(overallRMS);
        var g_peakRMS = rmsGrade(peakRMS);
        var g_crest = crestGrade(overallCrest);
        var g_trend = trendGrade(trendRatio);
        var worstGrade = Math.max(g_avgRMS, g_peakRMS, g_crest, g_trend);

        // Determine which indicator(s) caused worst grade
        var deciders = [];
        if (g_avgRMS === worstGrade) deciders.push('평균 RMS (' + overallRMS.toFixed(4) + ')');
        if (g_peakRMS === worstGrade) deciders.push('피크 RMS (' + peakRMS.toFixed(4) + ')');
        if (g_crest === worstGrade) deciders.push('Crest Factor (' + overallCrest.toFixed(2) + ')');
        if (g_trend === worstGrade) deciders.push('추세 (' + trendRatio.toFixed(1) + '배)');

        d.stats = {
          count: totalCount,
          avg: Math.round(sumAvg / totalCount * 1e4) / 1e4,
          min: globalMin,
          max: globalMax,
          rms: Math.round(overallRMS * 1e6) / 1e6,
          peak_rms: Math.round(peakRMS * 1e6) / 1e6,
          p2p: Math.round(overallP2P * 1e6) / 1e6,
          crest: Math.round(overallCrest * 1e4) / 1e4,
          trend_ratio: Math.round(trendRatio * 100) / 100,
          severity: {
            grade: worstGrade,
            label: gradeLabels[worstGrade],
            indicators: {
              avg_rms: { value: Math.round(overallRMS * 1e6) / 1e6, grade: g_avgRMS, label: gradeLabels[g_avgRMS] },
              peak_rms: { value: Math.round(peakRMS * 1e6) / 1e6, grade: g_peakRMS, label: gradeLabels[g_peakRMS] },
              crest: { value: Math.round(overallCrest * 1e4) / 1e4, grade: g_crest, label: gradeLabels[g_crest] },
              trend: { value: Math.round(trendRatio * 100) / 100, grade: g_trend, label: gradeLabels[g_trend] }
            },
            deciders: deciders
          }
        };
      } else {
        // Fallback: raw data
        var vals = d.raw.values || [];
        var rms = calcRMS(vals);
        var minV = vals.length ? Math.min.apply(null, vals) : 0;
        var maxV = vals.length ? Math.max.apply(null, vals) : 0;
        var peak = Math.max(Math.abs(minV), Math.abs(maxV));
        d.stats = {
          count: vals.length,
          avg: Math.round(calcMeanStd(vals).mean * 1e4) / 1e4,
          min: minV, max: maxV,
          rms: Math.round(rms * 1e6) / 1e6,
          p2p: Math.round((maxV - minV) * 1e6) / 1e6,
          crest: rms > 0 ? Math.round(peak / rms * 1e4) / 1e4 : 0
        };
      }
    }
    console.println('  [report] R-2 vibration stats computed for ' + keys.length + ' tags');
    cb(null, perTag);
  }

  fetchNextTag();
}

function calcRMS(vals) {
  if (!vals || vals.length === 0) return 0;
  var sumSq = 0;
  for (var i = 0; i < vals.length; i++) sumSq += vals[i] * vals[i];
  return Math.sqrt(sumSq / vals.length);
}

// Cooley-Tukey Radix-2 FFT (matches Go computeFFTSpectrum)
// timestamps: nanosecond timestamps (no timeformat), vals: float values
function computeFFT(timestamps, vals, maxBins) {
  if (!vals || vals.length < 16) return null;
  maxBins = maxBins || 4096;
  var N = vals.length;

  // Compute sample rate from first/last timestamp (nanoseconds)
  var firstNs = timestamps[0] || 0;
  var lastNs = timestamps[N - 1] || 0;
  var dtSec = (lastNs - firstNs) / 1e9 / (N - 1);
  if (dtSec <= 0) return null;
  var sampleRate = 1.0 / dtSec;

  // Pad to next power of 2
  var n = 1;
  while (n < N) n *= 2;
  var re = new Array(n), im = new Array(n);
  // Hanning window + zero-pad
  for (var i = 0; i < n; i++) {
    if (i < N) {
      var win = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
      re[i] = vals[i] * win;
    } else {
      re[i] = 0;
    }
    im[i] = 0;
  }
  // Bit-reversal permutation
  for (var i = 1, j = 0; i < n; i++) {
    var bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { var tmp = re[i]; re[i] = re[j]; re[j] = tmp; tmp = im[i]; im[i] = im[j]; im[j] = tmp; }
  }
  // Butterfly operations
  for (var len = 2; len <= n; len *= 2) {
    var half = len / 2, ang = -2 * Math.PI / len;
    var wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (var i = 0; i < n; i += len) {
      var curRe = 1, curIm = 0;
      for (var j = 0; j < half; j++) {
        var tRe = curRe * re[i + j + half] - curIm * im[i + j + half];
        var tIm = curRe * im[i + j + half] + curIm * re[i + j + half];
        re[i + j + half] = re[i + j] - tRe;
        im[i + j + half] = im[i + j] - tIm;
        re[i + j] += tRe;
        im[i + j] += tIm;
        var nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
  // Magnitude spectrum (first half)
  var halfN = n / 2;
  var rawMags = new Array(halfN - 1);
  for (var k = 1; k < halfN; k++) {
    rawMags[k - 1] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * 2 / N;
  }
  // Bin down to maxBins (same logic as Go)
  var freqs = [], mags = [];
  if (rawMags.length <= maxBins) {
    for (var k = 0; k < rawMags.length; k++) {
      freqs.push(Math.round((k + 1) * sampleRate / n * 1e6) / 1e6);
      mags.push(rawMags[k]);
    }
  } else {
    var binSize = rawMags.length / maxBins;
    for (var b = 0; b < maxBins; b++) {
      var start = Math.floor(b * binSize);
      var end = Math.floor((b + 1) * binSize);
      if (end > rawMags.length) end = rawMags.length;
      var sum = 0;
      for (var i = start; i < end; i++) sum += rawMags[i];
      var avg = sum / (end - start);
      var midK = Math.floor((start + end) / 2);
      freqs.push(Math.round((midK + 1) * sampleRate / n * 1e6) / 1e6);
      mags.push(Math.round(avg * 1e6) / 1e6);
    }
  }
  return { freqs: freqs, mags: mags, sampleRate: Math.round(sampleRate * 100) / 100, total_points: N };
}

// --- R-1 Finance Data Fetcher ---
function fetchFinanceData(mc, tableName, tags, stock, rollupUnit, timeWhere, cols, cb) {
  var ohlcv = findOHLCVTags(tags, stock);
  var stockName = stock || '';
  if (!stockName && ohlcv.close) {
    var cn = ohlcv.close;
    var suffixes = ['_close', '_open', '_high', '_low', '_volume'];
    for (var si = 0; si < suffixes.length; si++) {
      var idx = cn.toLowerCase().indexOf(suffixes[si]);
      if (idx > 0) { stockName = cn.substring(0, idx); break; }
    }
  }
  if (!stockName) stockName = tableName;

  if (!ohlcv.close) return cb(null, { trend: [], stockName: stockName });

  // Time label trim length by rollup unit (same as Go)
  var trimLen = 7; // month default
  if (rollupUnit === 'sec') trimLen = 19;
  else if (rollupUnit === 'min') trimLen = 16;
  else if (rollupUnit === 'hour') trimLen = 13;
  else if (rollupUnit === 'day' || rollupUnit === 'week') trimLen = 10;

  var fieldMap = {};
  if (ohlcv.open) fieldMap.open = ohlcv.open;
  if (ohlcv.high) fieldMap.high = ohlcv.high;
  if (ohlcv.low) fieldMap.low = ohlcv.low;
  if (ohlcv.close) fieldMap.close = ohlcv.close;
  if (ohlcv.volume) fieldMap.volume = ohlcv.volume;

  var fields = Object.keys(fieldMap);
  var ohlcvData = {}; // field → [{time, [field]: value}]
  var fieldIdx = 0;

  function fetchNextField() {
    if (fieldIdx >= fields.length) return mergeAndFinish();
    var field = fields[fieldIdx++];
    var tag = fieldMap[field];
    var decimals = field === 'volume' ? 0 : 2;

    var sql = "SELECT ROLLUP('" + rollupUnit + "', 1, " + cols.t + ") as t, ROUND(AVG(" + cols.v + ")," + decimals + ") as v FROM " + tableName +
      " WHERE " + cols.n + "='" + tag + "'" + (timeWhere || '') +
      " GROUP BY ROLLUP('" + rollupUnit + "', 1, " + cols.t + ") ORDER BY ROLLUP('" + rollupUnit + "', 1, " + cols.t + ")";
    mc.querySQL(sql, 'Default', '', '', function (err, json) {
      var data = [];
      if (!err && json) {
        try {
          var p = JSON.parse(json);
          if (p && p.data && p.data.rows) {
            for (var i = 0; i < p.data.rows.length; i++) {
              var t = String(p.data.rows[i][0] || '');
              if (t.length > trimLen) t = t.substring(0, trimLen);
              var item = { time: t };
              item[field] = p.data.rows[i][1];
              data.push(item);
            }
          }
        } catch (e) {}
      }
      ohlcvData[field] = data;
      console.println('  [report] R-1 field ' + field + ' (' + tag + '): ' + data.length + ' rows');
      fetchNextField();
    });
  }

  // Merge OHLCV by time (same as Go mergeOHLCV)
  function mergeAndFinish() {
    var timeMap = {};
    var timeOrder = [];
    // Use close as primary time source
    var primaryField = ohlcvData.close ? 'close' : Object.keys(ohlcvData)[0];
    var primary = ohlcvData[primaryField] || [];
    for (var i = 0; i < primary.length; i++) {
      var t = primary[i].time;
      if (!t) continue;
      if (!timeMap[t]) { timeMap[t] = { time: t }; timeOrder.push(t); }
      if (primary[i][primaryField] !== undefined) timeMap[t][primaryField] = primary[i][primaryField];
    }
    // Merge other fields
    var allFields = Object.keys(ohlcvData);
    for (var fi = 0; fi < allFields.length; fi++) {
      var f = allFields[fi];
      if (f === primaryField) continue;
      var items = ohlcvData[f] || [];
      for (var i = 0; i < items.length; i++) {
        var t = items[i].time;
        if (!t) continue;
        if (!timeMap[t]) { timeMap[t] = { time: t }; timeOrder.push(t); }
        if (items[i][f] !== undefined) timeMap[t][f] = items[i][f];
      }
    }
    var trend = timeOrder.map(function(t) { return timeMap[t]; });
    console.println('  [report] R-1 OHLCV merged: ' + trend.length + ' rows');

    // Compute finance summary (same as Go computeFinanceSummary)
    var financeSummary = computeFinanceSummary(trend);

    cb(null, { trend: trend, stockName: stockName, financeSummary: financeSummary });
  }

  fetchNextField();
}

// --- Finance Summary (same as Go computeFinanceSummary) ---
function computeFinanceSummary(trendData) {
  if (!trendData || trendData.length === 0) return '';
  var toF = function(v) { return parseFloat(v) || 0; };

  // Collect points with close > 0
  var pts = [];
  for (var i = 0; i < trendData.length; i++) {
    var d = trendData[i];
    var cl = toF(d.close);
    if (cl > 0) pts.push({ time: d.time || '', close: cl, open: toF(d.open), high: toF(d.high), low: toF(d.low), vol: toF(d.volume) });
  }
  if (pts.length === 0) return '';
  var lines = [];

  // 1. Trend direction
  var first = pts[0], last = pts[pts.length - 1];
  var changeRate = first.close > 0 ? (last.close - first.close) / first.close * 100 : 0;
  var direction = '횡보';
  if (changeRate > 5) direction = '상승';
  else if (changeRate < -5) direction = '하락';
  lines.push('- 추세: ' + first.time + ' → ' + last.time + ' (' + first.close.toFixed(1) + ' → ' + last.close.toFixed(1) + ', ' + changeRate.toFixed(1) + '% ' + direction + ')');

  // 2. Recent candle pattern (last 20 bars)
  var recentN = Math.min(20, pts.length);
  var recent = pts.slice(pts.length - recentN);
  var bullish = 0, bearish = 0;
  for (var i = 0; i < recent.length; i++) {
    if (recent[i].open > 0) {
      if (recent[i].close >= recent[i].open) bullish++; else bearish++;
    }
  }
  if (bullish + bearish > 0) {
    var dominant = '중립';
    if (bullish > bearish + 2) dominant = '강세 우위';
    else if (bearish > bullish + 2) dominant = '약세 우위';
    lines.push('- 최근 ' + recentN + '봉: 양봉 ' + bullish + '개, 음봉 ' + bearish + '개 (' + dominant + ')');
  }

  // 3. Moving averages
  function calcMA(data, period) {
    if (data.length < period) return 0;
    var sum = 0;
    for (var i = data.length - period; i < data.length; i++) sum += data[i].close;
    return sum / period;
  }
  var ma5 = calcMA(pts, 5), ma20 = calcMA(pts, 20), ma60 = calcMA(pts, 60);
  if (ma5 > 0 && ma20 > 0) {
    var arr = '';
    if (ma60 > 0) {
      if (ma5 > ma20 && ma20 > ma60) arr = '정배열 (강세)';
      else if (ma5 < ma20 && ma20 < ma60) arr = '역배열 (약세)';
      else arr = '혼조';
      lines.push('- 이동평균: MA5(' + ma5.toFixed(1) + ') / MA20(' + ma20.toFixed(1) + ') / MA60(' + ma60.toFixed(1) + ') → ' + arr);
    } else {
      arr = ma5 > ma20 ? '단기 우위' : '단기 열위';
      lines.push('- 이동평균: MA5(' + ma5.toFixed(1) + ') / MA20(' + ma20.toFixed(1) + ') → ' + arr);
    }
  }

  // 4. Volatility (high-low spread)
  var totalSpread = 0, spreadCount = 0, recentSpread = 0, recentSpreadCount = 0;
  for (var i = 0; i < pts.length; i++) {
    if (pts[i].high > 0 && pts[i].low > 0) {
      var sp = pts[i].high - pts[i].low;
      totalSpread += sp; spreadCount++;
      if (i >= pts.length - recentN) { recentSpread += sp; recentSpreadCount++; }
    }
  }
  if (spreadCount > 0 && recentSpreadCount > 0) {
    var avgSp = totalSpread / spreadCount, avgRecSp = recentSpread / recentSpreadCount;
    var volState = '보합';
    if (avgRecSp > avgSp * 1.2) volState = '확대';
    else if (avgRecSp < avgSp * 0.8) volState = '축소';
    lines.push('- 변동성: 전체 평균 스프레드 ' + avgSp.toFixed(1) + ', 최근 ' + avgRecSp.toFixed(1) + ' → 변동성 ' + volState);
  }

  // 5. High/Low points
  var maxP = pts[0], minP = pts[0];
  for (var i = 1; i < pts.length; i++) {
    if (pts[i].close > maxP.close) maxP = pts[i];
    if (pts[i].close < minP.close) minP = pts[i];
  }
  lines.push('- 최고가 구간: ' + maxP.time + ' (' + maxP.close.toFixed(1) + ')');
  lines.push('- 최저가 구간: ' + minP.time + ' (' + minP.close.toFixed(1) + ')');

  // 6. Volume trend
  var totalVol = 0, volCount = 0, recentVol = 0, recentVolCount = 0;
  for (var i = 0; i < pts.length; i++) {
    if (pts[i].vol > 0) {
      totalVol += pts[i].vol; volCount++;
      if (i >= pts.length - recentN) { recentVol += pts[i].vol; recentVolCount++; }
    }
  }
  if (volCount > 0 && recentVolCount > 0) {
    var avgVol = totalVol / volCount, avgRecVol = recentVol / recentVolCount;
    var ratio = avgRecVol / avgVol;
    var volTrend = '보합';
    if (ratio > 1.3) volTrend = '급증';
    else if (ratio > 1.1) volTrend = '증가';
    else if (ratio < 0.7) volTrend = '급감';
    else if (ratio < 0.9) volTrend = '감소';
    lines.push('- 거래량: 전체 평균 ' + Math.round(avgVol) + ', 최근 평균 ' + Math.round(avgRecVol) + ' (' + ratio.toFixed(1) + '배, ' + volTrend + ')');
  }

  return lines.join('\n');
}

// --- Template auto-detection ---
function detectIMUTags(tags) {
  var imuKeywords = ['accx', 'accy', 'accz', 'gyrox', 'gyroy', 'gyroz', 'acc_x', 'acc_y', 'acc_z', 'gyro_x', 'gyro_y', 'gyro_z'];
  var found = 0;
  for (var i = 0; i < tags.length; i++) {
    var lower = tags[i].toLowerCase();
    for (var j = 0; j < imuKeywords.length; j++) {
      if (lower === imuKeywords[j]) { found++; break; }
    }
  }
  return found >= 3;
}

function detectVibrationTags(tags, tableName) {
  var vibKeywords = ['vib', 'vibration', 'bearing', 'sensor', 'accel', 'velocity', 'displacement'];
  // 태그명이 C1/C2처럼 무의미해도 테이블명(BEARING 등)으로 감지되도록 둘 다 검사
  var names = tags.slice();
  if (tableName) names.push(tableName);
  for (var i = 0; i < names.length; i++) {
    var lower = String(names[i]).toLowerCase();
    for (var j = 0; j < vibKeywords.length; j++) {
      if (lower.indexOf(vibKeywords[j]) >= 0) return true;
    }
  }
  return false;
}

function findTagKey(obj, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    if (obj[candidates[i]]) return candidates[i];
  }
  var keys = Object.keys(obj);
  for (var i = 0; i < candidates.length; i++) {
    var lower = candidates[i].toLowerCase();
    for (var j = 0; j < keys.length; j++) {
      if (keys[j].toLowerCase() === lower) return keys[j];
    }
  }
  return '';
}

function calcMeanStd(vals) {
  if (!vals || vals.length === 0) return { mean: 0, std: 0 };
  var sum = 0;
  for (var i = 0; i < vals.length; i++) sum += vals[i];
  var mean = sum / vals.length;
  var sumSq = 0;
  for (var i = 0; i < vals.length; i++) sumSq += (vals[i] - mean) * (vals[i] - mean);
  return { mean: mean, std: Math.sqrt(sumSq / vals.length) };
}

function roundRate(count, total) {
  return Math.round(count / total * 1000) / 10;
}

function parseTimeRangeMs(csvData) {
  try {
    var p = JSON.parse(csvData);
    if (p && p.data && p.data.rows && p.data.rows.length > 0) {
      var row = p.data.rows[0];
      if (row[0] == null || row[1] == null) return '';
      var d0 = new Date(row[0]), d1 = new Date(row[1]);
      if (isNaN(d0.getTime()) || isNaN(d1.getTime())) return '';
      return formatDateLocal(d0) + ' ~ ' + formatDateLocal(d1);
    }
  } catch (e) {}
  return '';
}

// --- Helpers ---
function anyStr(obj, key) { var v = obj[key]; if (v === undefined || v === null) return ''; return String(v); }
function pad2(n) { return n < 10 ? '0' + n : String(n); }
function formatDateLocal(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
function dateStrToNano(s) { if (!s) return ''; s = s.trim(); if (s[0] >= '0' && s[0] <= '9' && s.indexOf('-') < 0) return s; var d = new Date(s); if (isNaN(d.getTime())) return s; return String(d.getTime() * 1000000); }
function msToNano(ms) { if (!ms) return ms; var s = String(ms).trim(); if (s.length > 15) return s; return s + '000000'; }
function pickRollupUnit(startMs, endMs) { if (!startMs || !endMs) return 'min'; var s = parseInt(startMs, 10), e = parseInt(endMs, 10); if (!s || !e) return 'min'; var h = (e - s) / 1000 / 3600; if (h < 1) return 'sec'; if (h < 48) return 'min'; if (h < 720) return 'hour'; if (h < 8760) return 'day'; return 'month'; }
function parseTagList(csvData) { if (!csvData) return []; try { var p = JSON.parse(csvData); if (p && p.data && p.data.rows) return p.data.rows.map(function (r) { return r[0]; }).filter(function (t) { return t; }); } catch (e) {} var lines = csvData.split('\n'); var tags = []; for (var i = 1; i < lines.length; i++) { var t = lines[i].trim(); if (t && t !== 'NAME') tags.push(t); } return tags; }
function parseStatsCSV(csvData) { var rows = [], items = []; try { var p = JSON.parse(csvData); if (p && p.data && p.data.rows) { for (var i = 0; i < p.data.rows.length; i++) { var r = p.data.rows[i]; if (r.length < 5) continue; rows.push('<tr><td>' + r[0] + '</td><td class="num">' + r[1] + '</td><td class="num">' + r[2] + '</td><td class="num">' + r[3] + '</td><td class="num">' + r[4] + '</td></tr>'); items.push({ name: r[0], count: r[1], avg: r[2], min: r[3], max: r[4] }); } } } catch (e) {} return { rows: rows, items: items }; }
function parseTimeRangeCSV(csvData) { try { var p = JSON.parse(csvData); if (p && p.data && p.data.rows && p.data.rows.length > 0) { var row = p.data.rows[0]; if (row[0] == null || row[1] == null) return ''; var s0 = String(row[0]), s1 = String(row[1]); if (s0 === 'null' || s1 === 'null' || !s0 || !s1) return ''; return s0.substring(0, 19) + ' ~ ' + s1.substring(0, 19); } } catch (e) {} return ''; }
function findOHLCVTags(tags, stock) {
  var result = {}; var fields = ['open', 'high', 'low', 'close', 'volume'];
  if (stock) {
    var prefix = stock.toUpperCase() + '_';
    tags.forEach(function (t) { var upper = t.toUpperCase(); if (upper.indexOf(prefix) !== 0) return; var suffix = t.substring(prefix.length).toLowerCase(); if (fields.indexOf(suffix) >= 0) result[suffix] = t; });
  }
  // 접두어(SILVER_open 등) 매칭 실패 또는 stock 미지정 → bare 이름(open/high/low/close/volume)으로 폴백.
  // 태그가 SILVER_open 형태가 아니라 open/high/low/close 그대로인 테이블은 접두어 검색이 0건 → 폴백 없이는 차트가 빠진다.
  // 멀티종목 테이블(SILVER_open, GOLD_open)은 접두어로 이미 채워져 폴백 미발동(bare 'open' 태그도 없음).
  if (!result.close || !result.open) {
    var lower = {}; tags.forEach(function (t) { lower[t.toLowerCase()] = t; });
    fields.forEach(function (f) { if (!result[f] && lower[f]) result[f] = lower[f]; });
  }
  return result;
}
function extractStockPrefix(tagVal) { var c = tagVal.split(',')[0].trim(); ['_close', '_open', '_high', '_low', '_volume', '_adj_close'].forEach(function (s) { var idx = c.toLowerCase().indexOf(s); if (idx > 0) c = c.substring(0, idx); }); return c.toUpperCase(); }
function calcTotalCount(csvData) { var total = 0; try { var p = JSON.parse(csvData); if (p && p.data && p.data.rows) p.data.rows.forEach(function (r) { if (r.length >= 2) total += parseInt(r[1], 10) || 0; }); } catch (e) {} return total; }
// ⚠️ 인라인 스타일 색은 **CSS 변수 + 옛 색 폴백**(var(--x, #구색)) 형태로만 쓸 것.
//    색을 하드코딩했더니 다크 테마 템플릿에서 남색 제목(#1a365d)이 배경에 묻혀 안 보였다(라이브 스크린샷).
//    변수를 정의한 새 템플릿(Neo 토큰)에선 테마를 따라가고, 변수가 없는 고객 커스텀 템플릿에선 폴백 색 그대로 — 하위호환.
function mdToHTML(text) {
  if (!text) return '';
  function inlineFmt(s) {
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/`(.+?)`/g, '<code style="background:var(--bg-input,#edf2f7);padding:2px 6px;border-radius:4px;font-size:13px;">$1</code>');
    return s;
  }

  // 구분행( |---|---| 형태 — 파이프/대시/콜론/공백만 + 대시 1개 이상 )
  function isSeparatorRow(s) { return /^[\s|:\-]+$/.test(s) && s.indexOf('-') >= 0 && s.indexOf('|') >= 0; }
  // 표 행을 셀 배열로 분해 (양끝 파이프 제거 후 | 로 split)
  function splitRow(s) {
    return s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
  }

  var lines = text.split('\n');
  var result = [];
  var inUL = false;

  function closeUL() { if (inUL) { result.push('</ul>'); inUL = false; } }

  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var trimmed = raw.trim();
    if (!trimmed) { closeUL(); continue; }

    // Headers
    if (/^####\s+/.test(trimmed)) { closeUL(); result.push('<h4 style="font-size:14px;font-weight:700;color:var(--text-primary,#2d3748);margin:18px 0 8px;">' + inlineFmt(trimmed.replace(/^####\s+/, '')) + '</h4>'); continue; }
    if (/^###\s+/.test(trimmed)) { closeUL(); result.push('<h3 style="font-size:15px;font-weight:700;color:var(--text-primary,#1a365d);margin:20px 0 10px;">' + inlineFmt(trimmed.replace(/^###\s+/, '')) + '</h3>'); continue; }
    if (/^##\s+/.test(trimmed)) { closeUL(); result.push('<h2 style="font-size:17px;font-weight:700;color:var(--text-primary,#1a365d);margin:24px 0 12px;border-bottom:2px solid var(--border-default,#e2e8f0);padding-bottom:6px;">' + inlineFmt(trimmed.replace(/^##\s+/, '')) + '</h2>'); continue; }

    // Ordered list: "1. text" → 번호 직접 보존, div 들여쓰기
    var olMatch = trimmed.match(/^(\d+)[.)]\s+(.*)/);
    if (olMatch) {
      closeUL();
      result.push('<div style="margin:10px 0 6px 8px;"><span style="font-weight:700;color:var(--primary-hover,#2b6cb0);margin-right:8px;">' + olMatch[1] + '.</span>' + inlineFmt(olMatch[2]) + '</div>');
      continue;
    }

    // Indented sub-item: "  - text" (check before top-level)
    if (/^\s{2,}[-*]\s+/.test(raw)) {
      if (!inUL) { result.push('<ul style="margin:4px 0 8px 28px;list-style-type:disc;">'); inUL = true; }
      result.push('<li style="margin-left:20px;margin-bottom:4px;list-style-type:circle;">' + inlineFmt(raw.trim().replace(/^[-*]\s+/, '')) + '</li>');
      continue;
    }

    // Unordered list: "- text" or "* text"
    if (/^[-*]\s+/.test(trimmed)) {
      if (!inUL) { result.push('<ul style="margin:4px 0 8px 28px;list-style-type:disc;">'); inUL = true; }
      result.push('<li style="margin-bottom:5px;">' + inlineFmt(trimmed.replace(/^[-*]\s+/, '')) + '</li>');
      continue;
    }

    // Markdown table: 헤더행 + 구분행(|---|) + 데이터행. 행 사이 빈 줄도 허용(LLM이 \n\n로 출력하는 케이스 방어).
    if (trimmed.indexOf('|') >= 0) {
      var sepIdx = i + 1;
      while (sepIdx < lines.length && lines[sepIdx].trim() === '') sepIdx++;
      if (sepIdx < lines.length && isSeparatorRow(lines[sepIdx].trim())) {
        closeUL();
        var headCells = splitRow(trimmed);
        var bodyRows = [];
        var p = sepIdx + 1;
        while (p < lines.length) {
          var lt = lines[p].trim();
          if (lt === '') { p++; continue; }   // 행 사이 빈 줄 건너뜀
          if (lt.indexOf('|') < 0) break;      // 표 종료
          bodyRows.push(splitRow(lt));
          p++;
        }
        var thHtml = '';
        for (var hc = 0; hc < headCells.length; hc++) {
          thHtml += '<th style="border:1px solid var(--border-medium,#cbd5e0);padding:8px 10px;background:var(--bg-elevated,#f7fafc);color:var(--text-primary,#1a365d);font-weight:700;text-align:left;">' + inlineFmt(headCells[hc]) + '</th>';
        }
        var bodyHtml = '';
        for (var br = 0; br < bodyRows.length; br++) {
          bodyHtml += '<tr>';
          for (var dc = 0; dc < bodyRows[br].length; dc++) {
            bodyHtml += '<td style="border:1px solid var(--border-default,#e2e8f0);padding:8px 10px;color:var(--text-secondary,#2d3748);">' + inlineFmt(bodyRows[br][dc]) + '</td>';
          }
          bodyHtml += '</tr>';
        }
        result.push('<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:13px;"><thead><tr>' + thHtml + '</tr></thead><tbody>' + bodyHtml + '</tbody></table>');
        i = p - 1; // 소비한 표 행들만큼 메인 루프 인덱스 이동
        continue;
      }
    }

    // Normal paragraph
    closeUL();
    result.push('<p style="margin-bottom:12px;line-height:1.7;">' + inlineFmt(trimmed) + '</p>');
  }
  closeUL();
  return result.join('\n');
}

module.exports = { register };
