var { argStr } = require('./registry');
var { detectColumns, detectTags } = require('./tql_spec');
var rangeCache = require('./range_cache');
var path = require('path');

var GRID_COLS = 36;
var CHART_W_LARGE = 17;
var CHART_W_SMALL = 7;
var CHART_H_DEFAULT = 7;
var LARGE_TYPES = { Line: true, Bar: true, Scatter: true, 'Tql chart': true, Video: true };
var COLORS = ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc', '#FADE2A'];

function chartWidth(type) { return LARGE_TYPES[type] ? CHART_W_LARGE : CHART_W_SMALL; }
function generateID() { return String(Date.now() * 1000 + Math.floor(Math.random() * 1000)); }
function generatePanelID() {
  var h = '0123456789abcdef', s = '';
  for (var i = 0; i < 32; i++) s += h[Math.floor(Math.random() * 16)];
  return s.substr(0,8)+'-'+s.substr(8,4)+'-4'+s.substr(13,3)+'-'+h[8+Math.floor(Math.random()*4)]+s.substr(17,3)+'-'+s.substr(20,12);
}

function getChartTypeDefaults(chartType) {
  switch (chartType) {
    case 'Line': return { areaStyle: false, smooth: false, isStep: false, isStack: false, connectNulls: true, isSymbol: false, symbol: 'circle', symbolSize: 4, isSampling: false, fillOpacity: 0.3, tagLimit: 12, markLine: { symbol: ['none','none'], label: { show: false }, data: [] }, visualMap: { type: 'piecewise', show: false, dimension: 0, seriesIndex: 0, pieces: [] } };
    case 'Bar': return { isStack: false, isLarge: false, isPolar: false, polarRadius: 30, polarSize: 80, startAngle: 90, maxValue: 100, tagLimit: 12, polarAxis: 'time' };
    case 'Scatter': return { isLarge: false, symbol: 'circle', symbolSize: 4, tagLimit: 12 };
    case 'Pie': return { doughnutRatio: 50, roseType: false, tagLimit: 12, labelShow: true, labelPosition: 'outside' };
    case 'Gauge': return { isAxisTick: true, axisLabelDistance: 25, valueFontSize: 15, valueAnimation: false, alignCenter: 30, isAnchor: true, anchorSize: 25, min: 0, max: 100, tagLimit: 1, digit: 0, axisLineStyleWidth: 10, isAxisLineStyleColor: false, axisLineStyleColor: [[0.5,'#c2c2c2'],[1,'#F44E3B']] };
    case 'Liquidfill': return { tagLimit: 1 };
    case 'Tql chart': return { theme: 'white' };
    case 'Text': return {};
    case 'Geomap': return {};
    case 'advScatter': return { isLarge: false, symbol: 'circle', symbolSize: 4, tagLimit: 12 };
    case 'Video': return {};
    default: return getChartTypeDefaults('Line');
  }
}

function makeBlock(table, tag, column, color, userName, aggregator, nameCol, timeCol) {
  if (!column) column = 'VALUE';
  if (!color) color = '#5470c6';
  if (!userName) userName = '';
  if (!aggregator) aggregator = 'avg';
  if (!nameCol) nameCol = 'NAME';
  if (!timeCol) timeCol = 'TIME';
  return {
    id: generatePanelID(), table: table, userName: userName, color: color, type: 'tag',
    filter: [{ id: generatePanelID(), column: nameCol, operator: 'in', value: tag, useFilter: true, useTyping: false, typingValue: nameCol + ' in ("' + tag + '")' }],
    values: [{ id: generatePanelID(), alias: '', value: column, jsonKey: '', aggregator: aggregator }],
    useRollup: false, name: nameCol, time: timeCol, useCustom: false, aggregator: aggregator,
    diff: 'none', tag: tag, value: column, jsonKey: '', alias: '', math: '', isValidMath: true,
    duration: { from: '', to: '' }, customFullTyping: { use: false, text: '' }, isVisible: true, tableInfo: [],
  };
}

// Neo board 뷰어(eI: $un.filter(key===type)[0].value)가 인식하는 유효 패널 타입.
// 이 집합 밖의 type이 .dsh에 들어가면 뷰어 파서가 TypeError로 죽어 "404 not found file name"이 뜬다.
// ($un의 'Adv scatter'/'Liquid fill'은 코드의 advScatter/Liquidfill과 표기가 달라 잠재 크래시 → 화이트리스트에서 제외해 Line으로 폴백)
var VALID_TYPES = { Line: 1, Bar: 1, Scatter: 1, Gauge: 1, Pie: 1, 'Tql chart': 1, Text: 1, Geomap: 1, Video: 1 };

// 입력 타입 → 유효 타입 매핑. spec-kind/임시명(line_multi, bar_multi 등)도 흡수. 매핑 불가면 입력 그대로(검증은 호출측).
function mapChartType(t) {
  if (!t) return 'Line';
  var map = {
    'line': 'Line', 'bar': 'Bar', 'scatter': 'Scatter', 'pie': 'Pie', 'gauge': 'Gauge',
    'tql chart': 'Tql chart', 'text': 'Text', 'geomap': 'Geomap', 'video': 'Video',
    // spec-kind / 임시명 별칭 → 유효 타입
    'line_single': 'Line', 'line_multi': 'Line', 'line_multi2': 'Line',
    'bar_single': 'Bar', 'bar_multi': 'Bar',
    'scatter_single': 'Scatter', 'scatter_multi': 'Scatter',
  };
  return map[String(t).toLowerCase()] || t;
}

