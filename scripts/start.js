'use strict';

// pkg run start — JSH 서비스 등록(필요 시) + 시작.

var path = require('path');
var process = require('process');
var fs = require('fs');
var service = require('service');

var ROOT = path.resolve(path.dirname(process.argv[1]), '..', 'cgi-bin');
var LLM_DIR = path.join(ROOT, 'llm');
var SERVICE_NAME = 'neo-pkg-llm';
var LAUNCHER = path.join(ROOT, 'llm-launcher.js');

if (!fs.existsSync(LAUNCHER)) {
  console.println('ERROR: launcher not found:', LAUNCHER);
  process.exit(1);
}

// 서비스 상태 확인 후 없으면 등록, 있으면 바로 시작
service.status(SERVICE_NAME, function(statusErr, info) {
  if (statusErr || !info) {
    // 서비스가 등록되어 있지 않으므로 등록
    console.println('installing service:', SERVICE_NAME);
    service.install({
      name: SERVICE_NAME,
      enable: true,
      working_dir: LLM_DIR,
      executable: LAUNCHER,
    }, function(err) {
      if (err) {
        console.println('ERROR install:', err.message || String(err));
        process.exit(1);
      }
      console.println('service installed.');
      doStart();
    });
  } else {
    doStart();
  }
});

function doStart() {
  console.println('starting service:', SERVICE_NAME);
  service.start(SERVICE_NAME, function(err) {
    if (err) {
      console.println('ERROR start:', err.message || String(err));
      process.exit(1);
    }
    console.println('service started.');
  });
}
