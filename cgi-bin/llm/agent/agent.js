var { createMessage } = require('../llm/types');
var { createBuilder, formatCatalog } = require('../context/builder');
var { createRegistry: createSkillRegistry } = require('../skill/skill');
var { createFixerContext, fix, fixDashboardTime, captureResults, validateTagInArgs } = require('../fixer/fixer');
var { setExpandTemplateFunc } = require('../fixer/tql_fix');
var { expandTemplate } = require('../tools/tql_templates');
var { parseTimeRange, buildSkillHint, compactHistory, inferTableName } = require('./classifier');

// Register template expansion function once at module load
setExpandTemplateFunc(expandTemplate);
var { createPipeline } = require('../guard/guard');
var ConsecutiveFailureGuard = require('../guard/consecutive_failure');
var DashboardEarlyGuard = require('../guard/dashboard_early');
var ChartOmissionGuard = require('../guard/chart_omission');
var ReportOmissionGuard = require('../guard/report_omission');

var MAX_STEPS = 60;

function createAgent(llmClient, registry) {
  var agent = {
    llm: llmClient,
    registry: registry,
    messages: [],
    maxSteps: MAX_STEPS,
    skillName: '',
    toolDefs: null,
    docCatalog: '',
    advanced: false,
    reportMode: false,
    cancelled: false,
    fixerCtx: createFixerContext(),
    guard: createPipeline(
      [ConsecutiveFailureGuard, DashboardEarlyGuard],
      [ChartOmissionGuard, ReportOmissionGuard]
    ),
  };

  // onProgress(text) — called for each tool step
  agent.onProgress = null;

  // cb(err, finalAnswer)
  agent.run = function (query, cb) { agentRun(agent, query, cb); };
  return agent;
}

// cb(err, finalAnswer)
function agentRun(agent, query, cb) {
  if (agent.messages.length === 0) {
    initMessages(agent, query, function () {
      runLoop(agent, 0, cb);
    });
  } else {
    continueMessages(agent, query);
    runLoop(agent, 0, cb);
  }
}

function buildSystemPrompt(agent, activeSkill) {
  var isOllama = (agent.llm.type === 'ollama');
  var builder = createBuilder();
  if (isOllama) builder.setOllama();
  if (!activeSkill.skipCore) { builder.addCore(); } else { builder.addSegment('Role'); }
  if (activeSkill.workflows && activeSkill.workflows.length > 0) builder.addWorkflow.apply(builder, activeSkill.workflows);
  if (activeSkill.toolGroups && activeSkill.toolGroups.length > 0) builder.addToolPrompts.apply(builder, activeSkill.toolGroups);
  if (agent.docCatalog) builder.setCatalog(agent.docCatalog);
  var prompt = builder.build();
  // Inject current datetime
  var now = new Date();
  prompt += '\n\n현재 날짜/시간: ' + now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0') + ' ' +
    String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':' +
    String(now.getSeconds()).padStart(2, '0') +
    ' (시간대: Asia/Seoul, KST)' +
    '\n시간 범위를 임의로 추측하지 마세요. 반드시 SELECT MIN(TIME), MAX(TIME) FROM 테이블 (timeformat="ms")로 실제 데이터 범위를 먼저 조회하세요.' +
    '\n중요: TQL의 TO_DATE()는 UTC 기준입니다. KST 시간을 사용하려면 epoch 나노초를 직접 사용하거나, tz("Asia/Seoul")를 CHART()에 추가하세요.' +
    '\nTQL SQL()에서 시간 필터링 시 epoch 나노초(숫자)를 사용하세요. 예: TIME BETWEEN 1778210100000000000 AND 1778221620000000000';
  if (isOllama) prompt += '\n/no_think';
  return prompt;
}

function applySkill(agent, activeSkill) {
  if (activeSkill.allowTools) {
    var allowed = {};
    for (var i = 0; i < activeSkill.allowTools.length; i++) allowed[activeSkill.allowTools[i]] = true;
    var allDefs = agent.registry.allToolDefs();
    var filtered = [];
    for (var j = 0; j < allDefs.length; j++) {
      if (allowed[allDefs[j].function.name]) filtered.push(allDefs[j]);
    }
    agent.toolDefs = filtered;
  } else {
    agent.toolDefs = agent.registry.allToolDefs();
  }
}

