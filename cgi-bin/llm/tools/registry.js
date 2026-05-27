/**
 * Tool Registry - manages tool definitions and execution.
 */

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
    var tool = tools[name];
    if (!tool) return cb(new Error('Unknown tool: ' + name));
    if (!args) args = {};
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
  require('./files').register(registry, mc);
  require('./dashboard').register(registry, mc);
  require('./report').register(registry, mc);
  require('./docs').register(registry, mc);
  require('./timer').register(registry, mc);
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

function argBool(args, key, fallback) {
  if (args[key] !== undefined) return !!args[key];
  return fallback || false;
}

module.exports = { createRegistry, argStr, argInt, argBool };
