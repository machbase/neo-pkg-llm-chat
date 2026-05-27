var { argStr } = require('./registry');
var { expandTemplate } = require('./tql_templates');

function register(registry, mc) {
  // execute_tql_script
  registry.register({
    name: 'execute_tql_script',
    description: 'Execute a TQL (Transforming Query Language) script on Machbase Neo. Returns the execution result (chart HTML, CSV data, or error).',
    parameters: {
      type: 'object',
      properties: {
        tql_content: { type: 'string', description: 'TQL script content to execute' },
      },
      required: ['tql_content'],
    },
    fn: function (args, cb) {
      var tql = argStr(args, 'tql_content', '');
      if (!tql) return cb(null, 'Error: tql_content is required');
      mc.executeTQL(tql, function (err, result) {
        if (err) return cb(null, 'Error: TQL execution failed: ' + err.message);
        if (!result || result.trim() === '') return cb(null, 'TQL executed successfully (no output).');
        if (result.length > 5000) {
          return cb(null, result.substring(0, 5000) + '\n... (truncated, total ' + result.length + ' chars)');
        }
        cb(null, result);
      });
    },
  });

  // save_tql_file
  registry.register({
    name: 'save_tql_file',
    description: 'Save a TQL script to a file in Machbase Neo filesystem.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File path (e.g., "GOLD/avg_trend.tql"). Must be English only.' },
        tql_content: { type: 'string', description: 'TQL script content or TEMPLATE reference' },
      },
      required: ['filename', 'tql_content'],
    },
    fn: function (args, cb) {
      var filename = argStr(args, 'filename', '');
      var tqlContent = argStr(args, 'tql_content', '');
      if (!filename) return cb(null, 'Error: filename is required');
      if (!tqlContent) return cb(null, 'Error: tql_content is required');

      // Expand TEMPLATE shorthand: "TEMPLATE:1-1 TABLE:SILVER TAG:close UNIT:day"
      var tmplMatch = tqlContent.match(/^TEMPLATE:\s*(\d+-\d+)\b/i);
      if (tmplMatch) {
        var tmplParams = {};
        var pairs = tqlContent.replace(/^TEMPLATE:\s*\d+-\d+\s*/i, '').trim();
        pairs.split(/\s+/).forEach(function (p) {
          var kv = p.split(':');
          if (kv.length >= 2) tmplParams[kv[0].toUpperCase()] = kv.slice(1).join(':');
        });

        // TIME_START/TIME_END 미제공 시 DB에서 실제 시간 범위 조회
        if ((!tmplParams.TIME_START || !tmplParams.TIME_END) && tmplParams.TABLE) {
          mc.querySQL('SELECT MIN(TIME), MAX(TIME) FROM ' + tmplParams.TABLE.toUpperCase(), 'default', '', '', function (err, raw) {
            var minT = '', maxT = '';
            if (!err) {
              try {
                var p = JSON.parse(raw);
                if (p && p.data && p.data.rows && p.data.rows.length > 0) {
                  minT = String(p.data.rows[0][0]).substring(0, 19);
                  maxT = String(p.data.rows[0][1]).substring(0, 19);
                }
              } catch (e) {}
            }
            if (minT) tmplParams.TIME_START = tmplParams.TIME_START || minT;
            if (maxT) tmplParams.TIME_END = tmplParams.TIME_END || maxT;
            var expanded = expandTemplate(tmplMatch[1], tmplParams);
            if (!expanded) return cb(null, 'Error: Template ' + tmplMatch[1] + ' not found');
            tqlContent = expanded;
            processTql();
          });
          return;
        }

        var expanded = expandTemplate(tmplMatch[1], tmplParams);
        if (!expanded) return cb(null, 'Error: Template ' + tmplMatch[1] + ' not found');
        tqlContent = expanded;
      }

      processTql();
      return;

      function processTql() {
        if (!filename.toLowerCase().endsWith('.tql')) filename += '.tql';

        var slashIdx = filename.lastIndexOf('/');
        var shiftedMsg = '';

        function doSave() {
          function afterFolder() {
            mc.executeTQL(tqlContent, function (err, testResult) {
              if (err) return cb(null, 'Error: TQL validation failed: ' + err.message);
              if (testResult && testResult.toLowerCase().indexOf('error') === 0) {
                return cb(null, 'Error: TQL validation failed: ' + testResult);
              }
              mc.writeFile(filename, tqlContent, function (err2) {
                if (err2) return cb(null, 'Error: Failed to save file: ' + err2.message);
                cb(null, 'TQL file saved: ' + filename + shiftedMsg);
              });
            });
          }

          if (slashIdx > 0) {
            mc.createFolder(filename.substring(0, slashIdx), function () { afterFolder(); });
          } else {
            afterFolder();
          }
        }

        // Convert epoch nanoseconds to TO_DATE before processing
        var nanoRe = /(\d{18,19})/g;
        var nanoM;
        while ((nanoM = nanoRe.exec(tqlContent)) !== null) {
          var ns = nanoM[1];
          var ms = parseInt(ns.substring(0, 13), 10);
          if (ms > 1000000000000) {
            var d = new Date(ms);
            var dt = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ' ' +
              String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0');
            tqlContent = tqlContent.replace(ns, "TO_DATE('" + dt + "')");
          }
        }

        // Time shift: if TQL contains TO_DATE with future times, shift to data range
        var toDateRe = /TO_DATE\s*\(\s*'([^']+)'\s*\)/g;
        var fromRe = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i;
        var dates = [];
        var m;
        while ((m = toDateRe.exec(tqlContent)) !== null) dates.push(m[1]);
        var tableMatch = fromRe.exec(tqlContent);

        if (dates.length >= 2 && tableMatch) {
          var tblName = tableMatch[1].toUpperCase();
          var reqStart = new Date(dates[0]).getTime();
          var reqEnd = new Date(dates[1]).getTime();

          if (reqStart > 0 && reqEnd > 0) {
            mc.querySQL('SELECT MAX(TIME) FROM ' + tblName, 'ms', '', '', function (err, raw) {
              if (err) return doSave();
              var maxMs = 0;
              try {
                var p = JSON.parse(raw);
                if (p && p.data && p.data.rows && p.data.rows.length > 0) maxMs = parseInt(String(p.data.rows[0][0]), 10);
              } catch (e) {
                var lines = (raw || '').split('\n');
                if (lines.length >= 2) maxMs = parseInt(lines[1].trim(), 10);
              }

              if (maxMs > 0 && reqStart > maxMs) {
                var duration = reqEnd - reqStart;
                var newEnd = maxMs;
                var newStart = maxMs - duration;
                function fmtDt(ms) {
                  var d = new Date(ms);
                  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ' ' +
                    String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0');
                }
                tqlContent = tqlContent.replace("TO_DATE('" + dates[0] + "')", "TO_DATE('" + fmtDt(newStart) + "')");
                tqlContent = tqlContent.replace("TO_DATE('" + dates[1] + "')", "TO_DATE('" + fmtDt(newEnd) + "')");
                shiftedMsg = '\n[주의] 요청 기간에 데이터가 없어 실제 데이터 기간으로 자동 조정됨: ' + fmtDt(newStart) + ' ~ ' + fmtDt(newEnd);
                console.println('[tql] Time shifted: ' + fmtDt(newStart) + ' ~ ' + fmtDt(newEnd));
              }
              doSave();
            });
            return;
          }
        }
        doSave();
      }
    },
  });
}

module.exports = { register };
