'use strict';

// Frontend calls this on every page load to discover the LLM server port.
// Returns port info only — service lifecycle is managed by scripts/start.js,
// scripts/stop.js, and the package toggle in Neo's UI.

var process = require('process');
var path = require('path');
var fs = require('fs');

var CGI_BIN_DIR = path.resolve(path.dirname(process.argv[1]), '..');
var CONFIG_FILE = path.join(CGI_BIN_DIR, 'config.json');
var DEFAULT_PORT = '8884';

function reply(data) {
  var body = JSON.stringify(data);
  process.stdout.write('Content-Type: application/json\r\n');
  process.stdout.write('\r\n');
  process.stdout.write(body);
}

function readPort() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      var cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, { encoding: 'utf8' }));
      if (cfg.server && cfg.server.port) return String(cfg.server.port);
    }
  } catch (e) { /* fall through */ }
  return DEFAULT_PORT;
}

reply({ ok: true, data: { port: readPort() } });
