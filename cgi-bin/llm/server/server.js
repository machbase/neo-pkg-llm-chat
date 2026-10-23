var http = require('http');
var http2 = require('@jsh/http');

var { WebSocketServer } = require('ws');
var { createGateway } = require('./ws_gateway');
var { createAuth } = require('./auth');
var { createClient } = require('../machbase/client');
var { prepareSql, parseAmbiguity } = require('../tools/table_access');

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

  function relayError(ctx, route, err) {
    console.println('[Server] proxy ' + route + ' failed: ' + err.message);
    setCORS(ctx);
    ctx.json(502, { error: 'relay failed: ' + err.message });
  }

  // --- Relay routes (proxy to machbase-neo) ---

  // Run 코드(SQL·TQL)의 테이블 이름 정규화 — 에이전트 도구와 같은 prepareSql, 호출자 토큰의 계정 기준
  // · 접두 없는 이름 → DB.소유자.테이블
  // · 후보가 여럿이면 실행하지 않고 안내(ambiguous), 그 밖의 실패(없음·권한)는 원문 그대로 넘겨 Neo가 판정
  function qualifyRunTql(tql, authHeader) {
    var out = { tql: tql };
    var token = auth.bearerOf(authHeader);
    var user = (token && tql) ? auth.verifyToken(token) : null;
    if (!user) return out;
    var mc = createClient({ host: cfg.machbase.host, port: cfg.machbase.port, user: user, token: token });
    prepareSql(mc, tql, function (err, sql) {
      if (!err) { out.tql = sql; return; }
      var amb = parseAmbiguity(err.message);
      if (amb) {
        out.ambiguous = '테이블 ' + amb.table + '이(가) 여러 계정에 있습니다: ' + amb.candidates.join(', ') +
          '. 코드에 DB.소유자.테이블 형태로 적어 주세요.';
      }
    });
    return out;
  }

  // 브라우저 TQL 실행 중계 — 호출자 토큰만 전달(서비스 계정 토큰으로 채우면 무인증 실행 경로가 됨)
  // · 차트 응답의 에셋 주소(/web/...)는 상대 주소 그대로 — 화면 iframe의 <base href>(접속 주소)로 풀림
  server.post('/db/tql', function (ctx) {
    var qs = ctx.request.queryString;
    var targetURL = neoBase + '/db/tql' + (qs ? '?' + qs : '');
    try {
      var body = ctx.request.body;
      var reqBody = (typeof body === 'string') ? body : JSON.stringify(body);
      var tqlAuth = ctx.request.getHeader('Authorization');
      var qualified = qualifyRunTql(reqBody, tqlAuth);
      if (qualified.ambiguous) {
        setCORS(ctx);
        return ctx.json(400, { success: false, reason: qualified.ambiguous });
      }
      reqBody = qualified.tql;
      var req = http2.NewRequest('POST', targetURL);
      req.header.set('Content-Type', ctx.request.getHeader('Content-Type') || 'text/plain');
      if (tqlAuth) req.header.set('Authorization', tqlAuth);
      if (reqBody) req.writeString(reqBody);
      var resp = _proxyClient.do(req);
      setCORS(ctx);
      var text = '';
      try { text = resp.string(); } catch (e2) {}
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

  // --- Config API ---

  var fs = require('fs');
  var pathMod = require('path');
  var process2 = require('process');
  var ARGV1 = process2.argv[1] || '';
  var CGI_BIN_DIR = ARGV1.slice(0, ARGV1.lastIndexOf('/llm'));
  if (!CGI_BIN_DIR) CGI_BIN_DIR = pathMod.resolve('..');
  var CONFIGS_DIR = pathMod.join(CGI_BIN_DIR, 'llm', 'configs');
  var PREFS_DIR = pathMod.join(CGI_BIN_DIR, 'llm', 'prefs');

  console.println('[Server] CONFIGS_DIR: ' + CONFIGS_DIR);
  console.println('[Server] PREFS_DIR: ' + PREFS_DIR);

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
  // 파일명 문자 제한 — 경로 탈출 방지
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
    // 상태 설정은 ctx.json/ctx.status — ctx.response.status() 는 getter 라 인자 무시(전부 200)
    ctx.json(status, data);
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
  // · config 파일은 LLM API 키를 담고 파일명이 곧 워커의 실행 계정 → 본인 것만 읽기·쓰기
  // · 판정은 요청 헤더의 API 토큰으로만, 브라우저가 보내는 이름(경로·본문)은 불신
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
  // 저장 전 정리
  // · machbase.user 를 인증된 계정으로 고정 — 본문에 다른 계정을 적어 그 계정으로 실행시키는 것 방지
  // · 접속 비밀(token·password) 제거 — 설정 파일은 /db/files 로 다른 계정에 노출
  function forceOwner(parsed, user) {
    parsed = parsed || {};
    parsed.machbase = parsed.machbase || {};
    parsed.machbase.user = user;
    delete parsed.machbase.token;
    delete parsed.machbase.password;
    return parsed;
  }

  // 토큰 검증(설정창 [검증] 버튼) — 성공 시 소문자 계정 이름
  server.get('/api/token/validate', function (ctx) {
    var user = requestUser(ctx);
    if (!user) return jsonReply(ctx, 401, { success: false, reason: 'invalid token' });
    jsonReply(ctx, 200, { success: true, reason: 'success', data: { user: user } });
  });

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

  // /api/prefs — 사용자별 UI 환경설정(즐겨찾기)
  // · GET → { favorites }, POST·PUT(text/plain 본문 { favorites }) → 저장
  // · 대상 사용자는 API 토큰으로 판정 — 이름 파라미터를 받으면 남의 즐겨찾기 읽기·덮어쓰기 가능
  // · 저장은 POST + text/plain — CORS preflight 회피(/api/configs 와 같은 방식)
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
    var files = [];
    if (dirExists) { try { files = fs.readdirSync(CONFIGS_DIR); } catch (e) {} }
    jsonReply(ctx, 200, {
      CONFIGS_DIR: CONFIGS_DIR, CONFIGS_DIR_EXISTS: dirExists, CONFIGS_FILES: files,
      activeWorkers: Object.keys(gateway.routes).length,
    });
  });

  // /health — 서비스 프록시 healthPath 메타데이터 대상(servicectl proxy list 등에서 참조)
  server.get('/health', function (ctx) {
    jsonReply(ctx, 200, { ok: true });
  });

  // --- WebSocket: external (browser) ---
  // 브라우저 WS 라우트 — /ws(서비스 프록시 /web/services/<svc>/ws 경유)
  var wss = new WebSocketServer({ server: server, path: '/ws' });

  // 사용자 식별은 메시지마다 실려 오는 API 토큰으로만(URL segment·본문 user_id 는 불신)
  // · 메시지마다 재검증 — 토큰 교체·폐기 즉시 반영
  function onBrowserConnection(socket) {
    var lastUser = '';
    console.println('[Server] Browser WS connected');

    socket.on('message', function (event) {
      var raw = (typeof event === 'string') ? event : (event && event.data) ? event.data : String(event);
      var token = '';
      try { token = (JSON.parse(raw) || {}).auth_token || ''; } catch (e) { /* 비 JSON 은 게이트웨이에서 무시 */ }
      var user = auth.verifyToken(token) || '';
      if (user && user !== lastUser) console.println('[Server] WS authenticated: ' + user);
      lastUser = user;
      gateway.handleBrowserMessage(socket, raw, user, user ? token : '');
    });

    socket.on('close', function () {
      console.println('[Server] Browser WS disconnected');
      gateway.cleanupBrowserConnection(socket);
    });
  }

  wss.on('connection', onBrowserConnection);

  // --- WebSocket: internal (workers) ---
  var wssInternal = new WebSocketServer({ server: server, path: '/internal/ws' });

  wssInternal.on('connection', function (socket, request) {
    console.println('[Server] Worker WS connected');
    gateway.handleWorkerConnection(socket);
  });

  // --- Graceful shutdown ---
  // 종료 훅은 HTTP 서버만 닫음 — 워커 정리는 stop.js(별도 프로세스, service.stop 가능) 담당
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
