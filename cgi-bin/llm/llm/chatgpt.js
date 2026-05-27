var http2 = require('@jsh/http');
var { createMessage, createToolCall, createChatResponse } = require('./types');

var _client = http2.NewClient();
var DEFAULT_MODEL = 'gpt-4o';
var BASE_URL = 'https://api.openai.com';

function createChatGPTClient(apiKey, model) {
  return {
    apiKey: apiKey, model: model || DEFAULT_MODEL, type: 'chatgpt',
    chat: function (messages, toolDefs, cb) { chatgptChat(this, messages, toolDefs, cb); },
    chatSync: function (messages, toolDefs) { return chatgptChatSync(this, messages, toolDefs); },
  };
}

function chatgptChat(client, messages, toolDefs, cb) {
  var reqBody = { model: client.model, messages: messagesToOpenAI(messages), tools: toolDefs && toolDefs.length > 0 ? toolDefs : undefined };
  var body = JSON.stringify(reqBody);

  try {
    var req = http2.NewRequest('POST', BASE_URL + '/v1/chat/completions');
    req.header.set('Content-Type', 'application/json');
    req.header.set('Authorization', 'Bearer ' + client.apiKey);
    req.writeString(body);

    var resp = _client.do(req);
    if (!resp.ok) {
      var errBody = ''; try { errBody = resp.string(); } catch (e) {}
      if (resp.statusCode === 429) return cb(new Error('[ChatGPT] API 사용량 한도 초과 (HTTP 429)'));
      return cb(new Error('[ChatGPT] API error (HTTP ' + resp.statusCode + '): ' + errBody));
    }
    var openaiResp = resp.json();
    if (openaiResp.error) return cb(new Error('[ChatGPT] ' + openaiResp.error.message));
    var msg = parseOpenAIResponse(openaiResp);
    cb(null, createChatResponse(client.model, msg, true));
  } catch (e) { cb(new Error('[ChatGPT] Request failed: ' + e.message)); }
}

function chatgptChatSync(client, messages, toolDefs) {
  var reqBody = { model: client.model, messages: messagesToOpenAI(messages), tools: toolDefs && toolDefs.length > 0 ? toolDefs : undefined };
  var body = JSON.stringify(reqBody);

  var req = http2.NewRequest('POST', BASE_URL + '/v1/chat/completions');
  req.header.set('Content-Type', 'application/json');
  req.header.set('Authorization', 'Bearer ' + client.apiKey);
  req.writeString(body);

  var resp = _client.do(req);
  if (!resp.ok) {
    var errBody = ''; try { errBody = resp.string(); } catch (e) {}
    if (resp.statusCode === 429) throw new Error('[ChatGPT] API 사용량 한도 초과 (HTTP 429)');
    throw new Error('[ChatGPT] API error (HTTP ' + resp.statusCode + '): ' + errBody);
  }
  var openaiResp = resp.json();
  if (openaiResp.error) throw new Error('[ChatGPT] ' + openaiResp.error.message);
  var msg = parseOpenAIResponse(openaiResp);
  return createChatResponse(client.model, msg, true);
}

function messagesToOpenAI(messages) {
  var result = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (msg.role === 'system' || msg.role === 'user') { result.push({ role: msg.role, content: msg.content }); }
    else if (msg.role === 'assistant') {
      var om = { role: 'assistant', content: msg.content || '' };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        om.tool_calls = [];
        for (var j = 0; j < msg.toolCalls.length; j++) {
          var tc = msg.toolCalls[j];
          om.tool_calls.push({ id: 'call_' + i + '_' + j, type: 'function', function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments || {}) } });
        }
      }
      result.push(om);
    } else if (msg.role === 'tool') {
      var toolCallId = 'call_0_0', toolIdx = 0;
      for (var k = result.length - 1; k >= 0; k--) { if (result[k].role === 'tool') toolIdx++; else break; }
      for (var m = result.length - 1; m >= 0; m--) { if (result[m].role === 'assistant' && result[m].tool_calls && result[m].tool_calls.length > toolIdx) { toolCallId = result[m].tool_calls[toolIdx].id; break; } }
      result.push({ role: 'tool', content: msg.content, tool_call_id: toolCallId });
    }
  }
  return result;
}

function parseOpenAIResponse(resp) {
  if (!resp.choices || resp.choices.length === 0) return createMessage('assistant', '');
  var choice = resp.choices[0], content = choice.message.content || '', toolCalls = [];
  if (choice.message.tool_calls) {
    for (var i = 0; i < choice.message.tool_calls.length; i++) {
      var tc = choice.message.tool_calls[i], args = {};
      try { args = JSON.parse(tc.function.arguments); } catch (e) {}
      toolCalls.push(createToolCall(tc.function.name, args));
    }
  }
  return createMessage('assistant', content, toolCalls);
}

module.exports = { createChatGPTClient };
