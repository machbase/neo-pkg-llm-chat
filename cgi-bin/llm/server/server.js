var http = require('http');
var http2 = require('@jsh/http');

var { WebSocketServer } = require('ws');
var { createGateway } = require('./ws_gateway');
var { createAuth } = require('./auth');

function runServer(cfg, port) {
  var gateway = createGateway(cfg, port);
  var neoBase = 'http://' + cfg.machbase.host + ':' + cfg.machbase.port;
  var _proxyClient = http2.NewClient();
  var auth = createAuth(neoBase);

  setInterval(function () { gateway.reapSessions(); }, 5 * 60 * 1000);

  var server = new http.Server({
    network: 'tcp',
    address: '0.0.0.0:' + port,
  });

  // --- Relay helpers ---

  function copyResponse(ctx, resp) {
    setCORS(ctx);
    var headers = resp.headers || {};
    var headerKeys = Object.keys(headers);
    for (var i = 0; i < headerKeys.length; i++) {
      var k = headerKeys[i];
      if (k.toLowerCase() === 'transfer-encoding') continue;
      ctx.setHeader(k, headers[k]);
    }
    // ctx.response.status() 는 getter — 상태 설정은 ctx.status().
    ctx.status(resp.statusCode);
    var text = '';
    try { text = resp.string(); } catch (e) {}
    ctx.response.write(text);
  }

  function relayError(ctx, route, err) {
    console.println('[Server] proxy ' + route + ' failed: ' + err.message);
    setCORS(ctx);
    ctx.json(502, { error: 'relay failed: ' + err.message });
  }

  // --- Relay routes (proxy to machbase-neo) ---

  // 브라우저의 TQL 실행 중계. 인증 경로(/web/api/tql)로 보내고 호출자의 토큰을 그대로 넘긴다.
  // 서비스 계정 토큰으로 대신 채우지 않는다 — 그러면 누구나 이 경로로 무인증 실행이 된다.
  server.post('/db/tql', function (ctx) {
    var qs = ctx.request.queryString;
    var targetURL = neoBase + '/web/api/tql' + (qs ? '?' + qs : '');
    try {
      var body = ctx.request.body;
      var reqBody = (typeof body === 'string') ? body : JSON.stringify(body);
      var req = http2.NewRequest('POST', targetURL);
      req.header.set('Content-Type', ctx.request.getHeader('Content-Type') || 'text/plain');
      var tqlAuth = ctx.request.getHeader('Authorization');
      if (tqlAuth) req.header.set('Authorization', tqlAuth);
      // 이 헤더가 있어야 TQL 이 호출자의 계정으로 실행된다(없으면 SYS 권한으로 돈다).
      req.header.set('X-Console-Id', 'neo-pkg-llm-chat, console-log-level=NONE');
      req.header.set('X-Console-Log-Level', 'NONE');
      if (reqBody) req.writeString(reqBody);
      var resp = _proxyClient.do(req);
      setCORS(ctx);
      var text = '';
      try { text = resp.string(); } catch (e2) {}
      var isChart = (text.indexOf('"chartID"') !== -1 || text.indexOf('"geomapID"') !== -1) && text.indexOf('/web/') !== -1;
      if (isChart) {
        text = text.replace(/("\/web\/)/g, '"' + neoBase + '/web/');
      }
      var headers = resp.headers || {};
      var headerKeys = Object.keys(headers);
      for (var hi = 0; hi < headerKeys.length; hi++) {
        var hk = headerKeys[hi];
        var hkl = hk.toLowerCase();
        if (hkl === 'transfer-encoding' || hkl === 'content-length') continue;
        ctx.setHeader(hk, headers[hk]);
      }
      ctx.status(resp.statusCode);
      ctx.response.write(text);
    } catch (e) {
      relayError(ctx, '/db/tql', e);
    }
  });

  server.get('/web/*path', function (ctx) {
    // 라우터의 *path 캡처는 앞 슬래시를 포함한다. 그대로 이으면 '/web//api/...' 가 되어
    // 정적 에셋 외의 경로가 전부 404 가 된다.
    var sub = String(ctx.param('path') || '');
    if (sub.charAt(0) === '/') sub = sub.slice(1);
    var path = '/web/' + sub;
    var qs = ctx.request.queryString;
    var targetURL = neoBase + path + (qs ? '?' + qs : '');
    try {
      var req = http2.NewRequest('GET', targetURL);
      // 호출자의 토큰만 넘긴다. 서비스 계정 토큰을 덧씌우면 브라우저가 그 계정 권한으로
      // /web/api/* 를 호출할 수 있다. 차트 에셋(/web/echarts/*, /web/api/tql-assets/*)은
      // 인증을 요구하지 않으므로 토큰 없이도 로드된다.
      var clientAuth = ctx.request.getHeader('Authorization');
      if (clientAuth) req.header.set('Authorization', clientAuth);
      copyResponse(ctx, _proxyClient.do(req));
    } catch (e) {
      relayError(ctx, path, e);
    }
  });

  server.post('/web/*path', function (ctx) {
    // 라우터의 *path 캡처는 앞 슬래시를 포함한다. 그대로 이으면 '/web//api/...' 가 되어
    // 정적 에셋 외의 경로가 전부 404 가 된다.
    var sub = String(ctx.param('path') || '');
    if (sub.charAt(0) === '/') sub = sub.slice(1);
    var path = '/web/' + sub;
    var qs = ctx.request.queryString;
    var targetURL = neoBase + path + (qs ? '?' + qs : '');
    try {
      var body = ctx.request.body;
      var reqBody = (typeof body === 'string') ? body : JSON.stringify(body);
      var req = http2.NewRequest('POST', targetURL);
      req.header.set('Content-Type', ctx.request.getHeader('Content-Type') || 'application/json');
      var clientAuth = ctx.request.getHeader('Authorization');
      if (clientAuth) req.header.set('Authorization', clientAuth);
      if (reqBody) req.writeString(reqBody);
      copyResponse(ctx, _proxyClient.do(req));
    } catch (e) {
      relayError(ctx, path, e);
    }
  });

  // --- Config API ---

  var fs = require('fs');
  var pathMod = require('path');
  var process2 = require('process');
  var ARGV1 = process2.argv[1] || '';
  var CGI_BIN_DIR = ARGV1.slice(0, ARGV1.lastIndexOf('/llm'));
  if (!CGI_BIN_DIR) CGI_BIN_DIR = pathMod.resolve('..');
  var CONFIGS_DIR = pathMod.join(CGI_BIN_DIR, 'llm', 'configs');
  var PREFS_DIR = pathMod.join(CGI_BIN_DIR, 'llm', 'prefs');
  var CONFIG_FILE = pathMod.join(CGI_BIN_DIR, 'config.json');
  var CONFIG_DEFAULT = { server: { port: '8884' } };

  console.println('[Server] CONFIGS_DIR: ' + CONFIGS_DIR);
  console.println('[Server] PREFS_DIR: ' + PREFS_DIR);
  console.println('[Server] CONFIG_FILE: ' + CONFIG_FILE);

  function setCORS(ctx) {
    ctx.setHeader('Access-Control-Allow-Origin', '*');
    ctx.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    ctx.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  function parseBody(ctx) {
    var body = ctx.request.body;
    if (typeof body === 'string') return JSON.parse(body);
    return body;
  }

  function readConfigFile(name) {
    var fp = pathMod.join(CONFIGS_DIR, name + '.json');
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, { encoding: 'utf8' }));
  }

  function writeConfigFile(name, data) {
    if (!fs.existsSync(CONFIGS_DIR)) fs.mkdirSync(CONFIGS_DIR, { recursive: true });
    fs.writeFileSync(pathMod.join(CONFIGS_DIR, name + '.json'), JSON.stringify(data, null, 2));
  }

  function removeConfigFile(name) {
    var fp = pathMod.join(CONFIGS_DIR, name + '.json');
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  // ── Per-user UI prefs (favorites) ──
  // Conservative filename charset to avoid path traversal via the `user` param.
  function safePrefName(name) {
    return String(name || '').replace(/[^A-Za-z0-9_.-]/g, '_') || 'sys';
  }
  function readPrefsFile(user) {
    var fp = pathMod.join(PREFS_DIR, safePrefName(user) + '.json');
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, { encoding: 'utf8' }));
  }
  function writePrefsFile(user, data) {
    if (!fs.existsSync(PREFS_DIR)) fs.mkdirSync(PREFS_DIR, { recursive: true });
    fs.writeFileSync(pathMod.join(PREFS_DIR, safePrefName(user) + '.json'), JSON.stringify(data, null, 2));
  }
  function sanitizeFavorites(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (it && typeof it.prompt === 'string' && it.prompt.trim()) {
        out.push({
          id: (typeof it.id === 'string' && it.id) ? it.id : ('fav-' + Date.now() + '-' + i),
          prompt: String(it.prompt),
        });
      }
    }
    return out;
  }

  function jsonReply(ctx, status, data) {
    setCORS(ctx);
    // 상태 설정은 ctx.json/ctx.status 로 한다. ctx.response.status() 는 현재 상태를 읽는
    // getter 라 인자를 줘도 무시되고 응답이 전부 200 으로 나간다.
    ctx.json(status, data);
  }

  function readMainConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, { encoding: 'utf8' }));
      }
    } catch (e) {}
    return JSON.parse(JSON.stringify(CONFIG_DEFAULT));
  }

  function listConfigNames() {
    if (!fs.existsSync(CONFIGS_DIR)) return [];
    var files = fs.readdirSync(CONFIGS_DIR);
    var names = [];
    for (var i = 0; i < files.length; i++) {
      if (files[i].endsWith('.json')) names.push(files[i].replace(/\.json$/, ''));
    }
    return names;
  }

  // -- config 접근 제어 --
  // config 파일은 계정의 DB 자격증명과 LLM API 키를 담고, 파일명이 곧 워커의 실행 계정이다.
  // 따라서 본인 것만 읽고 쓸 수 있어야 한다. 판정은 요청의 JWT 로 하며, 브라우저가 보내는
  // 이름(경로·본문)은 신뢰하지 않는다.
  function requestUser(ctx) {
    return auth.verifyToken(auth.bearerOf(ctx.request.getHeader('Authorization')));
  }
  function denyUnauthenticated(ctx) {
    jsonReply(ctx, 401, { success: false, reason: 'authentication required' });
  }
  function denyForbidden(ctx) {
    jsonReply(ctx, 403, { success: false, reason: 'forbidden' });
  }
  function ownConfigNames(user) {
    return listConfigNames().filter(function (n) { return n === user; });
  }
  // 저장되는 machbase.user 를 인증된 사용자로 고정 -- 본문에 다른 계정을 적어 보내
  // 그 계정으로 실행시키는 것을 막는다.
  function forceOwner(parsed, user) {
    parsed = parsed || {};
    parsed.machbase = parsed.machbase || {};
    parsed.machbase.user = user;
    return parsed;
  }

  // /api/config
  server.get('/api/config', function (ctx) {
    jsonReply(ctx, 200, { success: true, reason: 'success', data: readMainConfig() });
  });
  server.put('/api/config', handleMainConfigPut);
  server.post('/api/config', function (ctx) {
    var override = (ctx.query('_method') || '').toUpperCase();
    if (override === 'PUT') { handleMainConfigPut(ctx); return; }
    jsonReply(ctx, 405, { success: false, reason: 'method not allowed (use _method=PUT)' });
  });

  function handleMainConfigPut(ctx) {
    try {
      var parsed = parseBody(ctx);
      var existing = readMainConfig();
      if (parsed.server && parsed.server.port) {
        existing.server = existing.server || {};
        existing.server.port = String(parsed.server.port);
      }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2));
      jsonReply(ctx, 200, { success: true, reason: 'success', data: existing });
    } catch (e) {
      jsonReply(ctx, 500, { success: false, reason: 'failed to save: ' + e.message });
    }
  }

  // /api/configs
  server.get('/api/configs', function (ctx) {
    var user = requestUser(ctx);
    if (!user) return denyUnauthenticated(ctx);
    var name = ctx.query('name');
    if (!name) {
      jsonReply(ctx, 200, { success: true, reason: 'success', data: { configs: ownConfigNames(user) } });
      return;
    }
    if (name !== user) return denyForbidden(ctx);
    try {
      var data = readConfigFile(name);
      if (!data) { jsonReply(ctx, 404, { success: false, reason: 'config not found: ' + name }); }
      else { jsonReply(ctx, 200, { success: true, reason: 'success', data: { config: data, running: false } }); }
    } catch (e) { jsonReply(ctx, 500, { success: false, reason: e.message }); }
  });
  server.post('/api/configs', function (ctx) {
    var override = (ctx.query('_method') || '').toUpperCase();
    if (override === 'PUT') { handleConfigsPutByQuery(ctx); return; }
    if (override === 'DELETE') { handleConfigsDeleteByQuery(ctx); return; }
    var user = requestUser(ctx);
    if (!user) return denyUnauthenticated(ctx);
    try {
      writeConfigFile(user, forceOwner(parseBody(ctx), user));
      jsonReply(ctx, 201, { success: true, reason: 'success', data: { name: user } });
    } catch (e) { jsonReply(ctx, 500, { success: false, reason: e.message }); }
  });
  server.put('/api/configs', handleConfigsPutByQuery);
  server.delete('/api/configs', handleConfigsDeleteByQuery);

  function handleConfigsPutByQuery(ctx) {
    var user = requestUser(ctx);
    if (!user) return denyUnauthenticated(ctx);
    var name = ctx.query('name');
    if (!name) { jsonReply(ctx, 400, { success: false, reason: 'name parameter required' }); return; }
    if (name !== user) return denyForbidden(ctx);
    try { writeConfigFile(name, forceOwner(parseBody(ctx), user)); jsonReply(ctx, 200, { success: true, reason: 'success', data: { name: name } }); }
    catch (e) { jsonReply(ctx, 500, { success: false, reason: e.message }); }
  }
  function handleConfigsDeleteByQuery(ctx) {
    var user = requestUser(ctx);
    if (!user) return denyUnauthenticated(ctx);
    var name = ctx.query('name');
    if (!name) { jsonReply(ctx, 400, { success: false, reason: 'name parameter required' }); return; }
    if (name !== user) return denyForbidden(ctx);
    try { removeConfigFile(name); jsonReply(ctx, 200, { success: true, reason: 'success', data: { name: name } }); }
    catch (e) { jsonReply(ctx, 500, { success: false, reason: e.message }); }
  }

  // /api/configs/:name
  server.get('/api/configs/:name', function (ctx) {
    var user = requestUser(ctx);
    if (!user) return denyUnauthenticated(ctx);
    var name = ctx.param('name');
    if (name !== user) return denyForbidden(ctx);
    try {
      var data = readConfigFile(name);
      if (!data) { jsonReply(ctx, 404, { success: false, reason: 'config not found: ' + name }); }
      else { jsonReply(ctx, 200, { success: true, reason: 'success', data: { config: data, running: false } }); }
    } catch (e) { jsonReply(ctx, 500, { success: false, reason: e.message }); }
  });
  server.put('/api/configs/:name', handleConfigPutByName);
  server.delete('/api/configs/:name', handleConfigDeleteByName);
  server.post('/api/configs/:name', function (ctx) {
    var override = (ctx.query('_method') || '').toUpperCase();
    if (override === 'DELETE') { handleConfigDeleteByName(ctx); return; }
    handleConfigPutByName(ctx);
  });

  function handleConfigPutByName(ctx) {
    var user = requestUser(ctx);
    if (!user) return denyUnauthenticated(ctx);
    var name = ctx.param('name');
    if (name !== user) return denyForbidden(ctx);
    try { writeConfigFile(name, forceOwner(parseBody(ctx), user)); jsonReply(ctx, 200, { success: true, reason: 'success', data: { name: name } }); }
    catch (e) { jsonReply(ctx, 500, { success: false, reason: e.message }); }
  }
  function handleConfigDeleteByName(ctx) {
    var user = requestUser(ctx);
    if (!user) return denyUnauthenticated(ctx);
    var name = ctx.param('name');
    if (name !== user) return denyForbidden(ctx);
    try { removeConfigFile(name); jsonReply(ctx, 200, { success: true, reason: 'success', data: { name: name } }); }
    catch (e) { jsonReply(ctx, 500, { success: false, reason: e.message }); }
  }

  // /api/prefs — per-user UI preferences (favorites)
  // GET  /api/prefs   → { favorites: [...] }
  // POST /api/prefs   (text/plain body { favorites: [...] }) → saves
  // 대상 사용자는 요청의 JWT 에서 정한다 — 이름을 파라미터로 받으면 남의 즐겨찾기를
  // 읽고 덮어쓸 수 있다.
  // POST is used for saves (Content-Type text/plain) to avoid a CORS preflight,
  // same convention as /api/configs.
  function handlePrefsSave(ctx) {
    var user = requestUser(ctx);
    if (!user) return denyUnauthenticated(ctx);
    try {
      var parsed = parseBody(ctx) || {};
      var favorites = sanitizeFavorites(parsed.favorites);
      writePrefsFile(user, { favorites: favorites });
      jsonReply(ctx, 200, { success: true, reason: 'success', data: { favorites: favorites } });
    } catch (e) {
      jsonReply(ctx, 500, { success: false, reason: e.message });
    }
  }
  server.get('/api/prefs', function (ctx) {
    var user = requestUser(ctx);
    if (!user) return denyUnauthenticated(ctx);
    try {
      var data = readPrefsFile(user) || {};
      jsonReply(ctx, 200, { success: true, reason: 'success', data: { favorites: sanitizeFavorites(data.favorites) } });
    } catch (e) {
      jsonReply(ctx, 500, { success: false, reason: e.message });
    }
  });
  server.post('/api/prefs', handlePrefsSave);
  server.put('/api/prefs', handlePrefsSave);

  // /api/debug
  server.get('/api/debug', function (ctx) {
    if (!requestUser(ctx)) return denyUnauthenticated(ctx);
    var dirExists = fs.existsSync(CONFIGS_DIR);
    var fileExists = fs.existsSync(CONFIG_FILE);
    var files = [];
    if (dirExists) { try { files = fs.readdirSync(CONFIGS_DIR); } catch (e) {} }
    jsonReply(ctx, 200, {
      CONFIGS_DIR: CONFIGS_DIR, CONFIGS_DIR_EXISTS: dirExists, CONFIGS_FILES: files,
      CONFIG_FILE: CONFIG_FILE, CONFIG_FILE_EXISTS: fileExists,
      activeWorkers: Object.keys(gateway.routes).length,
    });
  });

  // /api/info
  server.get('/api/info', function (ctx) {
    var mainCfg = readMainConfig();
    var p = (mainCfg.server && mainCfg.server.port) || '8884';
    jsonReply(ctx, 200, { ok: true, data: { port: p } });
  });

  // /health — neo service proxy 의 healthPath 메타데이터 대상.
  // 프록시 자체는 호출하지 않지만 servicectl proxy list 등에서 가리킨다.
  server.get('/health', function (ctx) {
    jsonReply(ctx, 200, { ok: true });
  });

  // --- WebSocket: external (browser) ---
  // 라우트를 둘로 나눠 등록한다 — JSH ws 의 path 매칭은 path-template 의 끝 segment 가
  // 정적일 때만 동작하므로 /ws/:user 형태 하나로는 합칠 수 없다.
  // service proxy 경유 WS 는 이 라우트들로 도달하지 않는다.
  var wss = new WebSocketServer({ server: server, path: '/ws' });
  var wss2 = new WebSocketServer({ server: server, path: '/:user/ws' });

  // 사용자 식별은 메시지에 실려 오는 neo JWT 로만 한다. URL segment 나 본문 user_id 는
  // 브라우저가 정하는 값이라 신뢰하지 않는다. 검증된 이름은 연결 단위로 유지한다.
  function onBrowserConnection(socket) {
    var verifiedUser = '';
    console.println('[Server] Browser WS connected');

    socket.on('message', function (event) {
      var raw = (typeof event === 'string') ? event : (event && event.data) ? event.data : String(event);
      if (!verifiedUser) {
        var token = '';
        try { token = (JSON.parse(raw) || {}).auth_token || ''; } catch (e) { /* 비 JSON 은 아래에서 무시됨 */ }
        verifiedUser = auth.verifyToken(token) || '';
        if (verifiedUser) console.println('[Server] WS authenticated: ' + verifiedUser);
      }
      gateway.handleBrowserMessage(socket, raw, verifiedUser);
    });

    socket.on('close', function () {
      console.println('[Server] Browser WS disconnected');
      gateway.cleanupBrowserConnection(socket);
    });
  }

  wss.on('connection', onBrowserConnection);
  wss2.on('connection', onBrowserConnection);

  // --- WebSocket: internal (workers) ---
  var wssInternal = new WebSocketServer({ server: server, path: '/internal/ws' });

  wssInternal.on('connection', function (socket, request) {
    console.println('[Server] Worker WS connected');
    gateway.handleWorkerConnection(socket);
  });

  // --- Graceful shutdown ---
  // Worker cleanup is handled by scripts/stop.js (runs as separate process,
  // can call service.stop). Gateway shutdownHook only closes the HTTP server.
  var process3 = require('process');
  process3.addShutdownHook(function () {
    console.println('[Server] Shutdown hook triggered');
    try { server.close(); } catch (e) {}
    console.println('[Server] Shutdown complete');
  });

  console.println('[Server] Gateway listening on :' + port);
  server.serve();
}

module.exports = { runServer };
