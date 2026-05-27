'use strict';

// pkg run install — JSH 서비스 등록 + 자동 시작.

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

console.println('installing service:', SERVICE_NAME);
service.install({
  name: SERVICE_NAME,
  enable: true,
  working_dir: LLM_DIR,
  executable: LAUNCHER,
}, function(err) {
  if (err) {
    console.println('ERROR:', err.message || String(err));
    process.exit(1);
  }
  console.println('service installed.');

  // install 후 자동 start
  console.println('starting service:', SERVICE_NAME);
  service.start(SERVICE_NAME, function(startErr) {
    if (startErr) {
      console.println('WARN start:', startErr.message);
    } else {
      console.println('service started.');
    }
  });
});
