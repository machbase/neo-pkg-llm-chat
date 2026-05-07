'use strict';

// pkg run stop — 패키지 관리 서비스 중지 + 바이너리 트리 정리.

var process = require('process');
var service = require('service');

var SERVICE_NAME = 'neo-pkg-llm';

// 1. 프로세스 트리 먼저 정리
killLlmTree();

// 2. service.stop으로 레지스트리 상태 stopped 전이
console.println('stopping service:', SERVICE_NAME);
service.stop(SERVICE_NAME, function(err) {
  if (err) {
    console.println('WARN:', err.message);
  } else {
    console.println('service stopped.');
  }
});

function killLlmTree() {
  var fs = require('fs');
  var path = require('path');
  var os = require('os');
  var IS_WIN = os.platform() === 'windows';
  var BIN_NAME = IS_WIN ? 'neo-pkg-llm.exe' : 'neo-pkg-llm';

  // 1. OS 레벨 fallback — JSH 재시작으로 /proc/process tracker 가 비었거나
  //    stale 인 orphan 좀비 대응. 이게 빠지면 service.stop 이 launcher 의
  //    cmd.Wait() 에서 풀리지 않아 먹통이 되는 케이스 발생.
  try {
    if (IS_WIN) {
      process.exec('@taskkill', '/F', '/IM', BIN_NAME);
    } else {
      process.exec('@pkill', '-9', '-x', BIN_NAME);
    }
  } catch (e) {}

  // 2. /proc/process 기반 정확한 트리 kill (tracker 살아있는 경우)
  var procRoot = '/proc/process';
  if (!fs.existsSync(procRoot)) return;

  var re = /[\/\\]neo-pkg-llm(\.exe)?(\s|$|"|')/;
  var found = null;
  var entries = fs.readdirSync(procRoot);
  for (var i = 0; i < entries.length; i++) {
    var metaPath = path.join(procRoot, entries[i], 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      var meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      var exe = meta.exec_path || meta.command || '';
      var args = meta.args || [];
      var match = re.test(exe);
      for (var j = 0; !match && j < args.length; j++) {
        match = re.test(String(args[j]));
      }
      if (match) {
        found = { pid: meta.pid, pgid: meta.pgid > 0 ? meta.pgid : meta.pid };
        break;
      }
    } catch (e) {}
  }

  if (!found) return;
  console.println('killLlmTree: pid=' + found.pid + ' pgid=' + found.pgid);

  if (IS_WIN) {
    try { process.exec('@taskkill', '/T', '/PID', String(found.pid)); } catch (e) {}
    try { process.exec('@taskkill', '/F', '/T', '/PID', String(found.pid)); } catch (e) {}
  } else {
    // TERM 후 짧게 대기해 binary 가 cleanup 핸들러 돌릴 시간을 준다.
    // sleep 호출 실패해도 KILL 은 무조건 시도 (graceful 못 되면 force).
    try { process.exec('@kill', '-TERM', '-' + found.pgid); } catch (e) {}
    try { process.exec('@sleep', '0.5'); } catch (e) {}
    try { process.exec('@kill', '-KILL', '-' + found.pgid); } catch (e) {}
  }
}
