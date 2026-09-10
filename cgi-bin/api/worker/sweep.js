'use strict';

// CGI: POST /api/worker/sweep[?keep=sess-a,sess-b]
// Uninstalls orphaned llm-w-* worker services and removes their config files.
//
// Worker services live in two separate places: Neo's own service registry
// (etc/services/<name>.json, written by service.install) and this package's
// workers/<sessionID>.json. A crash leaves entries in both, and a leftover
// registry entry makes Neo emit a STOP line for it on every shutdown, so the
// registry is the authority here — an entry there can outlive the config file
// by months.
//
// service.list is undocumented: it takes (controller, callback), the address
// comes from resolveController(), and each entry is {config:{name,...}, status}
// — not a bare name. Entries with enable:false and status:"stopped" do appear,
// which is exactly the stale case this sweeps.

var process = require('process');
var path = require('path');
var fs = require('fs');
var service = require('service');

var ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
var WORKERS_DIR = path.join(ROOT, 'llm', 'workers');
var WORKER_PREFIX = 'llm-w-';

var diag = [];

function reply(data) {
  data.diag = diag.join('; ');
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

function svcNameOf(sessionID) {
  return WORKER_PREFIX + sessionID.replace(/[^a-zA-Z0-9-]/g, '').substring(0, 20);
}

// Tolerate a plain array or a wrapper, and entries that are {config:{name}},
// {name}, or a bare string.
function toNames(result) {
  var arr = result;
  if (arr && !Array.isArray(arr)) arr = arr.services || arr.data || arr.list;
  if (!Array.isArray(arr)) return null;
  var names = [];
  for (var i = 0; i < arr.length; i++) {
    var e = arr[i];
    var n = typeof e === 'string' ? e : (e && ((e.config && e.config.name) || e.name));
    if (n) names.push(n);
  }
  return names;
}

// Sessions the gateway still routes — their services must survive.
var keepSvc = {};

var method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
if (method !== 'POST') {
  reply({ ok: false, reason: 'method not allowed' });
} else {
  var keepRaw = getQuery('keep');
  if (keepRaw) {
    var ids = keepRaw.split(',');
    for (var k = 0; k < ids.length; k++) {
      if (ids[k]) keepSvc[svcNameOf(ids[k])] = true;
    }
  }

  var addr;
  try {
    addr = service.resolveController();
  } catch (e) {
    reply({ ok: false, reason: 'resolveController failed: ' + (e.message || String(e)) });
    addr = null;
  }

  if (addr) {
    service.list(addr, function (err, result) {
      if (err) {
        reply({ ok: false, reason: 'list failed: ' + (err.message || String(err)) });
        return;
      }
      var names = toNames(result);
      if (!names) {
        reply({ ok: false, reason: 'unexpected service.list shape: ' + JSON.stringify(result).substring(0, 200) });
        return;
      }
      diag.push('listed=' + names.length);
      var orphans = [];
      for (var i = 0; i < names.length; i++) {
        if (names[i].indexOf(WORKER_PREFIX) !== 0) continue;
        if (keepSvc[names[i]]) continue;
        orphans.push(names[i]);
      }
      uninstallAll(orphans, 0, []);
    });
  }
}

function uninstallAll(names, idx, failed) {
  if (idx < names.length) {
    // stop 실패는 무시한다 — 이미 죽은 서비스도 정의는 지워야 한다.
    service.stop(names[idx], function () {
      service.uninstall(names[idx], function (err) {
        if (err) failed.push(names[idx] + ':' + (err.message || err));
        uninstallAll(names, idx + 1, failed);
      });
    });
    return;
  }
  reply({ ok: true, removed: names.length - failed.length, failed: failed, files: sweepFiles() });
}

// Config files for sessions the gateway no longer routes. Left behind by the
// same crash; harmless on their own but they feed stop.js's service list.
function sweepFiles() {
  var removed = 0;
  var files;
  try { files = fs.readdirSync(WORKERS_DIR); } catch (e) { return 0; }
  for (var i = 0; i < files.length; i++) {
    if (!files[i].endsWith('.json')) continue;
    if (keepSvc[svcNameOf(files[i].replace(/\.json$/, ''))]) continue;
    try { fs.unlinkSync(path.join(WORKERS_DIR, files[i])); removed++; } catch (e) {}
  }
  return removed;
}
