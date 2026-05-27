'use strict';

// CGI: POST /api/worker/start?session_id=xxx
// Reads workers/{session_id}.json for worker config, then service.install + start

var process = require('process');
var path = require('path');
var fs = require('fs');
var service = require('service');

var ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
var LLM_DIR = path.join(ROOT, 'llm');
var WORKERS_DIR = path.join(LLM_DIR, 'workers');
var WORKER_SCRIPT = path.join(LLM_DIR, 'worker.js');
var WORKER_PREFIX = 'llm-w-';

function reply(data) {
  process.stdout.write('Content-Type: application/json\r\n');
  process.stdout.write('\r\n');
  process.stdout.write(JSON.stringify(data));
}

function getQuery(name) {
  var qs = process.env.get('QUERY_STRING') || '';
  var pairs = qs.split('&');
  for (var i = 0; i < pairs.length; i++) {
    var eq = pairs[i].indexOf('=');
    if (eq < 0) continue;
    if (decodeURIComponent(pairs[i].slice(0, eq)) === name) return decodeURIComponent(pairs[i].slice(eq + 1));
  }
  return '';
}

var method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
if (method !== 'POST') {
  reply({ ok: false, reason: 'method not allowed' });
} else {
  var sessionID = getQuery('session_id');
  if (!sessionID) {
    reply({ ok: false, reason: 'session_id required' });
  } else {
    var svcName = WORKER_PREFIX + sessionID.replace(/[^a-zA-Z0-9-]/g, '').substring(0, 20);
    service.install({
      name: svcName,
      working_dir: LLM_DIR,
      executable: WORKER_SCRIPT,
      args: [sessionID],
    }, function (err) {
      if (err) {
        reply({ ok: false, reason: 'install failed: ' + err.message });
        return;
      }
      service.start(svcName, function (startErr) {
        if (startErr) {
          reply({ ok: false, reason: 'start failed: ' + startErr.message });
        } else {
          reply({ ok: true, name: svcName });
        }
      });
    });
  }
}
