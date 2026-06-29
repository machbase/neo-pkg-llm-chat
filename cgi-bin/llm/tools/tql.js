var { argStr } = require('./registry');
var { expandTemplate } = require('./tql_templates');
var { extractUserTables, checkTableOwnership } = require('./ownership');

// 쿼리 결과에 행이 있는지 (Machbase는 200+{"success":false}로도 에러를 줄 수 있어 success/rows 확인)
function rowsPresent(qres) {
  try {
    var qp = JSON.parse(qres);
    return !!(qp && qp.success && qp.data && qp.data.rows && qp.data.rows.length > 0);
  } catch (e) { return (qres || '').length > 20; }
}
var ZERO_ROW_MSG = 'Error: 차트 쿼리가 데이터를 0건 반환했습니다 (TQL 문법은 맞지만 빈 차트가 됩니다). 시간 범위를 describe_table의 time range(ms)에 맞추고(TO_DATE에 실제 데이터 기간 사용), 태그명/테이블을 확인해 TQL을 고쳐 다시 저장하세요.';

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
      var tables = extractUserTables(tql);
      checkTableOwnership(mc, tables, function (ownerErr) {
        if (ownerErr) return cb(null, 'Error: ' + ownerErr.message);
        mc.executeTQL(tql, function (err, result) {
          if (err) return cb(null, 'Error: TQL execution failed: ' + err.message);
          if (!result || result.trim() === '') return cb(null, 'TQL executed successfully (no output).');
          if (result.length > 5000) {
            return cb(null, result.substring(0, 5000) + '\n... (truncated, total ' + result.length + ' chars)');
          }
          cb(null, result);
        });
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
        tql_content: { type: 'string', description: 'Raw TQL script content, written directly (no TEMPLATE syntax)' },
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
        var tables = extractUserTables(tqlContent);
        checkTableOwnership(mc, tables, function (ownerErr) {
          if (ownerErr) return cb(null, 'Error: ' + ownerErr.message);
          processTqlAfterOwnerCheck();
        });
      }

      function processTqlAfterOwnerCheck() {
        // 대시보드 테마 일관성: TQL이 직접 지정한 theme() 호출은 패널 테마(white)와 어긋남 → CHART 인자에서 제거
        tqlContent = tqlContent.replace(/theme\s*\(\s*['"][^'"]*['"]\s*\)\s*,/g, '');
        tqlContent = tqlContent.replace(/,\s*theme\s*\(\s*['"][^'"]*['"]\s*\)/g, '');

        // 레이아웃 일관성(겹침 방지) — chartOption이 있는 차트 TQL에만. 모두 보수적(못 잡으면 no-op)이라 유효 TQL을 깨지 않음.
        if (/chartOption\s*\(/.test(tqlContent)) {
          // 1) yAxis 안의 name 제거 (축 이름이 좌상단 제목/부제와 겹침). flat yAxis 객체에 한함(중첩이면 미매치=no-op)
          tqlContent = tqlContent.replace(/(yAxis\s*:\s*\{)([^{}]*?)(\})/g, function (m, head, body, tail) {
            if (!/\bname\s*:/.test(body)) return m;
            var nb = body.replace(/(^|,)\s*name\s*:\s*(['"])[^'"]*\2\s*/g, '$1');
            nb = nb.replace(/,\s*,/g, ',').replace(/^\s*,/, '').replace(/,\s*$/, '');
            return head + nb + tail;
          });
          // 2) grid가 아예 없으면 표준 grid 주입 (ECharts 기본 여백이 좁아 제목/범례/축 라벨이 겹침)
          if (!/grid\s*:/.test(tqlContent)) {
            tqlContent = tqlContent.replace(/chartOption\s*\(\s*\{/, 'chartOption({ grid: { left: 72, right: 30, top: 66, bottom: 78 },');
          } else {
            // 3) grid 여백이 너무 작으면 최소값으로 보정 (단일 flat grid 객체에 한함). 더 크게 잡은 값은 유지.
            tqlContent = tqlContent.replace(/grid\s*:\s*\{([^{}]*)\}/, function (m, body) {
              body = body.replace(/\bleft\s*:\s*(\d+)/, function (x, v) { return 'left: ' + Math.max(parseInt(v, 10), 55); });
              body = body.replace(/\bright\s*:\s*(\d+)/, function (x, v) { return 'right: ' + Math.max(parseInt(v, 10), 24); });
              body = body.replace(/\btop\s*:\s*(\d+)/, function (x, v) { return 'top: ' + Math.max(parseInt(v, 10), 60); });
              body = body.replace(/\bbottom\s*:\s*(\d+)/, function (x, v) { return 'bottom: ' + Math.max(parseInt(v, 10), 76); });
              return 'grid: {' + body + '}';
            });
          }
        }

        if (!filename.toLowerCase().endsWith('.tql')) filename += '.tql';

        var slashIdx = filename.lastIndexOf('/');
        var shiftedMsg = '';

        function doSave() {
          function afterFolder() {
            if (tqlContent.indexOf('$.foreach') >= 0) {
              return cb(null, 'Error: TQL SCRIPT에 존재하지 않는 $.foreach 사용. SCRIPT는 3-block {초기화},{레코드마다},{끝나고} 패턴이고 main(가운데) 블록이 레코드마다 자동 실행됩니다($.values[i]). 여러 시리즈는 main에서 배열에 push 후 deinit에서 인덱스별 $.yield(시리즈0[i], 시리즈1[i], ...). 고쳐서 다시 저장하세요.');
            }
            mc.executeTQL(tqlContent, function (err, testResult) {
              var tqlHint = '\n흔한 원인: CHART 옵션은 반드시 chartOption({...}) 안에 — title/grid/series를 CHART()에 직접 쓰면 "invalid option" 또는 "FUNCTION→TERNARY[:]" 에러 (형식: CHART(tz(\'Asia/Seoul\'), chartOption({ title:..., series:[...] }))) / ROLLUP 쿼리에 NAME을 SELECT/GROUP BY (단일 태그는 WHERE NAME=... 로만 필터, SELECT는 ROLLUP 표현식+집계만) / SQL()에 GROUP BY 누락 / ROLLUP에 alias / 큰따옴표 대신 백틱 / ROLLUP 단위 오류(sec~month, ms 불가) / ROLLUP 없는 테이블에 ROLLUP() / 차트에 TIME,VALUE 따로(=> [timestamp,value] 페어로). TQL을 고쳐 다시 저장하세요.';
              if (err) return cb(null, 'Error: TQL 실행 검증 실패: ' + err.message + tqlHint);
              var tqlRes = String(testResult || '');
              var tqlResLow = tqlRes.toLowerCase();
              if (tqlResLow.indexOf('error') === 0 || /MACH(?:CLI)?-ERR/i.test(tqlRes) || tqlResLow.indexOf('"success":false') >= 0 || tqlResLow.indexOf('"success": false') >= 0) {
                return cb(null, 'Error: TQL 실행 검증 실패: ' + tqlRes.substring(0, 500) + tqlHint);
              }
              function writeIt() {
                mc.writeFile(filename, tqlContent, function (err2) {
                  if (err2) return cb(null, 'Error: Failed to save file: ' + err2.message);
                  cb(null, 'TQL file saved: ' + filename + shiftedMsg);
                });
              }
              // 안전장치: TQL 문법은 맞아도 데이터 0건이면 빈 차트 → 우선 실제 데이터 범위로 자동 스냅 재시도, 그래도 0건이면 거부.
              // (모델이 시간 범위를 틀려도 — 예: 다른 테이블 범위 재사용 — 테이블에 데이터가 있으면 자동 교정)
              var sqlM = tqlContent.match(/SQL\(\s*`([\s\S]*?)`\s*\)/);
              if (!sqlM) return writeIt();
              mc.querySQL(sqlM[1], 'ms', '', '', function (qerr, qres) {
                // 추출 SQL을 직접 실행: CHART가 에러를 차트로 삼켜도 raw SQL이라 에러가 그대로 드러난다.
                // 구문/GROUP BY/컬럼 에러(MACHCLI-ERR / success:false)면 거부 — qerr.message(HTTP 500 본문) 또는 qres에서 탐지.
                var qBlob = (qerr && qerr.message ? qerr.message : '') + ' ' + String(qres || '');
                if (/MACH(?:CLI)?-ERR/i.test(qBlob) || /"success"\s*:\s*false/i.test(qBlob)) {
                  return cb(null, 'Error: TQL 실행 검증 실패(SQL): ' + qBlob.substring(0, 400) + tqlHint);
                }
                if (qerr) return writeIt(); // 에러 마커 없는 검증쿼리 실패(네트워크 등)는 과잉차단 방지 위해 통과
                if (rowsPresent(qres)) return writeIt();

                // 0건 → 테이블 실제 MIN/MAX(TIME)으로 TO_DATE 범위 스냅 후 재검
                var tmF = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(tqlContent);
                var tdAll = tqlContent.match(/TO_DATE\s*\(\s*'([^']+)'\s*\)/g);
                if (!tmF || !tdAll || tdAll.length < 2) return cb(null, ZERO_ROW_MSG);
                mc.querySQL('SELECT MIN(TIME), MAX(TIME) FROM ' + tmF[1].toUpperCase(), 'ms', '', '', function (me, mr) {
                  if (me) return cb(null, ZERO_ROW_MSG);
                  var mn = 0, mx = 0;
                  try {
                    var mp = JSON.parse(mr);
                    if (mp && mp.data && mp.data.rows && mp.data.rows.length > 0) {
                      mn = parseInt(String(mp.data.rows[0][0]), 10);
                      mx = parseInt(String(mp.data.rows[0][1]), 10);
                    }
                  } catch (e) {}
                  if (!mn || !mx) return cb(null, ZERO_ROW_MSG);
                  function p2(n) { return (n < 10 ? '0' : '') + n; }
                  function fmt(ms) { var d = new Date(ms); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); }
                  var d0 = (tdAll[0].match(/'([^']+)'/) || [])[1];
                  var d1 = (tdAll[1].match(/'([^']+)'/) || [])[1];
                  var snapped = tqlContent.replace("TO_DATE('" + d0 + "')", "TO_DATE('" + fmt(mn) + "')").replace("TO_DATE('" + d1 + "')", "TO_DATE('" + fmt(mx) + "')");
                  var sm2 = snapped.match(/SQL\(\s*`([\s\S]*?)`\s*\)/);
                  if (!sm2) return cb(null, ZERO_ROW_MSG);
                  mc.querySQL(sm2[1], 'ms', '', '', function (e4, r4) {
                    if (e4 || !rowsPresent(r4)) return cb(null, ZERO_ROW_MSG);
                    tqlContent = snapped;
                    shiftedMsg += '\n[주의] 요청 시간 범위에 데이터가 없어 실제 데이터 범위로 자동 조정: ' + fmt(mn) + ' ~ ' + fmt(mx);
                    console.println('[tql] 0-row → snapped to data range: ' + fmt(mn) + ' ~ ' + fmt(mx));
                    writeIt();
                  });
                });
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
