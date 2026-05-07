'use strict';

// pkg run start — 패키지 관리 서비스 시작 (현재: neo-pkg-llm 1개).
// service.start 전에 좀비 프로세스를 선제적으로 정리해 포트(8884) 점유로
// 새 launcher 의 binary 가 즉시 죽는 상황을 방지한다.

var process = require('process');
var service = require('service');
var fs = require('fs');
var path = require('path');
var os = require('os');

var SERVICE_NAME = 'neo-pkg-llm';
var IS_WIN = os.platform() === 'windows';
var BIN_NAME = IS_WIN ? 'neo-pkg-llm.exe' : 'neo-pkg-llm';

preemptiveKill();

console.println('starting service:', SERVICE_NAME);
service.start(SERVICE_NAME, function(err) {
  if (err) {
    console.println('ERROR:', err.message);
    process.exit(1);
    return;
  }
  console.println('service started.');
});

// install.js / uninstall.js 의 같은 이름 함수와 동일한 2단(OS pkill + /proc/process) 패턴.
function preemptiveKill() {
  // 1. OS 레벨 fallback — /proc/process tracker 밖 좀비 대응
  try {
    if (IS_WIN) {
      process.exec('@taskkill', '/F', '/IM', BIN_NAME);
    } else {
      process.exec('@pkill', '-9', '-x', BIN_NAME);
    }
  } catch (e) {}

  // 2. /proc/process 기반 정확한 트리 kill
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
  console.println('preemptive kill: pid=' + found.pid + ' pgid=' + found.pgid);

  if (IS_WIN) {
    try { process.exec('@taskkill', '/T', '/PID', String(found.pid)); } catch (e) {}
    try { process.exec('@taskkill', '/F', '/T', '/PID', String(found.pid)); } catch (e) {}
  } else {
    try { process.exec('@kill', '-TERM', '-' + found.pgid); } catch (e) {}
    try { process.exec('@sleep', '0.5'); } catch (e) {}
    try { process.exec('@kill', '-KILL', '-' + found.pgid); } catch (e) {}
  }
}
