'use strict';

// pkg run uninstall — 게이트웨이 전부 중지 + 서비스 등록 해제

var process = require('process');
var service = require('service');
var gateway = require('./gateway');

var pids = gateway.launcherPids();

console.println('stopping service:', gateway.SERVICE_NAME);
gateway.stopGateway(pids, function (killed, stopErr) {
  if (stopErr) {
    console.println('WARN stop:', stopErr.message);
  } else {
    console.println('service stopped.');
  }

  console.println('uninstalling service:', gateway.SERVICE_NAME);
  service.uninstall(gateway.SERVICE_NAME, function (err) {
    if (err) {
      console.println('WARN uninstall:', err.message);
    } else {
      console.println('service uninstalled.');
    }
    console.println('done');
  });
});
