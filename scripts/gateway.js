'use strict';

// 게이트웨이 서비스 공용 — install·start·stop·uninstall 스크립트에서 사용
// · service.install(enable:true)는 등록과 동시에 1개 실행, 실행 중 service.start는 1개 추가 실행
// · 서비스가 추적하지 않는 게이트웨이(중복 실행분)는 /proc/process에서 런처 경로로 찾아 종료

var path = require('path');
var fs = require('fs');
var process = require('process');
var service = require('service');

var SERVICE_NAME = 'neo-pkg-llm';
var PKG_ROOT = path.resolve(path.dirname(process.argv[1]), '..');
var LLM_DIR = path.join(PKG_ROOT, 'cgi-bin', 'llm');
var LAUNCHER = path.join(PKG_ROOT, 'cgi-bin', 'llm-launcher.js');
var PROC_DIR = '/proc/process';

// 이 패키지 런처로 실행 중인 프로세스 pid — 다른 폴더 사본 제외
// · 스크립트 시작 직후 호출 — 같은 프로세스 안에서 종료한 항목은 목록에 한동안 남음
function launcherPids() {
  var pids = [];
  var names;
  try { names = fs.readdirSync(PROC_DIR); } catch (e) { return pids; }
  for (var i = 0; i < names.length; i++) {
    try {
      var meta = JSON.parse(fs.readFileSync(PROC_DIR + '/' + names[i] + '/meta.json', 'utf8'));
      var args = meta.args || [];
      if (meta.pid !== process.pid && args.length && path.resolve(String(args[args.length - 1])) === LAUNCHER) pids.push(meta.pid);
    } catch (e) {}
  }
  return pids;
}

// 게이트웨이 전부 중지 — 추적 밖 프로세스 종료 후 서비스 중지, cb(종료한 수, 중지 오류)
function stopGateway(pids, cb) {
  service.status(SERVICE_NAME, function (err, info) {
    var tracked = !err && info && info.status === 'running' ? info.pid : 0;
    var killed = 0;
    for (var i = 0; i < pids.length; i++) {
      if (pids[i] === tracked) continue;
      try { process.kill(pids[i]); killed++; } catch (e) {
        console.println('WARN kill ' + pids[i] + ': ' + (e && e.message ? e.message : String(e)));
      }
    }
    if (killed) console.println('killed untracked gateway process(es): ' + killed);
    service.stop(SERVICE_NAME, function (stopErr) { cb(killed, stopErr); });
  });
}

// 서비스 등록 — 등록과 동시에 실행, Neo 재시작 시 자동 시작
function register(cb) {
  service.install({
    name: SERVICE_NAME,
    enable: true,
    working_dir: LLM_DIR,
    executable: LAUNCHER,
  }, cb);
}

module.exports = {
  SERVICE_NAME: SERVICE_NAME,
  LAUNCHER: LAUNCHER,
  launcherPids: launcherPids,
  stopGateway: stopGateway,
  register: register,
};
