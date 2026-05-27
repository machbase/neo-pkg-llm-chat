let logFile = null;
let logLevel = 'INFO';

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function init(opts) {
  if (opts && opts.dir) logDir = opts.dir;
  if (opts && opts.level) logLevel = opts.level.toUpperCase();

  // JSH virtual filesystem doesn't allow local fs writes — log to console only
  logFile = null;
  console.println('[Logger] Logging to console (JSH virtual FS)');
}

function log(level, msg) {
  if (LEVELS[level] < LEVELS[logLevel]) return;

  const now = new Date();
  const ts = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0') + ' ' +
    String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':' +
    String(now.getSeconds()).padStart(2, '0') + '.' +
    String(now.getMilliseconds()).padStart(3, '0');

  const line = ts + ' [' + level.padEnd(5) + '] ' + msg + '\n';
  console.print(line);

  if (logFile) {
    try {
      fs.writeFileSync(logFile, line, { flag: 'a' });
    } catch (e) { /* ignore */ }
  }
}

function debug(msg) { log('DEBUG', msg); }
function info(msg) { log('INFO', msg); }
function warn(msg) { log('WARN', msg); }
function error(msg) { log('ERROR', msg); }

function close() {
  logFile = null;
}

module.exports = { init, debug, info, warn, error, close };
