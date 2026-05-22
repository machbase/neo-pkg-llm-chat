'use strict';

// JSH 런타임에서 실행됨. cgi-bin/config.json의 port를 읽어 -port 로 전달하고,
// -config는 configs/ 밖 경로(_boot.json)로 지정하여 Manager가 sys.json을
// 자동 생성하지 않도록 한다. Linux / macOS / Windows 공통 지원.

const process = require('process');
const pathLib = require('path');
const os = require('os');
const fs = require('fs');
const service = require('service');

// ── 서비스 프록시 식별자 ──
// neo 본체가 /web/services/<SVC>/<prefix>/* 를 127.0.0.1:<port> 로 포워딩한다.
// 프론트는 포트 직접 호출 대신 이 공개 경로를 사용 → 포트 노출/CORS 불필요.
//
// !! SVC 는 반드시 JSH 서비스명(scripts/install.js 의 SERVICE_NAME)과 동일해야 한다.
// neo 는 서비스가 멈추면 ServiceLifecycleStopped 이벤트로 cleanupServiceProxies(event.Name)
// 를 호출해 'service == 서비스명' 인 프록시를 자동 해제한다(mods/server/server.go).
// 이름이 다르면(예: 패키지 경로형) stop 시 매칭이 안 돼 프록시가 orphan 으로 남는다.
const PROXY_SVC = 'neo-pkg-llm';
// 백엔드 master 라우터는 /api/*, /db/tql, /ws/{name}, /web/* 을 형제 root 경로로 분기하므로
// 각 prefix 를 따로 등록한다(단일 prefix 로는 한쪽만 매칭됨).
//   /ws/  → WS 업그레이드 경로. neo 서비스 프록시(httputil.ReverseProxy)가
//           Upgrade 헤더를 투명 포워딩하므로 별도 처리 없이 WS 핸드셰이크가 통과한다.
//           공개 /web/services/<SVC>/ws/{userId} → stripPrefix 후 백엔드 /ws/{userId}
//           → master /ws/ 분기 → 인스턴스 /ws 로 도달.
//   /web/ → TQL 차트 에셋(/web/echarts/*, /web/api/tql-assets/*). 프론트가 iframe 에
//           심는 절대경로를 /web/services/<SVC>/web/... 로 재작성해 보내면 stripPrefix 후
//           백엔드가 /web/... 를 받아 차트 JS/CSS 를 서빙한다(포트 직접 노출 제거).
const PROXY_PREFIXES = ['/api/', '/db/', '/ws/', '/web/'];
// 기본 스트립(/web/services/<SVC>/<prefix>)이면 백엔드는 /configs · /tql 만 받아
// master 라우트(/api/configs, POST /db/tql)와 어긋난다. 그래서 서비스명까지만
// 제거하도록 stripPrefix 를 지정해 백엔드가 /api/configs · /db/tql 을 그대로 받게 한다.
const PROXY_STRIP = '/web/services/' + PROXY_SVC;

const IS_WIN = os.platform() === 'windows';
const posix = pathLib;
const hostPath = IS_WIN ? pathLib.win32 : pathLib;

// ── JSH 가상경로 (POSIX 고정) ──
const SCRIPT_DIR = posix.resolve(posix.dirname(process.argv[1])); // /work/.../cgi-bin
const LLM_DIR = posix.join(SCRIPT_DIR, 'llm');                    // /work/.../cgi-bin/llm
const CONFIG_JSON = posix.join(SCRIPT_DIR, 'config.json');        // cgi-bin/config.json
const BIN_NAME = IS_WIN ? 'neo-pkg-llm.exe' : 'neo-pkg-llm';

// ── port 읽기 (없으면 기본 8884) ──
let port = '8884';
try {
  if (fs.existsSync(CONFIG_JSON)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_JSON, { encoding: 'utf8' }));
    if (cfg && cfg.server && cfg.server.port) port = String(cfg.server.port);
  }
} catch (e) {
  // 기본값 사용
}

