// Gateway — non-blocking WebSocket router + worker lifecycle manager
// Browser ←WS→ Gateway ←WS→ Worker (separate process per session)
//
// Service management (install/start/stop) is delegated to Neo CGI endpoints
// (cgi-bin/api/worker/start.js, stop.js) because service callbacks cannot fire
// inside the server.serve() event loop. CGI scripts run as separate processes
// where service callbacks work normally — same pattern as neo-pkg-replication.

var fs = require('fs');
var pathMod = require('path');
var http2 = require('@jsh/http');
var config = require('../config/config');

var SESSION_TTL = 30 * 60 * 1000; // 30 min
var WORKER_PREFIX = 'llm-w-';

function createGateway(cfg, serverPort) {
  var routes = {};       // sessionID → { browserConn, workerConn, serviceName, ... }
  var workerMap = {};    // connId → sessionID (reverse lookup for worker disconnect)
  var workerIdSeq = 0;

  // Paths
  var LLM_DIR = pathMod.resolve('.');
  var WORKER_SCRIPT = pathMod.join(LLM_DIR, 'worker.js');
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
  function freshCfg(userID) {
    if (!cfg || !cfg._path) return cfg;
    var absSysPath = pathMod.resolve(cfg._path);
    var configsDir = pathMod.dirname(absSysPath);
    var name = (userID || cfg.machbase.user || 'sys') + '.json';
    var userPath = pathMod.join(configsDir, name);
    try { if (fs.existsSync(userPath)) return config.loadConfig(userPath); } catch (e) {}
    try { return config.loadConfig(absSysPath); } catch (e) { return cfg; }
  }

  // =====================================================================
  //  Browser message handling
  // =====================================================================

  function handleBrowserMessage(conn, raw, authUserID) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    var userID = authUserID || (msg && msg.user_id) || cfg.machbase.user || 'sys';

    switch (msg.type) {
      case 'chat':
        handleChat(conn, userID, msg.session_id, msg.provider, msg.model, msg.query);
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

  function handleChat(browserConn, userID, sessionID, provider, model, query) {
    if (!provider || !model) {
      sendJSON(browserConn, { type: 'error', session_id: sessionID, msg: 'provider와 model은 필수입니다.' });
      return;
    }

    var route = routes[sessionID];

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
        workerConnId: null,
        serviceName: svcName,
        userID: userID,
        provider: provider,
        model: model,
        lastUsed: Date.now(),
        pendingQuery: query,
      };
      routes[sessionID] = route;
      console.println('[Gateway] New session: ' + sessionID + ' svc=' + svcName);
      startWorker(sessionID, route);
    } else {
      route.browserConn = browserConn;
      route.lastUsed = Date.now();
      if (route.workerConn) {
        sendJSON(route.workerConn, { type: 'chat', session_id: sessionID, query: query });
      } else {
        route.pendingQuery = query;
      }
    }
  }

  // --- Worker lifecycle via Neo CGI (sync HTTP) ---

  function startWorker(sessionID, route) {
    var workerCfgPath = pathMod.join(WORKERS_DIR, sessionID + '.json');
    var workerCfg = {
      session_id: sessionID,
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
      delete routes[sessionID];
    }
  }

  function killWorker(sessionID) {
    var route = routes[sessionID];
    if (!route) return;

    console.println('[Gateway] Killing worker: ' + route.serviceName);

    if (route.workerConnId !== null) {
      delete workerMap[route.workerConnId];
    }

    cgiPost('/stop', 'name=' + encodeURIComponent(route.serviceName));

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
    var c = freshCfg(userID);
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
    var connId = ++workerIdSeq;
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
        route.workerConnId = connId;
        workerMap[connId] = boundSessionID;
        console.println('[Gateway] Worker connected: ' + boundSessionID);

        if (route.pendingQuery) {
          sendJSON(conn, { type: 'chat', session_id: boundSessionID, query: route.pendingQuery });
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
        if (route) {
          route.workerConn = null;
          route.workerConnId = null;
        }
        delete workerMap[connId];
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

  return {
    handleBrowserMessage: handleBrowserMessage,
    handleWorkerConnection: handleWorkerConnection,
    cleanupBrowserConnection: cleanupBrowserConnection,
    reapSessions: reapSessions,
    routes: routes,
  };
}

module.exports = { createGateway };