// cb() — no error, just signals ready
function initMessages(agent, query, cb) {
  var skillRegistry = createSkillRegistry();
  var activeSkill = skillRegistry.classify(query);

  agent.skillName = activeSkill.name;
  agent.advanced = (activeSkill.name === 'AdvancedAnalysis');
  agent.reportMode = (activeSkill.name === 'Report');

  // Load document catalog directly from file (avoids async issues with registry.execute in WS context)
  try {
    var fs = require('fs');
    var catalogPath = require('path').join(process.cwd(), 'neo', 'catalog.md');
    agent.docCatalog = fs.readFileSync(catalogPath, 'utf8');
    console.println('[Agent] Doc catalog loaded: ' + agent.docCatalog.length + ' chars');
  } catch (e) {
    console.println('[Agent] Doc catalog not found: ' + e.message);
  }
  (function (next) { next(); })(function () {

    var systemPrompt = buildSystemPrompt(agent, activeSkill);
    var tr = parseTimeRange(query);
    if (tr) { agent.fixerCtx.timeStartDt = tr.startDt; agent.fixerCtx.timeEndDt = tr.endDt; }

    var userContent = query;
    var hint = buildSkillHint(query, activeSkill, tr);
    if (hint) userContent += '\n\n' + hint;

    agent.messages = [createMessage('system', systemPrompt), createMessage('user', userContent)];
    applySkill(agent, activeSkill);
    agent.fixerCtx.inferTableName = function () { return inferTableName(agent.messages); };

    console.println('[Agent] Skill: ' + activeSkill.name +
      ' | Workflows: [' + (activeSkill.workflows || []).join(', ') + ']' +
      ' | ToolGroups: [' + (activeSkill.toolGroups || []).join(', ') + ']' +
      ' | Tools: ' + agent.toolDefs.length + '/' + agent.registry.allToolDefs().length);

    cb();
  });
}

function continueMessages(agent, query) {
  agent.fixerCtx.timeStartDt = '';
  agent.fixerCtx.timeEndDt = '';
  agent.fixerCtx.dataMinDt = '';
  agent.fixerCtx.dataMaxDt = '';

  var tr = parseTimeRange(query);
  if (tr) { agent.fixerCtx.timeStartDt = tr.startDt; agent.fixerCtx.timeEndDt = tr.endDt; }

  var skillRegistry = createSkillRegistry();
  var activeSkill = skillRegistry.classify(query);
  var prevSkill = agent.skillName;

  agent.skillName = activeSkill.name;
  agent.advanced = (activeSkill.name === 'AdvancedAnalysis');
  agent.reportMode = (activeSkill.name === 'Report');

  console.println('[Agent] Skill: ' + activeSkill.name +
    ' | Workflows: [' + (activeSkill.workflows || []).join(', ') + ']' +
    ' | Tools: ' + (agent.toolDefs ? agent.toolDefs.length : '?'));

  if (activeSkill.name !== prevSkill) {
    var beforeLen = agent.messages.length;
    agent.messages = compactHistory(agent.messages);
    var newPrompt = buildSystemPrompt(agent, activeSkill);
    agent.messages[0] = createMessage('system', newPrompt);
    console.println('[Agent] Compacted: ' + beforeLen + ' → ' + agent.messages.length + ' messages');
    console.println('[Agent] Skill switch: ' + prevSkill + ' → ' + activeSkill.name);
  }

  applySkill(agent, activeSkill);
  var userContent = query;
  var hint = buildSkillHint(query, activeSkill, tr);
  if (hint) userContent += '\n\n' + hint;
  agent.messages.push(createMessage('user', userContent));
}