// 생성 단계 가드: 유효(또는 별칭 흡수 가능)면 {type}, 아니면 {error}(모델이 보고 스스로 교정).
// candlestick/ohlc는 inline 렌더 불가 → tql_path(또는 기본분석은 Line)로 유도.
function validateChartType(t) {
  var k = String(t || '').toLowerCase();
  if (k === 'ohlc' || k === 'candlestick') {
    return { error: 'chart type "' + t + '"는 inline tag로 렌더되지 않습니다. 캔들차트는 compile_tql_from_spec(kind="ohlc")로 만들어 tql_path로 넣으세요. (기본 분석이면 type="Line", tag="open,high,low,close")' };
  }
  var out = mapChartType(t);
  if (VALID_TYPES[out]) return { type: out };
  return { error: 'invalid chart type "' + t + '". 사용 가능한 타입: ' + Object.keys(VALID_TYPES).join(', ') };
}

// 패널 빌드용: 어떤 입력이 와도 절대 크래시 안 나는 유효 타입 보장(최후 폴백 Line).
function normalizeChartType(t) {
  var out = mapChartType(t);
  if (!VALID_TYPES[out]) {
    console.println('[dashboard] invalid chart type "' + t + '" → fallback Line');
    out = 'Line';
  }
  return out;
}

function makeChartPanel(title, chartType, table, tag, column, color, tqlPath, x, y, w, h, nameCol, timeCol) {
  chartType = normalizeChartType(chartType);
  if (tqlPath) chartType = 'Tql chart';
  // tql_path 차트에 제목이 없으면 파일명에서 유도(모델이 title 빠뜨려도 "New chart" 대신 의미있는 제목). 예: SILVER/Silver_Volume.tql → "Silver Volume"
  if (tqlPath && (!title || title === '')) {
    var bn = String(tqlPath).replace(/^.*\//, '').replace(/\.tql$/i, '').replace(/_/g, ' ').trim();
    if (bn) title = bn;
  }
  if (!w || w <= 0) w = chartWidth(chartType);
  if (!h || h <= 0) h = CHART_H_DEFAULT;

  var agg = 'avg';
  if (chartType === 'Pie') agg = 'count';
  else if (chartType === 'Gauge' || chartType === 'Liquidfill') agg = 'last';

  var panel = {
    id: generatePanelID(), title: title || 'New chart', titleColor: '', type: chartType,
    x: x, y: y, w: w, h: h, theme: 'white', useCustomTime: false, isAxisInterval: false,
    timeRange: { start: null, end: null, refresh: 'Off' },
    blockList: [], transformBlockList: [],
    tqlInfo: null,
    chartOptions: getChartTypeDefaults(chartType),
    commonOptions: {
      isLegend: true, legendTop: 'bottom', legendLeft: 'center', legendOrient: 'horizontal',
      isTooltip: true, tooltipTrigger: 'axis', tooltipBgColor: '#FFFFFF', tooltipTxtColor: '#333',
      tooltipDecimals: 3, tooltipUnit: '', isInsideTitle: true, isDataZoom: false, title: title || 'New chart',
      gridTop: 50, gridBottom: 50, gridLeft: 35, gridRight: 35,
    },
    xAxisOptions: [{
      type: 'time', axisTick: { alignWithLabel: true }, axisLabel: { hideOverlap: true },
      axisLine: { onZero: false }, scale: true, useMinMax: false, min: null, max: null, useBlockList: [0],
      label: { name: 'value', key: 'value', title: '', unit: '', decimals: null, squared: 0 },
    }],
    yAxisOptions: [{
      type: 'value', position: 'left', offset: '', alignTicks: true, scale: true, useMinMax: false,
      min: null, max: null, axisLine: { onZero: false }, thresholds: [],
      label: { name: 'value', key: 'value', title: '', unit: '', decimals: null, squared: 0 },
    }],
    axisInterval: { IntervalType: '', IntervalValue: '' },
    version: '1.0.1',
  };

  if (tqlPath) {
    if (tqlPath[0] !== '/') tqlPath = '/' + tqlPath;
    panel.tqlInfo = { path: tqlPath, params: [{ name: '', value: '', format: '' }], chart_id: '' };
    panel.blockList = [makeBlock('', '', 'VALUE', color, '', 'avg', nameCol, timeCol)];
  } else if (table && tag) {
    var tags = tag.split(',');
    var blocks = [];
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i].trim();
      if (!t) continue;
      var c = tags.length > 1 ? COLORS[i % COLORS.length] : (color || COLORS[0]);
      blocks.push(makeBlock(table, t, column, c, null, agg, nameCol, timeCol));
    }
    panel.blockList = blocks;
  }

  return panel;
}

function buildDSHFile(filename, title, timeStart, timeEnd, panels, refresh) {
  var name = path.basename(filename);
  var dir = path.dirname(filename);
  if (dir === '.') dir = '/';
  else dir = '/' + dir + '/';

  // auto-refresh가 켜진 대시보드는 end time을 live('now')로 — 고정 timestamp면 새로고침해도 같은 창만 보여 의미 없음.
  // ('now'는 Neo가 매 갱신마다 현재 시각으로 평가; parseTimeValue를 거치지 않고 문자열 그대로 사용)
  var refreshVal = refresh || 'Off';
  var endVal = (refreshVal && refreshVal !== 'Off') ? 'now' : parseTimeValue(timeEnd);

  var dashboardObj = {
    variables: [],
    timeRange: { start: parseTimeValue(timeStart), end: endVal, refresh: refreshVal },
    title: title, panels: panels,
  };
  // 심층(전부 TQL) 대시보드는 패널 헤더를 끔 → 각 차트가 좌상단에 제목+부제를 직접 표시(헤더에 가려지지 않음).
  // 기본(table-based) 대시보드는 헤더 유지.
  var allTql = panels && panels.length > 0 && panels.every(function (p) { return p.type === 'Tql chart'; });
  return {
    id: generateID(), type: 'dsh', name: name, path: dir, code: '',
    panels: [], range_bgn: '', range_end: '', savedCode: JSON.stringify(dashboardObj), sheet: [],
    shell: {},
    panelHeader: !allTql,
    dashboard: dashboardObj,
  };
}