// ── 호스트 경로 변환 ──
const hostWorkDir = hostPath.dirname(process.execPath);
const relFromWork = LLM_DIR.replace(/^\/work\//, '');
const hostLlmDir = hostPath.join(hostWorkDir, relFromWork);
const executable = hostPath.join(hostLlmDir, BIN_NAME);
// throwaway bootstrap — configs/ 밖이라 Manager.LoadAll 스캔 대상 아님
// → 사용자가 설정 저장하기 전까지 sys.json 자동 생성 안 됨 → 프론트는 settings 탭으로 분기
const bootConfig = hostPath.join(hostLlmDir, '_boot.json');

console.println('launching:', executable);
console.println('port:', port);
console.println('boot config:', bootConfig);
console.println('cwd:', hostLlmDir);

// ── 서비스 프록시 등록 → 바이너리 기동 (순서 중요) ──
// service.proxy.register 는 net.Socket 이벤트 기반 '비동기' RPC다(jsh/lib/service.js).
// 컨트롤러로의 connect→write→data 가 모두 JSH 이벤트 루프가 돌아야 settle 된다.
// 반면 아래 process.exec 는 바이너리가 사는 내내 루프를 '동기 블로킹'한다.
// 따라서 register 호출 직후 곧바로 exec 하면 RPC 가 전송조차 안 돼 등록이 0건이 된다.
// → 모든 register 콜백이 settle 된 뒤에만 launchBinary() 를 호출하도록 순서를 보장한다.
//   (register 는 동일 config 면 idempotent — 서비스 재시작마다 재등록해도 conflict 안 남.
//    RPC 의 keep-alive 타이머가 settle 까지 프로세스를 살려두므로 exec 전에 안전히 완료된다.)
const proxyTarget = 'http://127.0.0.1:' + port;

function unregisterProxy() {
  service.proxy.unregister(PROXY_SVC, function () {});
}

function launchBinary() {
  // 바이너리 종료(= exec 반환) 시 등록 해제. exec 가 블로킹되어 process.on('exit')
  // 도달이 보장되지 않을 수 있으므로 exec 반환 직후에도 명시적으로 해제한다.
  process.on('exit', unregisterProxy);

  // 바이너리 Manager는 configs/ 를 cwd 기준 상대경로로 스캔하므로
  // cwd = hostLlmDir (= cgi-bin/llm) 이어야 configs/sys.json이 올바른 위치에 생성됨.
  var exitCode;
  if (IS_WIN) {
    // cmd.exe /C "명령" 전달 시 Go의 Windows escape(` -> \")가 cmd 파서와 불일치 → 따옴표 깨짐.
    // 회피: .bat 파일로 저장 후 실행 (cmd가 파일 읽을 때는 따옴표 정상 해석)
    const batVirtual = posix.join(LLM_DIR, '_launch.bat');
    const batHost = hostPath.join(hostLlmDir, '_launch.bat');
    const batContent = [
      '@echo off',
      'cd /d "' + hostLlmDir + '"',
      '"' + executable + '" -port ' + port + ' -config "' + bootConfig + '"',
    ].join('\r\n') + '\r\n';
    fs.writeFileSync(batVirtual, batContent);
    exitCode = process.exec('@cmd.exe', '/C', batHost);
  } else {
    const script = `cd "${hostLlmDir}" && exec "${executable}" -port "${port}" -config "${bootConfig}"`;
    exitCode = process.exec('@/bin/sh', '-c', script);
  }
  // 바이너리가 종료되어 exec 가 반환됨 → 프록시 매핑이 죽은 target 을 가리키지 않도록 해제.
  unregisterProxy();
  process.exit(exitCode);
}

// 모든 prefix 의 register 가 settle(성공/실패 무관) 된 뒤 단 한 번 바이너리를 띄운다.
// 콜백이 안 오는 경우(컨트롤러 불가)에도 RPC timeout(약 5s) 후 err 콜백이 와서 진행되므로
// 프록시 실패가 바이너리 기동을 영구 차단하지는 않는다.
var pendingProxy = PROXY_PREFIXES.length;
function onProxySettled() {
  pendingProxy -= 1;
  if (pendingProxy === 0) launchBinary();
}
PROXY_PREFIXES.forEach(function (prefix) {
  service.proxy.register({
    service: PROXY_SVC,
    prefix: prefix,
    target: proxyTarget,
    stripPrefix: PROXY_STRIP,
    healthPath: '/health',
  }, function (err, entry) {
    if (err) {
      console.println('proxy register failed:', prefix, err.message);
    } else {
      console.println('proxy registered:', '/web/services/' + PROXY_SVC + prefix);
    }
    onProxySettled();
  });
});
