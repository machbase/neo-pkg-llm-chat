var http = require('http');
var http2 = require('@jsh/http');

var { WebSocketServer } = require('ws');
var { createGateway } = require('./ws_gateway');

function runServer(cfg, port) {
  var gateway = createGateway(cfg, port);
  var neoBase = 'http://' + cfg.machbase.host + ':' + cfg.machbase.port;
  var _proxyClient = http2.NewClient();

  setInterval(function () { gateway.reapSessions(); }, 5 * 60 * 1000);

  var server = new http.Server({
    network: 'tcp',
    address: '0.0.0.0:' + port,
  });

  // --- Relay helpers ---

  var _jwtToken = '';
  var _jwtExp = 0;

  function authHeaders() {
    if (!cfg.machbase.user) return {};
    if (_jwtToken && Date.now() < _jwtExp) return { 'Authorization': 'Bearer ' + _jwtToken };
    try {
      var payload = JSON.stringify({ loginName: cfg.machbase.user, password: cfg.machbase.password });
      var req = http2.NewRequest('POST', neoBase + '/web/api/login');
      req.header.set('Content-Type', 'application/json');
      req.writeString(payload);
      var resp = _proxyClient.do(req);
      var body = resp.string();
      var result = JSON.parse(body);
      if (result.success) {
        _jwtToken = result.accessToken;
        _jwtExp = Date.now() + 5 * 60 * 1000;
        return { 'Authorization': 'Bearer ' + _jwtToken };
      }
    } catch (e) {
      console.println('[Server] JWT login failed: ' + e.message);
    }
    return {};
  }

  function copyResponse(ctx, resp) {
    setCORS(ctx);
    var headers = resp.headers || {};
    var headerKeys = Object.keys(headers);
    for (var i = 0; i < headerKeys.length; i++) {
      var k = headerKeys[i];
      if (k.toLowerCase() === 'transfer-encoding') continue;
      ctx.setHeader(k, headers[k]);
    }
    ctx.response.status(resp.statusCode);
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

  server.post('/db/tql', function (ctx) {
    var qs = ctx.request.queryString;
    var targetURL = neoBase + '/db/tql' + (qs ? '?' + qs : '');
    try {
      var body = ctx.request.body;
      var reqBody = (typeof body === 'string') ? body : JSON.stringify(body);
      var req = http2.NewRequest('POST', targetURL);
      req.header.set('Content-Type', ctx.request.getHeader('Content-Type') || 'text/plain');
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
      ctx.response.status(resp.statusCode);
      ctx.response.write(text);
    } catch (e) {
      relayError(ctx, '/db/tql', e);
    }
  });

  server.get('/web/*path', function (ctx) {
    var path = '/web/' + ctx.param('path');
    var qs = ctx.request.queryString;
    var targetURL = neoBase + path + (qs ? '?' + qs : '');
    try {
      var req = http2.NewRequest('GET', targetURL);
      var clientAuth = ctx.request.getHeader('Authorization');
      if (clientAuth) req.header.set('Authorization', clientAuth);
      var auth = authHeaders();
      if (auth['Authorization']) req.header.set('Authorization', auth['Authorization']);
      copyResponse(ctx, _proxyClient.do(req));
    } catch (e) {
      relayError(ctx, path, e);
    }
  });

  server.post('/web/*path', function (ctx) {
    var path = '/web/' + ctx.param('path');
    var qs = ctx.request.queryString;
    var targetURL = neoBase + path + (qs ? '?' + qs : '');
    try {
      var body = ctx.request.body;
      var reqBody = (typeof body === 'string') ? body : JSON.stringify(body);
      var req = http2.NewRequest('POST', targetURL);
      req.header.set('Content-Type', ctx.request.getHeader('Content-Type') || 'application/json');
      var clientAuth = ctx.request.getHeader('Authorization');
      if (clientAuth) req.header.set('Authorization', clientAuth);
      var auth = authHeaders();
      if (auth['Authorization']) req.header.set('Authorization', auth['Authorization']);
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
  var CONFIG_FILE = pathMod.join(CGI_BIN_DIR, 'config.json');
  var CONFIG_DEFAULT = { server: { port: '8884' } };

  console.println('[Server] CONFIGS_DIR: ' + CONFIGS_DIR);
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

  function jsonReply(ctx, status, data) {
    setCORS(ctx);
    ctx.setHeader('Content-Type', 'application/json');
    ctx.response.status(status);
    ctx.response.write(JSON.stringify(data));
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
    var name = ctx.query('name');
    if (!name) {
      jsonReply(ctx, 200, { success: true, reason: 'success', data: { configs: listConfigNames() } });
      return;
    }
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
    try {
      var parsed = parseBody(ctx);
      var saveName = (parsed.machbase && parsed.machbase.user) || 'sys';
      writeConfigFile(saveName, parsed);
      jsonReply(ctx, 201, { success: true, reason: 'success', data: { name: saveName } });
    } catch (e) { jsonReply(ctx, 500, { success: false, reason: e.message }); }
  });
  server.put('/api/configs', handleConfigsPutByQuery);
  server.delete('/api/configs', handleConfigsDeleteByQuery);

  function handleConfigsPutByQuery(ctx) {
    var name = ctx.query('name');
    if (!name) { jsonReply(ctx, 400, { success: false, reason: 'name parameter required' }); return; }
    try { writeConfigFile(name, parseBody(ctx)); jsonReply(ctx, 200, { success: true, reason: 'success', data: { name: name } }); }
    catch (e) { jsonReply(ctx, 500, { success: false, reason: e.message }); }
  }
  function handleConfigsDeleteByQuery(ctx) {
    var name = ctx.query('name');
    if (!name) { jsonReply(ctx, 400, { success: false, reason: 'name parameter required' }); return; }
    try { removeConfigFile(name); jsonReply(ctx, 200, { success: true, reason: 'success', data: { name: name } }); }
    catch (e) { jsonReply(ctx, 500, { success: false, reason: e.message }); }
  }

  // /api/configs/:name
  server.get('/api/configs/:name', function (ctx) {
    var name = ctx.param('name');
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
    var name = ctx.param('name');
    try { writeConfigFile(name, parseBody(ctx)); jsonReply(ctx, 200, { success: true, reason: 'success', data: { name: name } }); }
    catch (e) { jsonReply(ctx, 500, { success: false, reason: e.message }); }
  }
  function handleConfigDeleteByName(ctx) {
    var name = ctx.param('name');
    try { removeConfigFile(name); jsonReply(ctx, 200, { success: true, reason: 'success', data: { name: name } }); }
    catch (e) { jsonReply(ctx, 500, { success: false, reason: e.message }); }
  }

  // /api/debug
  server.get('/api/debug', function (ctx) {
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

  // --- WebSocket: external (browser) ---
  var wss = new WebSocketServer({ server: server, path: '/ws' });
  var wss2 = new WebSocketServer({ server: server, path: '/:user/ws' });

  function extractUserFromWsUrl(url) {
    if (!url) return '';
    var s = String(url);
    var m = s.match(/\/([^\/\?]+)\/ws(?:[\/\?]|$)/);
    if (!m) return '';
    var seg = m[1];
    if (seg === 'ws' || seg === 'internal') return '';
    try { return decodeURIComponent(seg); } catch (e) { return seg; }
  }

  function onBrowserConnection(socket, request) {
    var extracted = extractUserFromWsUrl(request && request.url);
    var authUserID = extracted || '';
    console.println('[Server] Browser WS connected, user=' + (authUserID || '(from msg)'));

    socket.on('message', function (event) {
      var raw = (typeof event === 'string') ? event : (event && event.data) ? event.data : String(event);
      gateway.handleBrowserMessage(socket, raw, authUserID);
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
