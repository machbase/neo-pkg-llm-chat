var { argStr, argInt } = require('./registry');

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
      if (upper.indexOf('UPDATE ') === 0 || upper.indexOf('DELETE ') === 0) {
        return cb(null, 'Error: UPDATE/DELETE statements are not allowed.');
      }
      if (upper.indexOf('DROP ') === 0) {
        return cb(null, 'Error: DROP statements are not allowed through this tool. 사용자에게 직접 SQL 콘솔에서 실행하도록 안내하세요. 예: DROP TABLE 테이블명 CASCADE;');
      }

      var format = argStr(args, 'format', 'csv');
      var timeformat = argStr(args, 'timeformat', '');
      var timezone = argStr(args, 'timezone', '');
      var limit = argInt(args, 'limit', 500);

      if (upper.indexOf('LIMIT') === -1 && upper.indexOf('SELECT') === 0) {
        sql = sql.replace(/;?\s*$/, '') + ' LIMIT ' + limit;
      }

      // Always request JSON from Machbase, format to CSV in code if needed
      mc.querySQL(sql, timeformat, timezone, '', function (err, result) {
        if (err) return cb(null, 'Error: ' + err.message);
        if (format === 'json') return cb(null, result);
        try {
          var parsed = JSON.parse(result);
          if (!parsed.success) return cb(null, 'Error: ' + parsed.reason);
          var cols = parsed.data.columns;
          var rows = parsed.data.rows;
          var out = cols.join(',') + '\n';
          for (var i = 0; i < rows.length; i++) out += rows[i].join(',') + '\n';
          cb(null, out.trim());
        } catch (e) { cb(null, result); }
      });
    },
  });
}

module.exports = { register };
