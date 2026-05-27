'use strict';

// CGI: POST /api/worker/stop?name=xxx
// Stops and uninstalls the named worker service

var process = require('process');
var service = require('service');

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
  var svcName = getQuery('name');
  if (!svcName) {
    reply({ ok: false, reason: 'name required' });
  } else {
    service.stop(svcName, function (err) {
      // stop 실패해도 uninstall은 항상 시도
      service.uninstall(svcName, function () {
        if (err) {
          var msg = err.message || String(err);
          if (/not\s*found|not\s*running/i.test(msg)) {
            reply({ ok: true, name: svcName, alreadyStopped: true });
          } else {
            reply({ ok: false, reason: msg });
          }
        } else {
          reply({ ok: true, name: svcName });
        }
      });
    });
  }
}