// Recursive async loop: cb(err, finalAnswer)
function runLoop(agent, step, cb) {
  if (agent.cancelled) {
    console.println('[Agent] Cancelled before step ' + step);
    console.println('============================================================');
    return cb(null, '(중단됨)');
  }

  console.println('\n[Agent] Agentic Loop step ' + step + '...');
  if (step === 0) console.println('============================================================');

  if (step >= agent.maxSteps) {
    console.println('============================================================');
    return cb(null, '최대 실행 횟수에 도달했습니다.');
  }

  // Call LLM (async)
  agent.llm.chat(agent.messages, agent.toolDefs, function (err, resp) {
    if (agent.cancelled) {
      console.println('[Agent] Cancelled after LLM response at step ' + step);
      console.println('============================================================');
      return cb(null, '(중단됨)');
    }
    if (err) return cb(null, 'Error: LLM call failed at step ' + step + ': ' + err.message);

    var msg = resp.message;
    msg = fix(msg, agent.fixerCtx);

    // Pre-tool guards (may re-prompt LLM and replace msg)
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      msg = agent.guard.runPreTool(agent, msg);
    }

    // No tool calls → post-loop guards, then final answer
    if (!msg.toolCalls || msg.toolCalls.length === 0) {
      msg = agent.guard.runPostLoop(agent, msg);
      // Post-loop guard may have re-prompted and got tool calls back
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        agent.messages.push(msg);
        return executeToolCalls(agent, msg.toolCalls, 0, step, function (newStep) {
          runLoop(agent, newStep, cb);
        });
      }
      if (!msg.content) {
        console.println('[Agent] Empty response, retrying...');
        agent.messages.push(createMessage('user', '작업이 완료되지 않았습니다. 다음 단계를 계속 진행하세요.'));
        return runLoop(agent, step + 1, cb);
      }
      agent.messages.push(createMessage('assistant', msg.content));
      console.println('============================================================');
      return cb(null, msg.content);
    }

    // Execute tool calls sequentially
    agent.messages.push(msg);
    executeToolCalls(agent, msg.toolCalls, 0, step, function (newStep) {
      runLoop(agent, newStep, cb);
    });
  });
}

// Execute tool calls one by one: doneCb(updatedStep)
function executeToolCalls(agent, toolCalls, idx, step, doneCb) {
  if (agent.cancelled) {
    console.println('[Agent] Cancelled during tool execution');
    return doneCb(step);
  }
  if (idx >= toolCalls.length) return doneCb(step);

  var tc = toolCalls[idx];
  step++;
  var toolName = tc.function.name;
  console.println('\n[Step ' + step + '] Tool: ' + toolName);

  var args = tc.function.arguments || {};
  var keys = Object.keys(args);
  var argSummary = [];
  for (var k = 0; k < keys.length; k++) {
    var val = String(args[keys[k]]);
    if (val.length > 200) val = val.substring(0, 200) + '...';
    console.println('  |- ' + keys[k] + ': ' + val);
    argSummary.push(keys[k] + '=' + (val.length > 80 ? val.substring(0, 80) + '...' : val));
  }

  // Report tool call to UI
  if (agent.onProgress) {
    agent.onProgress('🛠️ Calling tool: **' + toolName + '**' + (argSummary.length > 0 ? '\n' + argSummary.join('\n') : ''));
  }

  fixDashboardTime(tc, agent.fixerCtx);

  var tagErr = validateTagInArgs(tc.function.name, args, agent.fixerCtx.knownTags);
  if (tagErr) {
    console.println('  \\- TAG ERROR: ' + tagErr.substring(0, 500));
    console.println('------------------------------------------------------------');
    agent.messages.push(createMessage('tool', tagErr));
    return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  }

  // Execute tool
  agent.registry.execute(toolName, args, function (execErr, result) {
    if (execErr) {
      result = 'Error: ' + (execErr.message || String(execErr));
      console.println('  \\- ERROR: ' + result);
    } else {
      if (result === null || result === undefined) result = '';
      result = String(result);
      console.println('  \\- OK: ' + truncate(result, 500));
    }
    console.println('------------------------------------------------------------');

    // Report result to UI
    if (agent.onProgress) {
      var preview = truncate(result, 300);
      agent.onProgress('```\n' + preview + '\n```');
    }

    captureResults(tc, result, execErr, agent.fixerCtx);
    agent.messages.push(createMessage('tool', result));

    executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  });
}

function truncate(s, max) {
  if (s === null || s === undefined) return '';
  s = String(s);
  if (s.length <= max) return s;
  return s.substring(0, max) + '... (total ' + s.length + ' chars)';
}

module.exports = { createAgent };
