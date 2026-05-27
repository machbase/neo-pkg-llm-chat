// TQL content fixes: template expansion, line breaks, escaped newlines
var { msToDatetime } = require('./time_fix');

var TQL_FUNC_RE = /\)[ \t]*(SQL_SELECT|SQL|SCRIPT|CHART_LINE|CHART_BAR3D|CHART|MAPVALUE|POPVALUE|MAPKEY|GROUPBYKEY|FFT|FLATTEN|PUSHKEY|CSV)\(/g;
var TEMPLATE_REF_RE = /TEMPLATE:\s*(\d+-\d+)/;
var TEMPLATE_TABLE_RE = /TABLE:\s*(\S+)/;
var TEMPLATE_TAG_RE = /(?:^|\s)TAG:\s*(\S+)/;
var TEMPLATE_TAG1_RE = /TAG1:\s*(\S+)/;
var TEMPLATE_TAG2_RE = /TAG2:\s*(\S+)/;
var TEMPLATE_UNIT_RE = /UNIT:\s*(\S+)/;
var TEMPLATE_ID_RE = /(\d+[-_]\d+)/;

// ExpandTemplateFunc callback - set by agent/templates.js
var expandTemplateFunc = null;

function setExpandTemplateFunc(fn) {
  expandTemplateFunc = fn;
}

function fixTQLContent(toolName, args, fctx) {
  if (toolName !== 'save_tql_file' && toolName !== 'execute_tql_script' && toolName !== 'validate_chart_tql') return;

  var contentKey = toolName === 'validate_chart_tql' ? 'tql_script' : 'tql_content';
  var content = args[contentKey];
  if (!content || typeof content !== 'string') return;

  // Case 1: TEMPLATE: reference in content
  var tmplMatch = TEMPLATE_REF_RE.exec(content);
  if (tmplMatch && expandTemplateFunc) {
    var params = extractTemplateParams(content, fctx);
    params.id = tmplMatch[1];
    try {
      var expanded = expandTemplateFunc(params.id, params);
      if (expanded) {
        args[contentKey] = expanded;
        console.println('  [fix] Template ' + params.id + ' expanded');
      }
    } catch (e) {
      console.println('  [fix] Template expansion failed: ' + e.message);
    }
  }

  // Case 2: Auto-detect template from filename
  if (toolName === 'save_tql_file' && expandTemplateFunc) {
    var filename = args.filename || '';
    var idMatch = TEMPLATE_ID_RE.exec(filename);
    if (idMatch) {
      var templateId = idMatch[1].replace('_', '-');
      var params2 = extractTemplateParams(content, fctx);
      try {
        var expanded2 = expandTemplateFunc(templateId, params2);
        if (expanded2) {
          args[contentKey] = expanded2;
          console.println('  [fix] Template ' + templateId + ' auto-expanded from filename');
        }
      } catch (e) { /* fallthrough */ }
    }
  }

  // Case 3: Replace remaining {PLACEHOLDER} in raw TQL content
  content = args[contentKey];
  if (content && content.indexOf('{') >= 0) {
    var params3 = extractTemplateParams(content, fctx);

    // Also extract TABLE/TAG from SQL in raw TQL (e.g., FROM SILVER WHERE NAME = 'close')
    if (!params3.TABLE) {
      var tblMatch = content.match(/FROM\s+([A-Z_][A-Z0-9_]*)/i);
      if (tblMatch) params3.TABLE = tblMatch[1];
    }
    if (!params3.TAG) {
      var tagMatch = content.match(/NAME\s*=\s*'([^']+)'/);
      if (tagMatch) params3.TAG = tagMatch[1];
    }
    if (!params3.TAG1) {
      var inMatch = content.match(/NAME\s+IN\s*\(\s*'([^']+)'\s*,\s*'([^']+)'/i);
      if (inMatch) { params3.TAG1 = inMatch[1]; params3.TAG2 = inMatch[2]; }
    }

    // Time range: prefer user-specified, but shift to data range if no data in that period
    if (fctx) {
      var userStart = fctx.timeStartDt || '';
      var userEnd = fctx.timeEndDt || '';
      var dataMin = fctx.dataMinDt || '';
      var dataMax = fctx.dataMaxDt || '';

      if (userStart && dataMax) {
        // Check if user range is outside data range → shift to data range (like report)
        var userStartMs = new Date(userStart.replace(' ', 'T')).getTime();
        var userEndMs = userEnd ? new Date(userEnd.replace(' ', 'T')).getTime() : Date.now();
        var dataMaxMs = new Date(dataMax.replace(' ', 'T')).getTime();
        var dataMinMs = dataMin ? new Date(dataMin.replace(' ', 'T')).getTime() : 0;

        if (userStartMs > dataMaxMs) {
          // User range is after all data → shift to data's last period
          var duration = userEndMs - userStartMs;
          var newEnd = dataMaxMs;
          var newStart = Math.max(dataMaxMs - duration, dataMinMs);
          params3.TIME_START = msToDatetime(newStart);
          params3.TIME_END = msToDatetime(newEnd);
          console.println('  [fix] TQL time shifted to data range: ' + params3.TIME_START + ' ~ ' + params3.TIME_END);
        } else {
          params3.TIME_START = userStart;
          params3.TIME_END = userEnd;
        }
      } else if (userStart) {
        params3.TIME_START = userStart;
        params3.TIME_END = userEnd;
      } else if (dataMin) {
        params3.TIME_START = dataMin;
        params3.TIME_END = dataMax;
      }

      // Fallback: epoch defaults (same as Go version)
      if (!params3.TIME_START) params3.TIME_START = '1970-01-01 00:00:00';
      if (!params3.TIME_END) params3.TIME_END = msToDatetime(Date.now());
    }

    var replaced = content;
    var pkeys = Object.keys(params3);
    for (var pi = 0; pi < pkeys.length; pi++) {
      var ph = '{' + pkeys[pi] + '}';
      while (replaced.indexOf(ph) >= 0) {
        replaced = replaced.replace(ph, params3[pkeys[pi]]);
      }
    }
    if (replaced !== content) {
      args[contentKey] = replaced;
      console.println('  [fix] TQL placeholders replaced: ' + pkeys.join(', '));
    }
  }

  // Case 4: Fix line breaks between TQL functions
  content = args[contentKey];
  var fixed = content.replace(TQL_FUNC_RE, ')\n$1(');
  if (fixed !== content) {
    args[contentKey] = fixed;
  }
}

function extractTemplateParams(content, fctx) {
  var params = {};

  var m;
  m = TEMPLATE_TABLE_RE.exec(content);
  if (m) params.TABLE = m[1];

  m = TEMPLATE_TAG_RE.exec(content);
  if (m) params.TAG = m[1].replace(/^['"]|['"]$/g, '');

  m = TEMPLATE_TAG1_RE.exec(content);
  if (m) params.TAG1 = m[1].replace(/^['"]|['"]$/g, '');

  m = TEMPLATE_TAG2_RE.exec(content);
  if (m) params.TAG2 = m[1].replace(/^['"]|['"]$/g, '');

  m = TEMPLATE_UNIT_RE.exec(content);
  if (m) {
    var unit = m[1].replace(/^['"]|['"]$/g, '');
    params.UNIT = "'" + unit + "'";
  }

  // Inject time range from fixer context
  if (fctx && fctx.timeStartDt) params.TIME_START = fctx.timeStartDt;
  if (fctx && fctx.timeEndDt) params.TIME_END = fctx.timeEndDt;

  return params;
}

function fixEscapedNewlines(args) {
  var keys = Object.keys(args);
  for (var i = 0; i < keys.length; i++) {
    var v = args[keys[i]];
    if (typeof v === 'string' && v.indexOf('\\n') >= 0) {
      args[keys[i]] = v.replace(/\\n/g, '\n');
    }
  }
}

module.exports = { fixTQLContent, fixEscapedNewlines, setExpandTemplateFunc, TEMPLATE_ID_RE };
