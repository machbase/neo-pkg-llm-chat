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
  // Optional ?name=xxx for cleaning up old/stale service registrations
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

  // Stop first (uninstall requires the service to be stopped on some neo versions).
  service.stop(SERVICE_NAME, (stopErr) => {
    // Ignore stop errors (service might already be stopped or not found) and proceed.
    doUninstall();
  });
}
