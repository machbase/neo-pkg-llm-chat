var { argStr, argInt } = require('./registry');
var path = require('path');

var GRID_COLS = 36;
var CHART_W_LARGE = 17;
var CHART_W_SMALL = 7;
var CHART_H_DEFAULT = 7;
var LARGE_TYPES = { Line: true, Bar: true, Scatter: true, 'Tql chart': true };
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
    case 'Pie': return { doughnutRatio: 50, roseType: false, tagLimit: 12 };
    case 'Gauge': return { isAxisTick: true, axisLabelDistance: 25, valueFontSize: 15, valueAnimation: false, alignCenter: 30, isAnchor: true, anchorSize: 25, min: 0, max: 100, tagLimit: 1, digit: 0, axisLineStyleWidth: 10, isAxisLineStyleColor: false, axisLineStyleColor: [[0.5,'#c2c2c2'],[1,'#F44E3B']] };
    case 'Tql chart': return { theme: 'white' };
    default: return getChartTypeDefaults('Line');
  }
}

function makeBlock(table, tag, column, color, userName, aggregator) {
  if (!column) column = 'VALUE';
  if (!color) color = '#367FEB';
  if (!userName) userName = 'sys';
  if (!aggregator) aggregator = 'value';
  return {
    id: generatePanelID(), table: table, userName: userName, color: color, type: 'tag',
    filter: [{ id: generatePanelID(), column: 'NAME', operator: 'in', value: tag, useFilter: true, useTyping: false, typingValue: 'NAME in ("' + tag + '")' }],
    values: [{ id: generatePanelID(), alias: '', value: column, aggregator: aggregator }],
    useRollup: false, name: 'NAME', time: 'TIME', useCustom: false, aggregator: aggregator,
    diff: 'none', tag: tag, value: column, alias: '', math: '', isValidMath: true,
    duration: { from: '', to: '' }, customFullTyping: { use: false, text: '' }, isVisible: true, tableInfo: [],
  };
}

function normalizeChartType(t) {
  if (!t) return 'Line';
  var map = { 'line': 'Line', 'bar': 'Bar', 'scatter': 'Scatter', 'pie': 'Line', 'gauge': 'Line', 'tql chart': 'Tql chart', 'liquid fill': 'Line' };
  return map[t.toLowerCase()] || t;
}

function makeChartPanel(title, chartType, table, tag, column, color, tqlPath, x, y, w, h) {
  chartType = normalizeChartType(chartType);
  if (tqlPath) chartType = 'Tql chart';
  if (!w || w <= 0) w = chartWidth(chartType);
  if (!h || h <= 0) h = CHART_H_DEFAULT;

  var agg = 'value';
  if (chartType === 'Pie') agg = 'count';
  else if (chartType === 'Gauge' || chartType === 'Liquid fill') agg = 'last';

  var panel = {
    id: generatePanelID(), title: title || 'Chart', titleColor: '', type: chartType,
    x: x, y: y, w: w, h: h, theme: 'white', useCustomTime: false, isAxisInterval: false,
    timeRange: { start: '', end: '', refresh: 'Off' },
    blockList: [], transformBlockList: [],
    chartInfo: getChartTypeDefaults(chartType),
    chartOptions: getChartTypeDefaults(chartType),
    commonOptions: {
      isLegend: true, legendTop: 'bottom', legendLeft: 'center', legendOrient: 'horizontal',
      isTooltip: true, tooltipTrigger: 'axis', tooltipBgColor: '#FFFFFF', tooltipTxtColor: '#333',
      tooltipDecimals: 3, tooltipUnit: '', isInsideTitle: true, isDataZoom: false, title: title,
      gridTop: 50, gridBottom: 50, gridLeft: 35, gridRight: 35,
    },
    xAxisOptions: [{
      type: 'time', axisTick: { alignWithLabel: true }, axisLabel: { hideOverlap: true },
      axisLine: { onZero: false }, scale: true, useMinMax: false, useBlockList: [0],
      label: { name: 'value', key: 'value', title: '', unit: '', decimals: null, squared: 0 },
    }],
    yAxisOptions: [{
      type: 'value', position: 'left', offset: '', alignTicks: true, scale: true, useMinMax: false,
      axisLine: { onZero: false },
      label: { name: 'value', key: 'value', title: '', unit: '', decimals: null, squared: 0 },
    }],
    axisInterval: { IntervalType: '', IntervalValue: '' },
  };

  if (tqlPath) {
    if (tqlPath[0] !== '/') tqlPath = '/' + tqlPath;
    panel.tqlInfo = { path: tqlPath, params: [{ name: '', value: '', format: '' }], chart_id: '' };
    panel.blockList = [makeBlock('', '', 'VALUE', color, 'sys', 'avg')];
  } else if (table && tag) {
    var tags = tag.split(',');
    var blocks = [];
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i].trim();
      if (!t) continue;
      var c = tags.length > 1 ? COLORS[i % COLORS.length] : (color || COLORS[0]);
      blocks.push(makeBlock(table, t, column, c, 'sys', agg));
    }
    panel.blockList = blocks;
  }

  return panel;
}

