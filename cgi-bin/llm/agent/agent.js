var process = require('process'); // jsh에선 process가 전역이 아님 → 명시적 require (catalog 로드의 process.cwd()용)
var { createMessage } = require('../llm/types');
var { createBuilder, formatCatalog } = require('../context/builder');
var { listReportTemplates, matchCustomByQuery } = require('../tools/report_templates');
var { createRegistry: createSkillRegistry } = require('../skill/skill');
var { createFixerContext, fix, fixDashboardTime, captureResults, validateTagInArgs } = require('../fixer/fixer');
var { setExpandTemplateFunc } = require('../fixer/tql_fix');
var { expandTemplate } = require('../tools/tql_templates');
var { parseTimeRange, buildSkillHint, compactHistory, inferTableName } = require('./classifier');
var security = require('../tools/security');

// Register template expansion function once at module load
setExpandTemplateFunc(expandTemplate);
var { createPipeline } = require('../guard/guard');
var ConsecutiveFailureGuard = require('../guard/consecutive_failure');
var DashboardEarlyGuard = require('../guard/dashboard_early');
var ChartOmissionGuard = require('../guard/chart_omission');
var ReportOmissionGuard = require('../guard/report_omission');
var RedundantFinalizeGuard = require('../guard/redundant_finalize');
var DashboardAnswerGuard = require('../guard/dashboard_answer');
var FakeTqlAnswerGuard = require('../guard/fake_tql_answer');
var DashboardOmissionGuard = require('../guard/dashboard_omission');
var RawTqlGuard = require('../guard/raw_tql');
var TqlOmissionGuard = require('../guard/tql_omission');

var MAX_STEPS = 60;
var COMPILE_FAIL_CAP = 6; // compile/save가 이만큼 연속 실패하면 결정론적으로 더 실행 안 함(무한루프 하드캡)

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
    // 대시보드 완성(create_dashboard_with_charts 성공) 후 같은 쿼리 내 추가 차트 생성을 결정론적으로 차단하는 플래그.
    // redundant_finalize 가드(권고형 rePrompt)는 약한 모델이 무시하면 뚫리므로, 도구 실행 레벨에서 못 박는다.
    // 쿼리마다 리셋 → 후속 "차트 추가해줘"는 정상 동작.
    dashboardFinalized: false,
    // compile/save 연속 실패 횟수. COMPILE_FAIL_CAP 도달 시 결정론적으로 추가 compile 차단(무한 거부루프 하드캡).
    compileFailStreak: 0,
    fixerCtx: createFixerContext(),
    guard: createPipeline(
      [ConsecutiveFailureGuard, DashboardEarlyGuard, RedundantFinalizeGuard],
      [DashboardOmissionGuard, ChartOmissionGuard, ReportOmissionGuard, DashboardAnswerGuard, TqlOmissionGuard, RawTqlGuard, FakeTqlAnswerGuard]
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
  // Deterministic security short-circuit (eval #5): refuse credential/server-control/shell/
  // config-file/prompt-leak/mutation-SQL requests BEFORE the LLM runs, so weak models cannot
  // ramble or confabulate. Scoped to attack SHAPES — legit how-to/feature questions pass through.
  // Privileged account/credential management → a GUIDED refusal (points to the console) instead.
  var _refusal = security.screenQuery(query);
  if (_refusal) {
    return cb(null, _refusal);
  }
  agent.dashboardFinalized = false; // 새 쿼리 시작 → 이전 쿼리의 대시보드 완성 상태 해제 (후속 차트 추가 허용)
  agent.compileFailStreak = 0;      // 새 쿼리 시작 → 연속 실패 카운터 리셋
  agent.currentQuery = query;       // 리포트 커스텀 쿼리-라우팅용(executeToolCalls에서 사용)
  if (agent.messages.length === 0) {
    initMessages(agent, query, function () {
      runLoop(agent, 0, cb);
    });
  } else {
    continueMessages(agent, query);
    runLoop(agent, 0, cb);
  }
}

