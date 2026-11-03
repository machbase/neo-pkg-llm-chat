'use strict';

// pkg run start — 게이트웨이 1개만 실행(이미 1개 실행 중이면 그대로)

var process = require('process');
var fs = require('fs');
var service = require('service');
var gateway = require('./gateway');

var pids = gateway.launcherPids();

if (!fs.existsSync(gateway.LAUNCHER)) {
  console.println('ERROR: launcher not found:', gateway.LAUNCHER);
  process.exit(1);
}

service.status(gateway.SERVICE_NAME, function (statusErr, info) {
  var registered = !statusErr && !!info;
  var running = registered && info.status === 'running';
  var extra = pids.filter(function (pid) { return !running || pid !== info.pid; });
  if (running && !extra.length) {
    console.println('service already running.');
    return;
  }

  // 남은 게이트웨이 정리 후 1개 실행 — 미등록이면 등록이 곧 실행
  gateway.stopGateway(pids, function (killed) {
    setTimeout(function () {
      if (registered) {
        console.println('starting service:', gateway.SERVICE_NAME);
        service.start(gateway.SERVICE_NAME, done);
      } else {
        console.println('installing service:', gateway.SERVICE_NAME);
        gateway.register(done);
      }
    }, killed ? 1000 : 0);
  });
});

function done(err) {
  if (err) {
    console.println('ERROR start:', err.message || String(err));
    process.exit(1);
  }
  console.println('service started.');
}
