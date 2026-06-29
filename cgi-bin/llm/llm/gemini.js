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

// Build the Gemini request body from unified messages.
// IMPORTANT: Gemini 2.5 thinking models return a `thoughtSignature` on each functionCall part.
// On multi-turn tool calling the API REQUIRES that signature to be echoed back in history,
// otherwise it rejects with HTTP 400 "Function call is missing a thought_signature".
// We persist it on the tool call (tc.thoughtSignature) in parseGeminiResponse and replay it here.
function buildGeminiRequest(client, messages, toolDefs) {
  var system = null, contents = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (msg.role === 'system') { system = { parts: [{ text: msg.content }] }; }
    else if (msg.role === 'user') { contents.push({ role: 'user', parts: [{ text: msg.content }] }); }
    else if (msg.role === 'assistant') {
      var parts = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.toolCalls) {
        for (var j = 0; j < msg.toolCalls.length; j++) {
          var tc = msg.toolCalls[j];
          var part = { functionCall: { name: tc.function.name, args: tc.function.arguments || {} } };
          if (tc.thoughtSignature) part.thoughtSignature = tc.thoughtSignature;
          parts.push(part);
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts: parts });
    } else if (msg.role === 'tool') {
      contents.push({ role: 'user', parts: [{ functionResponse: { name: '_tool', response: { result: msg.content } } }] });
    }
  }

  var reqBody = { contents: contents };
  if (system) reqBody.systemInstruction = system;
  if (toolDefs && toolDefs.length > 0) reqBody.tools = [{ functionDeclarations: toolDefsToGemini(toolDefs) }];

  var url = BASE_URL + '/v1beta/models/' + client.model + ':generateContent?key=' + client.apiKey;
  return { url: url, body: JSON.stringify(reqBody) };
}

function geminiChat(client, messages, toolDefs, cb) {
  var built = buildGeminiRequest(client, messages, toolDefs);
  var url = built.url, body = built.body;

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
  var built = buildGeminiRequest(client, messages, toolDefs);
  var url = built.url, body = built.body;

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
    else if (parts[i].functionCall) {
      var tc = createToolCall(parts[i].functionCall.name, parts[i].functionCall.args || {});
      // Preserve the thinking-model signature so it can be echoed back on the next turn
      // (Gemini 2.5 rejects multi-turn tool calls whose history omits it — HTTP 400).
      if (parts[i].thoughtSignature) tc.thoughtSignature = parts[i].thoughtSignature;
      toolCalls.push(tc);
    }
  }
  return createMessage('assistant', content, toolCalls);
}

module.exports = { createGeminiClient };
