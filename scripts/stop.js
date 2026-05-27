'use strict';

// pkg run stop — 모든 워커 서비스 정리 + Gateway 서비스 중지
// Workers are identified by config files in cgi-bin/llm/workers/*.json

var path = require('path');
var process = require('process');
var fs = require('fs');
var service = require('service');

var SERVICE_NAME = 'neo-pkg-llm';
var WORKER_PREFIX = 'llm-w-';
var ROOT = path.resolve(path.dirname(process.argv[1]), '..', 'cgi-bin');
var WORKERS_DIR = path.join(ROOT, 'llm', 'workers');
var LOG_FILE = path.join(path.resolve(path.dirname(process.argv[1]), '..'), 'stop-beacon.log');

var keepAlive = setInterval(function () {}, 1000);

function beacon(msg) {
  try { fs.writeFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + msg + '\n', { flag: 'a' }); } catch (e) {}
}

beacon('stop.js invoked');

// 1. Collect worker service names from config files
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

// 2. Stop workers then gateway
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

  // All workers done → cleanup files
  try {
    if (fs.existsSync(WORKERS_DIR)) {
      var wfiles = fs.readdirSync(WORKERS_DIR);
      for (var k = 0; k < wfiles.length; k++) {
        try { fs.unlinkSync(path.join(WORKERS_DIR, wfiles[k])); } catch (e) {}
      }
    }
  } catch (e) {}

  // Stop gateway
  console.println('[stop] stopping gateway:', SERVICE_NAME);
  service.stop(SERVICE_NAME, function (err) {
    beacon('gateway: ' + (err ? err.message : 'stop OK'));
    console.println('[stop] ' + (err ? 'WARN: ' + err.message : 'stopped.'));
    clearInterval(keepAlive);
    process.exit(0);
  });
}