function parseTimeValue(s) {
  if (!s) return '';
  var n = parseInt(s, 10);
  return isNaN(n) ? s : n;
}

// 대시보드 파일명에 작성시각 _YYYYMMDD_HHMMSS 자동 부착 (이력/파일 구분 — 모델 순응과 무관하게 코드가 보장).
// 모델이 베이스명만 줘도, 이미 타임스탬프를 붙여 줘도 항상 일관된 단일 타임스탬프가 된다.
function withTimestamp(filename) {
  // 기존/모델부착 타임스탬프 제거(중복 방지). _YYYYMMDD_HHMMSS(전체) 또는 _YYYYMMDD(날짜만, 모델이 자주 붙임) 둘 다 처리.
  var base = filename.replace(/\.dsh$/i, '').replace(/_\d{8}(_\d{6})?$/, '');
  var d = new Date();
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  var ts = '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  return base + '_' + ts + '.dsh';
}

var TYPE_MAP = { 'string': 5, 'varchar': 5, 'datetime': 6, 'double': 20, 'float': 16, 'int32': 8, 'int64': 12 };
var SIZE_MAP = { 'string': 32, 'varchar': 32, 'datetime': 8, 'double': 8, 'float': 4, 'int32': 4, 'int64': 8 };

// Fill tableInfo in each blockList entry (required for Neo dashboard viewer)
function fillTableInfo(mc, panel, cb) {
  var blockList = panel.blockList;
  if (!blockList || blockList.length === 0 || !blockList[0].table) return cb();

  var table = blockList[0].table;
  mc.querySQL('SELECT * FROM ' + table + ' LIMIT 0', '', '', '', function (err, raw) {
    if (err) return cb();
    try {
      var resp = JSON.parse(raw);
      if (!resp.data || !resp.data.columns) return cb();
      var cols = resp.data.columns;
      var types = resp.data.types || [];
      var tableInfo = [];
      for (var i = 0; i < cols.length; i++) {
        var t = types[i] || 'string';
        tableInfo.push([cols[i], TYPE_MAP[t] || 5, SIZE_MAP[t] || 32, i]);
      }
      tableInfo.push(['_RID', 12, 8, 65534]);
      for (var j = 0; j < blockList.length; j++) {
        blockList[j].tableInfo = tableInfo;
      }
    } catch (e) { /* ignore */ }
    cb();
  });
}

// Fill tableInfo for all panels sequentially
function fillAllPanels(mc, panels, idx, cb) {
  if (idx >= panels.length) return cb();
  fillTableInfo(mc, panels[idx], function () {
    fillAllPanels(mc, panels, idx + 1, cb);
  });
}

// tql_path를 참조하는 차트들의 실제 파일 존재를 검증. 없는 것은 drop하고 그 경로들을 droppedPaths로 반환.
// cb(keptCharts, droppedPaths). tql_path 없는 인라인 차트는 검증 대상이 아니므로 그대로 유지.
// (compile_tql_from_spec가 중복차단 등으로 저장 실패한 차트를 모델이 그대로 패널에 넣어 'not found' 렌더에러가
//  나던 문제를 도구 레이어에서 차단 — "안 돌아가는 TQL은 내보내지 않는다" 원칙을 대시보드 패널에도 적용.)
function validateTqlPaths(mc, charts, cb) {
  var anyTql = false;
  for (var i = 0; i < charts.length; i++) {
    if (charts[i] && charts[i].tql_path) {
      anyTql = true;
      charts[i].tql_path = String(charts[i].tql_path).replace(/^\/+/, ''); // 선행 슬래시 정규화
    }
  }
  if (!anyTql) return cb(charts, []);

  // ⚠️ mc.readFile은 **동기**다(client.js: cb가 httpDo 반환 전에 동기 호출). 따라서 비동기 fan-in 패턴
  // (루프 안에서 remaining++ 후 콜백에서 --remaining===0)을 쓰면 콜백이 매 반복마다 즉시 발화해
  // remaining이 1→0을 반복 → finish()가 **차트당 1번씩** 불린다. tql_path 차트 6개면 cb가 6번 호출되어
  // 대시보드가 6번 생성되고 상위 executeToolCalls 콜백이 6갈래로 포크 → 최종답변이 6번 방출된다.
  // 해법: 전체 pending 수(total)를 읽기 발행 **전에** 고정하고, 모두 resolve된 뒤에만 finish; + finished 가드로 단 1회 보장.
  var results = [];
  var pending = [];
  for (var j = 0; j < charts.length; j++) {
    if (!charts[j] || !charts[j].tql_path) { results[j] = true; continue; }
    results[j] = null; // pending
    pending.push(j);
  }
  var total = pending.length;
  var resolved = 0;
  var finished = false;
  for (var pj = 0; pj < pending.length; pj++) {
    (function (idx, p) {
      mc.readFile(p, function (err, data) {
        var body = String(data == null ? '' : data);
        // 존재 판정: 읽기 성공 + 본문이 not-found 에러 JSON이 아님(파일 API가 200+{success:false}로 줄 수 있음).
        // 정상 .tql 본문은 raw TQL 텍스트라 "success":false를 포함하지 않음.
        var ok = !err && body.indexOf('"success":false') < 0 && body.indexOf('"success": false') < 0;
        results[idx] = ok;
        resolved++;
        if (resolved === total) finish(); // 모든 차트가 resolve된 뒤에만(동기 콜백이어도 마지막 1번)
      });
    })(pending[pj], charts[pending[pj]].tql_path);
  }
  if (total === 0) return finish();

  function finish() {
    if (finished) return; // 동기/비동기 어느 쪽이든 cb는 정확히 1회
    finished = true;
    var kept = [], dropped = [];
    for (var k = 0; k < charts.length; k++) {
      if (results[k] === false) dropped.push(charts[k].tql_path);
      else kept.push(charts[k]);
    }
    cb(kept, dropped);
  }
}

