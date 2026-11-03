'use strict';

// 서비스 헬스 체크 — service controller(servicectl status) 상태 기준
//   status === 'running'               → healthy: true
//   stopped/starting/stopping/failed   → healthy: false  (상태/에러 함께 반환)
//   service 미설치                      → status: 'not_installed', healthy: false
//   controller 연결 실패 / timeout      → HTTP 503

const process = require('process');
const service = require('service');

const SERVICE_NAME = 'neo-pkg-llm';
const RPC_TIMEOUT_MS = 3000;

function reply(status, data) {
  process.stdout.write('Content-Type: application/json\r\n');
  process.stdout.write('Status: ' + status + '\r\n');
  process.stdout.write('\r\n');
  process.stdout.write(JSON.stringify(data));
}

function summarize(result) {
  const status = (result && result.status) || 'unknown';
  return {
    healthy: status === 'running',
    status: status,
    pid: (result && result.pid) || 0,
    exit_code: result && result.exit_code !== undefined && result.exit_code !== null ? result.exit_code : null,
    error: (result && result.error) || '',
  };
}

try {
  service.status(SERVICE_NAME, { timeout: RPC_TIMEOUT_MS }, (err, result) => {
    if (err) {
      const msg = err.message || String(err);
      if (/not\s*found|does not exist/i.test(msg)) {
        reply(200, {
          ok: true,
          data: { healthy: false, status: 'not_installed', pid: 0, exit_code: null, error: msg },
        });
        return;
      }
      reply(503, { ok: false, reason: msg });
      return;
    }
    reply(200, { ok: true, data: summarize(result) });
  });
} catch (e) {
  reply(500, { ok: false, reason: e.message || String(e) });
}
