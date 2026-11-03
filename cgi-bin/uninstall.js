'use strict';

const process = require('process');
const service = require('service');

const DEFAULT_SERVICE_NAME = 'neo-pkg-llm';

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
    const k = decodeURIComponent(pairs[i].slice(0, eq));
    if (k === name) return decodeURIComponent(pairs[i].slice(eq + 1));
  }
  return '';
}

const method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
if (method !== 'POST') {
  reply({ ok: false, reason: 'method not allowed' });
} else {
  // 선택 ?name=xxx — 잔존 서비스 등록 정리용
  const SERVICE_NAME = getQueryParam('name') || DEFAULT_SERVICE_NAME;

  function doUninstall() {
    service.uninstall(SERVICE_NAME, (err) => {
      if (err) {
        const msg = err.message || String(err);
        if (/not\s*found|does not exist/i.test(msg)) {
          reply({ ok: true, data: { name: SERVICE_NAME, alreadyAbsent: true } });
        } else {
          reply({ ok: false, reason: msg });
        }
      } else {
        reply({ ok: true, data: { name: SERVICE_NAME } });
      }
    });
  }

  // 먼저 중지 — 일부 neo 버전은 중지 상태에서만 uninstall 가능
  service.stop(SERVICE_NAME, (stopErr) => {
    // stop 오류 무시(이미 중지·미등록 가능) 후 진행
    doUninstall();
  });
}
