var { argStr, argInt } = require('./registry');
var { extractUserTables, checkTableOwnership } = require('./ownership');
var rangeCache = require('./range_cache');
var security = require('./security');

function register(registry, mc) {
  // list_tables
  registry.register({
    name: 'list_tables',
    description: 'List all TAG tables in Machbase Neo database.',
    parameters: { type: 'object', properties: {} },
    fn: function (args, cb) {
      var owner = (mc.user || 'SYS').toUpperCase();
      mc.querySQL("SELECT st.NAME FROM M$SYS_TABLES AS st JOIN M$SYS_USERS AS su ON st.USER_ID = su.USER_ID WHERE su.NAME = '" + owner + "' AND st.FLAG = 0 ORDER BY st.NAME", '', '', '', function (err, result) {
        if (err) return cb(null, 'Error: ' + err.message);
        try {
          var parsed = JSON.parse(result);
          if (!parsed.success) return cb(null, 'Error: ' + parsed.reason);
          var rows = parsed.data.rows;
          var out = '';
          for (var i = 0; i < rows.length; i++) out += rows[i][0] + '\n';
          cb(null, out.trim() || 'No tables found.');
        } catch (e) { cb(null, 'Error: ' + e.message); }
      });
    },
  });

  // list_table_tags
  registry.register({
    name: 'list_table_tags',
    description: 'List all tag names (NAME column distinct values) in a specific TAG table.',
    parameters: {
      type: 'object',
      properties: {
        table_name: { type: 'string', description: 'Table name to query tags from' },
      },
      required: ['table_name'],
    },
    fn: function (args, cb) {
      var table = argStr(args, 'table_name', '');
      if (!table) return cb(null, 'Error: table_name is required');
      checkTableOwnership(mc, [table.toUpperCase()], function (ownerErr) {
        if (ownerErr) return cb(null, 'Error: ' + ownerErr.message);
        mc.querySQL("SELECT NAME FROM _" + table.toLowerCase() + "_meta", '', '', '', function (err, result) {
          if (err) return cb(null, 'Error: ' + err.message);
          try {
            var parsed = JSON.parse(result);
            if (!parsed.success) return cb(null, 'Error: ' + parsed.reason);
            var rows = parsed.data.rows;
            var tags = [];
            for (var i = 0; i < rows.length; i++) tags.push(rows[i][0]);
            cb(null, '[' + table + '] ' + tags.join(', '));
          } catch (e) { cb(null, 'Error: ' + e.message); }
        });
      });
    },
  });

  // describe_table
  registry.register({
    name: 'describe_table',
    description: 'Get table type (TAG/LOG) and column structure (name, type, role). Call this BEFORE generating TQL/SQL to know the actual column names. Includes ownership check.',
    parameters: {
      type: 'object',
      properties: {
        table_name: { type: 'string', description: 'Table name to describe' },
        profile: { type: 'boolean', description: 'If true (TAG tables), also return tag list, per-tag stats (count/avg/min/max) and time range(ms) for dashboard building.' },
      },
      required: ['table_name'],
    },
    fn: function (args, cb) {
      var table = argStr(args, 'table_name', '');
      if (!table) return cb(null, 'Error: table_name is required');
      var profile = (args.profile === true || String(args.profile) === 'true');
      var owner = (mc.user || 'SYS').toUpperCase();

      var upperTable = table.toUpperCase();

      // 테이블 타입 + 컬럼 정보를 한번에 조회
      var sql = "SELECT m1.TYPE AS TABLE_TYPE, m2.NAME AS COLUMN_NAME, m2.TYPE AS COL_TYPE, m2.FLAG AS COL_FLAG, m2.ID AS COL_ID " +
        "FROM M$SYS_TABLES m1, M$SYS_COLUMNS m2 " +
        "WHERE m1.ID = m2.TABLE_ID AND m1.DATABASE_ID = m2.DATABASE_ID " +
        "AND m1.USER_ID = (SELECT USER_ID FROM M$SYS_USERS WHERE NAME = '" + owner + "' LIMIT 1) " +
        "AND m1.NAME = '" + upperTable + "' AND m1.FLAG = 0 " +
        "ORDER BY m2.ID";

      // 롤업 테이블 개수 조회 (correlated subquery 미지원이므로 별도 쿼리)
      var rollupSQL = "SELECT COUNT(*) FROM M$SYS_TABLES WHERE NAME LIKE '_" + upperTable + "_ROLLUP_%' AND FLAG = 2";

      mc.querySQL(sql, '', '', '', function (err, result) {
        if (err) return cb(null, 'Error: ' + err.message);
        try {
          var parsed = JSON.parse(result);
          if (!parsed.success) return cb(null, 'Error: ' + parsed.reason);
          var rows = parsed.data.rows;
          if (!rows || rows.length === 0) return cb(null, 'Error: table not found or no permission');

          var tableType = rows[0][0] === 6 ? 'TAG' : 'LOG';
          var TYPE_NAMES = { 5: 'varchar', 6: 'datetime', 8: 'int32', 12: 'int64', 16: 'float', 20: 'double' };
          var out = '[' + upperTable + '] type: ' + tableType + '\n';

          var nameCol = '', timeCol = '', valueCol = '';
          for (var i = 0; i < rows.length; i++) {
            var colName = rows[i][1];
            var colType = TYPE_NAMES[rows[i][2]] || 'type(' + rows[i][2] + ')';
            var colFlag = rows[i][3];
            var colId = rows[i][4];

            // 내부 컬럼 건너뛰기
            if (colId === 65534) continue;
            if (colId === 0 && (colName === '_ROWID' || colName === '_ARRIVAL_TIME')) continue;

            var role = '';
            // 비트 AND — ROLLUP 테이블은 SUMMARIZED 컬럼 플래그에 rollup 비트가 더해짐(예 570425344) → 정확비교(===)로는 누락
            if (colFlag & 134217728) { role = ' PRIMARY KEY'; nameCol = colName; }
            else if (colFlag & 16777216) { role = ' BASETIME'; timeCol = colName; }
            else if (colFlag & 33554432) { role = ' SUMMARIZED'; valueCol = colName; }

            out += '- ' + colName + ' (' + colType + ')' + role + '\n';
          }

          // TAG 테이블이면 롤업 존재 여부를 실제 확인
          if (tableType !== 'TAG') {
            out += 'ROLLUP: not available\n';
            return cb(null, out.trim());
          }
          mc.querySQL(rollupSQL, '', '', '', function (err2, result2) {
            var rollupCount = 0;
            if (!err2) {
              try {
                var p2 = JSON.parse(result2);
                if (p2.success && p2.data.rows && p2.data.rows.length > 0) rollupCount = p2.data.rows[0][0];
              } catch (e) {}
            }
            if (rollupCount > 0) out += 'ROLLUP: available (' + rollupCount + ' rollup tables)\n';
            else out += 'ROLLUP: not available\n';
            if (!profile) return cb(null, out.trim());
            appendProfile(mc, upperTable, nameCol || 'NAME', timeCol || 'TIME', valueCol || 'VALUE', out, cb);
          });
        } catch (e) { cb(null, 'Error: ' + e.message); }
      });
    },
  });

  // execute_sql_query
  registry.register({
    name: 'execute_sql_query',
    description: 'Execute a SQL query on Machbase Neo and return results. Use timeformat parameter for time formatting (not inside SQL). UPDATE/DELETE/DROP statements are not allowed.',
    parameters: {
      type: 'object',
      properties: {
        sql_query: { type: 'string', description: 'SQL query to execute' },
        format: { type: 'string', description: 'Output format: csv (default) or json', default: 'csv' },
        timeformat: { type: 'string', description: 'Time format: default, ms, us, ns' },
        timezone: { type: 'string', description: 'Timezone (e.g., UTC, Asia/Seoul)' },
        limit: { type: 'integer', description: 'Max rows to return (default: 500)', default: 500 },
      },
      required: ['sql_query'],
    },
    fn: function (args, cb) {
      var sql = argStr(args, 'sql_query', '');
      if (!sql) return cb(null, 'Error: sql_query is required');

      var upper = sql.toUpperCase().trim();
      // Defense-in-depth (also enforced at registry.execute chokepoint): refuse mutation/
      // privilege statements, multi-statement, and credential-table reads; allow SELECT + setup CREATE.
      var denied = security.sqlDenied(sql);
      if (denied) return cb(null, 'Error: ' + denied);

      var format = argStr(args, 'format', 'csv');
      var timeformat = argStr(args, 'timeformat', '');
      var timezone = argStr(args, 'timezone', '');
      var limit = argInt(args, 'limit', 500);

      if (upper.indexOf('LIMIT') === -1 && upper.indexOf('SELECT') === 0) {
        sql = sql.replace(/;?\s*$/, '') + ' LIMIT ' + limit;
      }

      var userTables = extractUserTables(sql);
      var finalSQL = sql;
      checkTableOwnership(mc, userTables, function (ownerErr) {
        if (ownerErr) return cb(null, 'Error: ' + ownerErr.message);
        // Always request JSON from Machbase, format to CSV in code if needed
        mc.querySQL(finalSQL, timeformat, timezone, '', function (err, result) {
          if (err) return cb(null, 'Error: ' + err.message);
          if (format === 'json') return cb(null, result);
          try {
            var parsed = JSON.parse(result);
            if (!parsed.success) return cb(null, 'Error: ' + parsed.reason);
            var cols = parsed.data.columns;
            var rows = parsed.data.rows;
            var out = cols.join(',') + '\n';
            for (var i = 0; i < rows.length; i++) out += rows[i].join(',') + '\n';
            out = out.trim();
            // Ground-truth row count footer — prevents weak models from confabulating
            // a count from the LIMIT clause (e.g. reporting "50 rows" when only 9 returned).
            var n = rows.length;
            // effective LIMIT: explicit LIMIT in the SQL, else the auto-applied limit param
            var limM = upper.match(/\bLIMIT\s+(\d+)/);
            var effLimit = limM ? parseInt(limM[1], 10) : limit;
            var footer = '\n\n(' + n + ' row' + (n === 1 ? '' : 's') + ')';
            if (n >= effLimit) footer += ' — capped at LIMIT ' + effLimit + ', more rows may exist';
            cb(null, out + footer);
          } catch (e) { cb(null, result); }
        });
      });
    },
  });
}

