'use strict';

// CGI stop — 워커 서비스 전체 중지 후 게이트웨이 서비스 중지

const process = require('process');
const path = require('path');
const fs = require('fs');
const service = require('service');

const DEFAULT_SERVICE_NAME = 'neo-pkg-llm';
const WORKER_PREFIX = 'llm-w-';
const ROOT = path.resolve(path.dirname(process.argv[1]));
const WORKERS_DIR = path.join(ROOT, 'llm', 'workers');

function reply(data) {
  const body = JSON.stringify(data);
  process.stdout.write('Content-Type: application/json\r\n');
  process.stdout.write('\r\n');
  process.stdout.write(body);
}

function getQueryParam(name) {
  const qs = process.env.get('QUERY_STRING') || '';
  const pairs = qs.split('&');
  for (let i = 0; i < pairs.length; i++) {
    const eq = pairs[i].indexOf('=');
    if (eq < 0) continue;
    if (decodeURIComponent(pairs[i].slice(0, eq)) === name) return decodeURIComponent(pairs[i].slice(eq + 1));
  }
  return '';
}

const method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
if (method !== 'POST') {
  reply({ ok: false, reason: 'method not allowed' });
} else {
  // 1. 설정 파일에서 워커 이름 수집
  const workerNames = [];
  try {
    if (fs.existsSync(WORKERS_DIR)) {
      const files = fs.readdirSync(WORKERS_DIR);
      for (let i = 0; i < files.length; i++) {
        if (files[i].endsWith('.json')) {
          const sessionID = files[i].replace(/\.json$/, '');
          workerNames.push(WORKER_PREFIX + sessionID.replace(/[^a-zA-Z0-9-]/g, '').substring(0, 20));
        }
      }
    }
  } catch (e) {}

  // 2. 워커 중지 → 파일 정리 → 게이트웨이 중지
  stopAll(workerNames, 0);
}

function stopAll(names, idx) {
  if (idx < names.length) {
    service.stop(names[idx], function () {
      service.uninstall(names[idx], function () {
        stopAll(names, idx + 1);
      });
    });
    return;
  }

  // 워커 설정 파일 삭제
  try {
    if (fs.existsSync(WORKERS_DIR)) {
      const files = fs.readdirSync(WORKERS_DIR);
      for (let i = 0; i < files.length; i++) {
        try { fs.unlinkSync(path.join(WORKERS_DIR, files[i])); } catch (e) {}
      }
    }
  } catch (e) {}

  // 게이트웨이 중지
  const SERVICE_NAME = getQueryParam('name') || DEFAULT_SERVICE_NAME;
  service.stop(SERVICE_NAME, (err) => {
    if (err) {
      const msg = err.message || String(err);
      if (/not\s*found|does not exist|not\s*running|already/i.test(msg)) {
        reply({ ok: true, data: { name: SERVICE_NAME, alreadyStopped: true, workers: names.length } });
      } else {
        reply({ ok: false, reason: msg });
      }
    } else {
      reply({ ok: true, data: { name: SERVICE_NAME, workers: names.length } });
    }
  });
}
