'use strict';

// CGI: POST /api/worker/sweep[?keep=sess-a,sess-b]
// 고아 llm-w-* 워커 서비스 제거 + 설정 파일 삭제
// · 워커 흔적 위치: Neo 서비스 레지스트리(etc/services/<name>.json)·workers/<sessionID>.json
// · 레지스트리 기준 정리 — 남은 항목은 Neo 종료마다 STOP 줄 유발, 설정 파일보다 오래 잔존
// · service.list(controller, cb) — 주소는 resolveController(), 항목은 {config:{name,...}, status}
// · enable:false·status:"stopped" 항목도 목록에 포함 → 정리 대상

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

// 배열·래퍼 객체 모두 허용, 항목은 {config:{name}}·{name}·문자열 허용
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

// 게이트웨이가 아직 라우팅 중인 세션 — 서비스 유지 대상
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
    // stop 실패 무시 — 이미 죽은 서비스도 정의 삭제 필요
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

// 라우팅 대상 아닌 세션의 설정 파일 삭제 — 남으면 stop.js 서비스 목록에 섞임
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
