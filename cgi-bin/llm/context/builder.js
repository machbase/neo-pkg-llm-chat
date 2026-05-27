const segments = require('./segments');
const segmentsOllama = require('./segments_ollama');
const { ToolPrompts } = require('./tool_prompts');
const { formatCatalog } = require('./catalog');

function createBuilder() {
  var parts = [];
  var catalog = '';
  var isOllama = false;

  function setOllama() { isOllama = true; return builder; }

  function addCore() {
    if (isOllama) {
      parts.push(segmentsOllama.OllamaSegRole);
      parts.push(segmentsOllama.OllamaSegTableSchema);
      parts.push(segmentsOllama.OllamaSegSqlTools);
      parts.push(segmentsOllama.OllamaSegErrorHandling);
      parts.push(segmentsOllama.OllamaSegCommonProhibitions);
    } else {
      parts.push(segments.SegRole);
      parts.push(segments.SegTableSchema);
      parts.push(segments.SegSqlTools);
      parts.push(segments.SegErrorHandling);
      parts.push(segments.SegCommonProhibitions);
    }
    return builder;
  }

  function addSegment(name) {
    var seg = resolveSegment(name);
    if (seg) parts.push(seg);
    return builder;
  }

  function addWorkflow() {
    for (var i = 0; i < arguments.length; i++) {
      var seg = resolveSegment(arguments[i]);
      if (seg) parts.push(seg);
    }
    return builder;
  }

  function addToolPrompts() {
    for (var i = 0; i < arguments.length; i++) {
      var group = arguments[i];
      if (isOllama && group === 'tql_tools') {
        parts.push(segmentsOllama.OllamaSegTQLRules);
        continue;
      }
      if (ToolPrompts[group]) {
        parts.push(ToolPrompts[group]);
      }
    }
    return builder;
  }

  function setCatalog(text) {
    catalog = text;
    return builder;
  }

  function build() {
    var result = parts.join('\n');
    if (catalog) {
      result += '\n' + catalog;
    }
    return result;
  }

  function resolveSegment(name) {
    if (isOllama) {
      var ollamaMap = {
        'Role': segmentsOllama.OllamaSegRole,
        'QueryClassification': segmentsOllama.OllamaSegQueryClassification,
        'TableSchema': segmentsOllama.OllamaSegTableSchema,
        'AdvancedWorkflow': segmentsOllama.OllamaSegAdvancedWorkflow,
        'BasicWorkflow': segmentsOllama.OllamaSegBasicWorkflow,
        'HTMLReportWorkflow': segmentsOllama.OllamaSegHTMLReportWorkflow,
        'TimerWorkflow': segmentsOllama.OllamaSegTimerWorkflow,
        'ErrorHandling': segmentsOllama.OllamaSegErrorHandling,
      };
      if (ollamaMap[name]) return ollamaMap[name];
    }
    var standardMap = {
      'Role': segments.SegRole,
      'QueryClassification': segments.SegQueryClassification || '',
      'TableSchema': segments.SegTableSchema,
      'AdvancedWorkflow': segments.SegAdvancedWorkflow || '',
      'BasicWorkflow': segments.SegBasicWorkflow || '',
      'HTMLReportWorkflow': segments.SegHTMLReportWorkflow || '',
      'TimerWorkflow': segments.SegTimerWorkflow || '',
      'ErrorHandling': segments.SegErrorHandling,
    };
    return standardMap[name] || '';
  }

  var builder = {
    setOllama: setOllama,
    addCore: addCore,
    addSegment: addSegment,
    addWorkflow: addWorkflow,
    addToolPrompts: addToolPrompts,
    setCatalog: setCatalog,
    build: build,
  };

  return builder;
}

module.exports = { createBuilder, formatCatalog };
