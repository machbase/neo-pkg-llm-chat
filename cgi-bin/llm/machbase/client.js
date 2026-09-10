var http2 = require('@jsh/http');

var _client = http2.NewClient();

/**
 * Sync HTTP helper using @jsh/http.Client.do() — blocking call.
 * cb(err, bodyText) is called synchronously before httpDo returns.
 */
function httpDo(method, url, headers, body, cb) {
  try {
    var req = http2.NewRequest(method, url);
    if (headers) {
      var keys = Object.keys(headers);
      for (var i = 0; i < keys.length; i++) req.header.set(keys[i], headers[keys[i]]);
    }
    if (body) req.writeString(body);

    var resp = _client.do(req);
    var text = '';
    try { text = resp.string(); } catch (e) { /* empty */ }
    if (!resp.ok) {
      var httpErr = new Error('HTTP ' + resp.statusCode + ': ' + text.substring(0, 200));
      httpErr.status = resp.statusCode;
      cb(httpErr);
      return;
    }
    cb(null, text);
  } catch (e) {
    cb(e);
  }
}

function createClient(cfg) {
  var baseURL = 'http://' + cfg.host + ':' + cfg.port;
  var jwtToken = '';
  var jwtExp = 0;
  var TOKEN_TTL_MS = 4 * 60 * 1000;

  function querySQL(sql, timeformat, tz, format, cb) {
    var params = ['q=' + encodeURIComponent(sql)];
    if (timeformat) params.push('timeformat=' + encodeURIComponent(timeformat));
    if (tz) params.push('tz=' + encodeURIComponent(tz));
    if (format) params.push('format=' + encodeURIComponent(format));
    // /web/machbase 는 /db/query 와 동작·응답이 같고 JWT 로 사용자를 검증한다. 이 호출은
    // config 계정의 권한으로 실행되므로 권한 밖 테이블은 DB 가 거부한다.
    authRequest('GET', '/web/machbase?' + params.join('&'), null, null, cb);
  }

  // X-Console-Id 가 있어야 TQL 이 토큰의 사용자로 실행된다. 없으면 서버 자체 커넥션(SYS)으로
  // 돌아 권한 밖 테이블까지 읽힌다. 값 자체는 식별용이라 고정 문자열로 충분하고,
  // 로그 레벨을 NONE 으로 두어 콘솔 스트림을 만들지 않는다.
  var TQL_CONSOLE_HEADERS = {
    'Content-Type': 'text/plain',
    'X-Console-Id': 'neo-pkg-llm-chat, console-log-level=NONE',
    'X-Console-Log-Level': 'NONE',
  };

  function executeTQL(tqlContent, cb) {
    authRequest('POST', '/web/api/tql', TQL_CONSOLE_HEADERS, tqlContent, cb);
  }

  function login(cb) {
    var payload = JSON.stringify({ loginName: cfg.user, password: cfg.password });
    httpDo('POST', baseURL + '/web/api/login', { 'Content-Type': 'application/json' }, payload, function (err, body) {
      if (err) return cb(err);
      try {
        var result = JSON.parse(body);
        if (!result.success) return cb(new Error('Login failed: ' + result.reason));
        jwtToken = result.accessToken;
        // 서버의 accessToken 수명은 300초. 전송 지연·시계 오차로 경계에서 401 이 나지
        // 않도록 로컬 만료를 60초 앞당겨 둔다.
        jwtExp = Date.now() + TOKEN_TTL_MS;
        cb(null, jwtToken);
      } catch (e) { cb(new Error('Login parse error: ' + e.message)); }
    });
  }

  function getToken(cb) {
    if (jwtToken && Date.now() < jwtExp) return cb(null, jwtToken);
    login(cb);
  }

  // 인증 요청 공통. 401(만료·폐기)이면 캐시된 토큰을 버리고 재로그인해 한 번만 재시도한다.
  // 재시도를 1회로 묶는 이유: 계정 잠금·비밀번호 변경처럼 재로그인해도 계속 401 인 상황에서
  // 무한 재시도로 도는 것을 막기 위해서다.
  function authRequest(method, path, extraHeaders, body, cb) {
    var retried = false;
    function attempt() {
      getToken(function (err, token) {
        if (err) return cb(err);
        var headers = { 'Authorization': 'Bearer ' + token };
        if (extraHeaders) {
          var keys = Object.keys(extraHeaders);
          for (var i = 0; i < keys.length; i++) headers[keys[i]] = extraHeaders[keys[i]];
        }
        httpDo(method, baseURL + path, headers, body, function (reqErr, text) {
          if (reqErr && reqErr.status === 401 && !retried) {
            retried = true;
            jwtToken = '';
            jwtExp = 0;
            return attempt();
          }
          cb(reqErr, text);
        });
      });
    }
    attempt();
  }

  function webGet(path, cb) {
    authRequest('GET', path, null, null, cb);
  }

  function webPost(path, payload, cb) {
    authRequest('POST', path, { 'Content-Type': 'application/json' }, payload ? JSON.stringify(payload) : undefined, cb);
  }

  function webPostRaw(path, contentType, data, cb) {
    authRequest('POST', path, { 'Content-Type': contentType }, data, cb);
  }

  function webDelete(path, cb) {
    authRequest('DELETE', path, null, null, cb);
  }

  function webPut(path, payload, cb) {
    authRequest('PUT', path, { 'Content-Type': 'application/json' }, payload ? JSON.stringify(payload) : undefined, cb);
  }

  function escapePath(p) {
    return p.split('/').map(function (seg) { return encodeURIComponent(seg); }).join('/');
  }

  function createFolder(folderPath, cb) {
    webPost('/web/api/files/' + escapePath(folderPath) + '/', null, function (err, body) {
      if (err) return cb(err);
      try {
        var parsed = JSON.parse(body);
        if (parsed && !parsed.success) {
          if ((parsed.reason || '').toLowerCase().indexOf('already exist') >= 0) return cb(null);
          return cb(new Error('Create folder failed: ' + parsed.reason));
        }
        cb(null);
      } catch (e) { cb(e); }
    });
  }

  function writeFile(relPath, data, cb) {
    webPostRaw('/web/api/files/' + escapePath(relPath), 'application/octet-stream', data, function (err) { cb(err); });
  }

  function readFile(relPath, cb) {
    webGet('/web/api/files/' + escapePath(relPath), cb);
  }

  function deleteFile(relPath, cb) {
    webDelete('/web/api/files/' + escapePath(relPath), function (err) { cb(err); });
  }

  function listDir(relPath, cb) {
    webGet('/web/api/files/' + escapePath(relPath), function (err, data) {
      if (err) return cb(err);
      try {
        var parsed = JSON.parse(data);
        var result = [];
        if (parsed && parsed.data && parsed.data.children) {
          var children = parsed.data.children;
          for (var i = 0; i < children.length; i++) result.push({ name: children[i].name, type: children[i].type });
        }
        cb(null, result);
      } catch (e) { cb(e); }
    });
  }

  return {
    querySQL: querySQL, executeTQL: executeTQL,
    webGet: webGet, webPost: webPost, webPostRaw: webPostRaw, webDelete: webDelete, webPut: webPut,
    createFolder: createFolder, writeFile: writeFile, readFile: readFile, deleteFile: deleteFile, listDir: listDir,
    escapePath: escapePath, baseURL: baseURL, user: cfg.user,
  };
}

module.exports = { createClient };
