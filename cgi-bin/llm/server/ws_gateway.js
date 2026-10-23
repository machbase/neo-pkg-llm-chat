// 게이트웨이 — 브라우저 WS 라우터 + 세션별 워커 수명 관리
// · Browser ←WS→ Gateway ←WS→ Worker(세션마다 별도 프로세스)
// · 워커 서비스 등록·시작·종료는 Neo CGI(cgi-bin/api/worker/*.js)에 위임 — serve() 안에서는 service 콜백이 안 불림

var fs = require('fs');
var pathMod = require('path');
var http2 = require('@jsh/http');
var config = require('../config/config');

var SESSION_TTL = 30 * 60 * 1000; // 30 min
var WORKER_PREFIX = 'llm-w-';

function createGateway(cfg, serverPort) {
  var routes = {};       // sessionID → { browserConn, workerConn, serviceName, ... }

  // Paths
  var LLM_DIR = pathMod.resolve('.');
  var CONFIGS_DIR = pathMod.join(LLM_DIR, 'configs');
  var WORKERS_DIR = pathMod.join(LLM_DIR, 'workers');

  try { if (!fs.existsSync(WORKERS_DIR)) fs.mkdirSync(WORKERS_DIR, { recursive: true }); } catch (e) {}

  var gatewayPort = serverPort || (cfg.server && cfg.server.port) || '8884';
  var neoBase = 'http://' + cfg.machbase.host + ':' + cfg.machbase.port;
  var _httpClient = http2.NewClient();
  var CGI_BASE = '/public/neo-pkg-llm-chat/cgi-bin/api/worker';

  console.println('[Gateway] LLM_DIR=' + LLM_DIR);
  console.println('[Gateway] Port=' + gatewayPort);
  console.println('[Gateway] Neo=' + neoBase);

  // --- Sync HTTP helper for CGI calls ---
  function cgiPost(endpoint, query) {
    try {
      var url = neoBase + CGI_BASE + endpoint + '?' + query;
      var req = http2.NewRequest('POST', url);
      var resp = _httpClient.do(req);
      var text = '';
      try { text = resp.string(); } catch (e) {}
      if (!resp.ok) return { ok: false, reason: 'HTTP ' + resp.statusCode + ': ' + text.substring(0, 200) };
      try { return JSON.parse(text); } catch (e) { return { ok: false, reason: 'parse error: ' + text.substring(0, 200) }; }
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  // --- Per-user config ---
  // 본인 설정 파일 — 없으면 null(sys.json으로 대신하지 않음)
  function userCfg(userID) {
    if (!userID) return null;
    var userPath = pathMod.join(CONFIGS_DIR, userID + '.json');
    try { if (fs.existsSync(userPath)) return config.loadConfig(userPath); } catch (e) {}
    return null;
  }

  // =====================================================================
  //  Browser message handling
  // =====================================================================

  function handleBrowserMessage(conn, raw, authUserID, authToken) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // 검증된 신원이 없으면 미처리 — 본문 user_id·sys 폴백 시 남의 설정(LLM API 키)으로 워커 기동 가능
    var userID = authUserID;
    if (!userID || !authToken) {
      sendJSON(conn, {
        type: 'error', session_id: msg && msg.session_id, code: 'auth_required',
        msg: 'API 토큰이 확인되지 않았습니다. 설정에서 토큰을 확인한 뒤 다시 시도하세요.',
      });
      return;
    }

    switch (msg.type) {
      case 'chat':
        handleChat(conn, userID, authToken, msg.session_id, msg.provider, msg.model, msg.query, String(msg.tz || '').substring(0, 64));
        break;
      case 'stop':
        handleStop(conn, msg.session_id);
        break;
      case 'clear':
        handleClear(conn, msg.session_id);
        break;
      case 'get_models':
        handleGetModels(conn, userID);
        break;
    }
  }

  function handleChat(browserConn, userID, token, sessionID, provider, model, query, tz) {
    if (!provider || !model) {
      sendJSON(browserConn, { type: 'error', session_id: sessionID, msg: 'provider와 model은 필수입니다.' });
      return;
    }

    // 사용자별 격리 — 본인 설정 파일이 없으면 거부(sys.json 폴백 워커로 남의 LLM API 키 사용 방지)
    if (!fs.existsSync(pathMod.join(CONFIGS_DIR, userID + '.json'))) {
      sendJSON(browserConn, { type: 'error', session_id: sessionID, code: 'config_required',
        msg: '설정이 없습니다. 먼저 본인 계정의 설정(LLM 제공자·API 키·접속 정보)을 저장한 뒤 채팅을 시작하세요.' });
      return;
    }

    var route = routes[sessionID];

    // 남의 세션 차단 — 세션 ID 만으로 다른 계정 워커에 토큰을 바꿔 넣는 것 방지
    if (route && route.userID !== userID) {
      sendJSON(browserConn, { type: 'error', session_id: sessionID, code: 'auth_required', msg: '다른 계정의 세션입니다.' });
      return;
    }

    if (route && (route.provider !== provider || route.model !== model)) {
      console.println('[Gateway] Model changed → kill worker ' + sessionID);
      killWorker(sessionID);
      route = null;
    }

    if (!route) {
      var svcName = WORKER_PREFIX + sessionID.replace(/[^a-zA-Z0-9-]/g, '').substring(0, 20);
      route = {
        browserConn: browserConn,
        workerConn: null,
        serviceName: svcName,
        userID: userID,
        token: token,
        provider: provider,
        model: model,
        tz: tz,
        lastUsed: Date.now(),
        pendingQuery: query,
      };
      routes[sessionID] = route;
      console.println('[Gateway] New session: ' + sessionID + ' svc=' + svcName);
      startWorker(sessionID, route);
    } else {
      route.browserConn = browserConn;
      route.token = token;
      route.tz = tz;
      route.lastUsed = Date.now();
      if (route.workerConn) {
        sendChatToWorker(route.workerConn, sessionID, route.token, query, route.tz);
      } else {
        route.pendingQuery = query;
      }
    }
  }

  // 워커로 질문 전달 — API 토큰은 이 메시지로만 전달(workers/*.json 등 파일에 안 남김)
  // · tz는 브라우저 시간대(시각 표시용)
  function sendChatToWorker(workerConn, sessionID, token, query, tz) {
    sendJSON(workerConn, { type: 'chat', session_id: sessionID, query: query, machbase_token: token, tz: tz });
  }

  // --- Worker lifecycle via Neo CGI (sync HTTP) ---

  function startWorker(sessionID, route) {
    var workerCfgPath = pathMod.join(WORKERS_DIR, sessionID + '.json');
    var workerCfg = {
      user_id: route.userID,
      provider: route.provider,
      model: route.model,
      config_path: pathMod.join(CONFIGS_DIR, route.userID + '.json'),
      fallback_config_path: pathMod.join(CONFIGS_DIR, 'sys.json'),
      gateway_url: 'ws://127.0.0.1:' + gatewayPort + '/internal/ws',
    };
    try {
      fs.writeFileSync(workerCfgPath, JSON.stringify(workerCfg, null, 2));
    } catch (e) {
      console.println('[Gateway] Config write failed: ' + e.message);
      sendJSON(route.browserConn, { type: 'error', session_id: sessionID, msg: 'Worker config write failed' });
      delete routes[sessionID];
      return;
    }

    var result = cgiPost('/start', 'session_id=' + encodeURIComponent(sessionID));
    if (result && result.ok) {
      console.println('[Gateway] Worker started: ' + route.serviceName);
    } else {
      var reason = (result && result.reason) || 'unknown error';
      console.println('[Gateway] Worker start failed: ' + reason);
      sendJSON(route.browserConn, { type: 'error', session_id: sessionID, msg: 'Worker start failed: ' + reason });
      // 기동 실패 시 방금 쓴 세션 설정 파일 삭제
      try { fs.unlinkSync(workerCfgPath); } catch (e2) {}
      delete routes[sessionID];
    }
  }

  function killWorker(sessionID) {
    var route = routes[sessionID];
    if (!route) return;

    console.println('[Gateway] Killing worker: ' + route.serviceName);

    cgiPost('/stop', 'name=' + encodeURIComponent(route.serviceName));

    // 세션 설정 파일 삭제 — 실패(이미 없음·잠김)는 무시, 워커 종료를 막지 않음
    try { fs.unlinkSync(pathMod.join(WORKERS_DIR, sessionID + '.json')); } catch (e) {}

    delete routes[sessionID];
  }

  function handleStop(browserConn, sessionID) {
    killWorker(sessionID);
    sendJSON(browserConn, { type: 'stop', session_id: sessionID, msg: 'stopped' });
  }

  function handleClear(browserConn, sessionID) {
    killWorker(sessionID);
    sendJSON(browserConn, { type: 'clear', session_id: sessionID });
  }

  function handleGetModels(conn, userID) {
    var c = userCfg(userID);
    if (!c) {
      sendJSON(conn, { type: 'models', msg: 'No providers configured. Please set API keys in Settings.' });
      return;
    }
    function namedModels(models) {
      var out = [];
      for (var i = 0; i < models.length; i++) {
        var name = (models[i].name || '').trim();
        if (!name) continue;
        out.push({ name: name, model_id: models[i].model_id || name });
      }
      return out;
    }
    var providers = [];
    var claudeModels = namedModels(c.claude.models);
    if (c.claude.api_key && claudeModels.length > 0) providers.push({ provider: 'claude', models: claudeModels });
    var chatgptModels = namedModels(c.chatgpt.models);
    if (c.chatgpt.api_key && chatgptModels.length > 0) providers.push({ provider: 'chatgpt', models: chatgptModels });
    var geminiModels = namedModels(c.gemini.models);
    if (c.gemini.api_key && geminiModels.length > 0) providers.push({ provider: 'gemini', models: geminiModels });
    var ollamaModels = namedModels(c.ollama.models);
    if (ollamaModels.length > 0) providers.push({ provider: 'ollama', models: ollamaModels });

    if (providers.length === 0) {
      sendJSON(conn, { type: 'models', msg: 'No providers configured. Please set API keys in Settings.' });
    } else {
      sendJSON(conn, { type: 'models', providers: providers });
    }
  }

  // =====================================================================
  //  Worker message handling (internal WS)
  // =====================================================================

  function handleWorkerConnection(conn) {
    var boundSessionID = null;

    conn.on('message', function (event) {
      var raw = (typeof event === 'string') ? event : (event && event.data) ? event.data : String(event);
      var msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }

      if (msg.type === 'worker_ready') {
        boundSessionID = msg.session_id;
        var route = routes[boundSessionID];
        if (!route) {
          console.println('[Gateway] worker_ready for unknown session: ' + boundSessionID);
          return;
        }
        route.workerConn = conn;
        console.println('[Gateway] Worker connected: ' + boundSessionID);

        if (route.pendingQuery) {
          sendChatToWorker(conn, boundSessionID, route.token, route.pendingQuery, route.tz);
          route.pendingQuery = null;
        }
        return;
      }

      // Forward worker messages to browser as-is
      if (!boundSessionID) return;
      var route = routes[boundSessionID];
      if (route && route.browserConn) {
        try { route.browserConn.send(raw); } catch (e) {}
      }
    });

    conn.on('close', function () {
      if (boundSessionID) {
        console.println('[Gateway] Worker disconnected: ' + boundSessionID);
        var route = routes[boundSessionID];
        if (route) route.workerConn = null;
      }
    });
  }

  // =====================================================================
  //  Cleanup
  // =====================================================================

  function cleanupBrowserConnection(conn) {
    var keys = Object.keys(routes);
    for (var i = 0; i < keys.length; i++) {
      if (routes[keys[i]].browserConn === conn) {
        console.println('[Gateway] Browser disconnected → kill worker ' + keys[i]);
        killWorker(keys[i]);
      }
    }
  }

  function reapSessions() {
    var now = Date.now();
    var keys = Object.keys(routes);
    for (var i = 0; i < keys.length; i++) {
      if (now - routes[keys[i]].lastUsed > SESSION_TTL) {
        console.println('[Gateway] Session expired: ' + keys[i]);
        killWorker(keys[i]);
      }
    }
  }

  function sendJSON(conn, obj) {
    try { conn.send(JSON.stringify(obj)); } catch (e) {
      console.println('[Gateway] Send error: ' + e.message);
    }
  }

  // 기동 시 고아 워커 정리
  // · 대상: 강제 종료로 남은 워커 서비스 등록(etc/services/)·세션 설정 파일 — 등록이 남으면 Neo 종료마다 STOP 발생
  // · 등록부 기준으로 훑음(등록이 설정 파일보다 오래 남음), service API 는 CGI 에 위임
  // · 기동 시점엔 라우팅 표가 비어 있어 남은 워커 서비스는 전부 고아
  function sweepOrphanWorkers() {
    var res = cgiPost('/sweep', 'keep=');
    if (!res || !res.ok) {
      console.println('[Gateway] Orphan sweep skipped: ' + ((res && res.reason) || 'no response'));
      return;
    }
    console.println('[Gateway] Orphan sweep: services=' + res.removed + ', files=' + res.files
      + (res.failed && res.failed.length ? ', failed=' + res.failed.join(',') : '')
      + (res.diag ? ' [' + res.diag + ']' : ''));
  }

  sweepOrphanWorkers();

  return {
    handleBrowserMessage: handleBrowserMessage,
    handleWorkerConnection: handleWorkerConnection,
    cleanupBrowserConnection: cleanupBrowserConnection,
    reapSessions: reapSessions,
    routes: routes,
  };
}

module.exports = { createGateway };
