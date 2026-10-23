var { argStr } = require('./registry');
var { parseTableRef, listAccessible, normalizeRef, resolveTableRef } = require('./table_access');
var { withUserRoot, ensureParentOf, readUserFile, deleteUserFile } = require('./paths');
var { detectColumns, detectTags, mentionedTags } = require('./tql_spec');
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

// 소유자 접두 table → Neo 대시보드 스키마(table + userName) 분리
// · 스키마에 database 자리 없음 → 세 부분 이름의 db는 버림(패널은 현재 database 테이블만 가리킴)
function applyBlockOwner(block, fallbackUser) {
  var ref = parseTableRef(block.table || '');
  if (ref.owner) { block.table = ref.table; block.userName = ref.owner; }
  else block.userName = fallbackUser;
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

// Neo board 뷰어가 인식하는 유효 패널 타입 — 집합 밖 type은 뷰어 파서 TypeError("404 not found file name")
// · advScatter/Liquidfill은 뷰어 표기('Adv scatter'/'Liquid fill')와 달라 제외(Line 폴백)
var VALID_TYPES = { Line: 1, Bar: 1, Scatter: 1, Gauge: 1, Pie: 1, 'Tql chart': 1, Text: 1, Geomap: 1, Video: 1 };

// 입력 타입 → 유효 타입 매핑(spec-kind/임시명 별칭 포함) — 매핑 불가면 입력 그대로(검증은 호출측)
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

// 생성 단계 가드: 유효(별칭 포함)면 {type}, 아니면 {error}(모델 자가 교정용)
// · candlestick/ohlc는 inline 렌더 불가 → tql_path(기본 분석은 Line)로 유도
function validateChartType(t) {
  var k = String(t || '').toLowerCase();
  if (k === 'ohlc' || k === 'candlestick') {
    return { error: 'chart type "' + t + '"는 inline tag로 렌더되지 않습니다. 캔들차트는 compile_tql_from_spec(kind="ohlc")로 만들어 tql_path로 넣으세요. (기본 분석이면 type="Line", tag="open,high,low,close")' };
  }
  var out = mapChartType(t);
  if (VALID_TYPES[out]) return { type: out };
  return { error: 'invalid chart type "' + t + '". 사용 가능한 타입: ' + Object.keys(VALID_TYPES).join(', ') };
}

// 패널 빌드용 유효 타입 보장 — 매핑 불가면 Line 폴백
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
  // tql_path 차트 제목 없으면 파일명에서 유도(SILVER/Silver_Volume.tql → "Silver Volume")
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

  // auto-refresh 켜진 대시보드는 end를 'now'로 — 고정 end면 새로고침해도 같은 창
  // · 'now'는 Neo가 갱신마다 평가, parseTimeValue 없이 문자열 그대로
  var refreshVal = refresh || 'Off';
  var endVal = (refreshVal && refreshVal !== 'Off') ? 'now' : parseTimeValue(timeEnd);

  var dashboardObj = {
    variables: [],
    timeRange: { start: parseTimeValue(timeStart), end: endVal, refresh: refreshVal },
    title: title, panels: panels,
  };
  // 전부 TQL 차트면 패널 헤더 끔(차트가 좌상단에 제목·부제 직접 표시), 그 외는 헤더 유지
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

// 대시보드 파일명에 작성시각 _YYYYMMDD_HHMMSS 부착 — 항상 단일 타임스탬프
function withTimestamp(filename) {
  // 이미 붙은 _YYYYMMDD_HHMMSS·_YYYYMMDD 제거 — 중복 방지
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

  // 블록은 table·userName 분리 저장 — 남의 소유 테이블 조회용 유저 접두 복원
  var table = blockList[0].userName ? blockList[0].userName + '.' + blockList[0].table : blockList[0].table;
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

// tql_path 차트의 파일 존재 검증 → cb(keptCharts, droppedPaths) — 렌더 시 'not found' 패널 방지
// · 없는 파일 차트는 드롭, 인라인 차트(tql_path 없음)는 그대로
function validateTqlPaths(mc, charts, cb) {
  var anyTql = false;
  for (var i = 0; i < charts.length; i++) {
    if (charts[i] && charts[i].tql_path) {
      anyTql = true;
      // 선행 슬래시 제거 + 계정 폴더 부착 — TQL은 {user}/ 아래 저장(경로 불일치 시 보드 렌더 'not found')
      charts[i].tql_path = withUserRoot(mc, String(charts[i].tql_path).replace(/^\/+/, ''));
    }
  }
  if (!anyTql) return cb(charts, []);

  // 읽기 콜백은 동기 호출 — total을 읽기 발행 전에 고정 + finished 가드로 cb 1회 보장(차트당 중복 발화 방지)
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
      readUserFile(mc, p, function (err, data) {
        var body = String(data == null ? '' : data);
        // 존재 판정: 읽기 성공 + 본문이 {success:false} 아님 — 파일 API가 200+{success:false}를 줄 수 있음
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

// 계산식 문자 포함 여부(괄호·+·*·/, withHyphen이면 -도)
function hasExprChars(s, withHyphen) {
  s = String(s);
  if (s.indexOf('(') >= 0 || s.indexOf(')') >= 0 || s.indexOf('+') >= 0 || s.indexOf('*') >= 0 || s.indexOf('/') >= 0) return true;
  // 컬럼명엔 하이픈 없음 → 하이픈=계산식(high-low), 태그는 device-0 등 흔해 제외
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
// inline 차트 테이블 이름을 DB.유저.테이블로 치환 — cb(오류 메시지 목록: 없음·모호)
// 목록 조회 실패 시 원래 이름 유지
function normalizeInlineTables(mc, charts, cb) {
  var any = false;
  for (var i = 0; i < charts.length; i++) { if (charts[i] && !charts[i].tql_path && charts[i].table) { any = true; break; } }
  if (!any) return cb([]);
  listAccessible(mc, false, function (err, rows) {
    if (err) return cb([]);
    var user = String(mc.user || '').toUpperCase(), errors = [];
    for (var j = 0; j < charts.length; j++) {
      var c = charts[j];
      if (!c || c.tql_path || !c.table) continue;
      var r = normalizeRef(c.table, rows, user);
      if (r.error) { if (errors.indexOf(r.error) < 0) errors.push(r.error); continue; }
      c.table = r.ref.qualified;
    }
    cb(errors);
  });
}

// 태그 자리의 컬럼 이름(값 컬럼 READING 등) → 실제 태그. 고칠 게 없으면 null
// · 컬럼 이름만 빼고 남는 태그가 있으면 그 태그들
// · 다 빠지면 차트 제목에 적힌 실제 태그, 없으면 앞 COLUMN_TAG_FALLBACK개 비교
var COLUMN_TAG_FALLBACK = 5;
function columnTagFix(c, realTags, realCols) {
  if (!realTags.length || !realCols.length) return null;
  var upTags = realTags.map(function (t) { return String(t).toUpperCase(); });
  var parts = String(c.tag).split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  function isColumn(t) { var u = t.toUpperCase(); return upTags.indexOf(u) < 0 && realCols.indexOf(u) >= 0; }
  if (!parts.some(isColumn)) return null;
  var rest = parts.filter(function (t) { return !isColumn(t); });
  if (rest.length) return rest.join(',');
  var inTitle = mentionedTags(c.title, realTags);
  return (inTitle.length ? inTitle : realTags.slice(0, COLUMN_TAG_FALLBACK)).join(',');
}

// inline 차트 검증 — 비기본 타입·계산식·없는 tag/column·중복 드롭(빈 차트 방지), 실재 목록 조회 실패 시 그 검사 통과
// · cb(kept, dropped, fixed) — fixed: 태그 자리의 컬럼 이름을 실제 태그로 바꾼 내역
function validateInlineCharts(mc, charts, cb) {
  function isInline(c) { return c && !c.tql_path && c.table && c.tag; }
  var anyInline = false;
  for (var i = 0; i < charts.length; i++) { if (isInline(charts[i])) { anyInline = true; break; } }
  if (!anyInline) return cb(charts, [], []);

  var tables = {};
  for (var k = 0; k < charts.length; k++) { if (isInline(charts[k])) tables[String(charts[k].table).toUpperCase()] = true; }
  var tblList = Object.keys(tables);
  var tagsByTable = {}, origTagsByTable = {}, colsByTable = {};

  (function resolve(ri) {
    if (ri >= tblList.length) return finish();
    var tbl = tblList[ri];
    detectColumns(mc, tbl, function (cc) {
      detectTags(mc, tbl, (cc && cc.n) || 'NAME', function (tags) {
        origTagsByTable[tbl] = (tags || []).map(String);
        tagsByTable[tbl] = (tags || []).map(function (t) { return String(t).toUpperCase(); });
        tableColumns(mc, tbl, function (cols) {
          colsByTable[tbl] = (cols || []).map(function (x) { return String(x).toUpperCase(); });
          resolve(ri + 1);
        });
      });
    });
  })(0);

  // 동일 차트 시그니처(테이블|정렬태그|컬럼|타입) — 제목만 다른 차트는 동일 취급
  function chartSig(c) {
    var tg = String(c.tag).split(',').map(function (t) { return t.trim().toUpperCase(); }).filter(Boolean).sort().join(',');
    return String(c.table).toUpperCase() + '|' + tg + '|' + String(c.column || '').toUpperCase() + '|' + String(c.type || 'Line').toUpperCase();
  }
  function finish() {
    var kept = [], dropped = [], fixed = [], seen = {};
    for (var i = 0; i < charts.length; i++) {
      var c = charts[i];
      if (!isInline(c)) { kept.push(c); continue; } // tql_path/비-inline은 그대로(별도 검증)
      var tbl = String(c.table).toUpperCase();
      var realTags = tagsByTable[tbl] || [], realCols = colsByTable[tbl] || [];
      var fixedTag = columnTagFix(c, origTagsByTable[tbl] || [], realCols);
      if (fixedTag) {
        fixed.push((c.title || '(무제)') + ' — ' + c.tag + ' → ' + fixedTag);
        c.tag = fixedTag;
      }
      var bad = '';
      // 타입 화이트리스트: 기본 분석 inline 차트는 데이터 차트(Line/Bar/Scatter)만
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
      // 중복 제거: 시그니처 같으면 뒤엣것 드롭 — 같은 원시 그래프 반복 방지
      var sig = chartSig(c);
      if (seen[sig]) { dropped.push((c.title || '(무제)') + ' — 중복(동일 차트)'); continue; }
      seen[sig] = true;
      kept.push(c);
    }
    cb(kept, dropped, fixed);
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
      filename = withTimestamp(filename); // 이후 폴더·쓰기·URL 모두 이 이름 사용
      // 계정 폴더 부착(보드 링크도 이 이름에서 파생)
      filename = withUserRoot(mc, filename);

      var charts;
      try { charts = JSON.parse(chartsStr); } catch (e) { return cb(null, 'Error: Invalid charts JSON: ' + e.message); }
      if (!Array.isArray(charts) || charts.length === 0) return cb(null, 'Error: charts must be a non-empty array');

      // 차트 타입 가드: inline 차트의 무효 type 거부 — 깨진 .dsh 방지
      // · tql_path 차트는 'Tql chart'로 강제돼 제외, type 미지정은 Line
      for (var vi = 0; vi < charts.length; vi++) {
        if (charts[vi].tql_path || !charts[vi].type) continue;
        var vr = validateChartType(charts[vi].type);
        if (vr.error) return cb(null, 'Error: ' + vr.error);
      }

      // tql_path 파일 존재 검증 — 댕글링 패널의 렌더 'not found' 방지
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
        // inline 차트 테이블 이름 정규화 — 없음·모호면 생성 전에 오류 반환
        normalizeInlineTables(mc, validCharts, function (nameErrors) {
        if (nameErrors.length > 0) return cb(null, 'Error: ' + nameErrors.join('\n'));
        // inline 차트 tag/column 실재성 검증 — 계산식·없는 식별자 패널 드롭(빈 차트 방지)
        validateInlineCharts(mc, validCharts, function (keptInline, droppedInline, fixedInline) {
          if (fixedInline && fixedInline.length > 0) {
            droppedMsg += '\n[주의] 태그 자리의 컬럼 이름을 실제 태그로 바꿨습니다(값은 값 컬럼에서 읽음): ' + fixedInline.join('; ');
          }
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
      if (tableName) return buildWithTable(tableName);
      // 파일명 폴더에서 추정 — 맨 앞은 계정 폴더("user/SILVER/x.dsh" → SILVER), 접근 가능한 실제 테이블로 정규화
      var segs = filename.split('/');
      if (segs.length < 3) return buildWithTable('');
      resolveTableRef(mc, segs[1].toUpperCase(), function (refErr, ref) { buildWithTable(refErr || !ref ? '' : ref.qualified); });
      }

      function buildWithTable(tableName) {
      // 테이블별 실제 컬럼 이름(PK/BASETIME/SUMMARIZED) — 패널 빌드 전에 채움
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

        // 블록 table의 소유자 접두를 userName으로 분리 — Neo UI는 둘을 따로 받음(남의 소유 테이블 차트용)
        var user = (mc.user || 'SYS').toUpperCase();
        for (var pi = 0; pi < panels.length; pi++) {
          var bl = panels[pi].blockList || [];
          for (var bi = 0; bi < bl.length; bi++) applyBlockOwner(bl[bi], user);
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

          ensureParentOf(mc, filename, function () { doWrite(); });
        });
      }

      // 참조 테이블별 실제 컬럼 이름 확보 → 시간 스냅 → 패널 빌드(detectColumns 폴백 NAME/TIME/VALUE)
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
        // 시간 스냅: 요청 끝이 데이터 범위 밖이면 기간 유지한 채 데이터 끝으로 이동(빈 꼬리 방지)
        // · bounds는 range_cache 우선, 미스면 1회 조회 후 캐시
        // 결측/해석불가('auto' 등) 판정 — 'now' 계열은 Neo가 라이브 평가해 제외
        function timeArgMissing(v) { return !v || (!/^now([+-]|$)/.test(v) && !(parseInt(v, 10) > 0)); }

        function applySnap(minMs, maxMs) {
          // 결측/해석불가면 데이터 전체 범위로 채움 — .dsh timeRange의 Invalid date 방지
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

        // 유효 시작값(스냅 대상)·결측/해석불가(채움 대상) 모두 bounds 확보
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
      } // buildWithTable
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

      // 베이스명만 준 경우 같은 폴더의 최신 _YYYYMMDD_HHMMSS 파일로 해소
      // · 계정 폴더 먼저, 없으면 계정 폴더 없는 경로
      function resolveLatest() {
        var scoped = withUserRoot(mc, filename);
        var raw = String(filename).replace(/^\/+/, '');
        tryDir(scoped, function (ok) {
          if (ok) return;
          if (raw === scoped) return cb(null, 'Error: dashboard not found: ' + filename);
          tryDir(raw, function (ok2) {
            if (!ok2) cb(null, 'Error: dashboard not found: ' + filename);
          });
        });

        function tryDir(candidate, next) {
          var slash = candidate.lastIndexOf('/');
          var dir = slash > 0 ? candidate.substring(0, slash) : '';
          var base = (slash > 0 ? candidate.substring(slash + 1) : candidate)
            .replace(/\.dsh$/i, '').replace(/_\d{8}(_\d{6})?$/, '');
          mc.listDir(dir || '/', function (e2, items) {
            if (e2 || !items) return next(false);
            var best = '', bestTs = '';
            for (var i = 0; i < items.length; i++) {
              var m = String(items[i].name || '').match(/^(.*)_(\d{8}_\d{6})\.dsh$/i);
              if (m && m[1].toUpperCase() === base.toUpperCase() && m[2] > bestTs) { bestTs = m[2]; best = items[i].name; }
            }
            if (!best) return next(false);
            var full = (dir ? dir + '/' : '') + best;
            mc.readFile(full, function (e3, data) {
              if (e3) return next(false);
              done(full, data);
              next(true);
            });
          });
        }
      }

      readUserFile(mc, filename, function (err, data, actualPath) {
        if (err) return resolveLatest();
        done(actualPath, data);
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
      deleteUserFile(mc, filename, function (err) { cb(null, err ? 'Error: ' + err.message : 'Dashboard deleted: ' + filename); });
    },
  });

  registry.register({
    name: 'get_dashboard',
    description: 'Get a dashboard\'s full configuration.',
    parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
    fn: function (args, cb) {
      var filename = argStr(args, 'filename', '');
      if (!filename) return cb(null, 'Error: filename is required');
      readUserFile(mc, filename, function (err, data) { cb(null, err ? 'Error: ' + err.message : data); });
    },
  });

  registry.register({
    name: 'update_dashboard_time_range',
    description: 'Update dashboard time range.',
    parameters: { type: 'object', properties: { filename: { type: 'string' }, time_start: { type: 'string' }, time_end: { type: 'string' }, refresh: { type: 'string' } }, required: ['filename'] },
    fn: function (args, cb) {
      var filename = argStr(args, 'filename', '');
      if (!filename) return cb(null, 'Error: filename is required');
      readUserFile(mc, filename, function (err, data, actualPath) {
        if (err) return cb(null, 'Error: ' + err.message);
        filename = actualPath;
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
      var target = [{ table: argStr(args, 'table', ''), tql_path: argStr(args, 'tql_path', '') }];
      normalizeInlineTables(mc, target, function (nameErrors) {
      if (nameErrors.length > 0) return cb(null, 'Error: ' + nameErrors.join('\n'));
      readUserFile(mc, filename, function (err, data, actualPath) {
        if (err) return cb(null, 'Error: ' + err.message);
        filename = actualPath;
        try {
          var dsh = JSON.parse(data);
          var d = dsh.dashboard || dsh;
          if (!d.panels) d.panels = [];
          var maxY = 0;
          for (var i = 0; i < d.panels.length; i++) { var py = (d.panels[i].y || 0) + (d.panels[i].h || CHART_H_DEFAULT); if (py > maxY) maxY = py; }
          var panel = makeChartPanel(argStr(args, 'chart_title', 'New chart'), argStr(args, 'chart_type', 'Line'), target[0].table, argStr(args, 'tag', ''), argStr(args, 'column', 'VALUE'), '', withUserRoot(mc, argStr(args, 'tql_path', '')), 0, maxY, 0, 0);
          var addUser = (mc.user || 'SYS').toUpperCase();
          for (var bi = 0; bi < (panel.blockList || []).length; bi++) applyBlockOwner(panel.blockList[bi], addUser);
          d.panels.push(panel);
          mc.writeFile(filename, JSON.stringify(dsh, null, 2), function (err2) { cb(null, err2 ? 'Error: ' + err2.message : 'Chart added: ' + argStr(args, 'chart_title', 'New chart')); });
        } catch (e) { cb(null, 'Error: ' + e.message); }
      });
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
      readUserFile(mc, filename, function (err, data, actualPath) {
        if (err) return cb(null, 'Error: ' + err.message);
        filename = actualPath;
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
      readUserFile(mc, filename, function (err, data, actualPath) {
        if (err) return cb(null, 'Error: ' + err.message);
        filename = actualPath;
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

module.exports = { register, columnTagFix }; // columnTagFix: 유닛 테스트용
