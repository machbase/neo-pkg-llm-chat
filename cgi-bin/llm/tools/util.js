var fs = require('fs');
var path = require('path');
var http2 = require('@jsh/http');
var _httpClient = http2.NewClient();

function readPkgVersion() {
  try {
    var pkgPath = path.resolve(__dirname, '../../package.json');
    var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch (e) { return 'unknown'; }
}

function listInstalledPackages() {
  var packages = [];
  try {
    var publicDir = path.resolve(__dirname, '../../../..');
    var entries = fs.readdirSync(publicDir);
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var entryPath = path.join(publicDir, entry);
      try {
        var stat = fs.statSync(entryPath);
        if (!stat.isDirectory()) continue;
      } catch (e) { continue; }
      if (entry.indexOf('neo-pkg-') !== 0) continue;
      var info = { name: entry };
      try {
        var pkg = JSON.parse(fs.readFileSync(path.join(entryPath, 'package.json'), 'utf8'));
        info.version = pkg.version || 'unknown';
      } catch (e) { info.version = 'unknown'; }
      packages.push(info);
    }
  } catch (e) { /* ignore */ }
  return packages;
}

// Check package health via CGI endpoint (sync HTTP call)
function checkPackageHealth(baseURL, pkgName) {
  try {
    var url = baseURL + '/public/' + pkgName + '/cgi-bin/api/health';
    var req = http2.NewRequest('GET', url);
    var resp = _httpClient.do(req);
    var text = '';
    try { text = resp.string(); } catch (e) { /* empty */ }
    if (!resp.ok) return { status: 'http_' + resp.statusCode };
    var parsed = JSON.parse(text);
    if (parsed && parsed.ok && parsed.data) {
      return { status: parsed.data.status || 'unknown', pid: parsed.data.pid || 0 };
    }
    return { status: 'unknown' };
  } catch (e) {
    return { status: 'unreachable' };
  }
}

function register(registry, mc) {
  registry.register({
    name: 'get_version',
    description: 'Get version, installed packages with health status, and Machbase Neo server info (config, storage, sessions).',
    parameters: { type: 'object', properties: {} },
    fn: function (args, cb) {
      var packages = listInstalledPackages();

      // Check health for each package via CGI (sync, fast)
      for (var p = 0; p < packages.length; p++) {
        var health = checkPackageHealth(mc.baseURL, packages[p].name);
        packages[p].service_status = health.status;
        if (health.pid) packages[p].service_pid = health.pid;
      }

      var info = {
        package: { name: 'neo-pkg-llm-chat', version: readPkgVersion(), runtime: 'JSH (Machbase Neo embedded JavaScript)' },
        installed_packages: packages,
        machbase: { status: 'unknown' },
      };

      // 1) DB connection check
      mc.querySQL('SELECT 1', '', '', '', function (err) {
        info.machbase.status = err ? 'disconnected' : 'connected';
        if (err) return cb(null, JSON.stringify(info, null, 2));

        // 2) Server config via V$PROPERTY
        mc.querySQL("SELECT NAME, VALUE FROM V$PROPERTY WHERE NAME IN ('BIND_IP_ADDRESS','PORT_NO','HANDLE_LIMIT','PROCESS_MAX_SIZE','TAG_PARTITION_COUNT','TAG_CACHE_ENABLE','TAG_CACHE_MAX_MEMORY_SIZE','RS_CACHE_ENABLE','RS_CACHE_MAX_MEMORY_SIZE')", '', '', '', function (err2, raw2) {
          if (!err2 && raw2) {
            try {
              var parsed = JSON.parse(raw2);
              if (parsed && parsed.data && parsed.data.rows) {
                var props = {};
                var rows = parsed.data.rows;
                for (var i = 0; i < rows.length; i++) props[rows[i][0]] = rows[i][1];
                info.machbase.config = props;
              }
            } catch (e) { /* ignore */ }
          }

          // 3) Storage usage via V$STORAGE
          mc.querySQL("SELECT * FROM V$STORAGE", '', '', '', function (err3, raw3) {
            if (!err3 && raw3) {
              try {
                var parsed = JSON.parse(raw3);
                if (parsed && parsed.data && parsed.data.columns && parsed.data.rows && parsed.data.rows.length > 0) {
                  var storage = {};
                  var cols = parsed.data.columns;
                  var row = parsed.data.rows[0];
                  for (var i = 0; i < cols.length; i++) storage[cols[i]] = row[i];
                  info.machbase.storage = storage;
                }
              } catch (e) { /* ignore */ }
            }

            // 4) Session info via V$SESSION
            mc.querySQL("SELECT ID, USER_NAME, CLIENT_TYPE, LOGIN_TIME FROM V$SESSION", '', '', '', function (err4, raw4) {
              if (!err4 && raw4) {
                try {
                  var parsed = JSON.parse(raw4);
                  if (parsed && parsed.data && parsed.data.rows) {
                    info.machbase.sessions = {
                      count: parsed.data.rows.length,
                      list: parsed.data.rows.slice(0, 20).map(function (r) {
                        return { id: r[0], user: r[1], client_type: r[2], login_time: r[3] };
                      }),
                    };
                  }
                } catch (e) { /* ignore */ }
              }

              // 5) Table count
              var owner = (mc.user || 'SYS').toUpperCase();
              mc.querySQL("SELECT COUNT(*) AS CNT FROM M$SYS_TABLES AS st JOIN M$SYS_USERS AS su ON st.USER_ID = su.USER_ID WHERE su.NAME = '" + owner + "' AND st.FLAG = 0", '', '', '', function (err5, raw5) {
                if (!err5 && raw5) {
                  try {
                    var parsed = JSON.parse(raw5);
                    if (parsed && parsed.data && parsed.data.rows && parsed.data.rows.length > 0) {
                      info.machbase.table_count = parsed.data.rows[0][0];
                    }
                  } catch (e) { /* ignore */ }
                }
                var result = JSON.stringify(info, null, 2);
                result += '\n\n[지시] 위 정보를 **모두** 사용자에게 정리하여 보여주세요. 패키지 정보, 서비스 상태, DB 연결, 서버 설정(config), 스토리지(storage), 세션(sessions), 테이블 수를 빠짐없이 포함하세요.';
                cb(null, result);
              });
            });
          });
        });
      });
    },
  });

  registry.register({
    name: 'debug_mcp_status',
    description: 'Check connection status and available tools.',
    parameters: { type: 'object', properties: {} },
    fn: function (args, cb) {
      var tools = registry.toolNames();
      var status = { tools_count: tools.length, tools: tools, runtime: 'JSH' };
      mc.querySQL('SELECT 1', '', '', '', function (err) {
        status.machbase = err ? 'disconnected: ' + err.message : 'connected';
        cb(null, JSON.stringify(status, null, 2));
      });
    },
  });
}

module.exports = { register };