// inline 차트(table+tag, tql_path 없음)의 tag/column 실재성 검증 — 계산식·파생지표/존재하지 않는 식별자를 도구 레벨에서 드롭.
// 기본 분석은 계산을 못 해 그런 패널이 빈 차트가 된다(예: column="high-low", "(open+close)/2", "volume_bucket").
// 프롬프트 금지는 약한 모델(ollama)이 무시하므로 validateTqlPaths와 대칭으로 결정론적 차단. 전 모델 공통(frontier엔 무해).
// cb(keptCharts, dropped[]). 실재 태그/컬럼 목록을 못 얻으면 그 검사는 통과(과잉드롭 방지).
function hasExprChars(s, withHyphen) {
  s = String(s);
  if (s.indexOf('(') >= 0 || s.indexOf(')') >= 0 || s.indexOf('+') >= 0 || s.indexOf('*') >= 0 || s.indexOf('/') >= 0) return true;
  // 컬럼명엔 하이픈이 없음 → 하이픈=계산식(high-low). 태그엔 device-0 등 흔하므로 태그 검사에선 제외.
  if (withHyphen && s.indexOf('-') >= 0) return true;
  return false;
}
function tableColumns(mc, table, cb) {
  mc.querySQL('SELECT * FROM ' + String(table).toUpperCase() + ' LIMIT 0', '', '', '', function (err, raw) {
    if (err) return cb([]);
    try { var resp = JSON.parse(raw); if (resp && resp.data && resp.data.columns) return cb(resp.data.columns); } catch (e) {}
    cb([]);
  });
}
function validateInlineCharts(mc, charts, cb) {
  function isInline(c) { return c && !c.tql_path && c.table && c.tag; }
  var anyInline = false;
  for (var i = 0; i < charts.length; i++) { if (isInline(charts[i])) { anyInline = true; break; } }
  if (!anyInline) return cb(charts, []);

  var tables = {};
  for (var k = 0; k < charts.length; k++) { if (isInline(charts[k])) tables[String(charts[k].table).toUpperCase()] = true; }
  var tblList = Object.keys(tables);
  var tagsByTable = {}, colsByTable = {};

  (function resolve(ri) {
    if (ri >= tblList.length) return finish();
    var tbl = tblList[ri];
    detectColumns(mc, tbl, function (cc) {
      detectTags(mc, tbl, (cc && cc.n) || 'NAME', function (tags) {
        tagsByTable[tbl] = (tags || []).map(function (t) { return String(t).toUpperCase(); });
        tableColumns(mc, tbl, function (cols) {
          colsByTable[tbl] = (cols || []).map(function (x) { return String(x).toUpperCase(); });
          resolve(ri + 1);
        });
      });
    });
  })(0);

  // 동일 차트 시그니처: 테이블|정렬태그|컬럼|타입. 제목만 다르고 데이터·표현이 같으면 동일.
  function chartSig(c) {
    var tg = String(c.tag).split(',').map(function (t) { return t.trim().toUpperCase(); }).filter(Boolean).sort().join(',');
    return String(c.table).toUpperCase() + '|' + tg + '|' + String(c.column || '').toUpperCase() + '|' + String(c.type || 'Line').toUpperCase();
  }
  function finish() {
    var kept = [], dropped = [], seen = {};
    for (var i = 0; i < charts.length; i++) {
      var c = charts[i];
      if (!isInline(c)) { kept.push(c); continue; } // tql_path/비-inline은 그대로(별도 검증)
      var tbl = String(c.table).toUpperCase();
      var realTags = tagsByTable[tbl] || [], realCols = colsByTable[tbl] || [];
      var bad = '';
      // 타입 화이트리스트: 기본 분석 inline 차트는 데이터 차트(Line/Bar/Scatter)만. Text/Gauge/Pie/Geomap/Video 등은
      // 태그 데이터를 제대로 못 그리거나(Text=정적텍스트) 기본 모드에 부적절 → 드롭. 블랙리스트보다 견고(새 타입도 자동 차단).
      var ctype = mapChartType(c.type); // 별칭/대소문자 정규화(line→Line, line_multi→Line 등)
      if (ctype !== 'Line' && ctype !== 'Bar' && ctype !== 'Scatter') {
        bad = 'type="' + (c.type || '') + '"(기본 분석은 Line/Bar/Scatter만 — Text/Gauge/Pie 등은 데이터 차트 아님)';
      }
      if (!bad && c.column) {
        if (hasExprChars(c.column, true)) bad = 'column="' + c.column + '"(계산식)';
        else if (realCols.length && realCols.indexOf(String(c.column).toUpperCase()) < 0) bad = 'column="' + c.column + '"(없는 컬럼)';
      }
      if (!bad) {
        var parts = String(c.tag).split(',');
        for (var p = 0; p < parts.length; p++) {
          var tg = parts[p].trim();
          if (!tg) continue;
          if (hasExprChars(tg, false)) { bad = 'tag="' + tg + '"(계산식)'; break; }
          if (realTags.length && realTags.indexOf(tg.toUpperCase()) < 0) { bad = 'tag="' + tg + '"(없는 태그)'; break; }
        }
      }
      if (bad) { dropped.push((c.title || '(무제)') + ' — ' + bad); continue; }
      // 중복제거: (테이블|정렬태그|컬럼|타입)이 같으면 제목만 다른 동일 차트 → 뒤엣것 드롭.
      // 기본 모드는 계산을 못 해 "추이/분포/평균"이 같은 원시 차트로 붕괴 → 같은 그래프 여러 개 방지.
      var sig = chartSig(c);
      if (seen[sig]) { dropped.push((c.title || '(무제)') + ' — 중복(동일 차트)'); continue; }
      seen[sig] = true;
      kept.push(c);
    }
    cb(kept, dropped);
  }
}

