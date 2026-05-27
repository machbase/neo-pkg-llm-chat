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
      cb(new Error('HTTP ' + resp.statusCode + ': ' + text.substring(0, 200)));
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

  function querySQL(sql, timeformat, tz, format, cb) {
    var params = ['q=' + encodeURIComponent(sql)];
    if (timeformat) params.push('timeformat=' + encodeURIComponent(timeformat));
    if (tz) params.push('tz=' + encodeURIComponent(tz));
    if (format) params.push('format=' + encodeURIComponent(format));
    httpDo('GET', baseURL + '/db/query?' + params.join('&'), null, null, cb);
  }

  function executeTQL(tqlContent, cb) {
    httpDo('POST', baseURL + '/db/tql', { 'Content-Type': 'text/plain' }, tqlContent, cb);
  }

  function login(cb) {
    var payload = JSON.stringify({ loginName: cfg.user, password: cfg.password });
    httpDo('POST', baseURL + '/web/api/login', { 'Content-Type': 'application/json' }, payload, function (err, body) {
      if (err) return cb(err);
      try {
        var result = JSON.parse(body);
        if (!result.success) return cb(new Error('Login failed: ' + result.reason));
        jwtToken = result.accessToken;
        jwtExp = Date.now() + 5 * 60 * 1000;
        cb(null, jwtToken);
      } catch (e) { cb(new Error('Login parse error: ' + e.message)); }
    });
  }

  function getToken(cb) {
    if (jwtToken && Date.now() < jwtExp) return cb(null, jwtToken);
    login(cb);
  }

  function webGet(path, cb) {
    getToken(function (err, token) {
      if (err) return cb(err);
      httpDo('GET', baseURL + path, { 'Authorization': 'Bearer ' + token }, null, cb);
    });
  }

  function webPost(path, payload, cb) {
    getToken(function (err, token) {
      if (err) return cb(err);
      var body = payload ? JSON.stringify(payload) : undefined;
      httpDo('POST', baseURL + path, { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body, cb);
    });
  }

  function webPostRaw(path, contentType, data, cb) {
    getToken(function (err, token) {
      if (err) return cb(err);
      httpDo('POST', baseURL + path, { 'Authorization': 'Bearer ' + token, 'Content-Type': contentType }, data, cb);
    });
  }

  function webDelete(path, cb) {
    getToken(function (err, token) {
      if (err) return cb(err);
      httpDo('DELETE', baseURL + path, { 'Authorization': 'Bearer ' + token }, null, cb);
    });
  }

  function webPut(path, payload, cb) {
    getToken(function (err, token) {
      if (err) return cb(err);
      var body = payload ? JSON.stringify(payload) : undefined;
      httpDo('PUT', baseURL + path, { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body, cb);
    });
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
