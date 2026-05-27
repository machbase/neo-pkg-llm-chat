const fs = require('fs');
const path = require('path');

function defaultConfig() {
  return {
    server: { port: '8884' },
    machbase: { host: '127.0.0.1', port: '5654', user: 'sys', password: 'manager' },
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

function applyEnvOverrides(cfg) {
  if (typeof process !== 'undefined' && process.env) {
    const env = process.env;
    if (env.MACHBASE_HOST) cfg.machbase.host = env.MACHBASE_HOST;
    if (env.MACHBASE_PORT) cfg.machbase.port = env.MACHBASE_PORT;
    if (env.MACHBASE_USER) cfg.machbase.user = env.MACHBASE_USER;
    if (env.MACHBASE_PASSWORD) cfg.machbase.password = env.MACHBASE_PASSWORD;
    if (env.LLM_PROVIDER) cfg.provider = env.LLM_PROVIDER;
    if (env.LLM_MODEL) cfg.model = env.LLM_MODEL;
    if (env.ANTHROPIC_API_KEY) cfg.claude.api_key = env.ANTHROPIC_API_KEY;
    if (env.OPENAI_API_KEY) cfg.chatgpt.api_key = env.OPENAI_API_KEY;
    if (env.GEMINI_API_KEY) cfg.gemini.api_key = env.GEMINI_API_KEY;
    if (env.OLLAMA_BASE_URL) cfg.ollama.base_url = env.OLLAMA_BASE_URL;
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

function getAPIKey(cfg) {
  switch (resolveProvider(cfg).toLowerCase()) {
    case 'claude': return cfg.claude.api_key;
    case 'chatgpt': return cfg.chatgpt.api_key;
    case 'gemini': return cfg.gemini.api_key;
    case 'ollama': return '';
    default: return '';
  }
}

module.exports = {
  defaultConfig,
  loadConfig,
  machbaseURL,
  ollamaURL,
  resolveProvider,
  resolveModel,
  resolveModelID,
  currentModels,
  getAPIKey,
};
