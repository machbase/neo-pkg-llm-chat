'use strict';

// CGI start — 서비스 미등록 시 등록(enable:true, 부팅 자동 시작) 후 시작

const process = require('process');
const path = require('path');
const fs = require('fs');
const service = require('service');

const SERVICE_NAME = 'neo-pkg-llm';
const ROOT = path.resolve(path.dirname(process.argv[1]));
const LLM_DIR = path.join(ROOT, 'llm');
const LAUNCHER = path.join(ROOT, 'llm-launcher.js');

function reply(data) {
  const body = JSON.stringify(data);
  process.stdout.write('Content-Type: application/json\r\n');
  process.stdout.write('\r\n');
  process.stdout.write(body);
}

const method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
if (method !== 'POST') {
  reply({ ok: false, reason: 'method not allowed' });
} else if (!fs.existsSync(LAUNCHER)) {
  reply({ ok: false, reason: 'launcher not found: ' + LAUNCHER });
} else {
  service.status(SERVICE_NAME, (statusErr, info) => {
    if (statusErr || !info) {
      // 미등록 → 설치(enable:true, 부팅 자동 시작) 후 시작
      service.install({
        name: SERVICE_NAME,
        enable: true,
        working_dir: LLM_DIR,
        executable: LAUNCHER,
      }, (installErr) => {
        if (installErr) {
          reply({ ok: false, reason: 'install failed: ' + (installErr.message || String(installErr)) });
          return;
        }
        service.start(SERVICE_NAME, (startErr) => {
          if (startErr) {
            reply({ ok: true, data: { name: SERVICE_NAME, installed: true, started: false, reason: startErr.message } });
          } else {
            reply({ ok: true, data: { name: SERVICE_NAME, installed: true, started: true } });
          }
        });
      });
      return;
    }
    // 등록됨 → 시작(실행 중이면 무동작)
    service.start(SERVICE_NAME, (startErr) => {
      if (startErr) {
        reply({ ok: false, reason: startErr.message || String(startErr) });
      } else {
        reply({ ok: true, data: { name: SERVICE_NAME, started: true } });
      }
    });
  });
}
