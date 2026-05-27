// Worker process — runs as a separate service per session
// Started by Gateway via CGI → service.start(), connects back via internal WS
//
// Usage: jsh worker.js <sessionID>
//   Reads workers/<sessionID>.json for config

'use strict';

var process = require('process');
var path = require('path');
var fs = require('fs');
var ws = require('ws');

var SCRIPT_DIR = path.resolve(path.dirname(process.argv[1]));
// Ensure cwd matches SCRIPT_DIR (working_dir from service may not set cwd)
try { process.chdir(SCRIPT_DIR); } catch (e) {}
var WORKERS_DIR = path.join(SCRIPT_DIR, 'workers');

// --- Parse args ---
var sessionID = process.argv[2];
if (!sessionID) {
  console.println('[Worker] ERROR: session ID required as argv[2]');
  process.exit(1);
}

// --- Load worker config ---
var workerCfgPath = path.join(WORKERS_DIR, sessionID + '.json');
var workerCfg;
try {
  workerCfg = JSON.parse(fs.readFileSync(workerCfgPath, 'utf8'));
} catch (e) {
  console.println('[Worker] ERROR: cannot read config ' + workerCfgPath + ': ' + e.message);
  process.exit(1);
}

console.println('[Worker] Session: ' + sessionID);
console.println('[Worker] User: ' + workerCfg.user_id);
console.println('[Worker] Provider: ' + workerCfg.provider + '/' + workerCfg.model);

// --- Load LLM config ---
var config = require('./config/config');
var cfgPath = workerCfg.config_path;
if (!fs.existsSync(cfgPath)) cfgPath = workerCfg.fallback_config_path;

var cfg;
try {
  cfg = config.loadConfig(cfgPath);
} catch (e) {
  console.println('[Worker] ERROR: cannot load config ' + cfgPath + ': ' + e.message);
  process.exit(1);
}
cfg.provider = workerCfg.provider;
cfg.model = workerCfg.model;

// --- Initialize components ---
var { createLLM } = require('./llm/factory');
var { createClient } = require('./machbase/client');
var { createRegistry } = require('./tools/registry');
var { createAgent } = require('./agent/agent');
var logger = require('./logger/logger');

logger.init({ dir: 'logs', prefix: 'worker-' + sessionID.substring(0, 12), level: 'DEBUG' });

var mc = createClient(cfg.machbase);
var registry = createRegistry(mc);
var llmClient;
try {
  llmClient = createLLM(cfg);
} catch (e) {
  console.println('[Worker] ERROR: LLM init failed: ' + e.message);
  process.exit(1);
}

var agent = createAgent(llmClient, registry);
console.println('[Worker] Tools: ' + registry.toolNames().length + ' loaded');

// --- Shutdown hook ---
try {
  process.addShutdownHook(function () {
    console.println('[Worker] Shutdown — cancelling agent');
    agent.cancelled = true;
  });
} catch (e) {}

// --- Connect to Gateway ---
var conn;
try {
  conn = new ws.WebSocket(workerCfg.gateway_url);
} catch (e) {
  console.println('[Worker] WS connect failed: ' + e.message);
  process.exit(1);
}

conn.on('open', function () {
  console.println('[Worker] Connected to Gateway');
  sendJSON({ type: 'worker_ready', session_id: sessionID });
});

conn.on('message', function (event) {
  var raw = (typeof event === 'string') ? event : (event && event.data) ? event.data : String(event);
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.type === 'chat') {
    runChat(msg.query);
  }
});

conn.on('close', function () {
  console.println('[Worker] Gateway connection closed — exiting');
  process.exit(0);
});

conn.on('error', function (err) {
  console.println('[Worker] WS error: ' + err.message);
});

// --- Chat execution ---
function runChat(query) {
  console.println('[Worker] Query: ' + query.substring(0, 100));
  sendStreamMsg('answer_start');

  agent.onProgress = function (text) {
    if (agent.cancelled) return;
    sendStreamMsg('stream_block_start');
    sendStreamMsg('stream_block_delta', text);
    sendStreamMsg('stream_block_stop');
  };

  agent.cancelled = false;
  agent.run(query, function (err, result) {
    if (agent.cancelled) {
      sendStreamMsg('answer_stop');
      return;
    }
    if (err) {
      sendStreamMsg('answer_stop');
      sendJSON({ type: 'error', session_id: sessionID, msg: 'Agent error: ' + err.message });
      return;
    }
    sendStreamMsg('stream_msg_start');
    sendStreamMsg('stream_msg_delta', result || '');
    sendStreamMsg('stream_msg_stop');
    sendStreamMsg('answer_stop');
  });
}

// --- Send helpers ---
function sendStreamMsg(msgType, text) {
  var message = { ver: '1.0', id: Date.now(), type: msgType };
  if (text !== undefined) {
    message.body = { ofStreamBlockDelta: { contentType: 'text/markdown', text: text } };
  }
  sendJSON({ type: 'msg', message: message });
}

function sendJSON(obj) {
  try { conn.send(JSON.stringify(obj)); } catch (e) {
    console.println('[Worker] Send error: ' + e.message);
  }
}

// Keep the event loop alive so WS messages can be dispatched
setInterval(function () {}, 1000);
