var { argStr } = require('./registry');
var { expandReportTemplate, loadReportTemplates } = require('./report_templates');

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

function register(registry, mc) {
  loadReportTemplates();

  registry.register({
    name: 'save_html_report',
    description: '데이터를 분석하여 HTML 리포트를 생성합니다. 차트와 심층 분석이 포함된 보고서를 자동으로 만들어줍니다. table만 지정하여 바로 호출하세요.',
    parameters: {
      type: 'object',
      properties: {
        template_id: { type: 'string', description: '템플릿 ID. 운전/차량: R-3, 진동: R-2, 금융: R-1, 범용: R-0', enum: ['R-0', 'R-1', 'R-2', 'R-3'] },
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
          '## 형식: 마크다운, 최소 7개 번호 항목 (1. 2. ...)\n' +
          '## 각 항목 구성:\n' +
          '- **제목** (볼드)\n' +
          '- 근거 데이터 수치 인용\n' +
          '- 구체적 실행 방안 (누가, 무엇을, 언제, 어떻게)\n' +
          '- 기대 효과\n\n' +
          '## 내용: 즉시 조치/단기 개선/중장기 전략으로 구분하여 우선순위별 정리' },
        rollup_unit: { type: 'string', enum: ['sec', 'min', 'hour', 'day', 'week', 'month'] },
        tag_name: { type: 'string', description: '분석 대상 태그명 또는 종목명. 사용자가 특정 대상을 언급하면 반드시 전달.' },
        time_start: { type: 'string' }, time_end: { type: 'string' },
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

  var templateID = anyStr(norm, 'template_id') || anyStr(norm, 'templateid') || 'R-0';
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
  if (hasAnalysis || hasReco) {
    var cached = getCachedParams(tableName);
    if (cached) {
      console.println('  [report] Cache hit for ' + tableName);
      // Both present → save
      if (hasAnalysis && hasReco) {
        var ckeys = Object.keys(cached);
        for (var ci = 0; ci < ckeys.length; ci++) params[ckeys[ci]] = cached[ckeys[ci]];
        params.ANALYSIS = mdToHTML(anyStr(norm, 'analysis'));
        params.RECOMMENDATIONS = mdToHTML(anyStr(norm, 'recommendations'));
        params.GENERATED_DATE = formatDateLocal(now);
        return saveToFile(mc, cached._templateID || templateID, params, filename, cb);
      }
      // One missing → tell LLM what's missing, don't re-query
      var missing = [];
      if (!hasAnalysis) missing.push('analysis');
      if (!hasReco) missing.push('recommendations');
      return cb(null, '다음 파라미터가 누락되었습니다: ' + missing.join(', ') + '. analysis와 recommendations를 모두 포함하여 다시 호출하세요.');
    }
  }

  var timeStart = dateStrToNano(anyStr(norm, 'time_start') || anyStr(norm, 'timestart'));
  var timeEnd = dateStrToNano(anyStr(norm, 'time_end') || anyStr(norm, 'timeend'));
  var timeWhere = '', timeWhereBase = '';
  if (timeStart && timeEnd) {
    var tsNano = msToNano(timeStart), teNano = msToNano(timeEnd);
    timeWhere = ' AND TIME BETWEEN ' + tsNano + ' AND ' + teNano;
    timeWhereBase = ' WHERE TIME BETWEEN ' + tsNano + ' AND ' + teNano;
  }

  var stock = anyStr(norm, 'tag_name') || anyStr(norm, 'stock') || anyStr(norm, 'tag') || '';
  if (stock) stock = extractStockPrefix(stock);
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
      mc.querySQL('SELECT MAX(TIME) FROM ' + tableName, '', '', '', function (merr, maxJSON) {
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
                timeWhere = ' AND TIME BETWEEN ' + newTsNano + ' AND ' + newTeNano;
                timeWhereBase = ' WHERE TIME BETWEEN ' + newTsNano + ' AND ' + newTeNano;
                console.println('[report] Adjusted time range to data: ' + newTsNano + ' ~ ' + newTeNano);
              }
            }
          } catch (e) {}
        }
        doStep1();
      });
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
        if (filtered.length > 0) { tags = filtered; stockWhere = " AND NAME IN ('" + filtered.join("','") + "')"; }
      }

      params.TAG_LIST_JSON = JSON.stringify(tags);

      if (templateID === 'R-0') {
        var ohlcv = findOHLCVTags(tags, stock);
        if (ohlcv.close && ohlcv.open) {
          templateID = 'R-1';
        } else if (detectIMUTags(tags)) {
          templateID = 'R-3';
        } else if (detectVibrationTags(tags)) {
          templateID = 'R-2';
        }
        if (templateID !== 'R-0') console.println('  [report] Auto-detected template: ' + templateID);
      }

      // Step 2: Get stats
      var statsSQL = 'SELECT NAME, COUNT(*) as cnt, ROUND(AVG(VALUE),2) as avg, ROUND(MIN(VALUE),2) as min, ROUND(MAX(VALUE),2) as max FROM ' + tableName;
      var whereClause = timeWhereBase || '';
      if (stockWhere) whereClause = whereClause ? whereClause + stockWhere : ' WHERE' + stockWhere.substring(4);
      statsSQL += whereClause + ' GROUP BY NAME';

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
        var timeRangeSQL = 'SELECT MIN(TIME), MAX(TIME) FROM ' + tableName + (timeWhereBase || '');
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

              // 템플릿별 계산 결과 요약 (LLM이 이 수치를 보고 분석 작성)
              var computedSummary = '';
              if (templateID === 'R-3' && params.DRIVING_DATA_JSON) {
                try {
                  var dd = JSON.parse(params.DRIVING_DATA_JSON);
                  computedSummary += '\n=== 차트/점수 계산 결과 (리포트에 이미 반영됨, 이 수치 기반으로 분석하세요) ===\n';
                  computedSummary += '안전 점수: ' + (dd.safety_score || 0).toFixed(1) + ' / 100\n';
                  var ev = dd.events || {};
                  var sm = dd.summary || {};
                  computedSummary += '총 이벤트: ' + (sm.total_events || 0) + '건 (전체 샘플 ' + (sm.total_samples || 0) + '건 중)\n';
                  computedSummary += '  - 급가속/급제동(ACCEL): ' + ((ev.accel || []).length) + '건 (' + ((sm.accel_pct || 0).toFixed(1)) + '%)\n';
                  computedSummary += '  - 급정거(BRAKE): ' + ((ev.brake || []).length) + '건 (' + ((sm.brake_pct || 0).toFixed(1)) + '%)\n';
                  computedSummary += '  - 급회전(TURN): ' + ((ev.turn || []).length) + '건 (' + ((sm.turn_pct || 0).toFixed(1)) + '%)\n';
                  var th = dd.thresholds || {};
                  if (th.accel) computedSummary += '이벤트 감지 임계값: AccX ±' + (th.accel || 0).toFixed(3) + 'g, AccY ±' + (th.brake || 0).toFixed(3) + 'g, GyroZ ±' + (th.turn || 0).toFixed(3) + 'rad/s\n';
                  var pt = dd.per_tag || {};
                  var ptKeys = Object.keys(pt);
                  if (ptKeys.length > 0) {
                    computedSummary += '태그별 롤업 추이 데이터 포인트: ';
                    ptKeys.forEach(function(k) { computedSummary += k + '=' + ((pt[k].rollup || {}).times || []).length + '건 '; });
                    computedSummary += '\n';
                  }
                } catch (e) {}
              } else if (templateID === 'R-2' && params.PER_TAG_DATA_JSON) {
                try {
                  var vd = JSON.parse(params.PER_TAG_DATA_JSON);
                  computedSummary += '\n=== 차트/분석 계산 결과 (리포트에 이미 반영됨, 이 수치 기반으로 분석하세요) ===\n';
                  var vKeys = Object.keys(vd);
                  vKeys.forEach(function(k) {
                    var tag = vd[k];
                    computedSummary += '\n[' + k + ']\n';
                    if (tag.stats) {
                      computedSummary += '  전체 통계: RMS=' + (tag.stats.rms || 0).toFixed(4) + ', P2P=' + (tag.stats.p2p || 0).toFixed(4) + ', Crest=' + (tag.stats.crest || 0).toFixed(2) + ', MIN=' + (tag.stats.min || 0).toFixed(4) + ', MAX=' + (tag.stats.max || 0).toFixed(4) + '\n';
                    }
                    // Rollup trend analysis: detect spikes/anomalies
                    var rollup = tag.rollup || [];
                    if (rollup.length > 0) {
                      var rmsVals = rollup.map(function(r) { return r.rms || 0; });
                      var rmsMin = Math.min.apply(null, rmsVals);
                      var rmsMax = Math.max.apply(null, rmsVals);
                      var rmsAvg = rmsVals.reduce(function(a, b) { return a + b; }, 0) / rmsVals.length;
                      computedSummary += '  RMS 추이(' + rollup.length + '포인트): 최소=' + rmsMin.toFixed(4) + ', 최대=' + rmsMax.toFixed(4) + ', 평균=' + rmsAvg.toFixed(4) + '\n';
                      // Detect spike: if max > avg * 3
                      if (rmsMax > rmsAvg * 3 && rmsAvg > 0) {
                        // Find spike location
                        var spikeIdx = rmsVals.indexOf(rmsMax);
                        var spikeTime = rollup[spikeIdx] ? rollup[spikeIdx].t : '?';
                        var spikeRatio = (rmsMax / rmsAvg).toFixed(1);
                        computedSummary += '  ★ RMS 급등 감지! ' + spikeTime + ' 시점에서 ' + rmsMax.toFixed(4) + ' (평균 대비 ' + spikeRatio + '배). 이 급등 원인을 반드시 분석하세요.\n';
                      }
                      // Detect trend: compare first 20% vs last 20%
                      var seg = Math.max(1, Math.floor(rmsVals.length * 0.2));
                      var earlyAvg = rmsVals.slice(0, seg).reduce(function(a, b) { return a + b; }, 0) / seg;
                      var lateAvg = rmsVals.slice(-seg).reduce(function(a, b) { return a + b; }, 0) / seg;
                      if (earlyAvg > 0) {
                        var trendRatio = lateAvg / earlyAvg;
                        if (trendRatio > 1.5) {
                          computedSummary += '  ★ RMS 상승 추세! 초반 평균 ' + earlyAvg.toFixed(4) + ' → 후반 평균 ' + lateAvg.toFixed(4) + ' (' + trendRatio.toFixed(1) + '배 증가). 진동 악화 가능성을 분석하세요.\n';
                        } else if (trendRatio < 0.5) {
                          computedSummary += '  RMS 하락 추세: 초반 ' + earlyAvg.toFixed(4) + ' → 후반 ' + lateAvg.toFixed(4) + ' (감소)\n';
                        } else {
                          computedSummary += '  RMS 추세: 안정적 (초반 ' + earlyAvg.toFixed(4) + ' → 후반 ' + lateAvg.toFixed(4) + ')\n';
                        }
                      }
                      // P2P spike
                      var p2pVals = rollup.map(function(r) { return r.p2p || 0; });
                      var p2pMax = Math.max.apply(null, p2pVals);
                      var p2pAvg = p2pVals.reduce(function(a, b) { return a + b; }, 0) / p2pVals.length;
                      if (p2pMax > p2pAvg * 3 && p2pAvg > 0) {
                        var p2pSpikeIdx = p2pVals.indexOf(p2pMax);
                        var p2pSpikeTime = rollup[p2pSpikeIdx] ? rollup[p2pSpikeIdx].t : '?';
                        computedSummary += '  ★ P2P 급등 감지! ' + p2pSpikeTime + ' 시점에서 ' + p2pMax.toFixed(4) + ' (평균 대비 ' + (p2pMax / p2pAvg).toFixed(1) + '배)\n';
                      }
                    }
                    if (tag.fft) computedSummary += '  FFT: ' + (tag.fft.freqs || []).length + '개 주파수 대역, 샘플레이트=' + (tag.fft.sampleRate || 0).toFixed(1) + 'Hz\n';
                  });
                } catch (e) {}
              } else if (templateID === 'R-1') {
                computedSummary += '\n=== 차트 데이터 기반 분석 요약 (리포트에 이미 반영됨, 이 수치 기반으로 분석하세요) ===\n';
                computedSummary += '종목명: ' + (params.STOCK_NAME || tableName) + '\n';
                if (params._FINANCE_SUMMARY) {
                  computedSummary += params._FINANCE_SUMMARY + '\n';
                }
              }
              summary += computedSummary;

              // 템플릿별 분석 방향 지침
              var domainGuide = '';
              if (templateID === 'R-3') {
                var safetyScore = 0;
                try { safetyScore = JSON.parse(params.DRIVING_DATA_JSON).safety_score || 0; } catch(e) {}
                var toneGuide = '';
                if (safetyScore >= 90) {
                  toneGuide = '  ★★ 안전 점수 ' + safetyScore.toFixed(1) + '점 = 매우 우수. 전체 톤을 긍정적/칭찬 위주로 작성하세요.\n' +
                    '  - "위험", "긴급", "즉시 교육" 등 과도한 경고 표현 금지\n' +
                    '  - 잘하고 있는 점을 먼저 언급하고, 소폭 개선 가능한 부분만 부드럽게 제안\n' +
                    '  - recommendations도 "유지 방법", "더 나은 습관", "참고 사항" 수준으로 작성\n';
                } else if (safetyScore >= 70) {
                  toneGuide = '  ★★ 안전 점수 ' + safetyScore.toFixed(1) + '�� = 양호. 균형 잡힌 톤으로 작성하세요.\n' +
                    '  - 잘하는 부분 인정 + 개선 필요 부분 구체적 제안\n';
                } else if (safetyScore >= 40) {
                  toneGuide = '  ★★ 안전 점수 ' + safetyScore.toFixed(1) + '점 = 주의 필요. 개선 방향 중심으로 작성하세요.\n';
                } else {
                  toneGuide = '  ★★ 안전 점수 ' + safetyScore.toFixed(1) + '점 = 위험. 심각한 문제점과 즉시 개선 필요사항 중심으로 작성하세요.\n';
                }
                domainGuide = '\n★ 분석 관점: 위 안전 점수와 이벤트 수치를 반드시 참조하여 운전 습관/행동 패턴 중심으로 해석하세요.\n' +
                  toneGuide +
                  '  - AccX/Y/Z → 가속/제동/코너링 습관 (급가속, 급제동, 급회전 빈도와 강도)\n' +
                  '  - GyroX/Y/Z → 차량 안정성 (롤링, 피칭, 요잉 패턴)\n' +
                  '  - Class → 운전 등급 변화 구간과 원인 추정\n' +
                  '  - recommendations는 실제 운전자가 바로 실천할 수 있는 운전 개선 팁으로 작성\n';
              } else if (templateID === 'R-2') {
                // 진동 심각도 판단: 최대 RMS 기준
                var maxRMS = 0;
                try {
                  var vdTone = JSON.parse(params.PER_TAG_DATA_JSON);
                  Object.keys(vdTone).forEach(function(k) {
                    var rms = (vdTone[k].stats || {}).rms || 0;
                    if (rms > maxRMS) maxRMS = rms;
                  });
                } catch(e) {}
                var vibTone = '';
                if (maxRMS < 1.8) {
                  vibTone = '  ★★ 최대 RMS ' + maxRMS.toFixed(3) + ' = ISO 10816 기준 양호(Zone A/B). 설비 상태 긍정 평가 위주로 작성하세요.\n' +
                    '  - "즉시 교체", "긴급 정지" 등 과도한 경고 금지. 예방적 관리/모니터링 유지 방향으로 작성\n';
                } else if (maxRMS < 4.5) {
                  vibTone = '  ★★ 최대 RMS ' + maxRMS.toFixed(3) + ' = ISO 10816 기준 주의(Zone C). 균형 잡힌 톤으로 작성하세요.\n' +
                    '  - 현재 운전 가능하나 점검 계획 수립 필요\n';
                } else {
                  vibTone = '  ★★ 최대 RMS ' + maxRMS.toFixed(3) + ' = ISO 10816 기준 위험(Zone D). 즉시 조치 필요사항 중심으로 작성하세요.\n';
                }
                domainGuide = '\n★ 분석 관점: 위 RMS/Peak/Crest Factor 수치를 반드시 참조하여 설비 상태 해석하세요.\n' +
                  vibTone +
                  '  - Crest Factor로 충격성 진동 여부 판단 (3 이하=정상, 3~6=주의, 6 이상=충격성)\n' +
                  '  - FFT 주파수 대역에서 특이 피크 → 베어링/기어/불균형 등 고장 모드 추정\n' +
                  '  - 롤업 추이에서 시간에 따른 악화/안정 판단\n' +
                  '  - recommendations는 설비 관리자가 취해야 할 점검/교체/모니터링 조치로 작성\n';
              } else if (templateID === 'R-1') {
                // 금융 변동률 기반 톤
                var changePct = 0;
                try {
                  var fdTone = JSON.parse(params.TREND_DATA_JSON);
                  if (fdTone.length >= 2) {
                    var fFirst = fdTone[0], fLast = fdTone[fdTone.length - 1];
                    if (fFirst.close && fLast.close) changePct = (fLast.close - fFirst.close) / fFirst.close * 100;
                  }
                } catch(e) {}
                var finTone = '';
                if (changePct > 10) {
                  finTone = '  ★★ 기간 수익률 +' + changePct.toFixed(1) + '% = 강세. 상승 요인 분석과 지속 가능성 평가 중심으로 작성하세요.\n' +
                    '  - 과열 여부/조정 가능성도 언급\n';
                } else if (changePct > 0) {
                  finTone = '  ★★ 기간 수익률 +' + changePct.toFixed(1) + '% = 완만한 상승. 균형 잡힌 톤으로 작성하세요.\n';
                } else if (changePct > -10) {
                  finTone = '  ★★ 기간 수익률 ' + changePct.toFixed(1) + '% = 완만한 하락. 하락 원인과 반등 가능성 중심으로 작성하세요.\n';
                } else {
                  finTone = '  ★★ 기간 수익률 ' + changePct.toFixed(1) + '% = 급락. 리스크 요인과 방어 전략 중심으로 작성하세요.\n';
                }
                domainGuide = '\n★ 분석 관점: 위 기간 변동률과 거래량을 반드시 참조하여 시장 동향 해석하세요.\n' +
                  finTone +
                  '  - 가격 추세 (상승/하락/횡보) 판단\n' +
                  '  - 거래량 변화와 가격 움직임의 상관관계\n' +
                  '  - recommendations는 투자 판단에 참고할 수 있는 시장 전망과 전략으로 작성\n';
              }
              var msg = '데이터를 조회했습니다. 아래 통계와 계산 결과를 기반으로 analysis와 recommendations를 작성하여 다시 호출하세요.\n' +
                '★ analysis: 최소 5개 ## 섹션, 각 2~3문단. 마크다운 필수.\n' +
                '★ recommendations: 7개 이상 번호 항목. 즉시/단기/중장기로 우선순위 구��. �� 항목에 근거 수치+실행방안+기대효과.\n' +
                domainGuide + '\n' + summary;
              return cb(null, msg);
            }

            saveToFile(mc, templateID, params, filename, cb);
          }

          if (templateID === 'R-3') {
            console.println('  [report] Fetching R-3 driving data for ' + tags.length + ' tags...');
            fetchDrivingData(mc, tableName, tags, rollupUnit, timeWhere, function (dErr, dData) {
              if (dData) params.DRIVING_DATA_JSON = JSON.stringify(dData);
              else params.DRIVING_DATA_JSON = '{"per_tag":{},"events":{"accel":[],"brake":[],"turn":[]},"safety_score":0,"summary":{},"thresholds":{}}';
              afterTemplateData();
            });
          } else if (templateID === 'R-2') {
            console.println('  [report] Fetching R-2 vibration data for ' + tags.length + ' tags...');
            fetchVibrationData(mc, tableName, tags, rollupUnit, timeWhere, function (vErr, vData) {
              if (vData) params.PER_TAG_DATA_JSON = JSON.stringify(vData);
              else params.PER_TAG_DATA_JSON = '{}';
              afterTemplateData();
            });
          } else if (templateID === 'R-1') {
            console.println('  [report] Fetching R-1 finance data...');
            params.STOCK_NAME = stock || tableName;
            fetchFinanceData(mc, tableName, tags, stock, rollupUnit, timeWhere, function (fErr, fData) {
              if (fData) {
                params.TREND_DATA_JSON = JSON.stringify(fData.trend || []);
                if (fData.stockName) params.STOCK_NAME = fData.stockName;
                if (fData.financeSummary) params._FINANCE_SUMMARY = fData.financeSummary;
              } else {
                params.TREND_DATA_JSON = '[]';
              }
              afterTemplateData();
            });
          } else {
            afterTemplateData();
          }
        });
      });
    }

    if (tags.length === 0) {
      // Fallback tag query
      mc.querySQL('SELECT NAME FROM ' + tableName + (timeWhereBase || '') + ' GROUP BY NAME', '', '', '', function (err1b, tagCSV2) {
        tags = parseTagList(err1b ? '' : tagCSV2);
        afterTags(tags);
      });
    } else {
      afterTags(tags);
    }
  });
  } // end doStep1

  checkTimeRangeAndProceed();
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
function fetchDrivingData(mc, tableName, tags, rollupUnit, timeWhere, cb) {
  var perTag = {};
  var tagIdx = 0;

  // Step 1: Fetch rollup + raw waveform per tag (same as Go: 4096 for raw)
  function fetchNextTag() {
    if (tagIdx >= tags.length) return fetchThresholds();
    var tag = tags[tagIdx++];

    var rollupSQL = "SELECT ROLLUP('" + rollupUnit + "', 1, TIME) as t, AVG(VALUE) as v FROM " + tableName +
      " WHERE NAME='" + tag + "'" + (timeWhere || '') +
      " GROUP BY ROLLUP('" + rollupUnit + "', 1, TIME) ORDER BY t";
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
      var rawSQL = "SELECT TIME, VALUE FROM " + tableName + " WHERE NAME='" + tag + "'" + (timeWhere || '') + " ORDER BY TIME LIMIT 4096";
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

    var statSQL = "SELECT ROUND(AVG(VALUE),6), ROUND(STDDEV(VALUE),6) FROM " + tableName + " WHERE NAME='" + actualTag + "'" + (timeWhere || '');
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
    var eventSQL = "SELECT TIME, VALUE FROM " + tableName + " WHERE NAME='" + actualTag + "'" + (timeWhere || '') + " ORDER BY TIME LIMIT 50000";
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

    var cntSQL = "SELECT COUNT(*) FROM " + tableName + " WHERE NAME='" + actualTag + "'" + (timeWhere || '');
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
function fetchVibrationData(mc, tableName, tags, rollupUnit, timeWhere, cb) {
  var perTag = {};
  var tagIdx = 0;

  function fetchNextTag() {
    if (tagIdx >= tags.length) return enrichStats();
    var tag = tags[tagIdx++];

    var rawSQL = "SELECT TIME, VALUE FROM " + tableName + " WHERE NAME='" + tag + "'" + (timeWhere || '') + " ORDER BY TIME LIMIT 4096";
    mc.querySQL(rawSQL, 'ms', '', '', function (err, rawJSON) {
      var raw = parseRawCSV(rawJSON);

      // ROLLUP with AVG, MIN, MAX, SUMSQ, COUNT (same column order as Go)
      var rollupSQL = "SELECT ROLLUP('" + rollupUnit + "', 1, TIME) as t, ROUND(AVG(VALUE),6) as avg_val, " +
        "ROUND(MIN(VALUE),6) as min_val, ROUND(MAX(VALUE),6) as max_val, " +
        "SUMSQ(VALUE) as sumsq, COUNT(VALUE) as cnt FROM " + tableName +
        " WHERE NAME='" + tag + "'" + (timeWhere || '') +
        " GROUP BY ROLLUP('" + rollupUnit + "', 1, TIME) ORDER BY ROLLUP('" + rollupUnit + "', 1, TIME)";
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
        var fftSQL = "SELECT TIME, VALUE FROM " + tableName + " WHERE NAME='" + tag + "'" + (timeWhere || '') + " ORDER BY TIME LIMIT 131072";
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
function fetchFinanceData(mc, tableName, tags, stock, rollupUnit, timeWhere, cb) {
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

    var sql = "SELECT ROLLUP('" + rollupUnit + "', 1, TIME) as t, ROUND(AVG(VALUE)," + decimals + ") as v FROM " + tableName +
      " WHERE NAME='" + tag + "'" + (timeWhere || '') +
      " GROUP BY ROLLUP('" + rollupUnit + "', 1, TIME) ORDER BY ROLLUP('" + rollupUnit + "', 1, TIME)";
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

function detectVibrationTags(tags) {
  var vibKeywords = ['vib', 'vibration', 'bearing', 'sensor', 'accel', 'velocity', 'displacement'];
  for (var i = 0; i < tags.length; i++) {
    var lower = tags[i].toLowerCase();
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
function findOHLCVTags(tags, stock) { var result = {}; var fields = ['open', 'high', 'low', 'close', 'volume']; if (stock) { var prefix = stock.toUpperCase() + '_'; tags.forEach(function (t) { var upper = t.toUpperCase(); if (upper.indexOf(prefix) !== 0) return; var suffix = t.substring(prefix.length).toLowerCase(); if (fields.indexOf(suffix) >= 0) result[suffix] = t; }); } else { var lower = {}; tags.forEach(function (t) { lower[t.toLowerCase()] = t; }); fields.forEach(function (f) { if (lower[f]) result[f] = lower[f]; }); } return result; }
function extractStockPrefix(tagVal) { var c = tagVal.split(',')[0].trim(); ['_close', '_open', '_high', '_low', '_volume', '_adj_close'].forEach(function (s) { var idx = c.toLowerCase().indexOf(s); if (idx > 0) c = c.substring(0, idx); }); return c.toUpperCase(); }
function calcTotalCount(csvData) { var total = 0; try { var p = JSON.parse(csvData); if (p && p.data && p.data.rows) p.data.rows.forEach(function (r) { if (r.length >= 2) total += parseInt(r[1], 10) || 0; }); } catch (e) {} return total; }
function mdToHTML(text) {
  if (!text) return '';
  function inlineFmt(s) {
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/`(.+?)`/g, '<code style="background:#edf2f7;padding:2px 6px;border-radius:4px;font-size:13px;">$1</code>');
    return s;
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
    if (/^####\s+/.test(trimmed)) { closeUL(); result.push('<h4 style="font-size:14px;font-weight:700;color:#2d3748;margin:18px 0 8px;">' + inlineFmt(trimmed.replace(/^####\s+/, '')) + '</h4>'); continue; }
    if (/^###\s+/.test(trimmed)) { closeUL(); result.push('<h3 style="font-size:15px;font-weight:700;color:#1a365d;margin:20px 0 10px;">' + inlineFmt(trimmed.replace(/^###\s+/, '')) + '</h3>'); continue; }
    if (/^##\s+/.test(trimmed)) { closeUL(); result.push('<h2 style="font-size:17px;font-weight:700;color:#1a365d;margin:24px 0 12px;border-bottom:2px solid #e2e8f0;padding-bottom:6px;">' + inlineFmt(trimmed.replace(/^##\s+/, '')) + '</h2>'); continue; }

    // Ordered list: "1. text" → 번호 직접 보존, div 들여쓰기
    var olMatch = trimmed.match(/^(\d+)[.)]\s+(.*)/);
    if (olMatch) {
      closeUL();
      result.push('<div style="margin:10px 0 6px 8px;"><span style="font-weight:700;color:#2b6cb0;margin-right:8px;">' + olMatch[1] + '.</span>' + inlineFmt(olMatch[2]) + '</div>');
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

    // Normal paragraph
    closeUL();
    result.push('<p style="margin-bottom:12px;line-height:1.7;">' + inlineFmt(trimmed) + '</p>');
  }
  closeUL();
  return result.join('\n');
}

module.exports = { register };