function buildDSHFile(filename, title, timeStart, timeEnd, panels) {
  var name = path.basename(filename);
  var dir = path.dirname(filename);
  if (dir === '.') dir = '/';
  else dir = '/' + dir + '/';

  return {
    id: generateID(), type: 'dsh', name: name, path: dir, code: '',
    panels: [], range_bgn: '', range_end: '', savedCode: false, sheet: [],
    shell: { icon: 'dashboard', theme: '', id: 'DSH' },
    dashboard: {
      variables: [],
      timeRange: { start: parseTimeValue(timeStart), end: parseTimeValue(timeEnd), refresh: 'Off' },
      title: title, panels: panels,
    },
  };
}

function parseTimeValue(s) {
  if (!s) return '';
  var n = parseInt(s, 10);
  return isNaN(n) ? s : n;
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
        charts: { type: 'string', description: 'JSON array of chart objects: [{title, type, table, tag, column, tql_path, color, w, h}]' },
      },
      required: ['filename', 'title', 'charts'],
    },
    fn: function (args, cb) {
      var filename = argStr(args, 'filename', '');
      var title = argStr(args, 'title', 'Dashboard');
      var timeStart = argStr(args, 'time_start', '');
      var timeEnd = argStr(args, 'time_end', '');
      var chartsStr = argStr(args, 'charts', '[]');
      if (!filename) return cb(null, 'Error: filename is required');
      if (!filename.toLowerCase().endsWith('.dsh')) filename += '.dsh';

      var charts;
      try { charts = JSON.parse(chartsStr); } catch (e) { return cb(null, 'Error: Invalid charts JSON: ' + e.message); }
      if (!Array.isArray(charts) || charts.length === 0) return cb(null, 'Error: charts must be a non-empty array');

      // Infer table name from charts
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
          panels.push(makeChartPanel(c.title, cType, c.table || '', c.tag || '', c.column || 'VALUE', c.color || COLORS[i % COLORS.length], tqlPath, x, y, w, h));
          x += w;
        }

        fillAllPanels(mc, panels, 0, function () {
          var dsh = buildDSHFile(filename, title, timeStart, timeEnd, panels);
          var content = JSON.stringify(dsh, null, 2);

          function doWrite() {
            mc.writeFile(filename, content, function (err) {
              if (err) return cb(null, 'Error: Failed to save dashboard: ' + err.message);
              var boardPath = filename.replace(/\.dsh$/i, '');
              var dashURL = mc.baseURL + '/web/ui/board/' + boardPath;
              cb(null, 'Dashboard created: ' + filename + ' (' + panels.length + ' charts)' + shiftedMsg + '\n\n[대시보드 열기](' + dashURL + ')');
            });
          }

          var slashIdx = filename.lastIndexOf('/');
          if (slashIdx > 0) {
            mc.createFolder(filename.substring(0, slashIdx), function () { doWrite(); });
          } else { doWrite(); }
        });
      }

      // Check if time range needs shifting
      if (tableName && timeStart) {
        var startMs = parseInt(timeStart, 10);
        if (startMs > 0) {
          mc.querySQL('SELECT MAX(TIME) FROM ' + tableName, 'ms', '', '', function (err, raw) {
            if (err) return afterTimeShift();
            try {
              var maxMs = 0;
              var parsed = JSON.parse(raw);
              if (parsed && parsed.data && parsed.data.rows && parsed.data.rows.length > 0) {
                maxMs = parseInt(String(parsed.data.rows[0][0]), 10);
              }
              if (!maxMs) {
                var lines = raw.split('\n');
                if (lines.length >= 2) maxMs = parseInt(lines[1].trim(), 10);
              }
              if (maxMs > 0 && startMs > maxMs) {
                var endMs = parseInt(timeEnd, 10) || startMs;
                var duration = endMs - startMs;
                if (duration <= 0) duration = 10 * 24 * 3600 * 1000;
                var minMs = 0;
                // Also get MIN(TIME) for lower bound
                mc.querySQL('SELECT MIN(TIME) FROM ' + tableName, 'ms', '', '', function (err2, raw2) {
                  try {
                    var p2 = JSON.parse(raw2);
                    if (p2 && p2.data && p2.data.rows && p2.data.rows.length > 0) minMs = parseInt(String(p2.data.rows[0][0]), 10);
                  } catch (e2) {
                    var l2 = (raw2 || '').split('\n');
                    if (l2.length >= 2) minMs = parseInt(l2[1].trim(), 10);
                  }
                  var newEnd = maxMs;
                  var newStart = Math.max(maxMs - duration, minMs || 0);
                  timeStart = String(newStart);
                  timeEnd = String(newEnd);
                  shiftedMsg = '\n[주의] 요청 기간에 데이터가 없어 실제 데이터 기간으로 자동 조정됨: ' + new Date(newStart).toISOString().substring(0,10) + ' ~ ' + new Date(newEnd).toISOString().substring(0,10);
                  console.println('[dashboard] Time shifted: ' + new Date(newStart).toISOString() + ' ~ ' + new Date(newEnd).toISOString());
                  afterTimeShift();
                });
                return;
              }
            } catch (e) { /* ignore */ }
            afterTimeShift();
          });
          return;
        }
      }
      afterTimeShift();
    },
  });

  registry.register({
    name: 'preview_dashboard',
    description: 'Get dashboard preview with title, panel count, and URL.',
    parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
    fn: function (args, cb) {
      var filename = argStr(args, 'filename', '');
      if (!filename) return cb(null, 'Error: filename is required');
      mc.readFile(filename, function (err, data) {
        if (err) return cb(null, 'Error: ' + err.message);
        try {
          var dsh = JSON.parse(data);
          var d = dsh.dashboard || dsh;
          var panels = d.panels || [];
          var title = d.title || dsh.name || filename;
          var dashURL = mc.baseURL + '/web/ui/board/' + filename.replace(/\.dsh$/i, '');
          cb(null, 'Dashboard: ' + title + '\nPanels: ' + panels.length + '\n\n[대시보드 열기](' + dashURL + ')');
        } catch (e) { cb(null, 'Error: ' + e.message); }
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
          var panel = makeChartPanel(argStr(args, 'chart_title', 'Chart'), argStr(args, 'chart_type', 'Line'), argStr(args, 'table', ''), argStr(args, 'tag', ''), argStr(args, 'column', 'VALUE'), '', argStr(args, 'tql_path', ''), 0, maxY, 0, 0);
          d.panels.push(panel);
          mc.writeFile(filename, JSON.stringify(dsh, null, 2), function (err2) { cb(null, err2 ? 'Error: ' + err2.message : 'Chart added: ' + argStr(args, 'chart_title', 'Chart')); });
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
