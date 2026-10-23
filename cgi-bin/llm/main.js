// 전역 process 보장 — CLI 단독 실행(jsh main.js) 시 bare `process` 참조 모듈 실패 방지(서버 모드는 런처가 설정)
try { if (typeof globalThis !== 'undefined' && typeof globalThis.process === 'undefined') globalThis.process = require('process'); } catch (e) {}

var config = require('./config/config');

// --- Parse CLI arguments ---
var mode = 'cli';
var configPath = 'configs/sys.json';
var query = '';
var provider = '';
var model = '';
var port = '';

if (typeof process !== 'undefined' && process.argv) {
  var args = process.argv;
  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) mode = args[++i];
    if (args[i] === '--config' && args[i + 1]) configPath = args[++i];
    if (args[i] === '--query' && args[i + 1]) query = args[++i];
    if (args[i] === '--provider' && args[i + 1]) provider = args[++i];
    if (args[i] === '--model' && args[i + 1]) model = args[++i];
    if (args[i] === '--port' && args[i + 1]) port = args[++i];
  }
}

// --- Initialize ---
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
  default:
    console.println('Unknown mode: ' + mode + ' (use cli or server)');
}

// --- CLI Mode ---
function runCLI(cfg, initialQuery) {
  var { createLLM } = require('./llm/factory');
  var { createRegistry } = require('./tools/registry');
  var { createAgent } = require('./agent/agent');

  var mc = createTokenClient(cfg);
  var registry = createRegistry(mc);
  var llmClient = createLLM(cfg);
  console.println('Tools: ' + registry.toolNames().length + ' loaded');

  if (initialQuery) {
    var agent = createAgent(llmClient, registry, mc);
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

// CLI 모드용 클라이언트 — 토큰은 `jsh -e MACHBASE_TOKEN=...`, 실행 계정은 토큰으로 판정
function createTokenClient(cfg) {
  var { createClient } = require('./machbase/client');
  var mc = createClient(cfg.machbase);
  mc.whoami(function (err, user) {
    if (err) { console.println('Machbase token: ' + err.message); return; }
    mc.user = user;
    console.println('Machbase user: ' + user);
  });
  return mc;
}
