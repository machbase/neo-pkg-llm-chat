'use strict';

// pkg run install — 옛 파일 정리 + 게이트웨이 서비스 재등록(등록과 동시에 실행)

var path = require('path');
var process = require('process');
var fs = require('fs');
var service = require('service');
var gateway = require('./gateway');

var PKG_ROOT = path.resolve(path.dirname(process.argv[1]), '..');

// 실행 중 게이트웨이 — 업데이트 전 버전이 띄운 것 포함
var pids = gateway.launcherPids();

// 덮어쓰기 업데이트로 남은 파일 정리(목록: scripts/obsolete.json)
// · 실패해도 설치 진행 — 예외 무시
try {
  require('./cleanup').runCleanup(PKG_ROOT);
} catch (e) {
  console.println('[install] cleanup skipped: ' + (e && e.message ? e.message : String(e)));
}

if (!fs.existsSync(gateway.LAUNCHER)) {
  console.println('ERROR: launcher not found:', gateway.LAUNCHER);
  process.exit(1);
}

// 기존 게이트웨이 전부 중지·등록 해제 후 재등록 — 남은 등록이 있으면 "already exists"로 설치 실패
gateway.stopGateway(pids, function (killed) {
  service.uninstall(gateway.SERVICE_NAME, function () {
    // 종료한 프로세스의 포트 해제 대기
    setTimeout(function () {
      console.println('installing service:', gateway.SERVICE_NAME);
      gateway.register(function (err) {
        if (err) {
          console.println('ERROR:', err.message || String(err));
          process.exit(1);
        }
        console.println('service installed and started.');
      });
    }, killed ? 1000 : 0);
  });
});
