/**
 * Tool Registry - manages tool definitions and execution.
 */

var security = require('./security');

function createRegistry(mc) {
  var tools = {};
  var order = [];

  function register(tool) {
    tools[tool.name] = tool;
    order.push(tool.name);
  }

  function get(name) { return tools[name] || null; }

  // Async execute: cb(err, result)
  function execute(name, args, cb) {
    if (!args) args = {};
    // 보안 관문 — 모든 LLM 백엔드의 도구 호출을 여기서 한 번 검사
    var sec = security.checkToolCall(name, args);
    if (sec.denied) return cb(null, sec.message);
    var tool = tools[name];
    if (!tool) return cb(new Error('Unknown tool: ' + name));
    // 내부 전용 도구는 모델이 이름으로 불러도 실행 안 함(다른 도구는 get(name).fn으로 직접 호출)
    if (tool.internal) {
      return cb(null, 'Error: ' + name + '은(는) 내부 전용 도구라 호출할 수 없습니다.' +
        (tool.useInstead ? ' 대신 ' + tool.useInstead + '을(를) 사용하세요.' : ''));
    }
    try {
      tool.fn(args, cb);
    } catch (e) {
      cb(e);
    }
  }

  function allToolDefs() {
    var defs = [];
    for (var i = 0; i < order.length; i++) {
      var tool = tools[order[i]];
      if (tool.internal) continue;
      defs.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || { type: 'object', properties: {} },
        },
      });
    }
    return defs;
  }

  function toolNames() { return order.slice(); }

  function subset(names) {
    var sub = createRegistry(mc);
    for (var i = 0; i < names.length; i++) {
      if (tools[names[i]]) sub._register(tools[names[i]]);
    }
    return sub;
  }

  var registry = {
    register: register,
    _register: register,
    get: get,
    execute: execute,
    allToolDefs: allToolDefs,
    toolNames: toolNames,
    subset: subset,
    client: mc,
  };

  // Register all tools
  require('./sql').register(registry, mc);
  require('./tql').register(registry, mc);
  require('./tql_spec').register(registry, mc); // compile_tql_from_spec — tql(save/execute) 등록 후
  require('./forecast').register(registry, mc); // forecast_table — tql_spec(헬퍼)/tql(save/execute) 등록 후
  require('./files').register(registry, mc);
  require('./dashboard').register(registry, mc);
  require('./report').register(registry, mc);
  require('./docs').register(registry, mc);
  require('./util').register(registry, mc);

  return registry;
}

// --- Arg helpers ---

function argStr(args, key, fallback) {
  if (args[key] !== undefined && args[key] !== null && args[key] !== '') {
    return String(args[key]);
  }
  return fallback || '';
}

function argInt(args, key, fallback) {
  if (args[key] !== undefined) {
    var n = parseInt(args[key], 10);
    if (!isNaN(n)) return n;
  }
  return fallback || 0;
}

module.exports = { createRegistry, argStr, argInt };
