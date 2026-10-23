var http2 = require('@jsh/http');

var _client = http2.NewClient();

// 동기 HTTP 호출(@jsh/http Client.do) — cb(err, 본문)은 반환 전에 호출됨
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

var NO_TOKEN_MSG = 'Machbase API 토큰이 없습니다. 설정에서 토큰을 입력하세요.';
var BAD_TOKEN_MSG = 'Machbase API 토큰이 유효하지 않습니다(HTTP 401). 설정에서 토큰을 확인하세요.';

// neo /db/* 클라이언트 — 인증은 API 토큰(nt_) 하나
// · cfg.token 은 CLI 용, 워커는 게이트웨이가 넘긴 토큰을 setToken 으로 주입
function createClient(cfg) {
  var baseURL = 'http://' + cfg.host + ':' + cfg.port;
  var token = cfg.token || '';

  function querySQL(sql, timeformat, tz, format, cb) {
    var params = ['q=' + encodeURIComponent(sql)];
    if (timeformat) params.push('timeformat=' + encodeURIComponent(timeformat));
    if (tz) params.push('tz=' + encodeURIComponent(tz));
    if (format) params.push('format=' + encodeURIComponent(format));
    request('GET', '/db/query?' + params.join('&'), null, null, cb);
  }

  function executeTQL(tqlContent, cb) {
    request('POST', '/db/tql', { 'Content-Type': 'text/plain' }, tqlContent, cb);
  }

  // neo 호출 단일 관문 — 토큰 없으면 미전송(헤더 없는 요청은 서버 설정에 따라 기본 신원으로 통과)
  function request(method, path, extraHeaders, body, cb) {
    if (!token) return cb(new Error(NO_TOKEN_MSG));
    var headers = { 'Authorization': 'Bearer ' + token };
    if (extraHeaders) {
      var keys = Object.keys(extraHeaders);
      for (var i = 0; i < keys.length; i++) headers[keys[i]] = extraHeaders[keys[i]];
    }
    httpDo(method, baseURL + path, headers, body, function (err, text) {
      if (err && err.status === 401) {
        var authErr = new Error(BAD_TOKEN_MSG);
        authErr.status = 401;
        return cb(authErr);
      }
      cb(err, text);
    });
  }

  function setToken(t) { token = t || ''; }

  // 시각 표시 시간대(IANA 이름) — 브라우저 시간대를 워커가 주입, 없으면 서버 시간대
  // · offset은 그 시간대의 UTC 대비 분(주입 시점 기준), 서버 시간대면 null
  var tz = '', tzOffsetMin = null;
  function setTimezone(z, offsetMin) { tz = z || ''; tzOffsetMin = tz && offsetMin != null ? offsetMin : null; }
  function timezone() { return tz || 'Local'; }
  function timezoneOffset() { return tzOffsetMin; }

  // Neo가 아는 시간대 이름인지 + 그 시간대의 지금 UTC 대비 분 → cb(ok, offsetMin)
  // · 모르는 이름이면 쿼리가 "unknown time zone"으로 실패
  function checkTimezone(z, cb) {
    if (!/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(String(z || ''))) return cb(false);
    querySQL('SELECT SYSDATE FROM M$SYS_USERS LIMIT 1', '2006-01-02 15:04:05', z, '', function (err, text) {
      var wall = '';
      try { var p = JSON.parse(text); if (!err && p.success) wall = String(p.data.rows[0][0]); } catch (e) {}
      var m = wall.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (!m) return cb(false);
      var off = (Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - Date.now()) / 60000;
      cb(true, Math.round(off / 15) * 15);
    });
  }

  // 토큰의 계정 이름(소문자), 무효면 에러
  function whoami(cb) {
    request('POST', '/db/token/validate', null, null, function (err, text) {
      if (err) return cb(err);
      try {
        var body = JSON.parse(text);
        if (!body || body.valid !== true || !body.user) return cb(new Error(BAD_TOKEN_MSG));
        cb(null, String(body.user).toLowerCase());
      } catch (e) { cb(e); }
    });
  }

  // 출력 가림용 비밀 목록
  function secrets() { return token ? [token] : []; }

  function escapePath(p) {
    return p.split('/').map(function (seg) { return encodeURIComponent(seg); }).join('/');
  }

  function createFolder(folderPath, cb) {
    request('POST', '/db/files/' + escapePath(folderPath) + '/', { 'Content-Type': 'application/json' }, undefined, function (err, body) {
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
    request('POST', '/db/files/' + escapePath(relPath), { 'Content-Type': 'application/octet-stream' }, data, function (err) { cb(err); });
  }

  function readFile(relPath, cb) {
    request('GET', '/db/files/' + escapePath(relPath), null, null, cb);
  }

  function deleteFile(relPath, cb) {
    request('DELETE', '/db/files/' + escapePath(relPath), null, null, function (err) { cb(err); });
  }

  function listDir(relPath, cb) {
    request('GET', '/db/files/' + escapePath(relPath), null, null, function (err, data) {
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
    createFolder: createFolder, writeFile: writeFile, readFile: readFile, deleteFile: deleteFile, listDir: listDir,
    setToken: setToken, secrets: secrets, whoami: whoami,
    setTimezone: setTimezone, timezone: timezone, timezoneOffset: timezoneOffset, checkTimezone: checkTimezone,
    escapePath: escapePath, baseURL: baseURL, user: cfg.user,
  };
}

module.exports = { createClient };