// Append dashboard profile (tags + per-tag stats + time range) for TAG tables — one-call exploration.
function appendProfile(mc, table, nameCol, timeCol, valueCol, out, cb) {
  var tableLower = table.toLowerCase();
  mc.querySQL('SELECT ' + nameCol + ' FROM _' + tableLower + '_meta', '', '', '', function (errT, resT) {
    var tags = [];
    if (!errT) {
      try {
        var pT = JSON.parse(resT);
        if (pT.success && pT.data && pT.data.rows) {
          for (var i = 0; i < pT.data.rows.length; i++) tags.push(pT.data.rows[i][0]);
        }
      } catch (e) {}
    }
    out += 'tags (' + tags.length + '): ' + tags.join(', ') + '\n';

    mc.querySQL('SELECT MIN(' + timeCol + '), MAX(' + timeCol + ') FROM ' + table, 'ms', '', '', function (errR, resR) {
      if (!errR) {
        try {
          var pR = JSON.parse(resR);
          if (pR.success && pR.data && pR.data.rows && pR.data.rows.length > 0) {
            var mn = pR.data.rows[0][0], mx = pR.data.rows[0][1];
            if (mn != null && mx != null) {
              out += 'time range (ms): ' + mn + ' ~ ' + mx + '\n';
              rangeCache.set(table, parseInt(String(mn), 10), parseInt(String(mx), 10));
            }
          }
        } catch (e) {}
      }

      var statsSQL = 'SELECT ' + nameCol + ', COUNT(*), ROUND(AVG(' + valueCol + '),2), ROUND(MIN(' + valueCol + '),2), ROUND(MAX(' + valueCol + '),2) FROM ' + table + ' GROUP BY ' + nameCol;
      mc.querySQL(statsSQL, '', '', '', function (errS, resS) {
        if (!errS) {
          try {
            var pS = JSON.parse(resS);
            if (pS.success && pS.data && pS.data.rows && pS.data.rows.length > 0) {
              var srows = pS.data.rows;
              var STAT_CAP = 50;
              out += 'tag stats:\n';
              var cap = srows.length > STAT_CAP ? STAT_CAP : srows.length;
              for (var j = 0; j < cap; j++) {
                var r = srows[j];
                out += '  ' + r[0] + '  count=' + r[1] + '  avg=' + r[2] + '  min=' + r[3] + '  max=' + r[4] + '\n';
              }
              if (srows.length > STAT_CAP) out += '  …(+' + (srows.length - STAT_CAP) + ' more tags)\n';
            }
          } catch (e) {}
        }
        cb(null, out.trim());
      });
    });
  });
}

module.exports = { register };
