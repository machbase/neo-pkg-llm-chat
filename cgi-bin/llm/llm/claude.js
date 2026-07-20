var http2 = require('@jsh/http');
var { createMessage, createToolCall, createChatResponse } = require('./types');

var _client = http2.NewClient();
var DEFAULT_MODEL = 'claude-sonnet-4-20250514';
var BASE_URL = 'https://api.anthropic.com';

function createClaudeClient(apiKey, model) {
  return {
    type: 'claude',
    apiKey: apiKey,
    model: model || DEFAULT_MODEL,
    chat: function (messages, toolDefs, cb) {
      claudeChat(this, messages, toolDefs, cb);
    },
    chatSync: function (messages, toolDefs) {
      return claudeChatSync(this, messages, toolDefs);
    },
  };
}

function claudeChat(client, messages, toolDefs, cb) {
  var systemPrompt = extractSystem(messages);
  var claudeMsgs = messagesToClaude(messages);
  var claudeTools = toolDefsToClaude(toolDefs);

  var reqBody = {
    model: client.model,
    max_tokens: 4096,
    system: buildSystemBlocks(systemPrompt),
    messages: claudeMsgs,
    tools: claudeTools,
  };

  var body = JSON.stringify(reqBody);

  try {
    var req = http2.NewRequest('POST', BASE_URL + '/v1/messages');
    req.header.set('Content-Type', 'application/json');
    req.header.set('x-api-key', client.apiKey);
    req.header.set('anthropic-version', '2023-06-01');
    req.header.set('anthropic-beta', 'prompt-caching-2024-07-31');
    req.writeString(body);

    console.println('[Claude] Sending request (' + body.length + ' bytes)...');
    var resp = _client.do(req);
    console.println('[Claude] Response: ' + resp.statusCode);

    if (!resp.ok) {
      var errBody = '';
      try { errBody = resp.string(); } catch (e) { errBody = String(resp.statusCode); }
      return cb(new Error('[Claude] API error (HTTP ' + resp.statusCode + '): ' + errBody));
    }

    var claudeResp = resp.json();
    // Log cache usage
    if (claudeResp.usage) {
      var u = claudeResp.usage;
      var cached = u.cache_read_input_tokens || 0;
      var created = u.cache_creation_input_tokens || 0;
      var input = u.input_tokens || 0;
      if (cached > 0 || created > 0) {
        console.println('[Claude] Cache: read=' + cached + ' created=' + created + ' input=' + input);
      }
    }
    var msg = parseClaudeResponse(claudeResp);
    cb(null, createChatResponse(client.model, msg, true));
  } catch (e) {
    cb(new Error('[Claude] Request failed: ' + e.message));
  }
}

function claudeChatSync(client, messages, toolDefs) {
  var systemPrompt = extractSystem(messages);
  var claudeMsgs = messagesToClaude(messages);
  var claudeTools = toolDefsToClaude(toolDefs);

  var reqBody = {
    model: client.model,
    max_tokens: 4096,
    system: buildSystemBlocks(systemPrompt),
    messages: claudeMsgs,
    tools: claudeTools,
  };

  var body = JSON.stringify(reqBody);
  var req = http2.NewRequest('POST', BASE_URL + '/v1/messages');
  req.header.set('Content-Type', 'application/json');
  req.header.set('x-api-key', client.apiKey);
  req.header.set('anthropic-version', '2023-06-01');
  req.header.set('anthropic-beta', 'prompt-caching-2024-07-31');
  req.writeString(body);

  console.println('[Claude] Sending sync request (' + body.length + ' bytes)...');
  var resp = _client.do(req);
  console.println('[Claude] Response: ' + resp.statusCode);

  if (!resp.ok) {
    var errBody = '';
    try { errBody = resp.string(); } catch (e) { errBody = String(resp.statusCode); }
    throw new Error('[Claude] API error (HTTP ' + resp.statusCode + '): ' + errBody);
  }

  var claudeResp = resp.json();
  if (claudeResp.usage) {
    var u = claudeResp.usage;
    var cached = u.cache_read_input_tokens || 0;
    var created = u.cache_creation_input_tokens || 0;
    var input = u.input_tokens || 0;
    if (cached > 0 || created > 0) {
      console.println('[Claude] Cache: read=' + cached + ' created=' + created + ' input=' + input);
    }
  }
  var msg = parseClaudeResponse(claudeResp);
  return createChatResponse(client.model, msg, true);
}