function register(registry, mc) {
  registry.register({
    name: 'create_dashboard_with_charts',
    description: 'Create a dashboard with multiple charts in one call.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Dashboard path (e.g., "GOLD/Gold_Dashboard.dsh")' },
        title: { type: 'string', description: 'Dashboard title' },
        time_start: { type: 'string', description: 'Start time (epoch ms as string)' },
        time_end: { type: 'string', description: 'End time (epoch ms as string)' },
        refresh: { type: 'string', description: 'Auto-refresh interval. Options: "Off", "3 seconds", "5 seconds", "10 seconds", "30 seconds", "1 minute", "5 minutes", "10 minutes", "1 hour". Default: "Off"' },
        charts: { type: 'string', description: 'JSON array of chart objects. PREFERRED: charts compiled via compile_tql_from_spec → reference each by [{title, tql_path}] (e.g. {"title":"Silver OHLC","tql_path":"SILVER/Silver_Candlestick.tql"}). ALWAYS include a title. Candlestick/OHLC and any compiled chart MUST use tql_path (do NOT rebuild as inline tag — an inline OHLC panel will not render). Only for simple ad-hoc charts without a compiled .tql, use inline {title, type, table, tag}: tag = single tag or comma-separated for a multi-line comparison. column/name_column/time_column (SUMMARIZED/PRIMARY KEY/BASETIME) are auto-detected from the table metadata — omit them unless you need to override.' },
      },
      required: ['filename', 'title', 'charts'],
    },
    fn: function (args, cb) {
      var filename = argStr(args, 'filename', '');
      var title = argStr(args, 'title', 'Dashboard');
      var timeStart = argStr(args, 'time_start', '');
      var timeEnd = argStr(args, 'time_end', '');
      var refresh = argStr(args, 'refresh', 'Off');
      var chartsStr = argStr(args, 'charts', '[]');
      if (!filename) return cb(null, 'Error: filename is required');
      if (!filename.toLowerCase().endsWith('.dsh')) filename += '.dsh';
      filename = withTimestamp(filename); // 작성시각 자동 부착(이력/구분). 이후 tableName추론/폴더/쓰기/URL 모두 이 이름 사용.

      var charts;
      try { charts = JSON.parse(chartsStr); } catch (e) { return cb(null, 'Error: Invalid charts JSON: ' + e.message); }
      if (!Array.isArray(charts) || charts.length === 0) return cb(null, 'Error: charts must be a non-empty array');

      // 차트 타입 가드: inline 차트의 유효하지 않은 type을 미리 거부(모델이 메시지 보고 교정 → 깨진 .dsh 방지).
      // tql_path 차트는 makeChartPanel에서 'Tql chart'로 강제되므로 검증 제외. type 미지정은 Line 기본.
      for (var vi = 0; vi < charts.length; vi++) {
        if (charts[vi].tql_path || !charts[vi].type) continue;
        var vr = validateChartType(charts[vi].type);
        if (vr.error) return cb(null, 'Error: ' + vr.error);
      }

      // tql_path 참조 차트의 실제 파일 존재를 먼저 검증 — 없는 파일(예: compile_tql_from_spec 중복차단으로
      // 저장 실패)을 가리키는 댕글링 패널이 들어가 렌더 시 'not found' 에러가 나는 것을 도구 레이어에서 차단.
      var droppedMsg = '';
      validateTqlPaths(mc, charts, function (validCharts, droppedPaths) {
        if (droppedPaths.length > 0) {
          droppedMsg = '\n[주의] 존재하지 않는 TQL 참조 패널 ' + droppedPaths.length + '개 제외: ' + droppedPaths.join(', ') +
            ' (compile_tql_from_spec 저장 실패분 — 중복차단 등). 다른 관점의 차트로 다시 만들어 추가하세요.';
        }
        if (!validCharts || validCharts.length === 0) {
          return cb(null, 'Error: 참조한 TQL 파일이 모두 존재하지 않아 대시보드를 만들 수 없습니다. 누락: ' + droppedPaths.join(', ') +
            '\n→ 차트를 compile_tql_from_spec로 먼저 성공 저장한 뒤 다시 시도하세요(중복차단 메시지가 떴다면 저장 안 된 것).');
        }
        // inline 차트 tag/column 실재성 검증 — 계산식·없는 식별자 패널 드롭(빈 차트 방지). 프롬프트 금지의 결정론적 백스톱.
        validateInlineCharts(mc, validCharts, function (keptInline, droppedInline) {
          if (droppedInline.length > 0) {
            droppedMsg += '\n[주의] 비기본타입·계산식·없는 tag/column·중복 패널 ' + droppedInline.length + '개 제외: ' + droppedInline.join('; ') +
              ' — 기본 분석 차트는 Line/Bar/Scatter + 실재 태그/VALUE만. 같은 차트를 제목만 바꿔 반복하지 말고, 통계요약·스프레드·평균·분포 등은 심층 분석을 사용하세요.';
          }
          if (!keptInline || keptInline.length === 0) {
            return cb(null, 'Error: 모든 차트가 계산식이거나 존재하지 않는 tag/column이라 대시보드를 만들 수 없습니다: ' + droppedInline.join('; ') +
              '\n→ describe_table에 나온 실재 태그명과 VALUE만 사용하세요(계산 지표는 심층 분석).');
          }
          charts = keptInline;
          buildDashboard();
        });
      });
      return;

      // Infer table name from charts
      function buildDashboard() {
      var tableName = '';
      for (var ci = 0; ci < charts.length; ci++) {
        if (charts[ci].table) { tableName = charts[ci].table; break; }
        if (charts[ci].tql_path) {
          var m = charts[ci].tql_path.match(/FROM\s+([A-Z_][A-Z0-9_]*)/i);
          if (m) { tableName = m[1].toUpperCase(); break; }
        }
      }
      if (!tableName) {
        // Try from filename: "SILVER/Silver_Dashboard.dsh" → SILVER
        var slashPos = filename.indexOf('/');
        if (slashPos > 0) tableName = filename.substring(0, slashPos).toUpperCase();
      }

      // Resolve real column names (PK/BASETIME/SUMMARIZED) per table so non-NAME/TIME/VALUE
      // schemas work without the model having to thread them in. Populated before panels build.
      var colsByTable = {};
      // Time range shift: if requested range has no data, shift to MAX(TIME)
      var shiftedMsg = '';
      function afterTimeShift() {
        var panels = [];
        var x = 0, y = 0;
        for (var i = 0; i < charts.length; i++) {
          var c = charts[i];
          var cType = normalizeChartType(c.type || 'Line');
          var tqlPath = c.tql_path || '';
          if (tqlPath) cType = 'Tql chart';
          var w = chartWidth(cType);
          var h = CHART_H_DEFAULT;
          if (x + w > GRID_COLS) { x = 0; y += CHART_H_DEFAULT; }
          var cols = colsByTable[String(c.table || '').toUpperCase()] || { n: 'NAME', t: 'TIME', v: 'VALUE' };
          panels.push(makeChartPanel(c.title, cType, c.table || '', c.tag || '', c.column || cols.v, c.color || COLORS[i % COLORS.length], tqlPath, x, y, w, h, c.name_column || cols.n, c.time_column || cols.t));
          x += w;
        }

        // Inject userName into all blocks (Neo UI requires 'SYS' etc. for V$_STAT queries)
        var user = (mc.user || 'SYS').toUpperCase();
        for (var pi = 0; pi < panels.length; pi++) {
          var bl = panels[pi].blockList || [];
          for (var bi = 0; bi < bl.length; bi++) bl[bi].userName = user;
        }

        fillAllPanels(mc, panels, 0, function () {
          var dsh = buildDSHFile(filename, title, timeStart, timeEnd, panels, refresh);
          var content = JSON.stringify(dsh, null, 2);

          function doWrite() {
            mc.writeFile(filename, content, function (err) {
              if (err) return cb(null, 'Error: Failed to save dashboard: ' + err.message);
              var boardPath = filename.replace(/\.dsh$/i, '');
              var dashURL = mc.baseURL + '/web/ui/board/' + boardPath;
              cb(null, 'Dashboard created: ' + filename + ' (' + panels.length + ' charts)' + shiftedMsg + droppedMsg + '\n\n[대시보드 열기](' + dashURL + ')');
            });
          }

          var slashIdx = filename.lastIndexOf('/');
          if (slashIdx > 0) {
            mc.createFolder(filename.substring(0, slashIdx), function () { doWrite(); });
          } else { doWrite(); }
        });
      }

      // Resolve real PK/BASETIME/SUMMARIZED column names for every referenced table first,
      // then time-snap + build panels. detectColumns falls back to NAME/TIME/VALUE.
      var distinctTables = {};
      for (var dti = 0; dti < charts.length; dti++) {
        if (charts[dti].table) distinctTables[String(charts[dti].table).toUpperCase()] = true;
      }
      if (tableName) distinctTables[String(tableName).toUpperCase()] = true;
      var tblList = Object.keys(distinctTables);

      (function resolveColsThen(ri) {
        if (ri < tblList.length) {
          return detectColumns(mc, tblList[ri], function (c) { colsByTable[tblList[ri]] = c; resolveColsThen(ri + 1); });
        }
        // 시간 스냅: 요청 끝이 데이터 범위 밖(미래꼬리/완전과거)이면 데이터 끝 기준으로 기간 유지하며 조정.
        //  - 요청 끝 ≤ 데이터 max(직접 과거창) → 그대로 존중
        //  - 요청 끝 > 데이터 max(상대 "최근 N일" 등) → 데이터 끝으로 시프트(빈 꼬리 방지)
        // bounds는 describe_table가 채운 range_cache 우선 사용(조회 0회), 미스면 1회 조회 후 캐시.
        // 결측/해석불가('auto' 등 모델 센티널) 판정 — 'now' 계열은 Neo가 라이브 평가하는 유효 표현이라 제외.
        function timeArgMissing(v) { return !v || (!/^now([+-]|$)/.test(v) && !(parseInt(v, 10) > 0)); }

        function applySnap(minMs, maxMs) {
          // 결측/해석불가면 데이터 전체 범위로 채움 — ''/'auto'가 .dsh timeRange에 박혀 Invalid date로 깨지는 것 방지.
          if (minMs > 0 && maxMs > 0) {
            var filled = false;
            if (timeArgMissing(timeStart)) { timeStart = String(minMs); filled = true; }
            if (timeArgMissing(timeEnd)) { timeEnd = String(maxMs); filled = true; }
            if (filled) console.println('[dashboard] Time range filled from data bounds: ' + timeStart + ' ~ ' + timeEnd);
          }
          var startMs = parseInt(timeStart, 10);
          var endMs = parseInt(timeEnd, 10) || startMs;
          if (minMs > 0 && maxMs > 0 && startMs > 0 && (endMs > maxMs || endMs < minMs)) {
            var duration = endMs - startMs;
            if (duration <= 0) duration = 10 * 24 * 3600 * 1000;
            var newEnd = maxMs;
            var newStart = Math.max(maxMs - duration, minMs);
            timeStart = String(newStart);
            timeEnd = String(newEnd);
            shiftedMsg = '\n[주의] 요청 기간이 데이터 범위를 벗어나 실제 데이터 끝 기준으로 조정됨: ' + new Date(newStart).toISOString().substring(0, 10) + ' ~ ' + new Date(newEnd).toISOString().substring(0, 10);
            console.println('[dashboard] Time snapped: ' + new Date(newStart).toISOString() + ' ~ ' + new Date(newEnd).toISOString());
          }
          afterTimeShift();
        }

        // 유효한 시작값(스냅 대상)뿐 아니라 결측/해석불가(채움 대상)도 bounds 확보 경로로 진입시킨다.
        if (tableName && (parseInt(timeStart, 10) > 0 || timeArgMissing(timeStart) || timeArgMissing(timeEnd))) {
          var cached = rangeCache.get(tableName);
          if (cached) return applySnap(cached.min, cached.max);
          var snapTimeCol = (colsByTable[String(tableName).toUpperCase()] || {}).t || 'TIME';
          mc.querySQL('SELECT MIN(' + snapTimeCol + '), MAX(' + snapTimeCol + ') FROM ' + tableName, 'ms', '', '', function (err, raw) {
            if (err) return afterTimeShift();
            var minMs = 0, maxMs = 0;
            try {
              var parsed = JSON.parse(raw);
              if (parsed && parsed.data && parsed.data.rows && parsed.data.rows.length > 0) {
                minMs = parseInt(String(parsed.data.rows[0][0]), 10);
                maxMs = parseInt(String(parsed.data.rows[0][1]), 10);
              }
            } catch (e) { /* ignore */ }
            if (minMs > 0 && maxMs > 0) rangeCache.set(tableName, minMs, maxMs);
            applySnap(minMs, maxMs);
          });
          return;
        }
        afterTimeShift();
      })(0);
      } // buildDashboard
    },
  });

  registry.register({
    name: 'preview_dashboard',
    description: 'Get dashboard preview with title, panel count, and URL.',
    parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
    fn: function (args, cb) {
      var filename = argStr(args, 'filename', '');
      if (!filename) return cb(null, 'Error: filename is required');
      if (!filename.toLowerCase().endsWith('.dsh')) filename += '.dsh';

      function done(fn, data) {
        try {
          var dsh = JSON.parse(data);
          var d = dsh.dashboard || dsh;
          var panels = d.panels || [];
          var title = d.title || dsh.name || fn;
          var dashURL = mc.baseURL + '/web/ui/board/' + fn.replace(/\.dsh$/i, '');
          cb(null, 'Dashboard: ' + title + '\nPanels: ' + panels.length + '\n\n[대시보드 열기](' + dashURL + ')');
        } catch (e) { cb(null, 'Error: ' + e.message); }
      }

      // create_dashboard_with_charts가 _YYYYMMDD_HHMMSS를 자동 부착하므로, 모델이 베이스명을 넘기면
      // 정확 파일이 없을 수 있다 → 같은 폴더에서 최신 타임스탬프 파일로 자동 해소.
      function resolveLatest() {
        var slash = filename.lastIndexOf('/');
        var dir = slash > 0 ? filename.substring(0, slash) : '';
        var base = (slash > 0 ? filename.substring(slash + 1) : filename)
          .replace(/\.dsh$/i, '').replace(/_\d{8}(_\d{6})?$/, '');
        mc.listDir(dir || '/', function (e2, items) {
          if (e2 || !items) return cb(null, 'Error: dashboard not found: ' + filename);
          var best = '', bestTs = '';
          for (var i = 0; i < items.length; i++) {
            var m = String(items[i].name || '').match(/^(.*)_(\d{8}_\d{6})\.dsh$/i);
            if (m && m[1].toUpperCase() === base.toUpperCase() && m[2] > bestTs) { bestTs = m[2]; best = items[i].name; }
          }
          if (!best) return cb(null, 'Error: dashboard not found: ' + filename);
          var full = (dir ? dir + '/' : '') + best;
          mc.readFile(full, function (e3, data) {
            if (e3) return cb(null, 'Error: ' + e3.message);
            done(full, data);
          });
        });
      }

      mc.readFile(filename, function (err, data) {
        if (err) return resolveLatest();
        done(filename, data);
      });
    },
  });

  registry.register({
    name: 'delete_dashboard',
    description: 'Delete a dashboard file.',
    parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
    fn: function (args, cb) {
      var filename = argStr(args, 'filename', '');
      if (!filename) return cb(null, 'Error: filename is required');
      mc.deleteFile(filename, function (err) { cb(null, err ? 'Error: ' + err.message : 'Dashboard deleted: ' + filename); });
    },
  });

  registry.register({
    name: 'get_dashboard',
    description: 'Get a dashboard\'s full configuration.',
    parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
    fn: function (args, cb) {
      var filename = argStr(args, 'filename', '');
      if (!filename) return cb(null, 'Error: filename is required');
      mc.readFile(filename, function (err, data) { cb(null, err ? 'Error: ' + err.message : data); });
    },
  });

  registry.register({
    name: 'update_dashboard_time_range',
    description: 'Update dashboard time range.',
    parameters: { type: 'object', properties: { filename: { type: 'string' }, time_start: { type: 'string' }, time_end: { type: 'string' }, refresh: { type: 'string' } }, required: ['filename'] },
    fn: function (args, cb) {
      var filename = argStr(args, 'filename', '');
      if (!filename) return cb(null, 'Error: filename is required');
      mc.readFile(filename, function (err, data) {
        if (err) return cb(null, 'Error: ' + err.message);
        try {
          var dsh = JSON.parse(data);
          var d = dsh.dashboard || dsh;
          if (args.time_start || args.time_end) d.timeRange = { start: parseTimeValue(argStr(args, 'time_start', '')), end: parseTimeValue(argStr(args, 'time_end', '')), refresh: args.refresh || 'Off' };
          if (args.refresh) d.timeRange.refresh = args.refresh;
          // refresh가 켜져 있으면 end는 live('now')로 (고정 end면 새로고침 무의미)
          if (d.timeRange && d.timeRange.refresh && d.timeRange.refresh !== 'Off') d.timeRange.end = 'now';
          mc.writeFile(filename, JSON.stringify(dsh, null, 2), function (err2) { cb(null, err2 ? 'Error: ' + err2.message : 'Dashboard time range updated: ' + filename); });
        } catch (e) { cb(null, 'Error: ' + e.message); }
      });
    },
  });

  registry.register({
    name: 'add_chart_to_dashboard',
    description: 'Add a single chart to an existing dashboard.',
    parameters: { type: 'object', properties: { filename: { type: 'string' }, chart_title: { type: 'string' }, chart_type: { type: 'string' }, table: { type: 'string' }, tag: { type: 'string' }, column: { type: 'string' }, tql_path: { type: 'string' } }, required: ['filename', 'chart_title', 'chart_type'] },
    fn: function (args, cb) {
      var filename = argStr(args, 'filename', '');
      if (!filename) return cb(null, 'Error: filename is required');
      mc.readFile(filename, function (err, data) {
        if (err) return cb(null, 'Error: ' + err.message);
        try {
          var dsh = JSON.parse(data);
          var d = dsh.dashboard || dsh;
          if (!d.panels) d.panels = [];
          var maxY = 0;
          for (var i = 0; i < d.panels.length; i++) { var py = (d.panels[i].y || 0) + (d.panels[i].h || CHART_H_DEFAULT); if (py > maxY) maxY = py; }
          var panel = makeChartPanel(argStr(args, 'chart_title', 'New chart'), argStr(args, 'chart_type', 'Line'), argStr(args, 'table', ''), argStr(args, 'tag', ''), argStr(args, 'column', 'VALUE'), '', argStr(args, 'tql_path', ''), 0, maxY, 0, 0);
          var addUser = (mc.user || 'SYS').toUpperCase();
          for (var bi = 0; bi < (panel.blockList || []).length; bi++) panel.blockList[bi].userName = addUser;
          d.panels.push(panel);
          mc.writeFile(filename, JSON.stringify(dsh, null, 2), function (err2) { cb(null, err2 ? 'Error: ' + err2.message : 'Chart added: ' + argStr(args, 'chart_title', 'New chart')); });
        } catch (e) { cb(null, 'Error: ' + e.message); }
      });
    },
  });

  registry.register({
    name: 'remove_chart_from_dashboard',
    description: 'Remove a chart from a dashboard by panel ID or title.',
    parameters: { type: 'object', properties: { filename: { type: 'string' }, panel_id: { type: 'string' }, panel_title: { type: 'string' } }, required: ['filename'] },
    fn: function (args, cb) {
      var filename = argStr(args, 'filename', '');
      var pid = argStr(args, 'panel_id', ''), ptitle = argStr(args, 'panel_title', '');
      if (!filename) return cb(null, 'Error: filename is required');
      mc.readFile(filename, function (err, data) {
        if (err) return cb(null, 'Error: ' + err.message);
        try {
          var dsh = JSON.parse(data);
          var d = dsh.dashboard || dsh;
          var before = (d.panels || []).length;
          d.panels = (d.panels || []).filter(function (p) { if (pid && p.id === pid) return false; if (ptitle && p.title === ptitle) return false; return true; });
          mc.writeFile(filename, JSON.stringify(dsh, null, 2), function (err2) { cb(null, err2 ? 'Error: ' + err2.message : 'Removed ' + (before - d.panels.length) + ' chart(s)'); });
        } catch (e) { cb(null, 'Error: ' + e.message); }
      });
    },
  });

  registry.register({
    name: 'update_chart_in_dashboard',
    description: 'Update chart properties in a dashboard.',
    parameters: { type: 'object', properties: { filename: { type: 'string' }, panel_id: { type: 'string' }, panel_title: { type: 'string' }, new_title: { type: 'string' } }, required: ['filename'] },
    fn: function (args, cb) {
      var filename = argStr(args, 'filename', '');
      if (!filename) return cb(null, 'Error: filename is required');
      mc.readFile(filename, function (err, data) {
        if (err) return cb(null, 'Error: ' + err.message);
        try {
          var dsh = JSON.parse(data);
          var d = dsh.dashboard || dsh;
          var found = false;
          for (var i = 0; i < (d.panels || []).length; i++) {
            var p = d.panels[i];
            if ((args.panel_id && p.id === args.panel_id) || (args.panel_title && p.title === args.panel_title)) {
              if (args.new_title) p.title = args.new_title;
              found = true; break;
            }
          }
          if (!found) return cb(null, 'Error: Panel not found');
          mc.writeFile(filename, JSON.stringify(dsh, null, 2), function (err2) { cb(null, err2 ? 'Error: ' + err2.message : 'Chart updated'); });
        } catch (e) { cb(null, 'Error: ' + e.message); }
      });
    },
  });
}

module.exports = { register };
