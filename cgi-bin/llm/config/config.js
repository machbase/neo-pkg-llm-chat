const fs = require('fs');
const path = require('path');

function defaultConfig() {
  return {
    server: { port: '8884' },
    machbase: { host: '127.0.0.1', port: '5654', user: 'sys' },
    claude: { api_key: '', models: [{ name: '', model_id: '' }] },
    chatgpt: { api_key: '', models: [{ name: '', model_id: '' }] },
    gemini: { api_key: '', models: [{ name: '', model_id: '' }] },
    ollama: { base_url: '', models: [{ name: '', model_id: '' }] },
  };
}

function loadConfig(filePath) {
  const cfg = defaultConfig();
  cfg._path = filePath;

  try {
    const data = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(data);
    Object.assign(cfg.server, parsed.server || {});
    Object.assign(cfg.machbase, parsed.machbase || {});
    // 접속 비밀은 파일에서 안 읽음 — 설정 파일은 /db/files 로 다른 계정에 노출
    delete cfg.machbase.password;
    delete cfg.machbase.token;
    Object.assign(cfg.claude, parsed.claude || {});
    Object.assign(cfg.chatgpt, parsed.chatgpt || {});
    Object.assign(cfg.gemini, parsed.gemini || {});
    Object.assign(cfg.ollama, parsed.ollama || {});
  } catch (e) {
    console.println('[Config] File not found or invalid: ' + filePath + ', using defaults');
  }

  // Runtime overrides (not saved to file)
  cfg.provider = '';
  cfg.model = '';

  applyEnvOverrides(cfg);
  return cfg;
}

// jsh 의 process.env 는 속성 접근 불가 → get() 사용(`jsh -e KEY=VALUE` 로 전달)
function envGet(env, key) {
  return typeof env.get === 'function' ? env.get(key) : env[key];
}

function applyEnvOverrides(cfg) {
  if (typeof process !== 'undefined' && process.env) {
    const env = process.env;
    const get = function (key) { return envGet(env, key); };
    if (get('MACHBASE_HOST')) cfg.machbase.host = get('MACHBASE_HOST');
    if (get('MACHBASE_PORT')) cfg.machbase.port = get('MACHBASE_PORT');
    if (get('MACHBASE_TOKEN')) cfg.machbase.token = get('MACHBASE_TOKEN');
    if (get('LLM_PROVIDER')) cfg.provider = get('LLM_PROVIDER');
    if (get('LLM_MODEL')) cfg.model = get('LLM_MODEL');
    if (get('ANTHROPIC_API_KEY')) cfg.claude.api_key = get('ANTHROPIC_API_KEY');
    if (get('OPENAI_API_KEY')) cfg.chatgpt.api_key = get('OPENAI_API_KEY');
    if (get('GEMINI_API_KEY')) cfg.gemini.api_key = get('GEMINI_API_KEY');
    if (get('OLLAMA_BASE_URL')) cfg.ollama.base_url = get('OLLAMA_BASE_URL');
  }
}

function machbaseURL(cfg) {
  return 'http://' + cfg.machbase.host + ':' + cfg.machbase.port;
}

function ollamaURL(cfg) {
  if (cfg.ollama.base_url) return cfg.ollama.base_url;
  return 'http://' + cfg.machbase.host + ':11434';
}

function resolveProvider(cfg) {
  if (cfg.provider) return cfg.provider;
  if (cfg.claude.api_key) return 'claude';
  if (cfg.chatgpt.api_key) return 'chatgpt';
  if (cfg.gemini.api_key) return 'gemini';
  if (cfg.ollama.base_url || cfg.ollama.models.length > 0) return 'ollama';
  return 'gemini';
}

function resolveModel(cfg) {
  if (cfg.model) return cfg.model;
  const models = currentModels(cfg);
  if (models.length > 0) return models[0].name;
  return '';
}

function resolveModelID(cfg) {
  const model = resolveModel(cfg);
  const models = currentModels(cfg);
  for (let i = 0; i < models.length; i++) {
    if (models[i].name.toLowerCase() === model.toLowerCase()) {
      return models[i].model_id || models[i].name;
    }
  }
  return model;
}

function currentModels(cfg) {
  switch (resolveProvider(cfg).toLowerCase()) {
    case 'claude': return cfg.claude.models;
    case 'chatgpt': return cfg.chatgpt.models;
    case 'gemini': return cfg.gemini.models;
    case 'ollama': return cfg.ollama.models;
    default: return [];
  }
}

module.exports = {
  defaultConfig,
  loadConfig,
  machbaseURL,
  ollamaURL,
  resolveProvider,
  resolveModelID,
};