// Live report-template list (builtin + installed custom) injected into the Report skill's prompt
// so the LLM can route the request topic to a custom (C-*) template before falling back to builtin.
function buildReportTemplateList() {
  var list;
  try { list = listReportTemplates(); } catch (e) { return ''; }
  if (!list || list.length === 0) return '';
  var customs = [], builtins = [];
  for (var i = 0; i < list.length; i++) { (list[i].custom ? customs : builtins).push(list[i]); }
  var ordered = customs.concat(builtins); // customs first so the first topic-match is the custom
  var out = '\n\n## 사용 가능한 리포트 템플릿 (template_id에 아래 ID를 정확히 사용)';
  out += '\n[필수 선택 규칙] 요청 주제에 맞는 ★커스텀이 있으면 빌트인보다 반드시 그 커스텀을 선택하세요.';
  out += '\n  예) "진동 리포트" 요청 + 커스텀 진동 템플릿 존재 → 빌트인 R-2-vibration이 아니라 그 커스텀을 사용.';
  out += '\n  주제에 맞는 템플릿이 하나도 없을 때만 R-0-general.';
  for (var j = 0; j < ordered.length; j++) {
    var t = ordered[j];
    out += '\n- ' + t.id + ': ' + (t.title || '') + (t.custom ? '  ★커스텀(우선 선택)' : '  (빌트인)');
  }
  return out;
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
  if (activeSkill.workflows && activeSkill.workflows.indexOf('HTMLReportWorkflow') >= 0) {
    prompt += buildReportTemplateList();
  }
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

// Ollama 심층 재활성(2026-06-08): compile_tql_from_spec(IR)로 raw TQL 없이 차트 생성이 가능해져
// 더 이상 AdvancedAnalysis를 BasicAnalysis로 강등하지 않는다. 약한 모델도 작은 JSON spec은 emit 가능하고,
// 컴파일러가 TQL 문법/함정을 보장하므로 예전의 CHART 구조 무한루프가 발생하지 않는다.
// (복원 필요 시: agent.llm.type==='ollama' && activeSkill.name==='AdvancedAnalysis'면 skillRegistry.get('BasicAnalysis') 반환)
function rerouteForOllama(agent, activeSkill, skillRegistry) {
  return activeSkill;
}

// cb() — no error, just signals ready
function initMessages(agent, query, cb) {
  var skillRegistry = createSkillRegistry();
  var activeSkill = rerouteForOllama(agent, skillRegistry.classify(query), skillRegistry);

  agent.skillName = activeSkill.name;
  agent.advanced = (activeSkill.name === 'AdvancedAnalysis');
  agent.reportMode = (activeSkill.name === 'Report');
  agent.fixerCtx.advanced = agent.advanced;
  agent.fixerCtx.skillName = agent.skillName;

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

// 후속(수정/추가) 요청 마커 — 있으면 이전 분석 맥락을 보존(압축 안 함).
var FOLLOWUP_MARKERS = ['방금', '아까', '추가', '수정', '바꿔', '변경', '다시', '번 차트', '거기', '여기'];
function hasFollowupMarker(query) {
  for (var i = 0; i < FOLLOWUP_MARKERS.length; i++) if (query.indexOf(FOLLOWUP_MARKERS[i]) >= 0) return true;
  return false;
}
function historyHasDashboardUrl(messages) {
  for (var i = 0; i < messages.length; i++) {
    if (messages[i].content && String(messages[i].content).indexOf('대시보드 열기') >= 0) return true;
  }
  return false;
}
// 같은 스킬이라도: 이전 대시보드가 완성된 뒤(URL 존재) 후속 마커 없는 새 분석 요청이면 히스토리 압축.
// (이전 분석 시도들이 누적돼 모델이 혼동하는 세션 오염 방지 — 후속 수정 요청은 마커로 보존)
// 이전 분석 작업 흔적(완성된 대시보드 URL 또는 분석 도구 호출)이 있으면 true.
// historyHasDashboardUrl과 달리 "실패/잘린 이전 시도"(URL 없음)도 잡아 → 새 요청 시 그 잔재를 compact로 청소.
function historyHasPriorAnalysisWork(messages) {
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m.content && String(m.content).indexOf('대시보드 열기') >= 0) return true;
    if (m.role === 'assistant' && m.toolCalls) {
      for (var j = 0; j < m.toolCalls.length; j++) {
        var nm = m.toolCalls[j].function.name;
        if (nm === 'describe_table' || nm === 'compile_tql_from_spec' || nm === 'forecast_table' ||
            nm === 'create_dashboard_with_charts' || nm === 'save_tql_file') return true;
      }
    }
  }
  return false;
}

