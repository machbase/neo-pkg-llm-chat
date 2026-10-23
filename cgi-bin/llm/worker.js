// 워커 프로세스 — 세션마다 별도 서비스로 실행
// · 게이트웨이가 CGI(service.start)로 기동, 내부 WS 로 게이트웨이에 접속
// · 사용: jsh worker.js <sessionID> — 설정은 workers/<sessionID>.json

'use strict';

var process = require('process');
var path = require('path');
var fs = require('fs');
var ws = require('ws');

var SCRIPT_DIR = path.resolve(path.dirname(process.argv[1]));
// cwd 를 스크립트 폴더로 고정 — 서비스 working_dir 이 cwd 를 안 바꿀 수 있음
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
// 실행 계정 = 게이트웨이가 토큰으로 검증한 계정(설정 파일 값 아님)
cfg.machbase.user = workerCfg.user_id;

// --- Initialize components ---
var { createLLM } = require('./llm/factory');
var { createClient } = require('./machbase/client');
var { userZone } = require('./machbase/timezone');
var { createRegistry } = require('./tools/registry');
var { createAgent } = require('./agent/agent');
var followups = require('./agent/followups');

var mc = createClient(cfg.machbase);
var registry = createRegistry(mc);

// UI 로 나가는 모든 출력(진행 서술·도구 결과 미리보기·최종 답변)에서 실제 비밀값·자격증명 패턴 가림
var security = require('./tools/security');
// 사전 차단에 쓸 설정 파일 이름 — configs 폴더의 계정별 설정 파일 전부
try { security.setConfigFiles(fs.readdirSync(path.dirname(cfgPath))); } catch (e) {}
var OUTPUT_SECRETS = [
  cfg.claude && cfg.claude.api_key,
  cfg.chatgpt && cfg.chatgpt.api_key,
  cfg.gemini && cfg.gemini.api_key,
].filter(function (s) { return s && typeof s === 'string' && s.length >= 4; });
var llmClient;
try {
  llmClient = createLLM(cfg);
} catch (e) {
  console.println('[Worker] ERROR: LLM init failed: ' + e.message);
  process.exit(1);
}

var agent = createAgent(llmClient, registry, mc);
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
    // API 토큰은 메모리에만 보관 — 게이트웨이가 질문마다 전달
    mc.setToken(msg.machbase_token);
    applyTimezone(msg.tz);
    runChat(msg.query);
  }
});

// 브라우저 시간대 — Neo가 모르는 이름이면 이전 값 유지
function applyTimezone(z) {
  if (!z || z === mc.timezone()) return;
  mc.checkTimezone(z, function (ok, offsetMin) {
    if (ok) mc.setTimezone(z, offsetMin);
    else console.println('[Worker] 알 수 없는 시간대 무시: ' + z);
  });
}

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
  agent.zone = userZone(mc);

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
    // answer_stop 먼저 — 후속 질문 생성 전에 UI 입력 잠금 해제(칩은 늦게 오거나 안 와도 무방)
    sendStreamMsg('answer_stop');

    followups.generate(llmClient, cfg.provider, query, result || '', function (items) {
      if (agent.cancelled || !items.length) return;
      sendJSON({ type: 'followups', session_id: sessionID, items: items });
    });
  });
}

// --- Send helpers ---
function sendStreamMsg(msgType, text) {
  var message = { ver: '1.0', id: Date.now(), type: msgType };
  if (text !== undefined) {
    var safe = security.redactSecrets(text, OUTPUT_SECRETS.concat(mc.secrets()));
    message.body = { ofStreamBlockDelta: { contentType: 'text/markdown', text: safe } };
  }
  sendJSON({ type: 'msg', message: message });
}

function sendJSON(obj) {
  try { conn.send(JSON.stringify(obj)); } catch (e) {
    console.println('[Worker] Send error: ' + e.message);
  }
}

// 이벤트 루프 유지 — 없으면 WS 메시지 미수신
setInterval(function () {}, 1000);
