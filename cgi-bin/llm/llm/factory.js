var config = require('../config/config');
var { createClaudeClient } = require('./claude');
var { createChatGPTClient } = require('./chatgpt');
var { createGeminiClient } = require('./gemini');
var { createOllamaClient } = require('./ollama');

function createLLM(cfg) {
  var provider = config.resolveProvider(cfg);
  var modelID = config.resolveModelID(cfg);

  switch (provider.toLowerCase()) {
    case 'claude':
      if (!cfg.claude.api_key) throw new Error('Claude API key is required');
      console.println('[LLM] Claude (' + modelID + ')');
      return createClaudeClient(cfg.claude.api_key, modelID);

    case 'chatgpt':
      if (!cfg.chatgpt.api_key) throw new Error('ChatGPT API key is required');
      console.println('[LLM] ChatGPT (' + modelID + ')');
      return createChatGPTClient(cfg.chatgpt.api_key, modelID);

    case 'gemini':
      if (!cfg.gemini.api_key) throw new Error('Gemini API key is required');
      console.println('[LLM] Gemini (' + modelID + ')');
      return createGeminiClient(cfg.gemini.api_key, modelID);

    case 'ollama':
      var ollamaUrl = config.ollamaURL(cfg);
      console.println('[LLM] Ollama (' + modelID + ') at ' + ollamaUrl);
      return createOllamaClient(ollamaUrl, modelID);

    default:
      throw new Error('Unknown provider: ' + provider);
  }
}

module.exports = { createLLM };
