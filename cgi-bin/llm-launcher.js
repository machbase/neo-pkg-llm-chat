'use strict';

const process = require('process');
const path = require('path');
const fs = require('fs');

// JSH 가상 경로 기준
const SCRIPT_DIR = path.resolve(path.dirname(process.argv[1]));
const LLM_DIR = path.join(SCRIPT_DIR, 'llm');
const MAIN_JS = path.join(LLM_DIR, 'main.js');
const CONFIGS_DIR = path.join(LLM_DIR, 'configs');
const DEFAULT_CONFIG_FILE = path.join(CONFIGS_DIR, 'sys.json');
const BEACON_FILE = path.join(SCRIPT_DIR, 'launcher-beacon.log');

// Diagnostic beacon — 시작 시점/단계/에러를 디스크에 기록
function beacon(line) {
  try {
    const ts = new Date().toISOString();
    fs.writeFileSync(BEACON_FILE, '[' + ts + '] ' + line + '\n', { flag: 'a' });
  } catch (e) { /* nothing we can do */ }
}

// 최초 beacon — launcher가 실행됐다는 증거
try { fs.writeFileSync(BEACON_FILE, '=== launcher invoked at ' + new Date().toISOString() + ' ===\n'); } catch (e) {}
beacon('argv: ' + JSON.stringify(process.argv));
beacon('SCRIPT_DIR=' + SCRIPT_DIR);
beacon('LLM_DIR=' + LLM_DIR);

try {
  console.println('[llm-launcher] Starting JSH mode');
  console.println('[llm-launcher] LLM_DIR:', LLM_DIR);
  console.println('[llm-launcher] main.js:', MAIN_JS);

  // 최초 부팅 시드: configs/sys.json이 없으면 defaultConfig()로 생성
  if (!fs.existsSync(DEFAULT_CONFIG_FILE)) {
    beacon('seeding sys.json...');
    console.println('[llm-launcher] configs/sys.json not found — seeding defaults');
    if (!fs.existsSync(CONFIGS_DIR)) fs.mkdirSync(CONFIGS_DIR, { recursive: true });
    const { defaultConfig } = require(path.join(LLM_DIR, 'config', 'config.js'));
    fs.writeFileSync(DEFAULT_CONFIG_FILE, JSON.stringify(defaultConfig(), null, 2));
    console.println('[llm-launcher] seeded: ' + DEFAULT_CONFIG_FILE);
    beacon('seeded sys.json OK');
  } else {
    beacon('sys.json already exists');
  }

  beacon('chdir to ' + LLM_DIR);
  process.chdir(LLM_DIR);

  beacon('setting argv for main.js');
  process.argv = [process.argv[0], MAIN_JS, '--mode', 'server', '--config', 'configs/sys.json'];

  beacon('requiring main.js: ' + MAIN_JS);
  require(MAIN_JS);
  beacon('main.js require returned (server.serve should be running)');
} catch (e) {
  beacon('FATAL: ' + (e && e.message ? e.message : String(e)));
  if (e && e.stack) beacon('STACK: ' + e.stack);
  try { console.println('[llm-launcher] FATAL: ' + (e && e.message ? e.message : String(e))); } catch (_) {}
  throw e;
}
