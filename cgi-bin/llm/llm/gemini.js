var http2 = require('@jsh/http');
var { createMessage, createToolCall, createChatResponse } = require('./types');

var _client = http2.NewClient();
var DEFAULT_MODEL = 'gemini-2.5-flash';
var BASE_URL = 'https://generativelanguage.googleapis.com';

function createGeminiClient(apiKey, model) {
  return {
    apiKey: apiKey, model: model || DEFAULT_MODEL, type: 'gemini',
    chat: function (messages, toolDefs, cb) { geminiChat(this, messages, toolDefs, cb); },
    chatSync: function (messages, toolDefs) { return geminiChatSync(this, messages, toolDefs); },
  };
}

function geminiChat(client, messages, toolDefs, cb) {
  var system = null, contents = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (msg.role === 'system') { system = { parts: [{ text: msg.content }] }; }
    else if (msg.role === 'user') { contents.push({ role: 'user', parts: [{ text: msg.content }] }); }
    else if (msg.role === 'assistant') {
      var parts = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.toolCalls) { for (var j = 0; j < msg.toolCalls.length; j++) { var tc = msg.toolCalls[j]; parts.push({ functionCall: { name: tc.function.name, args: tc.function.arguments || {} } }); } }
      if (parts.length > 0) contents.push({ role: 'model', parts: parts });
    } else if (msg.role === 'tool') {
      contents.push({ role: 'user', parts: [{ functionResponse: { name: '_tool', response: { result: msg.content } } }] });
    }
  }

  var reqBody = { contents: contents };
  if (system) reqBody.systemInstruction = system;
  if (toolDefs && toolDefs.length > 0) reqBody.tools = [{ functionDeclarations: toolDefsToGemini(toolDefs) }];

  var url = BASE_URL + '/v1beta/models/' + client.model + ':generateContent?key=' + client.apiKey;
  var body = JSON.stringify(reqBody);

  try {
    var req = http2.NewRequest('POST', url);
    req.header.set('Content-Type', 'application/json');
    req.writeString(body);
    var resp = _client.do(req);
    if (!resp.ok) {
      var errBody = ''; try { errBody = resp.string(); } catch (e) {}
      if (resp.statusCode === 429) return cb(new Error('[Gemini] API 사용량 한도 초과 (HTTP 429)'));
      return cb(new Error('[Gemini] API error (HTTP ' + resp.statusCode + '): ' + errBody));
    }
    var geminiResp = resp.json();
    cb(null, createChatResponse(client.model, parseGeminiResponse(geminiResp), true));
  } catch (e) { cb(new Error('[Gemini] Request failed: ' + e.message)); }
}

function geminiChatSync(client, messages, toolDefs) {
  var system = null, contents = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (msg.role === 'system') { system = { parts: [{ text: msg.content }] }; }
    else if (msg.role === 'user') { contents.push({ role: 'user', parts: [{ text: msg.content }] }); }
    else if (msg.role === 'assistant') {
      var parts = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.toolCalls) { for (var j = 0; j < msg.toolCalls.length; j++) { var tc = msg.toolCalls[j]; parts.push({ functionCall: { name: tc.function.name, args: tc.function.arguments || {} } }); } }
      if (parts.length > 0) contents.push({ role: 'model', parts: parts });
    } else if (msg.role === 'tool') {
      contents.push({ role: 'user', parts: [{ functionResponse: { name: '_tool', response: { result: msg.content } } }] });
    }
  }

  var reqBody = { contents: contents };
  if (system) reqBody.systemInstruction = system;
  if (toolDefs && toolDefs.length > 0) reqBody.tools = [{ functionDeclarations: toolDefsToGemini(toolDefs) }];

  var url = BASE_URL + '/v1beta/models/' + client.model + ':generateContent?key=' + client.apiKey;
  var body = JSON.stringify(reqBody);

  var req = http2.NewRequest('POST', url);
  req.header.set('Content-Type', 'application/json');
  req.writeString(body);
  var resp = _client.do(req);
  if (!resp.ok) {
    var errBody = ''; try { errBody = resp.string(); } catch (e) {}
    if (resp.statusCode === 429) throw new Error('[Gemini] API 사용량 한도 초과 (HTTP 429)');
    throw new Error('[Gemini] API error (HTTP ' + resp.statusCode + '): ' + errBody);
  }
  var geminiResp = resp.json();
  return createChatResponse(client.model, parseGeminiResponse(geminiResp), true);
}

function toolDefsToGemini(toolDefs) {
  var d = [];
  for (var i = 0; i < toolDefs.length; i++) { var fn = toolDefs[i].function; d.push({ name: fn.name, description: fn.description, parameters: fn.parameters || { type: 'object', properties: {} } }); }
  return d;
}

function parseGeminiResponse(resp) {
  if (!resp.candidates || resp.candidates.length === 0) return createMessage('assistant', '');
  var parts = resp.candidates[0].content ? resp.candidates[0].content.parts : [];
  var content = '', toolCalls = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].text) content += parts[i].text;
    else if (parts[i].functionCall) toolCalls.push(createToolCall(parts[i].functionCall.name, parts[i].functionCall.args || {}));
  }
  return createMessage('assistant', content, toolCalls);
}

module.exports = { createGeminiClient };
