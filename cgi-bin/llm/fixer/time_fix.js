var DT_FORMAT_RE = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/;

function fixTimeFloats(args) {
  ['time_start', 'time_end'].forEach(function (key) {
    if (typeof args[key] === 'number') {
      args[key] = String(Math.floor(args[key]));
    }
  });
}

function fixTimeValues(args) {
  ['time_start', 'time_end'].forEach(function (key) {
    var v = args[key];
    if (typeof v !== 'string') return;
    // Nanosecond trim (>15 digits)
    if (v.length > 15 && isAllDigits(v)) {
      args[key] = v.substring(0, v.length - 6);
      return;
    }
    // DateTime string → epoch ms
    if (!isAllDigits(v)) {
      var ms = parseTimeValue(v);
      if (ms > 0) {
        args[key] = String(ms);
        console.println('  [fix] ' + key + ': ' + v + ' → ' + ms);
      }
    }
  });
}

function parseTimeValue(v) {
  // Try epoch ms (all digits)
  if (isAllDigits(v)) return parseInt(v, 10);

  // Try "2006-01-02 15:04:05"
  var m = DT_FORMAT_RE.exec(v);
  if (m) {
    var d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]),
      parseInt(m[4]), parseInt(m[5]), parseInt(m[6]));
    return d.getTime();
  }

  // Try "2006-01-02"
  var parts = v.split('-');
  if (parts.length === 3 && parts[0].length === 4) {
    var d2 = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    return d2.getTime();
  }

  return 0;
}

function isAllDigits(s) {
  if (!s || s.length === 0) return false;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function captureDataTimeRange(args, result, fctx) {
  var sql = (args.sql_query || '').toUpperCase();
  if (sql.indexOf('MIN(TIME)') < 0 && sql.indexOf('MAX(TIME)') < 0) return;

  try {
    var parsed = JSON.parse(result);
    if (parsed && parsed.data && parsed.data.rows && parsed.data.rows.length > 0) {
      var row = parsed.data.rows[0];
      var minVal = row[0];
      var maxVal = row[1] || row[0];
      if (minVal) {
        var minMs = parseInt(String(minVal), 10);
        if (minMs > 0) {
          fctx.dataMinDt = msToDatetime(minMs);
        }
      }
      if (maxVal) {
        var maxMs = parseInt(String(maxVal), 10);
        if (maxMs > 0) {
          fctx.dataMaxDt = msToDatetime(maxMs);
        }
      }
    }
  } catch (e) {
    // Try CSV format
    var lines = result.split('\n');
    if (lines.length >= 2) {
      var vals = lines[1].split(',');
      if (vals.length >= 2) {
        var minMs2 = parseInt(vals[0].trim(), 10);
        var maxMs2 = parseInt(vals[1].trim(), 10);
        if (minMs2 > 0) fctx.dataMinDt = msToDatetime(minMs2);
        if (maxMs2 > 0) fctx.dataMaxDt = msToDatetime(maxMs2);
      }
    }
  }
}

function msToDatetime(ms) {
  var d = new Date(ms);
  return d.getFullYear() + '-' +
    pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

module.exports = { fixTimeFloats, fixTimeValues, parseTimeValue, captureDataTimeRange, isAllDigits, msToDatetime };
