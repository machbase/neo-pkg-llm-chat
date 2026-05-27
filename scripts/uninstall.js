'use strict';

// pkg run uninstall — JSH 서비스 중지 + 등록 해제.

var process = require('process');
var service = require('service');

var SERVICE_NAME = 'neo-pkg-llm';

console.println('stopping service:', SERVICE_NAME);
service.stop(SERVICE_NAME, function(stopErr) {
  if (stopErr) {
    console.println('WARN stop:', stopErr.message);
  } else {
    console.println('service stopped.');
  }

  console.println('uninstalling service:', SERVICE_NAME);
  service.uninstall(SERVICE_NAME, function(err) {
    if (err) {
      console.println('WARN uninstall:', err.message);
    } else {
      console.println('service uninstalled.');
    }
    console.println('done');
  });
});
