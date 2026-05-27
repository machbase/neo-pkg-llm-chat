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
// neo 본체가 /web/services/<SVC>/<prefix>/* 를 127.0.0.1:<port> 로 포워딩한다.
// 프론트는 포트 직접 호출 대신 이 공개 경로를 사용 → 포트 노출/CORS 불필요.
//
// !! SVC 는 반드시 JSH 서비스명(cgi-bin/install.js 의 SERVICE_NAME)과 동일해야 한다.
// neo 는 서비스가 멈추면 ServiceLifecycleStopped 이벤트로 cleanupServiceProxies(event.Name)
// 를 호출해 'service == 서비스명' 인 프록시를 자동 해제한다(mods/server/server.go).
// 이름이 다르면(예: 패키지 경로형) stop 시 매칭이 안 돼 프록시가 orphan 으로 남는다.
const PROXY_SVC = 'neo-pkg-llm';
// 백엔드 master 라우터는 /api/*, /db/tql, /ws/{user} 를 형제 root 경로로 분기하므로
// 각 prefix 를 따로 등록한다(단일 prefix 로는 한쪽만 매칭됨).
//   /ws/  → WS 업그레이드 경로. neo 서비스 프록시(httputil.ReverseProxy)가
//           Upgrade 헤더를 투명 포워딩하므로 별도 처리 없이 WS 핸드셰이크가 통과한다.
//           공개 /web/services/<SVC>/ws/{userId} → stripPrefix 후 백엔드 /ws/{userId}
//           → server.js 의 /ws/:user 라우트로 도달.
//
// NOTE: 과거에는 차트 에셋용으로 '/web/' prefix 도 등록했으나, neo 본체의 글로벌
// /web/* 라우트(neo-web UI · WS 포함)와 우선순위 충돌해 neo-web 의 다른 WS 까지
// 막는 부작용이 있어 제외. 차트 에셋은 페이지 origin(neo 본체)으로 직접 서빙되거나
// 별도 fix 로 처리한다.
const PROXY_PREFIXES = ['/api/', '/db/', '/ws/'];
// 기본 스트립(/web/services/<SVC>/<prefix>)이면 백엔드는 /configs · /tql 만 받아
// master 라우트(/api/configs, POST /db/tql)와 어긋난다. 그래서 서비스명까지만
// 제거하도록 stripPrefix 를 지정해 백엔드가 /api/configs · /db/tql 을 그대로 받게 한다.
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

// cfg → server.port. require(MAIN_JS) 가 같은 sys.json 을 로드하므로 target port 일치.
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
// service.proxy.register 는 net.Socket 이벤트 기반 '비동기' RPC다(jsh/lib/service.js).
// 컨트롤러로의 connect→write→data 가 모두 JSH 이벤트 루프가 돌아야 settle 된다.
// require(MAIN_JS) 는 in-process 로 server.serve() 까지 진입해 이벤트 루프를 점유한다
// (동기 블로킹). 따라서 register 직후 곧바로 require 하면 RPC 가 전송조차 안 돼 등록 0건.
// → 모든 register 콜백이 settle 된 뒤에만 bootMain() 을 호출하도록 순서를 보장한다.
// (register 는 동일 config 면 idempotent — 서비스 재시작마다 재등록해도 conflict 안 남.
//  종료 정리는 neo 가 stop 이벤트에서 service==PROXY_SVC 매칭으로 자동 해제하므로
//  수동 unregister 는 생략 — 시그널 kill 시 비동기 콜백이 못 settle 되어 신뢰 불가.)
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