function extractSystem(messages) {
  for (var i = 0; i < messages.length; i++) {
    if (messages[i].role === 'system') return messages[i].content;
  }
  return '';
}

function buildSystemBlocks(system) {
  if (!system) return [];
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

// tool_use ↔ tool_result 매칭을 인덱스 추론이 아니라 FIFO 큐로 보장한다.
// assistant turn마다 tool_use에 순번 id를 부여해 큐에 넣고, 뒤따르는 tool 메시지가 순서대로 pop해 같은 id를 쓴다.
// → 가드가 메시지를 주입('cancelled' tool)·삭제(toolCall drop)해도 짝이 안 깨진다
//   (인덱스 추론 방식은 이때 짝이 어긋나 Claude 400 'unexpected tool_use_id'를 낸다).
function messagesToClaude(messages) {
  var result = [];
  var pendingIds = [];   // 직전 assistant의 tool_use id들(결과 대기), 순서대로
  var seq = 0;
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        var blocks = [];
        if (msg.content) blocks.push({ type: 'text', text: msg.content });
        pendingIds = [];   // 새 assistant 턴 → 이 턴의 tool_use가 곧 이어질 tool_result와 짝
        for (var j = 0; j < msg.toolCalls.length; j++) {
          var tc = msg.toolCalls[j];
          var id = 'call_' + (seq++);
          blocks.push({ type: 'tool_use', id: id, name: tc.function.name, input: tc.function.arguments || {} });
          pendingIds.push(id);
        }
        result.push({ role: 'assistant', content: blocks });
      } else {
        result.push({ role: 'assistant', content: msg.content });
        pendingIds = [];   // tool_use 없는 assistant → 대기 짝 없음
      }
    } else if (msg.role === 'tool') {
      if (pendingIds.length > 0) {
        var tid = pendingIds.shift();   // 직전 assistant tool_use와 순서대로 1:1
        var prev = result[result.length - 1];
        if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
          prev.content.push({ type: 'tool_result', tool_use_id: tid, content: msg.content });
        } else {
          result.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: msg.content }] });
        }
      } else {
        // 짝 없는 tool 결과(가드 주입 꼬임 등) → tool_result로 내보내면 Claude 400 → 텍스트로 강등(orphan 방지)
        var prevO = result[result.length - 1];
        if (prevO && prevO.role === 'user' && Array.isArray(prevO.content)) {
          prevO.content.push({ type: 'text', text: String(msg.content || '') });
        } else {
          result.push({ role: 'user', content: String(msg.content || '') });
        }
      }
    }
  }
  return result;
}

function toolDefsToClaude(toolDefs) {
  if (!toolDefs || toolDefs.length === 0) return [];
  var tools = [];
  for (var i = 0; i < toolDefs.length; i++) {
    var fn = toolDefs[i].function;
    tools.push({ name: fn.name, description: fn.description, input_schema: fn.parameters || { type: 'object', properties: {} } });
  }
  if (tools.length > 0) tools[tools.length - 1].cache_control = { type: 'ephemeral' };
  return tools;
}

function parseClaudeResponse(resp) {
  var toolCalls = [];
  var content = '';
  if (resp.content) {
    for (var i = 0; i < resp.content.length; i++) {
      var block = resp.content[i];
      if (block.type === 'text') content += block.text;
      else if (block.type === 'tool_use') toolCalls.push(createToolCall(block.name, block.input || {}));
    }
  }
  return createMessage('assistant', content, toolCalls);
}

module.exports = { createClaudeClient };
