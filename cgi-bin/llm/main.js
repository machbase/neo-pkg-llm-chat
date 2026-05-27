var config = require('./config/config');
var logger = require('./logger/logger');

// --- Parse CLI arguments ---
var mode = 'cli';
var configPath = 'configs/sys.json';
var query = '';
var provider = '';
var model = '';
var port = '';
var neoWSURL = '';

if (typeof process !== 'undefined' && process.argv) {
  var args = process.argv;
  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) mode = args[++i];
    if (args[i] === '--config' && args[i + 1]) configPath = args[++i];
    if (args[i] === '--query' && args[i + 1]) query = args[++i];
    if (args[i] === '--provider' && args[i + 1]) provider = args[++i];
    if (args[i] === '--model' && args[i + 1]) model = args[++i];
    if (args[i] === '--port' && args[i + 1]) port = args[++i];
    if (args[i] === '--neo-ws-url' && args[i + 1]) neoWSURL = args[++i];
  }
}

// --- Initialize ---
logger.init({ dir: 'logs', prefix: 'neo-pkg-llm', level: 'DEBUG' });

var cfg = config.loadConfig(configPath);
if (provider) cfg.provider = provider;
if (model) cfg.model = model;

console.println('=== neo-pkg-llm JSH ===');
console.println('Mode: ' + mode);
console.println('Machbase: ' + config.machbaseURL(cfg));

// --- Mode dispatch ---
switch (mode) {
  case 'cli':
    runCLI(cfg, query);
    break;
  case 'server':
    runServerMode(cfg, port);
    break;
  case 'ws':
    runWSMode(cfg, neoWSURL);
    break;
  default:
    console.println('Unknown mode: ' + mode + ' (use cli, server, or ws)');
}

// --- CLI Mode ---
function runCLI(cfg, initialQuery) {
  var { createLLM } = require('./llm/factory');
  var { createClient } = require('./machbase/client');
  var { createRegistry } = require('./tools/registry');
  var { createAgent } = require('./agent/agent');

  var mc = createClient(cfg.machbase);
  var registry = createRegistry(mc);
  var llmClient = createLLM(cfg);
  console.println('Tools: ' + registry.toolNames().length + ' loaded');

  if (initialQuery) {
    var agent = createAgent(llmClient, registry);
    agent.run(initialQuery, function (err, result) {
      console.println('\n============================================================');
      console.println(err ? 'Error: ' + err.message : result);
      console.println('============================================================');
    });
  } else {
    console.println('Usage: machbase-neo jsh main.js --query "테이블 목록 조회"');
    console.println('  or:  machbase-neo jsh main.js --mode server --port 8884');
  }
}

// --- Server Mode (Gateway — no LLM in this process) ---
function runServerMode(cfg, serverPort) {
  serverPort = serverPort || cfg.server.port || '8884';
  console.println('Provider: ' + config.resolveProvider(cfg));
  console.println('Model: ' + config.resolveModelID(cfg));

  var { runServer } = require('./server/server');
  runServer(cfg, serverPort);
}

// --- WebSocket Client Mode (legacy, for direct Neo integration) ---
function runWSMode(cfg, wsURL) {
  if (!wsURL) {
    console.println('Error: --neo-ws-url is required for ws mode');
    return;
  }

  var { createLLM } = require('./llm/factory');
  var { createClient } = require('./machbase/client');
  var { createRegistry } = require('./tools/registry');

  var mc = createClient(cfg.machbase);
  var registry = createRegistry(mc);
  var llmClient = createLLM(cfg);
  console.println('Tools: ' + registry.toolNames().length + ' loaded');

  var { runWSClient } = require('./server/ws_client');
  runWSClient(wsURL, llmClient, registry);
}
