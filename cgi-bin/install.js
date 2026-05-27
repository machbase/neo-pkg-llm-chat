'use strict';

const path = require('path');
const process = require('process');
const fs = require('fs');
const service = require('service');

const ROOT = path.resolve(path.dirname(process.argv[1]));
const LLM_DIR = path.join(ROOT, 'llm');
const SERVICE_NAME = 'neo-pkg-llm';
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
  service.install({
    name: SERVICE_NAME,
    enable: true,
    working_dir: LLM_DIR,
    executable: LAUNCHER,
  }, (err) => {
    if (err) {
      reply({ ok: false, reason: err.message || String(err) });
      return;
    }
    // install 후 자동 start
    service.start(SERVICE_NAME, (startErr) => {
      if (startErr) {
        reply({ ok: true, data: { name: SERVICE_NAME, started: false, reason: startErr.message } });
      } else {
        reply({ ok: true, data: { name: SERVICE_NAME, started: true } });
      }
    });
  });
}
