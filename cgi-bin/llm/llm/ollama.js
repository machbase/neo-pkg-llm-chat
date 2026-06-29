var http2 = require('@jsh/http');
var { createMessage, createToolCall, createChatResponse } = require('./types');

var _client = http2.NewClient();
var DEFAULT_MODEL = 'qwen3.5:9b';

function createOllamaClient(baseURL, model) {
  return {
    baseURL: baseURL || 'http://127.0.0.1:11434', model: model || DEFAULT_MODEL, type: 'ollama',
    // numKeep=6100: 컨텍스트가 num_ctx 초과 시 프롬프트 앞쪽 6100토큰 유지(큰 시스템 프롬프트 KV 캐시 재사용 → 초기/반복 처리 속도).
    // 수동으로 정한 검증값 — 흔들지 말 것.
    temperature: 0, numPredict: 4096, numCtx: 40960, numGPU: 36, numKeep: 6100,
    chat: function (messages, toolDefs, cb) { ollamaChat(this, messages, toolDefs, cb); },
    chatSync: function (messages, toolDefs) { return ollamaChatSync(this, messages, toolDefs); },
    // ⚠️ 미사용(의도적): 어디서도 호출 안 함. 스킬별 num_keep 동적 조정 시도였으나, 위 수동 6100이 검증값이라
    // per-skill 값(6900 등)은 미적용 상태로 둠. 동적 튜닝이 필요해지면 continueMessages에서 호출해 와이어링.
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