function shouldCompactForNewAnalysis(messages, query, skill) {
  if (!skill || (skill.name !== 'AdvancedAnalysis' && skill.name !== 'BasicAnalysis')) return false;
  if (!historyHasPriorAnalysisWork(messages)) return false;
  if (hasFollowupMarker(query)) return false;
  return true;
}

function continueMessages(agent, query) {
  agent.fixerCtx.timeStartDt = '';
  agent.fixerCtx.timeEndDt = '';
  agent.fixerCtx.dataMinDt = '';
  agent.fixerCtx.dataMaxDt = '';

  var tr = parseTimeRange(query);
  if (tr) { agent.fixerCtx.timeStartDt = tr.startDt; agent.fixerCtx.timeEndDt = tr.endDt; }

  var skillRegistry = createSkillRegistry();
  var activeSkill = rerouteForOllama(agent, skillRegistry.classify(query), skillRegistry);
  var prevSkill = agent.skillName;

  agent.skillName = activeSkill.name;
  agent.advanced = (activeSkill.name === 'AdvancedAnalysis');
  agent.reportMode = (activeSkill.name === 'Report');
  agent.fixerCtx.advanced = agent.advanced;
  agent.fixerCtx.skillName = agent.skillName;

  console.println('[Agent] Skill: ' + activeSkill.name +
    ' | Workflows: [' + (activeSkill.workflows || []).join(', ') + ']' +
    ' | Tools: ' + (agent.toolDefs ? agent.toolDefs.length : '?'));

  var skillSwitched = (activeSkill.name !== prevSkill);
  // 스킬 동일해도 "이전 대시보드 완성 후 새 분석 요청"이면 압축 (세션 오염 방지)
  var newAnalysis = (!skillSwitched && shouldCompactForNewAnalysis(agent.messages, query, activeSkill));
  if (skillSwitched || newAnalysis) {
    var beforeLen = agent.messages.length;
    agent.messages = compactHistory(agent.messages);
    if (skillSwitched) {
      var newPrompt = buildSystemPrompt(agent, activeSkill);
      agent.messages[0] = createMessage('system', newPrompt);
      console.println('[Agent] Skill switch: ' + prevSkill + ' → ' + activeSkill.name);
    } else {
      console.println('[Agent] New analysis after completed dashboard → history compacted');
    }
    console.println('[Agent] Compacted: ' + beforeLen + ' → ' + agent.messages.length + ' messages');
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
      var finalContent = collapseRepeatedBlocks(msg.content);
      // Security backstop (eval #5 category 1): redact credentials/keys/account-enumeration
      // from the user-facing answer — model-independent, catches what prompt refusal misses.
      var _mc = agent.registry && agent.registry.client;
      finalContent = security.redactSecrets(finalContent, _mc && _mc.password ? [_mc.password] : []);
      agent.messages.push(createMessage('assistant', finalContent));
      console.println('============================================================');
      return cb(null, finalContent);
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

  // 대시보드 완성 후 추가 차트 생성 차단 (결정론적). 배치 내에서도 create_dashboard가 먼저 실행돼 플래그가 켜지면
  // 뒤따르는 compile/save는 여기서 막혀 고아 .tql 양산을 방지. 대시보드 생성 전 차트 저장들은 플래그가 꺼져 있어 통과.
  var _fcSaveArgs = tc.function.arguments || {};
  var _isForecastSave = (toolName === 'forecast_table') && _fcSaveArgs && _fcSaveArgs.filename; // filename 있는 forecast = 차트 저장
  if (agent.dashboardFinalized && (toolName === 'compile_tql_from_spec' || toolName === 'save_tql_file' || _isForecastSave)) {
    console.println('  \\- BLOCKED: dashboard already finalized, skipping ' + toolName + ' (orphan chart prevention)');
    console.println('------------------------------------------------------------');
    agent.messages.push(createMessage('tool',
      '취소됨: 대시보드가 이미 생성·완성되었습니다. 추가 차트는 기존 대시보드에 포함되지 않으므로 만들지 마세요. ' +
      '받은 대시보드 URL로 최종 답변(분석 요약 + [대시보드 열기](URL))을 작성하세요.'));
    return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  }

  // 무한 거부루프 하드캡: compile/save가 COMPILE_FAIL_CAP회 연속 실패하면 더 실행하지 않고 건너뜀 유도(결정론적).
  // 약한 모델이 같은 잘못된 spec을 끝없이 재시도하는 것을 코드가 끊는다(consecutive_failure 가드는 권고라 무시당함).
  if ((toolName === 'compile_tql_from_spec' || toolName === 'save_tql_file' || toolName === 'forecast_table') && agent.compileFailStreak >= COMPILE_FAIL_CAP) {
    console.println('  \\- BLOCKED: ' + agent.compileFailStreak + ' consecutive compile failures, forcing skip (cap ' + COMPILE_FAIL_CAP + ')');
    console.println('------------------------------------------------------------');
    agent.messages.push(createMessage('tool',
      '취소됨: 이 차트가 ' + agent.compileFailStreak + '회 연속 실패해 건너뜁니다. 같은 차트를 더 만들려 하지 말고, ' +
      '지금까지 저장에 성공한 .tql 파일들만으로 즉시 create_dashboard_with_charts를 호출해 대시보드를 완성하세요.'));
    return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  }

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

  // 리포트 커스텀 쿼리-라우팅(결정론적): 약한 모델이 커스텀을 이름으로 못 고르므로, 쿼리에 고유 주제 키워드가 있으면
  // 매칭되는 커스텀 template_id를 주입. 모델이 이미 C-* 커스텀을 골랐으면 존중. generic 슬러그(sample)는 미매칭(설계).
  if (toolName === 'save_html_report') {
    var curTpl = String((args && args.template_id) || '');
    if (!/^C-/i.test(curTpl)) {
      var customId = matchCustomByQuery(agent.currentQuery || '');
      if (customId) {
        args.template_id = customId;
        console.println('  [report] custom routed by query → ' + customId + ' (was "' + (curTpl || '(none)') + '")');
      }
    }
  }

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
      // 대시보드 생성 성공 → 이후 같은 쿼리 내 추가 차트 생성 차단 플래그 ON
      if (toolName === 'create_dashboard_with_charts') agent.dashboardFinalized = true;
    }
    // compile/save 연속 실패 스트릭 갱신(하드캡용). 도구는 실패를 'Error:' 문자열로도 반환(execErr 없이) → 둘 다 검사. 성공이면 리셋.
    if (toolName === 'compile_tql_from_spec' || toolName === 'save_tql_file' || toolName === 'forecast_table') {
      var compileFailed = !!execErr || String(result).indexOf('Error:') === 0 || String(result).indexOf('TIR invalid') >= 0;
      agent.compileFailStreak = compileFailed ? (agent.compileFailStreak + 1) : 0;
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

// 약한 모델(특히 ollama)이 최종 답변에서 같은 블록을 N번 반복 생성하는 degeneration을 결정론적으로 제거.
// 생성엔 손대지 않고 반환 직전 텍스트만 보정. 주기적 블록이 본문의 60%+를 차지하는 "진짜 반복"일 때만 1개로 축약 — 일반 답변은 그대로 통과.
function collapseRepeatedBlocks(content) {
  if (!content) return content;
  var s = String(content).replace(/\s+$/, '');
  if (s.length < 400) return content;          // 짧은 답변은 손대지 않음
  var n = s.length;
  // "끝에서 반복되는 블록"을 잡는다 — 모델이 서로 다른 서두(A·B) 뒤에 같은 블록(C)을 N번 반복하는 실제 패턴 대응.
  // 주기 L을 작은 값부터 찾아 primitive period를 고르고, 그 반복이 본문의 40%+를 차지할 때만 unit 1개로 축약.
  for (var L = 40; L <= Math.floor(n / 2); L++) {
    if (s.slice(n - L, n) !== s.slice(n - 2 * L, n - L)) continue; // 끝이 L주기로 반복 안 함
    var reps = 2, pos = n - 2 * L;
    while (pos - L >= 0 && s.slice(pos - L, pos) === s.slice(n - L, n)) { reps++; pos -= L; }
    if (reps * L < n * 0.4) continue;            // 반복 꼬리가 본문의 40% 미만 → 우연한 주기, 무시
    var unit = s.slice(n - L, n).replace(/\s+$/, '');
    var prefix = s.slice(0, pos).replace(/\s+$/, '');
    var out = prefix ? (prefix + '\n\n' + unit) : unit;
    console.println('[Agent] collapsed ' + reps + 'x repeated block (' + n + ' → ' + out.length + ' chars)');
    return out;
  }
  return content;
}

module.exports = { createAgent };
