'use strict';

const process = require('process');
const service = require('service');

const SERVICE_NAME = 'neo-pkg-llm';

function reply(data) {
  const body = JSON.stringify(data);
  process.stdout.write('Content-Type: application/json\r\n');
  process.stdout.write('\r\n');
  process.stdout.write(body);
}

service.status(SERVICE_NAME, (err, result) => {
  if (err) {
    reply({ ok: false, reason: err.message || String(err) });
  } else {
    reply({ ok: true, data: result });
  }
});
