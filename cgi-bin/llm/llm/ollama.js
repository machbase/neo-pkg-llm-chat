var http2 = require('@jsh/http');
var { createMessage, createToolCall, createChatResponse } = require('./types');

var _client = http2.NewClient();
var DEFAULT_MODEL = 'qwen3.5:9b';

function createOllamaClient(baseURL, model) {
  return {
    baseURL: baseURL || 'http://127.0.0.1:11434', model: model || DEFAULT_MODEL, type: 'ollama',
    temperature: 0, numPredict: 4096, numCtx: 40960, numGPU: 36, numKeep: 6100,
    chat: function (messages, toolDefs, cb) { ollamaChat(this, messages, toolDefs, cb); },
    chatSync: function (messages, toolDefs) { return ollamaChatSync(this, messages, toolDefs); },
    setNumKeep: function (skillName) {
      var map = { AdvancedAnalysis: 6900, BasicAnalysis: 6100, Report: 5500, DocLookup: 5500 };
      this.numKeep = map[skillName] || 6100;
      console.println('[Ollama] num_keep set to ' + this.numKeep + ' (skill: ' + skillName + ')');
    },
  };
}

function ollamaChat(client, messages, toolDefs, cb) {
  var reqBody = {
    model: client.model, messages: messagesToOllama(messages),
    tools: toolDefs && toolDefs.length > 0 ? toolDefs : undefined, stream: false,
    options: { temperature: client.temperature, num_predict: client.numPredict, num_ctx: client.numCtx, num_gpu: client.numGPU, num_keep: client.numKeep },
  };
  var body = JSON.stringify(reqBody);

  try {
    var req = http2.NewRequest('POST', client.baseURL + '/api/chat');
    req.header.set('Content-Type', 'application/json');
    req.writeString(body);
    var resp = _client.do(req);
    if (!resp.ok) {
      var errBody = ''; try { errBody = resp.string(); } catch (e) {}
      return cb(new Error('[Ollama] API error (HTTP ' + resp.statusCode + '): ' + errBody));
    }
    var ollamaResp = resp.json();
    if (ollamaResp.error) return cb(new Error('[Ollama] ' + ollamaResp.error));
    cb(null, createChatResponse(client.model, parseOllamaResponse(ollamaResp), true));
  } catch (e) { cb(new Error('[Ollama] Request failed: ' + e.message)); }
}

function ollamaChatSync(client, messages, toolDefs) {
  var reqBody = {
    model: client.model, messages: messagesToOllama(messages),
    tools: toolDefs && toolDefs.length > 0 ? toolDefs : undefined, stream: false,
    options: { temperature: client.temperature, num_predict: client.numPredict, num_ctx: client.numCtx, num_gpu: client.numGPU, num_keep: client.numKeep },
  };
  var body = JSON.stringify(reqBody);

  var req = http2.NewRequest('POST', client.baseURL + '/api/chat');
  req.header.set('Content-Type', 'application/json');
  req.writeString(body);
  var resp = _client.do(req);
  if (!resp.ok) {
    var errBody = ''; try { errBody = resp.string(); } catch (e) {}
    throw new Error('[Ollama] API error (HTTP ' + resp.statusCode + '): ' + errBody);
  }
  var ollamaResp = resp.json();
  if (ollamaResp.error) throw new Error('[Ollama] ' + ollamaResp.error);
  return createChatResponse(client.model, parseOllamaResponse(ollamaResp), true);
}

function messagesToOllama(messages) {
  var result = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var om = { role: msg.role, content: msg.content };
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      om.tool_calls = [];
      for (var j = 0; j < msg.toolCalls.length; j++) { var tc = msg.toolCalls[j]; om.tool_calls.push({ function: { name: tc.function.name, arguments: tc.function.arguments || {} } }); }
    }
    result.push(om);
  }
  return result;
}

function parseOllamaResponse(resp) {
  var om = resp.message || {}, content = om.content || '', toolCalls = [];
  if (om.tool_calls) { for (var i = 0; i < om.tool_calls.length; i++) { var tc = om.tool_calls[i]; toolCalls.push(createToolCall(tc.function.name, tc.function.arguments || {})); } }
  return createMessage('assistant', content, toolCalls);
}

module.exports = { createOllamaClient };
