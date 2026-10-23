'use strict';

const process = require('process');
const path = require('path');
const fs = require('fs');
const service = require('service');

// JSH 가상 경로 기준
const SCRIPT_DIR = path.resolve(path.dirname(process.argv[1]));
const LLM_DIR = path.join(SCRIPT_DIR, 'llm');
const MAIN_JS = path.join(LLM_DIR, 'main.js');
const CONFIGS_DIR = path.join(LLM_DIR, 'configs');
const DEFAULT_CONFIG_FILE = path.join(CONFIGS_DIR, 'sys.json');
const BEACON_FILE = path.join(SCRIPT_DIR, 'launcher-beacon.log');

// ── 서비스 프록시 식별자 ──
// neo가 /web/services/<SVC>/<prefix>/* 를 127.0.0.1:<port> 로 포워딩 — 프론트는 이 공개 경로 사용(포트 노출·CORS 불필요)
// !! SVC = JSH 서비스명(install.js 의 SERVICE_NAME) 필수 — neo가 stop 시 서비스명 매칭으로 프록시 자동 해제, 다르면 orphan
const PROXY_SVC = 'neo-pkg-llm';
// 백엔드 라우트별 prefix 각각 등록
// · /ws/ — WS 업그레이드 경로(프록시가 Upgrade 헤더 전달)
// · /web/ 미등록 — neo 글로벌 /web/* 라우트와 충돌
const PROXY_PREFIXES = ['/api/', '/db/', '/ws/'];
// 서비스명까지만 제거 — 백엔드가 /api/configs · /db/tql 경로 그대로 수신
const PROXY_STRIP = '/web/services/' + PROXY_SVC;

// Diagnostic beacon — 시작 시점/단계/에러를 디스크에 기록
function beacon(line) {
  try {
    const ts = new Date().toISOString();
    fs.writeFileSync(BEACON_FILE, '[' + ts + '] ' + line + '\n', { flag: 'a' });
  } catch (e) { /* nothing we can do */ }
}

// 최초 beacon — launcher가 실행됐다는 증거
try { fs.writeFileSync(BEACON_FILE, '=== launcher invoked at ' + new Date().toISOString() + ' ===\n'); } catch (e) {}
beacon('argv: ' + JSON.stringify(process.argv));
beacon('SCRIPT_DIR=' + SCRIPT_DIR);
beacon('LLM_DIR=' + LLM_DIR);

// sys.json → server.port — main.js와 같은 파일이라 target port 일치
function readPort() {
  try {
    if (fs.existsSync(DEFAULT_CONFIG_FILE)) {
      var raw = fs.readFileSync(DEFAULT_CONFIG_FILE, { encoding: 'utf8' });
      var cfg = JSON.parse(raw);
      if (cfg && cfg.server && cfg.server.port) return String(cfg.server.port);
    }
  } catch (e) {
    beacon('readPort failed: ' + (e && e.message ? e.message : String(e)));
  }
  return '8884';
}

function bootMain() {
  try {
    console.println('[llm-launcher] Starting JSH mode');
    console.println('[llm-launcher] LLM_DIR:', LLM_DIR);
    console.println('[llm-launcher] main.js:', MAIN_JS);

    beacon('chdir to ' + LLM_DIR);
    process.chdir(LLM_DIR);

    beacon('setting argv for main.js');
    process.argv = [process.argv[0], MAIN_JS, '--mode', 'server', '--config', 'configs/sys.json'];

    beacon('requiring main.js: ' + MAIN_JS);
    require(MAIN_JS);
    beacon('main.js require returned (server.serve should be running)');
  } catch (e) {
    beacon('FATAL: ' + (e && e.message ? e.message : String(e)));
    if (e && e.stack) beacon('STACK: ' + e.stack);
    try { console.println('[llm-launcher] FATAL: ' + (e && e.message ? e.message : String(e))); } catch (_) {}
    throw e;
  }
}

// 최초 부팅 시드: configs/sys.json이 없으면 defaultConfig()로 생성
// (readPort 가 같은 파일을 읽으므로 register 전에 시드해야 target port 가 정확함)
try {
  if (!fs.existsSync(DEFAULT_CONFIG_FILE)) {
    beacon('seeding sys.json...');
    console.println('[llm-launcher] configs/sys.json not found — seeding defaults');
    if (!fs.existsSync(CONFIGS_DIR)) fs.mkdirSync(CONFIGS_DIR, { recursive: true });
    const { defaultConfig } = require(path.join(LLM_DIR, 'config', 'config.js'));
    fs.writeFileSync(DEFAULT_CONFIG_FILE, JSON.stringify(defaultConfig(), null, 2));
    console.println('[llm-launcher] seeded: ' + DEFAULT_CONFIG_FILE);
    beacon('seeded sys.json OK');
  } else {
    beacon('sys.json already exists');
  }
} catch (e) {
  beacon('seed failed: ' + (e && e.message ? e.message : String(e)));
  throw e;
}

// ── 서비스 프록시 등록 → main.js require (순서 중요) ──
// · register는 이벤트 루프가 돌아야 settle되는 비동기 RPC, require(MAIN_JS)는 server.serve()로 루프 점유
//   → 모든 register 콜백 settle 후에만 bootMain() 호출
// · register는 동일 config면 idempotent — 재시작마다 재등록 무방
// · unregister 생략 — neo가 stop 시 서비스명 매칭으로 자동 해제
const targetPort = readPort();
const proxyTarget = 'http://127.0.0.1:' + targetPort;
beacon('proxy target: ' + proxyTarget);

var pendingProxy = PROXY_PREFIXES.length;
function onProxySettled() {
  pendingProxy -= 1;
  if (pendingProxy === 0) bootMain();
}
PROXY_PREFIXES.forEach(function (prefix) {
  service.proxy.register({
    service: PROXY_SVC,
    prefix: prefix,
    target: proxyTarget,
    stripPrefix: PROXY_STRIP,
    healthPath: '/health',
  }, function (err) {
    if (err) {
      beacon('proxy register failed: ' + prefix + ' err=' + err.message);
      console.println('[llm-launcher] proxy register failed:', prefix, err.message);
    } else {
      beacon('proxy registered: ' + prefix);
      console.println('[llm-launcher] proxy registered:', '/web/services/' + PROXY_SVC + prefix);
    }
    onProxySettled();
  });
});
