'use strict';

// pkg run stop — 모든 워커 서비스 정리 + 게이트웨이 전부 중지
// 워커 식별 기준: cgi-bin/llm/workers/*.json 설정 파일

var path = require('path');
var process = require('process');
var fs = require('fs');
var service = require('service');
var gateway = require('./gateway');

var SERVICE_NAME = gateway.SERVICE_NAME;
var WORKER_PREFIX = 'llm-w-';
var gatewayPids = gateway.launcherPids();
var ROOT = path.resolve(path.dirname(process.argv[1]), '..', 'cgi-bin');
var WORKERS_DIR = path.join(ROOT, 'llm', 'workers');
var LOG_FILE = path.join(path.resolve(path.dirname(process.argv[1]), '..'), 'stop-beacon.log');

var keepAlive = setInterval(function () {}, 1000);

function beacon(msg) {
  try { fs.writeFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + msg + '\n', { flag: 'a' }); } catch (e) {}
}

beacon('stop.js invoked');

// 1. 설정 파일에서 워커 서비스 이름 수집
var workerNames = [];
try {
  if (fs.existsSync(WORKERS_DIR)) {
    var files = fs.readdirSync(WORKERS_DIR);
    for (var i = 0; i < files.length; i++) {
      if (files[i].endsWith('.json')) {
        var sessionID = files[i].replace(/\.json$/, '');
        workerNames.push(WORKER_PREFIX + sessionID.replace(/[^a-zA-Z0-9-]/g, '').substring(0, 20));
      }
    }
  }
} catch (e) {
  beacon('scan error: ' + e.message);
}

beacon('found ' + workerNames.length + ' workers: ' + workerNames.join(', '));
console.println('[stop] found ' + workerNames.length + ' worker(s)');

// 2. 워커 중지 후 게이트웨이 중지
stopAll(workerNames, 0);

function stopAll(names, idx) {
  if (idx < names.length) {
    var name = names[idx];
    beacon('stopping worker: ' + name);
    console.println('[stop] stopping worker:', name);
    service.stop(name, function (err) {
      beacon('stop ' + name + ': ' + (err ? err.message : 'OK'));
      service.uninstall(name, function () {
        stopAll(names, idx + 1);
      });
    });
    return;
  }

  // 워커 처리 완료 → 설정 파일 삭제
  try {
    if (fs.existsSync(WORKERS_DIR)) {
      var wfiles = fs.readdirSync(WORKERS_DIR);
      for (var k = 0; k < wfiles.length; k++) {
        try { fs.unlinkSync(path.join(WORKERS_DIR, wfiles[k])); } catch (e) {}
      }
    }
  } catch (e) {}

  // 게이트웨이 중지 — 서비스가 추적하지 않는 중복 실행분 포함
  console.println('[stop] stopping gateway:', SERVICE_NAME);
  gateway.stopGateway(gatewayPids, function (killed, err) {
    beacon('gateway: ' + (err ? err.message : 'stop OK') + (killed ? ', killed untracked ' + killed : ''));
    console.println('[stop] ' + (err ? 'WARN: ' + err.message : 'stopped.'));
    clearInterval(keepAlive);
    process.exit(0);
  });
}
