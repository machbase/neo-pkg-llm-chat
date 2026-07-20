var process = require('process'); // jsh에선 process가 전역이 아님 → 명시적 require (catalog 로드의 process.cwd()용)
var { createMessage } = require('../llm/types');
var { createBuilder, formatCatalog } = require('../context/builder');
var { listReportTemplates, matchCustomByQuery, matchBuiltinByQuery } = require('../tools/report_templates');
var { createRegistry: createSkillRegistry } = require('../skill/skill');
var { createFixerContext, fix, fixDashboardTime, captureResults, validateTagInArgs } = require('../fixer/fixer');
var { parseTimeRange, buildSkillHint, compactHistory, inferTableName } = require('./classifier');
var security = require('../tools/security');
var { bareSelectCols } = require('../tools/sql'); // 버킷 GROUP BY + bare VALUE 실행 전 차단용
var docIntent = require('./doc_intent');

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
var ForecastLabelGuard = require('../guard/forecast_label');
var DocIndexAnswerGuard = require('../guard/doc_index_answer');

var MAX_STEPS = 60;
var COMPILE_FAIL_CAP = 6; // compile/save가 이만큼 연속 실패하면 결정론적으로 더 실행 안 함(무한루프 하드캡)
var DOC_EXAMPLE_CAP = 3;  // DocLookup 예제요청 시 compile_tql_from_spec 최대 개수(과잉생성·num_predict 초과 truncation 방지)
var DOC_READ_CAP = 8;     // DocLookup 문서 조회(get_full_document_content 등) 최대 횟수(과잉탐색 degeneration 차단, 설치 6문서 정당조회는 통과)
var FAILED_SECTION_CAP = 3; // 존재하지 않는 섹션(한국어명 헛짚기 등) 조회 하드캡. 실패는 새 내용 0이라 DOC_READ_CAP 예산을 안 먹되(되돌림), 무한 추측은 이 캡이 끊음
var LLM_ERROR_RETRIES = 2; // LLM 호출 실패(ollama 간헐적 tool_call XML 파싱오류 HTTP500·일시 네트워크) 시 같은 step 재시도 횟수
var REPEAT_CALL_CAP = 2;  // 같은 도구+같은 인자를 이만큼 실행한 뒤 또 부르면 차단(스텁 문서 무한 재조회 등 degeneration 하드캡)
var REPEAT_BLOCK_CAP = 3; // 반복 차단이 이만큼 쌓이면 도구 없이 답변 강제(차단만 무한반복하며 step 소진하는 것 방지)
var FINALIZE_ROUND_CAP = 3; // 완성(dashboardFinalized) 후 도구 없는 답변 강제 LLM 라운드 상한 — 모델이 넛지를 무시하고 공회전하면 URL 폴백으로 결정론 종료
var SCHEMA_LOOP_TOOLS = { describe_table: 1, list_tables: 1, list_table_tags: 1 }; // 스키마 확인 도구 — 데이터질문서 이것만 반복하면 execute_sql_query로 넘어가야 할 신호
var SCHEMA_LOOP_NUDGE_CAP = 2; // 스키마도구 반복 시 "execute 실행하라" 콕집어 유도 최대 횟수(초과 시 일반 반복차단 경로로 폴백)
var UNIT_MISMATCH_CAP = 2; // 질문 시간단위(주 단위 등) vs SQL 버킷단위(day 등) 불일치 시 재작성 유도 최대 횟수(초과 시 통과 — 무한루프 방지)
var REPORT_SAVE_NUDGE_CAP = 2; // save_html_report 1차(데이터조회) 후 2차 저장호출을 안 하고 완료 위조 시, 재호출 강제 유도 최대 횟수
var FORECAST_CALL_NUDGE_CAP = 2; // 예측 의도 질문(CodeExec)에서 forecast_table을 안 부르고 되묻기/답변 종료 시, 호출 강제 유도 최대 횟수
var FORECAST_SHORTAGE_CAP = 2;   // forecast_table "전 태그 데이터 부족"이 이 횟수면 추가 호출 차단 — 약한 모델이 rollup만 바꿔가며 재시도하는 루프 방지(인자가 달라 REPEAT_CALL_CAP에 안 걸림)
// 예측 의도 감지 — skill.js 4.5 FORECAST_ANY와 동일 키워드. **CodeExec 스킬 게이트와 결합**해야 순수 예측 요청만 잡힌다
// (설명/사용법 질문은 DocLookup으로, "예측 리포트"는 Report로, 대시보드는 Basic/Advanced로 이미 분류돼 CodeExec가 아님).
var FORECAST_INTENT_RE = /예측|forecast|predict|예상|전망|향후|이후\s*데이터|미래\s*값|extrapolat/i;
// "선언 후 미실행" 감지(ollama): 답변이 조회를 미래형으로 예고("~하겠습니다/할 것입니다")하는데 실제 실행이 없는 경우.
// 좁게(조회/가져올/추출/쿼리 + 미래형만) 잡아 리포트 서술("분석하겠습니다") 오탐을 피한다.
var ANNOUNCE_NO_ACTION_RE = /(조회하겠|조회할 것|가져오겠|가져올 것|추출하겠|추출할 것|불러오겠|쿼리로 가져|select[^.\n]{0,40}(가져|조회|실행))/i;
// 질문에 "기간"이 명시됐는지 감지 — 있으면 TIME 필터가 정당(today-filter 교정 힌트 미발동). "시간별"처럼 버킷단위는 범위 아님(숫자+단위만 인정).
var TIME_RANGE_RE = /(오늘|어제|그제|내일|모레|최근|요새|지난|저번|이번|작년|올해|금년|이달|당일|당월|처음|마지막|최신|\d{4}\s*년|\d{1,2}\s*월|\d{4}-\d{1,2}|\d+\s*(일|주일?|개월|달|년|시간|분|초)\s*(전|간|동안|이내|이후|이전)?|기간|부터|까지|사이|이후|이전|이래|동안|범위)/;

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
      [DashboardOmissionGuard, ChartOmissionGuard, ReportOmissionGuard, DashboardAnswerGuard, TqlOmissionGuard,
       ForecastLabelGuard, DocIndexAnswerGuard, RawTqlGuard, FakeTqlAnswerGuard]
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
  // Deterministic security short-circuit: refuse credential/server-control/shell/
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
  agent._finalizeNudged = false;    // 완성 가드: 이번 턴 "보고서 작성" 지시 주입 여부(1회용)
  agent._finalizeResult = '';       // 완성 가드: 마무리 도구 결과(URL 포함) — 빈 보고서 폴백용
  agent._finalizeRounds = 0;        // 완성 후 강제답변 LLM 라운드 수(FINALIZE_ROUND_CAP 공회전 하드캡용)
  agent.reportSavePending = false;  // save_html_report 1차 호출(데이터조회)만 되고 실제 파일 저장(2차 호출)이 아직 안 된 상태
  agent._reportSaveNudges = 0;      // 저장 재호출 강제 유도 누적 횟수(REPORT_SAVE_NUDGE_CAP 상한)
  agent._forecastCalled = false;    // 이번 쿼리에서 forecast_table을 시도했는지(성공·도구 되묻기·에러 무관) — 되묻기 가드 전제
  agent._forecastCallNudges = 0;    // 예측 의도인데 미호출 답변 시 호출 강제 유도 누적 횟수(FORECAST_CALL_NUDGE_CAP 상한)
  agent._forecastShortages = 0;     // forecast_table "전 태그 데이터 부족" 누적(FORECAST_SHORTAGE_CAP 도달 시 추가 호출 차단)
  agent.docExampleCompiles = 0;     // DocLookup 예제 생성 개수(DOC_EXAMPLE_CAP 하드캡용)
  agent._docTableNames = undefined; // DocLookup 가드용 테이블명 캐시 — 쿼리마다 재확보(세션 중 생성된 테이블·일시 오류 반영)
  agent._docIndexNudged = false;    // 섹션목록만 보고 답변 시 재유도(doc_index_answer 가드) 쿼리당 1회 플래그
  agent._docReads = 0;              // DocLookup 문서 조회 횟수(DOC_READ_CAP 과잉탐색 하드캡용; 실패 섹션조회는 되돌림)
  agent._failedDocSections = 0;     // "섹션 없음"(존재X 섹션명 헛짚기) 응답 횟수(FAILED_SECTION_CAP 무한추측 하드캡용)
  agent._forceEmptyRetried = false; // 강제답변 빈응답 시 1회 재촉 후 정직 폴백(대시보드 아닌 경우) 플래그
  agent._strippedEmptyRetried = false; // 답변이 문서경로 줄뿐이라 후처리(stripDocPathLines) 후 빈응답 → 1회 재촉 플래그
  agent._ranQuery = false;          // 이번 쿼리에서 execute_sql_query를 한 번이라도 실행했는지("선언 후 미실행" 넛지용)
  agent._intentNudged = false;      // "조회하겠다"만 하고 미실행 시 1회 재유도 플래그(캡)
  agent._callCounts = {};           // (도구+인자) 시그니처별 실행 횟수 — 동일 호출 반복 차단용(쿼리마다 리셋)
  agent._repeatBlocks = 0;          // 반복 차단 누적 횟수(REPEAT_BLOCK_CAP 도달 시 도구 없이 답변 강제)
  agent._repeatForceAnswer = false; // 반복 교착 → 도구 제거 답변 강제 플래그
  agent._schemaLoopNudges = 0;      // 스키마도구(describe/list) 반복 시 execute 실행 유도 횟수(SCHEMA_LOOP_NUDGE_CAP 상한)
  agent._unitMismatchNudges = 0;    // 질문단위 vs SQL버킷단위 불일치 재작성 유도 횟수(UNIT_MISMATCH_CAP 상한)
  agent._multiTagNudged = false;    // 다중 태그 합산집계(GROUP BY NAME 누락) 재작성 유도 1회 플래그
  agent._bareValueNudges = 0;       // 버킷 GROUP BY + bare VALUE(임의 행 값 반환) 재작성 유도 횟수(UNIT_MISMATCH_CAP 상한)
  agent._lastQueryHadRows = false;  // 마지막 execute_sql_query가 실데이터 행을 반환했는지(숫자 없는 답변 재촉용)
  agent._noNumbersNudged = false;   // 데이터 있는데 답변에 숫자 0개 → 수치 포함 재작성 재촉 1회 플래그
  agent._forceExecNudged = false;   // 반복교착 강제답변에서 execute_sql_query만 남길 때 실행 지시 1회 플래그
  agent._llmErrorRetries = 0;       // LLM 호출 실패 재시도 카운터(LLM_ERROR_RETRIES 상한)
  if (agent.llm.type === 'ollama' && agent.llm.temperature !== 0) agent.llm.temperature = 0; // 이전 턴 재시도 온도 잔재 원복
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
  // Ollama 카탈로그 다이어트: 카탈로그(~10k토큰 문서 인덱스)는 search_documents를 쓸 수 있는 스킬(DocLookup/General)에만 필요.
  // 나머지 스킬(Basic/Advanced/Report/Timer/DataQuery/SystemInfo)은 search_documents 미노출 → 카탈로그가 죽은 짐이라
  // ollama일 때만 빼서 프리필↓·희석↓(40k창의 ~25% 절약). 강한 3모델(gpt/claude/gemini)은 큰 창+캐싱이라 항상 포함.
  var skillUsesCatalog = !activeSkill.allowTools || activeSkill.allowTools.indexOf('search_documents') >= 0;
  if (agent.docCatalog && (!isOllama || skillUsesCatalog)) {
    // ollama엔 경량본(path+제목만) 주입 — 키워드 열(덩치의 절반)은 search_documents가 디스크에서 읽으므로
    // 컨텍스트에 넣을 필요 없음. 제목 지도는 검색 미스 시 폴백으로 유지. 강한 모델은 전문(직접 의미선택이 나음).
    builder.setCatalog(isOllama ? leanCatalog(agent.docCatalog) : agent.docCatalog);
  }
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
  // thinking 억제는 ollama.js의 think:false 파라미터가 담당(프롬프트 /no_think은 네이티브 thinking 모델이 무시).
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

// Ollama 스킬 강등 훅(현재 no-op): compile_tql_from_spec(IR)이 TQL 문법/함정을 보장하므로 약한 모델도
// AdvancedAnalysis를 그대로 쓴다. 강등이 다시 필요하면 ollama + AdvancedAnalysis일 때
// skillRegistry.get('BasicAnalysis')를 반환하도록 구현.
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
  agent.fixerCtx.isOllama = !!(agent.llm && agent.llm.type === 'ollama');

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
  agent.fixerCtx.isOllama = !!(agent.llm && agent.llm.type === 'ollama');

  console.println('[Agent] Skill: ' + activeSkill.name +
    ' | Workflows: [' + (activeSkill.workflows || []).join(', ') + ']' +
    ' | Tools: ' + (agent.toolDefs ? agent.toolDefs.length : '?'));

  var skillSwitched = (activeSkill.name !== prevSkill);

  // Ollama 전용: 약한 모델은 이전 질문 맥락이 새 질문 답을 오염시킴 → 후속 마커 없으면 매 질문 풀 리셋.
  // (마커 있음 = 관련 질문이면 아래 compact 경로로 흘려 맥락 보존.) 강한 모델(gpt/claude/gemini)은 미적용.
  // 스킬 동일 시 기존 system 객체를 그대로 재사용 → 타임스탬프까지 동일해 KV 프리픽스 캐시 유지.
  if (agent.llm.type === 'ollama' && !hasFollowupMarker(query)) {
    var sysMsg = (!skillSwitched && agent.messages[0] && agent.messages[0].role === 'system')
      ? agent.messages[0]
      : createMessage('system', buildSystemPrompt(agent, activeSkill));
    applySkill(agent, activeSkill);
    var ucReset = query;
    var hintReset = buildSkillHint(query, activeSkill, tr);
    if (hintReset) ucReset += '\n\n' + hintReset;
    agent.messages = [sysMsg, createMessage('user', ucReset)];
    console.println('[Agent][ollama] full reset (no follow-up marker) → ' + agent.messages.length + ' messages');
    return;
  }

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
  // Ollama 완성 가드: 마무리 도구(create_dashboard_with_charts / save_html_report 저장) 성공 후엔 도구 없이 호출 →
  // 약한 모델이 describe_table/list_tables로 무한 재탐색하지 않고 보고서(content)를 쓰고 종료하게 강제.
  // 강한 모델(gpt/claude/gemini)은 기존 흐름(preview_dashboard 등) 유지.
  // 도구 없이 답변 강제: (a) 대시보드/리포트 완성 후, 또는 (b) 동일 호출 반복 차단이 누적돼 교착일 때(_repeatForceAnswer).
  var _forceAnswer = (agent.llm.type === 'ollama' && (agent.dashboardFinalized || agent._repeatForceAnswer));
  // 완성 후 강제답변이 수렴하지 않는 공회전 하드캡: 모델이 넛지를 무시하고 tool_call 흉내/가드 재프롬프트로
  // 계속 돌면(라이브에서 ~10초 호출 60회+ 관측, 차단 경로는 step을 안 태워 maxSteps 백스톱도 못 닿음)
  // 상한 초과 시 완성 도구 결과(URL 포함)로 결정론 종료 — 빈응답 폴백과 같은 출구.
  if (_forceAnswer && agent.dashboardFinalized) {
    agent._finalizeRounds = (agent._finalizeRounds || 0) + 1;
    if (agent._finalizeRounds > FINALIZE_ROUND_CAP) {
      console.println('[Agent] Post-finalize churn: round ' + agent._finalizeRounds + ' > cap ' + FINALIZE_ROUND_CAP + ' → deterministic completion.');
      console.println('============================================================');
      return cb(null, agent._finalizeResult || '작업이 완료되었습니다.');
    }
  }
  if (agent.dashboardFinalized && _forceAnswer && !agent._finalizeNudged) {
    // 마무리 도구 성공 후, 약한 모델은 "이제 보고서 써라"를 명시하지 않으면 침묵함 → 도구 제거와 함께 직접 지시(1회).
    agent._finalizeNudged = true;
    agent.messages.push(createMessage('user', '작업 완료: 대시보드/리포트가 생성되었습니다. 추가 도구 호출 없이, 앞서 조회한 통계·결과를 인용해 한국어 분석 보고서를 작성하고 종료하세요. URL이 있으면 [열기](URL) 형식으로 포함하세요.'));
  }
  var _callTools = _forceAnswer ? [] : agent.toolDefs;
  // 반복교착 강제답변이라도 "데이터 질문 + 아직 쿼리 0회"면 execute_sql_query 하나만 남긴다 —
  // 도구를 전부 제거하면 SQL 실행이 불가능해져 "먼저 확인하겠습니다"류 선언만 하고 끝난다.
  // 문서질문(DocLookup)·완성 후(dashboardFinalized)·이미 쿼리한 경우는 전부 제거. 재교착은 MAX_STEPS가 백스톱.
  // ⚠ 상한 필수: 도구 채널이 열려 있으면 약한 모델이 목록에 없는 describe_table을 계속 환각 호출하며 차단 루프에
  // 빠진다. REPEAT_BLOCK_CAP×2 초과 시 도구 완전 제거로 복귀 — 빈 도구면 ollama가 content를 내고 종료.
  if (_forceAnswer && !agent.dashboardFinalized && agent.skillName !== 'DocLookup' && !agent._ranQuery &&
      agent._repeatBlocks < REPEAT_BLOCK_CAP * 2) {
    _callTools = [];
    for (var _ti = 0; _ti < agent.toolDefs.length; _ti++) {
      if (agent.toolDefs[_ti].function && agent.toolDefs[_ti].function.name === 'execute_sql_query') _callTools.push(agent.toolDefs[_ti]);
    }
    if (_callTools.length && !agent._forceExecNudged) {
      agent._forceExecNudged = true;
      console.println('[Agent] Force-answer on data question with no query ran → keep execute_sql_query only.');
      agent.messages.push(createMessage('user',
        '다른 도구는 모두 차단되었습니다. 지금 execute_sql_query로 질문에 답할 SQL을 한 번 실행하고, 그 결과만으로 최종 답변을 작성하세요.'));
    }
  }
  agent.llm.chat(agent.messages, _callTools, function (err, resp) {
    if (agent.cancelled) {
      console.println('[Agent] Cancelled after LLM response at step ' + step);
      console.println('============================================================');
      return cb(null, '(중단됨)');
    }
    if (err) {
      // ollama 약한 모델의 간헐적 tool_call 파싱오류(HTTP 500 "XML syntax error ..." 등)·일시 네트워크 오류 →
      // 같은 step 재시도(비결정적이라 대개 복구). 소진 시 graceful 메시지(raw 에러 노출 금지).
      if ((agent._llmErrorRetries || 0) < LLM_ERROR_RETRIES) {
        agent._llmErrorRetries = (agent._llmErrorRetries || 0) + 1;
        // temp=0이면 재시도해도 같은 malform 반복 → ollama는 재시도마다 온도를 올려 다른 샘플링으로 회피(0.5,0.9).
        if (agent.llm.type === 'ollama') agent.llm.temperature = 0.4 * agent._llmErrorRetries + 0.1;
        console.println('[Agent] LLM error (retry ' + agent._llmErrorRetries + '/' + LLM_ERROR_RETRIES + ', temp=' + (agent.llm.temperature || 0) + '): ' + err.message);
        return runLoop(agent, step, cb);
      }
      console.println('[Agent] LLM error, retries exhausted: ' + err.message);
      console.println('============================================================');
      if (agent.llm.type === 'ollama') agent.llm.temperature = 0; // 소진 → 온도 원복
      return cb(null, '일시적으로 응답 생성에 실패했습니다(모델 오류). 같은 질문을 다시 시도해 주세요.');
    }
    agent._llmErrorRetries = 0; // 성공 → step별 재시도 카운터 리셋
    if (agent.llm.type === 'ollama' && agent.llm.temperature !== 0) agent.llm.temperature = 0; // 재시도로 올렸던 온도 원복

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
      // Ollama 리포트 저장 가드: save_html_report 1차 호출(데이터 조회)만 하고 2차 저장 호출을 건너뛴 채
      // 분석 본문을 채팅으로 뱉으며 완료·URL을 위조하는 것을 차단. 실제 파일 저장·진짜 링크는 2차 호출에서만 발생.
      // 방금 쓴 분석을 보존해 도구 인자로 재사용하도록 하고, 도구를 남겨둔 채 재호출을 명시적으로 지시(캡까지).
      if (agent.llm.type === 'ollama' && agent.reportSavePending && agent._reportSaveNudges < REPORT_SAVE_NUDGE_CAP) {
        agent._reportSaveNudges++;
        console.println('[Agent] Report NOT saved but model answered without re-calling save_html_report → forcing re-call (nudge ' + agent._reportSaveNudges + '/' + REPORT_SAVE_NUDGE_CAP + ')');
        if (msg.content) agent.messages.push(createMessage('assistant', msg.content)); // 모델이 방금 작성한 분석 본문 보존
        agent.messages.push(createMessage('user',
          '아직 리포트 파일이 저장되지 않았습니다. 위에서 작성한 분석 내용을 analysis와 recommendations 인자에 담아 save_html_report를 반드시 다시 호출하세요. ' +
          'URL·파일명·링크를 직접 지어내 답하지 마세요 — 실제 링크는 저장 도구만 생성합니다.'));
        return runLoop(agent, step + 1, cb);
      }
      // Ollama 예측 되묻기 가드: 예측 의도 질문(skill 4.5 → CodeExec)에서 forecast_table을 한 번도 안 부르고
      // 최종 답변(대개 describe_table의 태그 목록을 보고 "어떤 태그를 예측할까요?" 되묻기)을 내면 호출을 강제 재유도.
      // 태그 판단은 도구 소관(1개=자동/2~5=전부/5초과=도구가 되묻음)인데 약한 모델이 도구 설명의 "되묻기"를 보고
      // 자기가 선점하는 패턴 — 프롬프트 금지("즉시 호출·되묻지 마세요")로는 안 지켜져 결정론으로 차단.
      // forecast_table을 한 번이라도 시도했으면(성공·도구 되묻기·에러 무관) 미발동 — 도구 자신의 되묻기는 정당하다.
      if (agent.llm.type === 'ollama' && agent.skillName === 'CodeExec' && !agent._forecastCalled &&
          FORECAST_INTENT_RE.test(String(agent.currentQuery || '')) &&
          agent._forecastCallNudges < FORECAST_CALL_NUDGE_CAP) {
        agent._forecastCallNudges++;
        var _fcTable = lastDescribedTable(agent);
        console.println('[Agent] Forecast intent but model answered without calling forecast_table → forcing call (nudge ' + agent._forecastCallNudges + '/' + FORECAST_CALL_NUDGE_CAP + ')');
        if (msg.content) agent.messages.push(createMessage('assistant', msg.content)); // 방금 낸 답변 보존(인덱스 페어링 유지)
        agent.messages.push(createMessage('user',
          '사용자는 예측을 요청했습니다. 태그·저장 여부를 사용자에게 묻지 말고 지금 forecast_table 도구를 호출하세요. ' +
          (_fcTable ? 'spec={"table":"' + _fcTable + '"} 로 호출하면 됩니다. ' : 'spec에 {"table":"테이블명"}만 주면 됩니다. ') +
          '태그는 도구가 알아서 처리합니다(1개=자동, 2~5개=전부 예측, 5개 초과=데이터 많은 순 상위 5개 자동 선정).'));
        return runLoop(agent, step + 1, cb);
      }
      if (!msg.content) {
        if (_forceAnswer) {
          // (a) 대시보드/리포트 완성 후 빈응답 → URL 포함 완료 답변으로 종료.
          if (agent.dashboardFinalized) {
            console.println('[Agent] Finalized but empty report → deterministic completion.');
            console.println('============================================================');
            return cb(null, agent._finalizeResult || '작업이 완료되었습니다.');
          }
          // (b) 문서 과잉탐색(DOC_READ_CAP) 등으로 강제답변인데 빈응답 → '작업 완료'는 문서질문에 엉뚱.
          //     1회 강하게 재촉(도구는 여전히 제거됨), 그래도 비면 정직 폴백으로 종료.
          if (!agent._forceEmptyRetried) {
            agent._forceEmptyRetried = true;
            console.println('[Agent] Forced-answer empty → one strong retry.');
            agent.messages.push(createMessage('user',
              '빈 응답은 허용되지 않습니다. 방금 조회한 문서 내용을 근거로 사용자 질문에 대한 답변을 지금 바로, 한국어로 작성하세요.'));
            return runLoop(agent, step + 1, cb);
          }
          console.println('[Agent] Forced-answer still empty → honest fallback.');
          console.println('============================================================');
          return cb(null, '문서를 확인했지만 답변 생성에 실패했습니다. 질문을 조금 더 구체적으로 다시 시도해 주세요.');
        }
        console.println('[Agent] Empty response, retrying...');
        agent.messages.push(createMessage('user', '작업이 완료되지 않았습니다. 다음 단계를 계속 진행하세요.'));
        return runLoop(agent, step + 1, cb);
      }
      // "선언 후 미실행" 가드(ollama): 답변이 조회를 예고("~하겠습니다")하는데 이번 쿼리에서 execute_sql_query를
      // 한 번도 안 불렀으면(말만 하고 종료 — 약한 모델 패턴) 실제 실행을 1회 재유도. 좁은 패턴 + 캡 1로 오탐/루프 최소화.
      // DocLookup(문서 how-to)은 데이터 조회가 아니라 문서 설명이 정답 → 넛지 무의미하고 넛지문이 답변에 누출되므로 제외.
      if (agent.llm.type === 'ollama' && agent.skillName !== 'DocLookup' && !agent._ranQuery && !agent._intentNudged && ANNOUNCE_NO_ACTION_RE.test(msg.content)) {
        agent._intentNudged = true;
        console.println('[Agent] Announced a query but never executed one → nudge to actually run it.');
        agent.messages.push(createMessage('assistant', msg.content)); // 방금 낸 선언 보존(인덱스 페어링 유지)
        agent.messages.push(createMessage('user',
          '방금 답에서 조회하겠다고 말만 하고 실제로 실행하지 않았습니다. 지금 execute_sql_query 도구를 실제로 호출해 데이터를 가져온 뒤, 그 결과로 답하세요. 예고하지 말고 도구를 지금 호출하세요.'));
        return runLoop(agent, step + 1, cb);
      }
      // 숫자 없는 데이터 답변 재촉(ollama·캡1): 쿼리가 실데이터 행을 반환했는데 최종 답변에 숫자가 하나도 없으면
      // ("최근 4개 시점만 조회되었습니다. 보고 싶으시면 말씀해 주세요!" 류) 값 포함 재작성 1회 유도.
      // 0건/에러 결과였으면 _lastQueryHadRows=false라 "데이터 없습니다" 정직 답변은 미발동.
      if (agent.llm.type === 'ollama' && agent.skillName !== 'DocLookup' && agent._ranQuery &&
          agent._lastQueryHadRows && !agent._noNumbersNudged && msg.content && !/\d/.test(msg.content)) {
        agent._noNumbersNudged = true;
        console.println('[Agent] Data answer contains no numbers → nudge to include actual values.');
        agent.messages.push(createMessage('assistant', msg.content));
        agent.messages.push(createMessage('user',
          '방금 답변에 조회 결과의 실제 수치가 하나도 없습니다. 위에서 조회한 결과의 값들을 표로 포함해 완전한 답변을 지금 작성하세요.'));
        return runLoop(agent, step + 1, cb);
      }
      var finalContent = collapseRepeatedBlocks(msg.content);
      finalContent = normalizeProductName(finalContent);                             // 제품명 오표기 정정(마하베이스→마크베이스) — 전 프로바이더
      if (agent.llm.type === 'ollama') finalContent = normalizeHan(finalContent);   // 약한 모델 한자/중국어 누출 보정
      if (agent.llm.type === 'ollama') finalContent = balanceFences(finalContent);  // 안 닫힌 ```tql 펜스 복구(블록 병합→실행오류 방지)
      if (agent.llm.type === 'ollama') finalContent = dedupeTqlBlocks(finalContent); // 같은 SQL의 ```tql 블록 재탕 제거
      if (agent.llm.type === 'ollama') finalContent = reflowMarkdown(finalContent); // 깨진 목록 골격 복원(번호 뒤 공백·인라인 불릿 줄바꿈)
      if (agent.llm.type === 'ollama') finalContent = stripToolInternals(finalContent); // 도구 안내문(section= 등) 사용자 조언으로 에코된 줄 제거
      // 저장 재유도(캡)까지 실패해 최종 폴백에 도달: 실제 파일 저장이 안 됐으므로 모델이 지어낸 URL/링크 제거 + 정직 고지.
      if (agent.llm.type === 'ollama' && agent.reportSavePending) finalContent = stripFabricatedReportSave(finalContent);
      // DocLookup 답변에서 내부 문서 경로(.md) 노출 줄만 제거(약한 모델 누출 보정).
      // (섹션 제목 나열은 부착하지 않는다 — 영어 제목이라 한국어 답변에 노이즈. 폭/깊이는 모델이 쓰게 프롬프트로 유도.)
      if (agent.llm.type === 'ollama' && agent.skillName === 'DocLookup') {
        finalContent = stripDocPathLines(finalContent);
        // 약한 모델이 "자세한 내용은 xxx.md 참고"처럼 경로 줄만 답으로 낸 경우 → 위 제거 후 알맹이가 사라져 빈 답변이 됨.
        // 빈-응답 폴백(위 !msg.content 분기)은 후처리 前에만 걸리므로 여기서 다시 검사: 1회 강하게 재촉, 그래도 비면 정직 폴백.
        if (!finalContent.replace(/\s/g, '')) {
          if (!agent._strippedEmptyRetried) {
            agent._strippedEmptyRetried = true;
            console.println('[Agent] Answer was doc-path line(s) only → stripped to empty → one strong retry.');
            agent.messages.push(createMessage('user',
              '문서 경로(.md)만 답하지 말고, 방금 조회한 문서 내용을 근거로 사용자 질문에 대한 실제 답변(설명 + SQL 예시)을 지금 바로 한국어로 작성하세요.'));
            return runLoop(agent, step + 1, cb);
          }
          console.println('[Agent] Still doc-path-only after retry → honest fallback.');
          console.println('============================================================');
          return cb(null, '문서를 확인했지만 답변 생성에 실패했습니다. 질문을 조금 더 구체적으로 다시 시도해 주세요.');
        }
      }
      // Security backstop: redact credentials/keys/account-enumeration
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
  // 완성 후엔 차트 생성(compile/save/forecast)뿐 아니라 재탐색 도구(describe_table/list_tables)도 차단 —
  // 약한 모델이 create_dashboard와 같은 배치에 이들을 묶어 뱉으면 완성 후 불필요 재탐색이 되므로.
  // forecast_table은 **filename 유무와 무관하게** 차단한다 — 호출 자체가 리포트 산출(=완성)이라
  // 완성 후 재호출은 리포트를 하나 더 만들 뿐이다. (dashboardFinalized는 쿼리마다 리셋되므로 후속 질문은 정상 동작.)
  if (agent.dashboardFinalized && (toolName === 'compile_tql_from_spec' || toolName === 'save_tql_file' ||
      toolName === 'forecast_table' || toolName === 'describe_table' || toolName === 'list_tables')) {
    console.println('  \\- BLOCKED: dashboard already finalized, skipping ' + toolName + ' (post-finalize tool block)');
    console.println('------------------------------------------------------------');
    agent.messages.push(createMessage('tool',
      '취소됨: 대시보드가 이미 생성·완성되었습니다. 추가 차트는 기존 대시보드에 포함되지 않으므로 만들지 마세요. ' +
      '받은 대시보드 URL로 최종 답변(분석 요약 + [대시보드 열기](URL))을 작성하세요.'));
    return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  }

  // DocLookup 결정론 가드(ollama): EXCEPTION(예제 생성 경로) 발동 조건 = (예제/코드 명시 요청) AND
  // (실재 테이블명이 질문에 명시) 둘 다 — 예제 키워드만 보면 "롤업 예제 알려줘" 같은 테이블 없는
  // 순수 문서 질문까지 compile_tql_from_spec으로 샌다. 판정은 doc_intent(실재 테이블 목록 대조).
  var _docGuarded = toolName === 'compile_tql_from_spec' || toolName === 'describe_table' || toolName === 'list_tables' ||
    toolName === 'search_documents' || toolName === 'get_full_document_content' || toolName === 'get_document_sections';
  if (agent.llm.type === 'ollama' && agent.skillName === 'DocLookup' && _docGuarded) {
    var _dq = String(agent.currentQuery || '');
    var _wantsEx = docIntent.wantsExample(_dq);
    var _structQ = docIntent.asksTableStructure(_dq);
    // 테이블명 실재 판정에 목록 필요 → 최초 1회 lazy 확보 후 같은 호출 재진입(entry의 step++ 상쇄로 -1)
    if ((_wantsEx || _structQ) && agent._docTableNames === undefined) {
      return agent.registry.execute('list_tables', {}, function (tErr, tRes) {
        agent._docTableNames = tErr ? null : docIntent.parseTableNames(tRes);
        executeToolCalls(agent, toolCalls, idx, step - 1, doneCb);
      });
    }
    var _qTable = (_wantsEx || _structQ) ? docIntent.mentionsTable(_dq, agent._docTableNames) : '';
    var _exception = _wantsEx && !!_qTable;

    if (toolName === 'compile_tql_from_spec' || toolName === 'describe_table' || toolName === 'list_tables') {
      // "무슨 테이블 있어?" 류 목록 탐색 질문은 문서가 아니라 list_tables가 정답 → 차단 제외
      var _isListQ = toolName === 'list_tables' && docIntent.asksTableList(_dq);
      // "SENSOR_TEST 테이블 구조/컬럼 알려줘" 류 스키마 질문은 describe_table이 정답(hint도 지시) → 차단 제외
      var _isStructQ = toolName === 'describe_table' && _structQ && !!_qTable;
      if (!_exception && !_isListQ && !_isStructQ) {
        var _why = _wantsEx
          ? '질문에 특정 테이블명이 없으므로 예제 생성 대상이 아닙니다. search_documents로 문서를 찾아 해당 섹션을 읽고 문서 기반으로 설명하세요(문서 코드 예제는 extract_code_blocks로 추출 가능).'
          : '이 질문은 개념/사용법 설명 요청입니다. 테이블 탐색·차트 생성 없이, 검색·조회한 문서 내용만으로 설명하세요.';
        // 이 차단은 REPEAT_CALL_CAP 체크보다 앞이라 callCount에 안 잡힌다 → 차단 누적을 따로 세어
        // 캡 도달 시 도구 없이 답변 강제(이미 문서는 읽었으므로 그걸로 답하게). 안 세면 재호출 무한루프.
        agent._repeatBlocks++;
        console.println('  \\- BLOCKED: DocLookup ' + (_wantsEx ? '테이블명 없는 예제 요청' : '순수 설명 질문') + ' → ' + toolName + ' 차단 (누적 ' + agent._repeatBlocks + ')');
        console.println('------------------------------------------------------------');
        agent.messages.push(createMessage('tool', _why));
        if (agent._repeatBlocks >= REPEAT_BLOCK_CAP) {
          agent._repeatForceAnswer = true;
          console.println('  \\- DocLookup 차단 ' + agent._repeatBlocks + '회 반복 → 도구 없이 답변 강제(무한루프 방지)');
        }
        return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
      }
      // EXCEPTION인데 질문에 없는 다른 테이블로 컴파일 → 차단(환각 테이블 방지)
      if (_exception && toolName === 'compile_tql_from_spec') {
        var _argTable = docIntent.extractSpecTable(tc.function.arguments || {});
        if (_argTable && _argTable.toUpperCase() !== _qTable.toUpperCase() &&
            _dq.toUpperCase().indexOf(_argTable.toUpperCase()) < 0) {
          console.println('  \\- BLOCKED: DocLookup 질문에 없는 테이블(' + _argTable + ')로 컴파일 시도 차단');
          console.println('------------------------------------------------------------');
          agent.messages.push(createMessage('tool',
            '질문에 언급된 테이블(' + _qTable + ')로만 예제를 만드세요. spec.table을 ' + _qTable + '로 고쳐 재호출하세요.'));
          return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
        }
      }
    }

    // 거울 가드: 진짜 EXCEPTION(테이블명+예제)일 때만 문서 도구 차단 → describe→compile 직행 유도.
    // (조건을 더 넓히면 테이블명 없는 "차트 예제" 질문까지 문서를 막아 교착이 된다)
    if (_exception && (toolName === 'search_documents' || toolName === 'get_full_document_content' || toolName === 'get_document_sections')) {
      console.println('  \\- BLOCKED: DocLookup 테이블 예제 요청(' + _qTable + ') → ' + toolName + ' 차단 (문서 없이 describe→compile)');
      console.println('------------------------------------------------------------');
      agent.messages.push(createMessage('tool',
        '테이블(' + _qTable + ') 예제 요청입니다. 문서 검색 없이 describe_table로 태그·컬럼을 확인한 뒤 compile_tql_from_spec(filename 없이)로 검증된 TQL 예제를 생성하세요.'));
      return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
    }
  }

  // DocLookup 문서 조회 하드캡: 약한 모델이 답을 이미 얻고도 멈추지 않고 문서/섹션을 계속 읽는
  // 과잉탐색(non-termination) degeneration 차단. 설치처럼 여러 문서 정당 조회(≈6)는 살리게 넉넉히.
  // 초과 시 도구 없이 답변 강제(_repeatForceAnswer). search_documents는 제외(검색은 저렴·수렴).
  if (agent.llm.type === 'ollama' && agent.skillName === 'DocLookup' &&
      (toolName === 'get_full_document_content' || toolName === 'get_document_sections' || toolName === 'extract_code_blocks')) {
    if (agent._docReads >= DOC_READ_CAP || agent._failedDocSections >= FAILED_SECTION_CAP) {
      agent._repeatForceAnswer = true;
      var _capHitSection = agent._failedDocSections >= FAILED_SECTION_CAP;
      console.println('  \\- BLOCKED: DocLookup ' + (_capHitSection ? '섹션 헛짚기 ' + agent._failedDocSections + '회' : '문서 조회 ' + DOC_READ_CAP + '회') + ' 도달 → 도구 없이 답변 강제');
      console.println('------------------------------------------------------------');
      // 강제답변 시 원 질문을 재명시 + "읽은 것을 그대로 인용"으로 재초점 — 과잉탐색으로 컨텍스트가
      // 비대해진 약한 모델이 정답 섹션을 이미 읽고도 질문과 무관한 내용을 뱉는 걸 억제.
      var _origQ = String(agent.currentQuery || '').slice(0, 200);
      agent.messages.push(createMessage('tool', (_capHitSection
        ? '존재하지 않는 섹션명을 여러 번 조회했습니다. 더 추측하지 말고, '
        : '문서를 충분히(' + DOC_READ_CAP + '회) 읽었습니다. 더 읽지 말고, ') +
        '원래 질문은 "' + _origQ + '"입니다. 방금 읽은 문서 내용에서 그 답(명령어·구문·방법)을 그대로 인용해 질문에 직접 답하고 종료하세요. 문서와 무관한 문장은 절대 쓰지 마세요.'));
      return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
    }
    agent._docReads++;
  }

  // DocLookup 예제 개수 하드캡: DOC_EXAMPLE_CAP개 넘게 compile하려 하면 차단 → 과잉생성/num_predict 초과 truncation 방지.
  if (agent.llm.type === 'ollama' && agent.skillName === 'DocLookup' && toolName === 'compile_tql_from_spec' && agent.docExampleCompiles >= DOC_EXAMPLE_CAP) {
    console.println('  \\- BLOCKED: DocLookup 예제 ' + DOC_EXAMPLE_CAP + '개 도달, 추가 compile 차단');
    console.println('------------------------------------------------------------');
    agent.messages.push(createMessage('tool',
      '예제 ' + DOC_EXAMPLE_CAP + '개면 충분합니다. 더 만들지 말고, 지금까지 생성한 예제를 각각 [제목 → 짧은 설명 → 그 예제의 ```tql 블록]을 한 묶음으로 이어 붙여 답변하고 종료하세요.'));
    return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  }

  // forecast_table "데이터 부족" 반복 차단: 부족 응답을 받고도 rollup만 바꿔 재호출하는 루프(BEARING 3.4분 데이터에서
  // 7연속 호출 실사례). 버킷 단위는 도구가 이미 구간 기준 최소로 잡으므로 인자를 바꿔도 결과가 달라지지 않는다.
  if (toolName === 'forecast_table' && agent._forecastShortages >= FORECAST_SHORTAGE_CAP) {
    console.println('  \\- BLOCKED: forecast_table 데이터 부족 ' + agent._forecastShortages + '회 → 추가 호출 차단');
    console.println('------------------------------------------------------------');
    agent.messages.push(createMessage('tool',
      '취소됨: 이 테이블은 예측에 필요한 데이터가 부족합니다(이미 ' + agent._forecastShortages + '회 확인). ' +
      '다시 호출하지 말고, 앞의 "데이터 부족" 표를 그대로 사용자에게 전달하며 데이터가 더 쌓인 뒤 시도하라고 안내하세요.'));
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
  if (agent.llm.type === 'ollama') normalizeHanInArgs(args); // 한자 누출이 대시보드 제목/리포트 본문 등 저장물에 박히는 것 차단
  if (agent.llm.type === 'ollama') reflowMarkdownInArgs(args); // 리포트 본문(analysis/recommendations)의 깨진 목록 골격 복원

  // forecast_table 태그 임의축소 교정(전 프로바이더, 결정론): 사용자가 질문에서 언급하지 않은 태그를 모델이
  // tag/tags에 넣으면 제거 — 태그 결정은 도구 소관(1개=자동/2~5=전부/5초과=되묻기). 하이쿠가 "실버 데이터
  // 예측해줘"에 tag:"close"를 넣어 5태그 중 1개만 예측된 라이브 사례(ollama 되묻기와 같은 병의 변종: 선점).
  if (toolName === 'forecast_table') normalizeForecastTags(agent, args);

  // 동일 호출 반복 차단(결정론적 degeneration 하드캡, 전 프로바이더): 같은 도구를 같은 인자로 REPEAT_CALL_CAP회
  // 실행한 뒤 또 부르면 실행하지 않고 끊는다 — 약한 모델이 스텁 문서·불만족 결과에 갇혀 같은 문서를
  // 수십 번 재조회하는 degeneration 방지. 인자가 다르면 시그니처가 달라 무영향.
  var _callSig = toolName + '|' + safeArgSig(args);
  if ((agent._callCounts[_callSig] || 0) >= REPEAT_CALL_CAP) {
    // 스키마 도구(describe/list) 반복 = 데이터 질문에서 "이제 쿼리해야" 신호. 여기서 일반 반복차단 경로로
    // 가면 _repeatBlocks가 쌓여 도구 전부 제거(force-answer) → execute_sql_query까지 사라져 "먼저 구조를
    // 확인하겠습니다"류 선언만 하고 끝난다. → 스키마는 이미 확보됐으니 도구를 유지한 채
    // execute_sql_query 실행을 콕 집어 유도(캡 SCHEMA_LOOP_NUDGE_CAP회). 무시하면 아래 일반 경로로 폴백
    // (force-answer 백스톱 유지). ollama·非DocLookup·아직 쿼리 안 함(_ranQuery)에만 발동 —
    // 정상 케이스(describe 1회 후 바로 쿼리)는 반복 자체가 없어 미발동, 강모델·문서질문 무영향.
    if (agent.llm.type === 'ollama' && agent.skillName !== 'DocLookup' &&
        SCHEMA_LOOP_TOOLS[toolName] && !agent._ranQuery &&
        (agent._schemaLoopNudges || 0) < SCHEMA_LOOP_NUDGE_CAP) {
      agent._schemaLoopNudges = (agent._schemaLoopNudges || 0) + 1;
      console.println('  \\- BLOCKED: ' + toolName + ' 반복(스키마 확인됨) → execute_sql_query 실행 유도 (' + agent._schemaLoopNudges + '/' + SCHEMA_LOOP_NUDGE_CAP + ')');
      console.println('------------------------------------------------------------');
      agent.messages.push(createMessage('tool',
        '취소됨: ' + toolName + '로 테이블 구조를 이미 확인했습니다(결과는 위에 있음). ' +
        '더 확인하지 말고, 지금 바로 execute_sql_query로 실제 SQL을 실행해 질문에 답하세요.'));
      return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
    }
    agent._repeatBlocks++;
    console.println('  \\- BLOCKED: 동일 호출 ' + REPEAT_CALL_CAP + '회 반복(' + toolName + '), 추가 실행 차단 (누적 ' + agent._repeatBlocks + ')');
    console.println('------------------------------------------------------------');
    // 스키마 도구(describe/list) 반복이면 문서용 범용 문구("다른 문서로 바꾸고…") 대신 실행을 콕 집어 지시 —
    // 데이터 질문에서 범용 문구는 방향 제시가 없어 모델이 계속 describe를 환각 호출한다.
    agent.messages.push(createMessage('tool',
      SCHEMA_LOOP_TOOLS[toolName] && !agent._ranQuery
        ? '취소됨: ' + toolName + '은(는) 더 이상 호출할 수 없습니다(스키마는 위에 이미 있음). 지금 execute_sql_query로 질문에 답할 SQL을 실행하세요.'
        : '취소됨: 같은 도구를 같은 인자로 이미 여러 번 호출했고 그 결과는 위에 있습니다. 똑같은 호출을 반복하지 마세요. ' +
          '필요하면 다른 인자(section=/다른 키워드)나 다른 문서로 바꾸고, 이 문서가 내용 없이 다른 곳(SDK 등)만 가리키면 ' +
          '지금까지 확인한 내용으로 답하거나 "이 문서에서는 다루지 않습니다"라고 답하세요.'));
    // 반복 차단만 계속 쌓이면(모델이 지시 무시) 도구 없이 답변 강제(ollama) — step 소진·무한교착 방지.
    if (agent.llm.type === 'ollama' && agent._repeatBlocks >= REPEAT_BLOCK_CAP) {
      agent._repeatForceAnswer = true;
      console.println('  \\- 반복 차단 ' + agent._repeatBlocks + '회 → 도구 없이 답변 강제');
    }
    return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  }
  agent._callCounts[_callSig] = (agent._callCounts[_callSig] || 0) + 1;

  // 시간단위 불일치 넛지(ollama·데이터질문·캡): "주 단위" 질문에 day 버킷 쿼리처럼, 질문이 요구하는 시간
  // 버킷 단위와 SQL 버킷 단위가 다르면 결과를 내기 전에 차단하고 올바른 단위로 재작성 유도. day 쿼리는 에러 없이
  // 성공(데이터 반환)해 hintForError로는 못 잡으므로 실행 전 차단이 유일. 오탐 방지: detectQuestionBucketUnit이
  // 복합 버킷어·정확히 1개 단위일 때만 감지(주가·월요일·지난주·30일 등 미매칭). 버킷이 틀리거나(_sUnit 존재) 아예 없을 때(VALUE 집계 한정) 발동.
  if (toolName === 'execute_sql_query' && agent.llm.type === 'ollama' && agent.skillName !== 'DocLookup' &&
      (agent._unitMismatchNudges || 0) < UNIT_MISMATCH_CAP) {
    var _qUnit = detectQuestionBucketUnit(agent.currentQuery);
    var _sUnit = detectSqlBucketUnit(args.sql_query);
    // (a) 다른 버킷: 질문 week인데 SQL day 등(_sUnit 존재, 강한 신호). (b) 버킷 누락: 질문이 시간버킷을 요구하는데
    // SQL이 버킷 없이 VALUE를 집계(전체를 한 값으로 뭉갬). (b)는 VALUE 집계일 때만 → MIN(TIME)/COUNT(*)
    // 같은 무버킷 탐색쿼리는 통과(오탐 방지). 질문에 버킷어 없으면 _qUnit=null이라 (a)(b) 모두 스킵("이번 달 평균" 등 정당).
    var _wrongBucket = _qUnit && _sUnit && _qUnit !== _sUnit;
    // stat 가상뷰(v$_stat)는 전체기간 요약이라 버킷 질문엔 항상 오답 — describe의 STAT 안내에 낚여
    // 버킷 질문을 stat 뷰로 답하는 것을 결정론 차단. VALUE 집계처럼 "버킷 누락"으로 취급.
    // 개수 질문("시간별 데이터 개수")은 COUNT(*)가 답변 형태라 VALUE 집계 조건에 안 걸려 버킷 지시를 못 받음
    // → 질문에 개수 의도가 있으면 무버킷 COUNT(도 차단. MIN/MAX(TIME) 탐색은 계속 예외.
    var _countIntent = /개수|건수|몇\s*건|몇\s*개|카운트/.test(String(agent.currentQuery || ''));
    var _missingBucket = _qUnit && !_sUnit &&
        (/\b(AVG|SUM|SUMSQ|MAX|MIN|COUNT)\s*\(\s*VALUE\b/i.test(String(args.sql_query || '')) ||
         /v\$\w+_stat\b/i.test(String(args.sql_query || '')) ||
         (_countIntent && /\bCOUNT\s*\(/i.test(String(args.sql_query || ''))));
    if (_wrongBucket || _missingBucket) {
      agent._unitMismatchNudges++;
      console.println('  \\- BLOCKED: 시간단위 ' + (_missingBucket ? '버킷 누락' : '불일치') + '(질문=' + _qUnit + ' / 쿼리=' + (_sUnit || '버킷없음') + ') → 재작성 유도 (' + agent._unitMismatchNudges + '/' + UNIT_MISMATCH_CAP + ')');
      console.println('------------------------------------------------------------');
      // ⚠ 개수 예시는 COUNT(VALUE) — ROLLUP 경로에서 COUNT(*)는 사전집계된 롤업 행 수(버킷당 1)를 세버림.
      var _aggEx = _countIntent ? 'COUNT(VALUE)' : 'AVG(VALUE)';
      agent.messages.push(createMessage('tool',
        '취소됨: 질문은 "' + _qUnit + '" 단위 시간별 집계를 요구하는데 이 쿼리는 ' +
        (_missingBucket ? '시간 버킷 없이 전체를 한 값으로 집계했습니다.' : '"' + _sUnit + '" 버킷입니다.') + ' ' +
        '시간 버킷을 ' + _qUnit + '(으)로 넣어 다시 실행하세요(질문에 기간이 없으면 TIME 필터도 넣지 마세요). ' +
        '예: SELECT ROLLUP(\'' + _qUnit + '\',1,TIME) AS bucket, ' + _aggEx + ' FROM 테이블 WHERE NAME=\'태그\' GROUP BY bucket ORDER BY bucket.'));
      return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
    }
  }

  // 다중태그 합산 방어(ollama·캡1): WHERE가 태그를 2개 이상 선택(NAME IN (...) 또는 NAME='A' OR NAME='B')하면서
  // VALUE를 집계하는데 GROUP BY에 NAME이 없으면 모든 태그가 한 값으로 합산됨 — 여러 태그를 나열한 질문은
  // 태그별 결과가 의도인 게 일반적. 실행 전 1회만 차단·재작성 유도.
  // 진짜 합산이 의도면 같은 쿼리를 다시 내면 됨(캡 1이라 두 번째부터는 통과 — 오탐이어도 1스텝 비용뿐).
  if (toolName === 'execute_sql_query' && agent.llm.type === 'ollama' && agent.skillName !== 'DocLookup' &&
      !agent._multiTagNudged) {
    var _msql = String(args.sql_query || '');
    var _inList = _msql.match(/\bNAME\s+IN\s*\(([^)]*)\)/i);
    var _multiTag = (_inList && (_inList[1].match(/'/g) || []).length >= 4) ||                  // IN ('a','b',...) = 따옴표 4개+
                    /\bNAME\s*=\s*'[^']+'[\s\S]*\bOR\b[\s\S]*\bNAME\s*=\s*'/i.test(_msql);      // NAME='a' OR ... NAME='b'
    var _valAgg2 = /\b(AVG|SUM|SUMSQ|MAX|MIN|COUNT)\s*\(\s*VALUE\b/i.test(_msql);
    var _gbClause = _msql.match(/\bGROUP\s+BY\b([\s\S]*?)(?:\bORDER\s+BY\b|\bLIMIT\b|$)/i);
    var _nameGrouped = _gbClause ? /\bNAME\b/i.test(_gbClause[1]) : false;
    if (_multiTag && _valAgg2 && !_nameGrouped) {
      agent._multiTagNudged = true;
      console.println('  \\- BLOCKED: 다중 태그 집계에 GROUP BY NAME 누락(태그 합산됨) → 태그별 분리 재작성 유도 (1/1)');
      console.println('------------------------------------------------------------');
      agent.messages.push(createMessage('tool',
        '취소됨: WHERE가 여러 태그를 선택하는데 GROUP BY에 NAME이 없어 모든 태그가 하나로 합산 집계됩니다. ' +
        '태그별 결과가 필요하면 SELECT와 GROUP BY 맨 앞에 NAME을 추가해 다시 실행하세요. ' +
        '예: SELECT NAME, DATE_TRUNC(\'hour\',TIME) AS bucket, AVG(VALUE) FROM ... WHERE NAME IN (...) GROUP BY NAME, DATE_TRUNC(\'hour\',TIME) ORDER BY NAME, bucket. ' +
        '(전체 합산이 의도라면 같은 쿼리를 그대로 다시 실행하세요.)'));
      return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
    }
  }

  // bare VALUE 방어(ollama·캡): 버킷 GROUP BY에서 SELECT의 VALUE를 집계 없이 쓰면 Machbase는 에러가 아니라
  // **그룹의 임의 행 값을 조용히 반환**한다(bare TIME이 ERR-2044인 것과 비대칭).
  // 에러 힌트가 발동할 기회가 없으므로 실행 전 차단이 유일한 방어. 올바른 쿼리(집계로 감싼 VALUE)는 미발동.
  if (toolName === 'execute_sql_query' && agent.llm.type === 'ollama' && agent.skillName !== 'DocLookup' &&
      (agent._bareValueNudges || 0) < UNIT_MISMATCH_CAP) {
    var _bsql = String(args.sql_query || '');
    var _bgb = _bsql.match(/\bGROUP\s+BY\b([\s\S]*?)(?:\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|$)/i);
    if (_bgb && /(?:DATE_TRUNC|ROLLUP)\s*\(/i.test(_bgb[1]) && bareSelectCols(_bsql).indexOf('VALUE') >= 0) {
      agent._bareValueNudges++;
      console.println('  \\- BLOCKED: 버킷 GROUP BY + bare VALUE(임의 행 값 반환) → 집계 재작성 유도 (' + agent._bareValueNudges + '/' + UNIT_MISMATCH_CAP + ')');
      console.println('------------------------------------------------------------');
      agent.messages.push(createMessage('tool',
        '취소됨: GROUP BY 집계 쿼리에서 SELECT의 VALUE를 집계함수 없이 쓰면 그룹의 임의 행 값이 나옵니다(틀린 결과). ' +
        'VALUE를 집계함수로 감싸 다시 실행하세요 — 평균 AVG(VALUE), 합계 SUM(VALUE), 변동폭 MAX(VALUE)-MIN(VALUE), 개수 COUNT(VALUE).'));
      return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
    }
  }

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
      } else if (!curTpl || /^R-0/i.test(curTpl)) {
        // 빌트인 쿼리-라우팅: 사용자가 "진동 리포트"처럼 주제를 말로 명시해도 테이블/태그명이 무관하면(BEARING의 C1/C2 등)
        // 자동감지가 못 잡고, 약한 모델은 template_id를 누락 → 질문 토큰으로 빌트인을 결정론적으로 주입.
        // 모델이 구체적 빌트인(R-1/R-2/R-3)을 이미 골랐으면 존중, 누락/R-0-general일 때만 발동.
        var builtinId = matchBuiltinByQuery(agent.currentQuery || '');
        if (builtinId && !/^R-0/i.test(builtinId)) {
          args.template_id = builtinId;
          console.println('  [report] builtin routed by query → ' + builtinId + ' (was "' + (curTpl || '(none)') + '")');
        }
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
    if (toolName === 'execute_sql_query') agent._ranQuery = true; // 조회 시도함 → "선언 후 미실행" 넛지 대상에서 제외(에러여도 시도는 한 것)
    if (execErr) {
      result = 'Error: ' + (execErr.message || String(execErr));
      console.println('  \\- ERROR: ' + result);
    } else {
      if (result === null || result === undefined) result = '';
      result = String(result);
      console.println('  \\- OK: ' + truncate(result, 500));
      // 대시보드 생성 성공 → 이후 같은 쿼리 내 추가 차트 생성 차단 + (ollama) 도구 없이 답변 강제 플래그 ON
      if (toolName === 'create_dashboard_with_charts') { agent.dashboardFinalized = true; agent._finalizeResult = result; }
      // 리포트 저장 완료(2차 호출에서 파일 저장 = "리포트 열기" URL 반환)도 완성 신호 → 완성 후 도구 없이 답변 강제.
      // 1차 호출(데이터 조회, 결과에 "다시 호출" 안내)만 되면 reportSavePending=true로 표시 → 모델이 2차 저장을
      // 건너뛰고 완료를 위조하면 runLoop 가드가 저장 재호출을 강제. 저장 성공/부분수집 상태를 결정론적으로 구분.
      if (toolName === 'save_html_report') {
        if (result.indexOf('리포트 열기') >= 0 || result.indexOf('Report saved') >= 0) {
          agent.dashboardFinalized = true; agent._finalizeResult = result; agent.reportSavePending = false; // 저장 완료
        } else if (result.indexOf('다시 호출') >= 0) {
          agent.reportSavePending = true; // 데이터만 조회됨(1차) 또는 한쪽만 수집(부분) → 아직 저장 안 됨
        }
      }
      // forecast_table도 **HTML 예측 리포트를 저장하고 링크를 돌려주면 완성**이다.
      // 이걸 완성 신호로 안 잡으면 ollama가 리포트를 다 만들고도 describe_table 등을 계속 호출해 MAX_STEPS까지 돈다
      // (create_dashboard/save_html_report와 같은 degeneration). 되묻기·에러 결과엔 링크가 없어 자연히 제외된다.
      // ⚠️ _finalizeResult는 **빈응답 폴백에서 그대로 최종 답변**이 된다 → 도구 결과의 모델용 지시문([지시…] 줄)을
      //    반드시 제거할 것. 안 그러면 ollama가 침묵할 때 그 지시문이 사용자에게 노출된다.
      if (toolName === 'forecast_table' && result.indexOf('리포트 열기') >= 0) {
        agent.dashboardFinalized = true;
        agent._finalizeResult = result.replace(/\n*\[지시[^\n]*\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      }
      // DocLookup 예제요청에서 compile 성공 개수 카운트(DOC_EXAMPLE_CAP 하드캡용) — 에러 결과는 제외.
      if (agent.skillName === 'DocLookup' && toolName === 'compile_tql_from_spec' &&
          result.indexOf('Error:') !== 0 && result.indexOf('TIR invalid') < 0) agent.docExampleCompiles++;
      // 존재하지 않는 섹션(한국어명 헛짚기 등) 조회 → 새 내용 0. DOC_READ_CAP 예산을 안 먹게 되돌리고, 별도 헛짚기 카운터만 증가
      // (무한추측은 FAILED_SECTION_CAP이 차단). 이렇게 해야 실제 섹션 조회의 답변 예산이 헛짚기로 소진되지 않음.
      if (agent.skillName === 'DocLookup' && toolName === 'get_full_document_content' &&
          (result.indexOf('" not found.') >= 0 || result.indexOf('이 문서에 없습니다') >= 0)) {
        if (agent._docReads > 0) agent._docReads--;
        agent._failedDocSections++;
      }
      // today-filter 오적용 방어(ollama): 질문에 기간이 없는데 모델이 WHERE에 TIME 필터(주입된 현재날짜 등)를 넣어
      // 0행이 나오면, 결과에 교정 힌트를 붙여 "필터 제거 후 전체조회"를 유도. sanitizeSql로 WHERE를
      // 몰래 지우는 건 금지(오늘/최근 질문 훼손) → 힌트로만. 강모델은 이 실수를 안 하므로 ollama 한정. 같은
      // 필터 재조회는 REPEAT_CALL_CAP이 차단. 질문에 기간표현(TIME_RANGE_RE) 있으면 필터가 정당 → 미발동.
      // 날짜 리터럴 오류(MACHCLI-ERR-300 등)도 같은 뿌리(기간 없는 질문에 현재날짜 TO_DATE 필터) —
      // 0행이 아니라 에러로 나타나 queryReturnedNoData에 안 걸리므로 별도 조건으로 같이 잡는다.
      // 마지막 쿼리가 실데이터를 반환했는지 추적 — "데이터 있는데 숫자 없는 답변" 재촉(post-loop)의 전제 신호.
      if (toolName === 'execute_sql_query') {
        var _rowsM = String(result).match(/\((\d+) rows?\)/);
        agent._lastQueryHadRows = !!(_rowsM && +_rowsM[1] > 0 && String(result).indexOf('Error:') !== 0 && !queryReturnedNoData(result));
      }
      var _dateErr = /MACHCLI-ERR-300|Invalid date value/i.test(String(result || ''));
      // COUNT(*)는 필터가 0건을 잡아도 NULL이 아니라 "0"을 반환 → queryReturnedNoData(영숫자 없음 판정)가
      // 못 잡음. COUNT가 든 SQL에서 1행 전부 0이면 "실질 no data"로 판정.
      var _countZero = /\bCOUNT\s*\(/i.test(String(args.sql_query || '')) && countReturnedAllZero(result);
      if (agent.llm.type === 'ollama' && toolName === 'execute_sql_query' &&
          (queryReturnedNoData(result) || _dateErr || _countZero) &&
          /\bTIME\s*(>=|>|<=|<|=|BETWEEN)/i.test(String(args.sql_query || '')) &&
          !TIME_RANGE_RE.test(String(agent.currentQuery || ''))) {
        console.println('  \\- HINT: 질문에 기간 없음 + TIME 필터 ' + (_dateErr ? '날짜 오류' : (_countZero ? 'COUNT=0' : '데이터 0건(집계 NULL 포함)')) + ' → 필터 제거 재조회 유도(today-filter 방어)');
        result += '\n\n⚠ ' + (_dateErr ? '날짜 필터에서 오류가 났습니다.' : '이 기간에 데이터가 없습니다(0행, 집계 NULL 또는 COUNT=0).') + ' 질문에 기간(오늘/최근/특정 날짜)이 명시되지 않았는데 WHERE에 TIME 조건이 들어갔습니다. WHERE에서 TIME 조건을 완전히 제거하고 전체 기간으로 다시 조회하세요. (현재 날짜로 필터를 만들지 마세요 — 데이터는 과거 시점일 수 있습니다.)';
      }
      // ROLLUP 경로의 COUNT(*)는 원본 행이 아니라 사전집계된 롤업 행 수(버킷당 1)를 센다.
      // 결과가 그럴싸해 모델이 그대로 답해버리므로 실행 후 교정 힌트로 재조회 유도(ollama).
      if (agent.llm.type === 'ollama' && toolName === 'execute_sql_query' &&
          /\bROLLUP\s*\(/i.test(String(args.sql_query || '')) &&
          /\bCOUNT\s*\(\s*\*\s*\)/.test(String(args.sql_query || ''))) {
        console.println('  \\- HINT: ROLLUP + COUNT(*) → 롤업 행 수를 세버림, COUNT(VALUE) 재조회 유도');
        result += '\n\n⚠ ROLLUP 집계에서 COUNT(*)는 원본 데이터 개수가 아니라 사전집계된 버킷 행 수(항상 1)를 셉니다. COUNT(*)를 COUNT(VALUE)로 바꿔 다시 실행하세요.';
      }
    }
    // 예측 되묻기 가드 전제: forecast_table을 **시도**했는지(성공·되묻기·에러 무관). 시도했으면 재유도 안 함.
    if (toolName === 'forecast_table') agent._forecastCalled = true;
    // "전 태그 데이터 부족"(리포트 없음) 누적 — FORECAST_SHORTAGE_CAP 도달 시 재호출 차단. 일부 태그라도 성공하면 리포트 링크가 있어 미집계.
    if (toolName === 'forecast_table' && result.indexOf('데이터 부족') >= 0 && result.indexOf('리포트 열기') < 0) {
      agent._forecastShortages++;
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

// execute_sql_query 결과가 "실질적으로 데이터 없음"인지 판정(today-filter 방어용).
// 두 형태를 모두 잡는다: ① 0행(비집계에서 필터가 0건) ② 집계 1행인데 값이 전부 NULL/빈칸
// (GROUP BY 없는 MAX/MIN/AVG 등은 필터가 0건을 잡아도 "(0 rows)"가 아니라 NULL 1행을 반환하므로).
// 결과 포맷: "헤더\n데이터행들\n\n(N rows)" (sql.js). NULL 셀은 join(',')에서 빈칸/콤마로 렌더 → 영숫자 값 유무로 판정.
// COUNT(*) 계열 필터쿼리가 0건을 잡으면 NULL이 아니라 0이 나온다 → 1행 결과의 숫자 셀이 전부 0(NULL 셀 허용)이면
// "실질 no data". VALUE가 실제 0인 데이터와 헷갈리지 않게 호출측에서 COUNT( 포함 SQL에서만 사용할 것.
function countReturnedAllZero(result) {
  if (typeof result !== 'string') return false;
  var m = result.match(/^([\s\S]*?)\n\n\(1 rows?\)/);
  if (!m) return false;
  var body = m[1], nl = body.indexOf('\n');
  if (nl < 0) return false;
  var cells = body.slice(nl + 1).trim().split(/[,\n]/);
  var sawZero = false;
  for (var i = 0; i < cells.length; i++) {
    var c = cells[i].trim();
    if (c === '') continue;                      // NULL 셀(집계 NULL)
    if (!/^0(\.0+)?$/.test(c)) return false;     // 0 아닌 실제 값 존재
    sawZero = true;
  }
  return sawZero;
}

function queryReturnedNoData(result) {
  if (typeof result !== 'string') return false;
  if (/\(0 rows?\)/.test(result)) return true;                     // ① 0행
  var m = result.match(/^([\s\S]*?)\n\n\(\d+ rows?\)/);            // 헤더+데이터행(footer 앞)
  if (!m) return false;
  var body = m[1], nl = body.indexOf('\n');
  if (nl < 0) return true;                                          // 헤더만 남음 = 집계 NULL이 trim돼 데이터행 없음
  return !/[0-9A-Za-z가-힣]/.test(body.slice(nl + 1));              // 데이터부에 실제 값(영숫자/한글) 전무 → NULL만
}

// 카탈로그 경량본: 키워드 열 제거(| path | title |만). ollama 주입용 — 검색은 디스크 전문을 읽으므로 무손실.
function leanCatalog(fullText) {
  var lines = String(fullText).split('\n'), out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf('|') >= 0) {
      var cols = line.split('|');
      if (cols.length >= 4) line = '|' + cols[1] + '|' + cols[2] + '|'; // path | title
    }
    out.push(line);
  }
  return out.join('\n');
}

// 질문에서 "시간 버킷 단위" 의도 추출(단위-불일치 넛지용). 오탐 방지가 최우선 →
// bare 글자(주/일/월/시간/분) 금지, 복합 버킷어(주별/주 단위/weekly 등)만. 정확히 1개 단위일 때만 반환(0=없음,
// 2+=모호 → null). 주간(=daytime 모호)·분/초(분석 등 오탐)는 미지원. 지난주·30일 같은 범위표현은 복합어가 아니라 자동 배제.
function detectQuestionBucketUnit(q) {
  var s = String(q || '');
  var hits = {};
  if (/시간별|시간대별|시간\s*단위|hourly/i.test(s)) hits.hour = 1;
  if (/일별|날짜별|일\s*단위|하루\s*단위|매일|daily/i.test(s)) hits.day = 1;
  if (/주별|주\s*단위|weekly/i.test(s)) hits.week = 1;
  if (/월별|월\s*단위|monthly/i.test(s)) hits.month = 1;
  var keys = Object.keys(hits);
  return keys.length === 1 ? keys[0] : null;
}

// SQL에서 시간 버킷 단위 추출 — ROLLUP('X',...) 또는 DATE_TRUNC('X',...)의 첫 단위. 없으면 null(버킷 없는 쿼리).
function detectSqlBucketUnit(sql) {
  var m = String(sql || '').match(/(?:ROLLUP|DATE_TRUNC)\s*\(\s*'([a-z]+)'/i);
  return m ? m[1].toLowerCase() : null;
}

// (도구 인자) 안정 시그니처 — 최상위 키를 정렬해 직렬화(동일 호출 반복 감지용). 실패 시 문자열 폴백.
function safeArgSig(args) {
  try {
    if (!args || typeof args !== 'object') return String(args);
    var keys = Object.keys(args).sort();
    var o = {};
    for (var i = 0; i < keys.length; i++) o[keys[i]] = args[keys[i]];
    return JSON.stringify(o);
  } catch (e) { return String(args); }
}

// Ollama 약한 모델이 가끔 답변에 한자/중국어를 누출(Role의 "한자 금지" 위반) → 흔한 도메인 용어를 결정론적 치환.
// 삭제는 문장을 깨뜨리므로 치환만 함. 맵에 없는 한자는 남되 경고 로그로 남겨 맵을 키운다. (긴 키 먼저 = 부분치환 방지)
var HAN_MAP = [
  ['成交量', '거래량'], ['波动性', '변동성'], ['传感器', '센서'], ['开盘', '시가'], ['收盘', '종가'],
  ['最高', '최고'], ['最低', '최저'], ['最大', '최대'], ['最小', '최소'], ['平均', '평균'],
  ['价格', '가격'], ['时间戳', '타임스탬프'], ['时间', '시간'], ['分析', '분석'], ['数据源', '데이터소스'], ['数据', '데이터'], ['趋势', '추세'],
  ['波动', '변동'], ['设备', '디바이스'], ['温度', '온도'], ['振动', '진동'], ['图表', '차트'],
  ['报告', '보고서'], ['统计', '통계'], ['日期', '날짜'], ['总量', '총량'],
  ['来源', '소스'], ['输出', '출력'], ['输入', '입력'], ['转换', '변환'], ['查询', '쿼리'], ['函数', '함수'],
  ['制造商', '제조사'], ['信息', '정보'], ['单位', '단위'], ['描述', '설명'], ['属性', '속성'], ['字段', '필드'], ['例如', '예를 들어'], ['等等', '등'], ['等', '등'],
  // 금융/리포트 답변에서 흔히 새는 상용 표현. 3글자→2글자→1글자 순으로 두어 부분치환 방지.
  ['可适当', '적절히'], ['适当', '적절히'], ['交易日', '거래일'], ['交易', '거래'], ['成交', '거래'], ['指标', '지표'], ['风险', '리스크'], ['投资', '투자'],
  ['资产', '자산'], ['市场', '시장'], ['建议', '권고'], ['收益', '수익'], ['波幅', '변동폭'], ['支撑', '지지'], ['阻力', '저항'],
  // 모니터링/대시보드 답변·차트 제목에서 새는 표현
  ['使用率', '사용률'], ['日均', '일평균'], ['内存', '메모리'], ['状态', '상태'], ['错误', '오류'],
  ['请求', '요청'], ['响应', '응답'], ['连接', '연결'], ['服务', '서비스'], ['数量', '개수'],
  // 누출 경고 로그·라이브 답변에서 수집된 표현. '的'는 조사라 어떤 단어 뒤에도 붙을 수 있어 맨 뒤 단독 폴백.
  ['从现在起', '지금부터'], ['毫秒', '밀리초'], ['的差异', '의 차이'], ['差异', '차이'],
  ['육眼', '육안'], ['眼前', '눈앞'], ['眼', '안'], ['前', '전'], ['的', '의']
];
// 약한 모델이 문서 도구의 재호출 안내문("section=를 사용해 조회하세요" 등)을 사용자 조언으로 에코하는
// 내부 노출을 결정론적으로 제거. 줄 통삭제는 "관련 섹션: A, B (section=으로 조회 가능)" 같은 유용한 줄까지
// 먹으므로 ① 괄호 꼬리만 외과적으로 제거 → ② 그래도 토큰이 남는 줄만 삭제. 코드펜스 안은 보존.
var TOOL_INTERNALS_RE = /section\s*=|file_identifier|search_documents|get_full_document_content|get_document_sections|extract_code_blocks|list_available_documents|이 문서의 주요 섹션|이 문서의 다른 섹션/;
var TOOL_INTERNALS_PAREN_RE = /\s*[(（][^()（）]*(?:section\s*=|file_identifier|search_documents|get_full_document_content|get_document_sections|extract_code_blocks|list_available_documents)[^()（）]*[)）]/g;
function stripToolInternals(text) {
  if (!text) return text;
  var lines = String(text).split('\n');
  var out = [], inFence = false, removed = 0;
  for (var i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) inFence = !inFence;
    var line = lines[i];
    if (!inFence && TOOL_INTERNALS_RE.test(line)) {
      line = line.replace(TOOL_INTERNALS_PAREN_RE, ''); // 괄호 꼬리 "(section=으로 조회 가능)" 류만 제거
      if (TOOL_INTERNALS_RE.test(line)) { removed++; continue; } // 여전히 남으면 순수 도구 안내 줄 → 삭제
    }
    out.push(line);
  }
  if (removed) console.println('[Agent] 도구 내부 노출 ' + removed + '줄 제거(stripToolInternals)');
  return out.join('\n');
}

// DocLookup 답변에서 내부 문서 경로(.md) 노출 줄 제거 — "이 예제는 tql/tql-guide.md에 실제로 존재합니다"류
// 자기증명 메타 문장 대응. 문서 조회 답변에서 .md 경로는 항상 내부 식별자다. 코드펜스 안은 보존.
function stripDocPathLines(text) {
  if (!text) return text;
  var lines = String(text).split('\n');
  var out = [], inFence = false, removed = 0;
  for (var i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) inFence = !inFence;
    if (!inFence && /\.md\b/.test(lines[i])) { removed++; continue; }
    out.push(lines[i]);
  }
  if (removed) console.println('[Agent] 문서 경로 노출 ' + removed + '줄 제거(stripDocPathLines)');
  return out.join('\n');
}

// 제품명 한국어 오표기 결정론적 정정 — 모델이 Machbase를 "마하베이스"로 잘못 음역하는 것을 "마크베이스"로.
// (강한 모델도 이 음역 실수를 하므로 ollama 한정이 아닌 전 프로바이더 후처리. 정상 표기·영문은 통과.)
function normalizeProductName(s) {
  if (!s) return s;
  return s.split('마하베이스').join('마크베이스').split('마하 베이스').join('마크베이스');
}

// Ollama 약한 모델이 마크다운 목록 골격을 깨뜨려 내보내는 것을 결정론적으로 복원 — 의미 변경 없이 공백·줄바꿈만 손댄다.
// ① "6.경쟁"처럼 번호 뒤 공백 누락(marked·mdToHTML 모두 목록으로 인식 못 함)
// ② "…있습니다. - 실행방안: …"처럼 하위 불릿이 줄바꿈 없이 문장 뒤에 이어짐 → 줄 분리
// ③ 문단에 바로 붙은 번호 목록 앞 빈 줄 삽입(1. 외 시작번호는 문단을 목록으로 못 끊는 GFM 규칙)
// 코드펜스 안·표 행(| 포함, 셀에 '- '류가 흔함)·인라인코드는 건드리지 않는다. 소수점(3.14)·절 번호(3.5)는 뒤가 숫자라 제외.
function reflowMarkdown(s) {
  if (!s) return s;
  var lines = String(s).split('\n');
  var out = [], inFence = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line); continue; }
    if (inFence || line.indexOf('|') >= 0) { out.push(line); continue; }
    var codes = [];
    line = line.replace(/`[^`]*`/g, function (m) { codes.push(m); return '\u0000' + (codes.length - 1) + '\u0000'; });
    // ② 문장 끝 부호 뒤에 이어진 "- " 불릿을 줄로 분리 ("-5도" 같은 음수는 대시 뒤 공백이 없어 미매치)
    line = line.replace(/([.:!?])[ \t]+- (?=\S)/g, '$1\n- ');
    // ② 변형: 부호 없이 "라벨:"로 이어진 불릿("… 설정 필수 - 기대효과: …")도 분리 — 라벨은 한글/영문만
    // (숫자 라벨 제외 → "9:00 - 10:30" 같은 시간 범위 오탐 차단)
    line = line.replace(/([가-힣A-Za-z0-9%)\]]) - ([가-힣A-Za-z]{1,10}): (?=\S)/g, '$1\n- $2: ');
    // 문장 끝 마침표 뒤에 공백 없이 이어진 번호 항목("…다. 6.경쟁")을 문단으로 분리
    line = line.replace(/\.[ \t]+(\d{1,2})[.)](?=[가-힣A-Za-z*(])/g, '.\n\n$1. ');
    // 부호 없이 끝난 문장 뒤의 번호 항목("…수익 극대화 2.기술적")도 분리 — 단 "그림 2.개요" 같은 캡션 지칭은 유지
    line = line.replace(/([가-힣]{1,4})[ \t]+(\d{1,2})\.(?=[가-힣])/g, function (m, w, n) {
      if (/^(그림|도표|차트|사진|표|절|장|항|조)$/.test(w)) return m;
      return w + '\n\n' + n + '. ';
    });
    // ① 줄 시작(분리로 생긴 줄 포함) 번호 뒤 공백 누락 보정
    line = line.replace(/(^|\n)(\d{1,2})\.(?=[가-힣A-Za-z*(])/g, '$1$2. ');
    line = line.replace(/\u0000(\d+)\u0000/g, function (_, n) { return codes[parseInt(n, 10)]; });
    var parts = line.split('\n');
    for (var p = 0; p < parts.length; p++) {
      var part = parts[p];
      // ③ 직전 줄이 목록 항목이 아닌 문단이면 번호 목록 앞에 빈 줄
      if (/^\d{1,2}\. /.test(part)) {
        var prev = out[out.length - 1];
        if (prev && prev.trim() && !/^\s*(\d{1,2}[.)]|[-*])\s/.test(prev)) out.push('');
      }
      // ④ 번호 항목에 바로 붙은 불릿은 하위 항목으로 3칸 들여쓰기 (빈 줄로 떨어진 불릿은 별개 목록으로 존중,
      //    단 이미 들여쓴 하위 불릿의 연속이면 빈 줄 하나 건너서도 이어 들여쓴다)
      if (/^[-*] /.test(part)) {
        var last = out[out.length - 1];
        if (last !== undefined && (/^\d{1,2}[.)] /.test(last) || /^\s{2,}[-*] /.test(last) ||
            (!last.trim() && /^\s{2,}[-*] /.test(out[out.length - 2] || '')))) {
          part = '   ' + part;
        }
      }
      out.push(part);
    }
  }
  return out.join('\n');
}

// 리포트 본문류 장문 필드만 목록 골격 복원 — 제목/식별자 필드는 줄바꿈이 생기면 안 되므로 제외.
var MD_ARG_FIELDS = ['analysis', 'recommendations'];
function reflowMarkdownInArgs(o) {
  if (!o || typeof o !== 'object') return;
  for (var i = 0; i < MD_ARG_FIELDS.length; i++) {
    var f = MD_ARG_FIELDS[i];
    if (typeof o[f] === 'string' && o[f]) o[f] = reflowMarkdown(o[f]);
  }
}

function normalizeHan(s) {
  if (!s) return s;
  for (var i = 0; i < HAN_MAP.length; i++) s = s.split(HAN_MAP[i][0]).join(HAN_MAP[i][1]);
  var leftover = s.match(/[一-鿿]/g);
  if (leftover) console.println('[Agent] ⚠ 미치환 한자 누출: ' + leftover.join('') + ' (HAN_MAP 추가 검토)');
  return s;
}

// 한자 누출은 답변만이 아니라 도구 인자로도 새어 저장물(대시보드 차트 제목·리포트 본문)에 박힌다 —
// 최종답변 normalizeHan은 저장물엔 안 닿으므로 실행 전 인자에서 정규화. 제목·본문류 필드만 손대고
// SQL/TQL·테이블/태그/파일명 인자는 중문 식별자가 실데이터일 수 있어 제외. 선택자(panel_title)도
// 기존 저장물의 제목과 매칭돼야 하므로 제외.
var HAN_ARG_FIELDS = ['title', 'subtitle', 'chart_title', 'new_title', 'analysis', 'recommendations'];
function normalizeHanInArgs(o) {
  if (!o || typeof o !== 'object') return;
  for (var i = 0; i < HAN_ARG_FIELDS.length; i++) {
    var f = HAN_ARG_FIELDS[i];
    if (typeof o[f] === 'string' && /[一-鿿]/.test(o[f])) o[f] = normalizeHan(o[f]);
  }
  if (Array.isArray(o.charts)) for (var j = 0; j < o.charts.length; j++) normalizeHanInArgs(o.charts[j]);
  normalizeHanInArgs(o.spec);    // compile_tql_from_spec: spec.output.title/subtitle
  normalizeHanInArgs(o.output);
}

// 한국어 금융 태그 별칭 — 사용자가 "종가 예측해줘"처럼 한글로 태그를 지칭하면 영문 태그가 질문에 없어도
// 정당한 지정으로 인정한다(강한 모델의 올바른 별칭 매핑을 교정이 되돌리지 않게). 일반 센서 태그는 영문
// 그대로 입력되므로 substring 매치로 충분.
var FC_TAG_ALIASES = { '종가': 'close', '시가': 'open', '고가': 'high', '저가': 'low', '거래량': 'volume' };

// forecast_table 인자 교정: 질문에 없는 tag/tags 제거(전부 없으면 도구 자동결정, 일부만 언급이면 그것만 유지).
// spec(객체/JSON 문자열)과 최상위 인자 둘 다 본다 — forecast.js assemble()이 둘 다 읽기 때문.
// 한계(수용): "그 태그로 예측해줘" 같은 대명사 지칭은 질문에 태그명이 없어 전체 예측으로 넘어간다 —
// 임의 축소(엉뚱한 태그 1개)보다 과잉 제공(요청 태그 포함 전체)이 낫다는 판단.
function normalizeForecastTags(agent, args) {
  var q = String(agent.currentQuery || '').toLowerCase();
  if (!q) return;
  function mentioned(tag) {
    var t = String(tag).toLowerCase();
    if (q.indexOf(t) >= 0) return true;
    for (var k in FC_TAG_ALIASES) {
      if (FC_TAG_ALIASES[k] === t && q.indexOf(k) >= 0) return true;
    }
    return false;
  }
  function filterHolder(holder) {
    if (!holder || typeof holder !== 'object') return false;
    var given = [];
    if (Array.isArray(holder.tags) && holder.tags.length) given = holder.tags.map(String);
    else if (holder.tag != null && String(holder.tag).trim() !== '') {
      given = String(holder.tag).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    }
    if (!given.length) return false;
    var asked = [];
    for (var i = 0; i < given.length; i++) { if (mentioned(given[i])) asked.push(given[i]); }
    if (asked.length === given.length) return false; // 전부 사용자가 말한 태그 → 그대로
    delete holder.tag; delete holder.tags;
    if (asked.length === 1) holder.tag = asked[0];
    else if (asked.length > 1) holder.tags = asked;
    console.println('  \\- FIX: forecast_table 태그 교정 — 질문에 없는 태그 제거(' + given.join(',') + ' → ' +
      (asked.length ? asked.join(',') : '도구 자동결정') + ')');
    return true;
  }
  var sp = args.spec, isStr = typeof sp === 'string';
  if (isStr) { try { sp = JSON.parse(sp); } catch (e) { sp = null; } }
  if (filterHolder(sp) && isStr) args.spec = JSON.stringify(sp);
  filterHolder(args); // 최상위 tag/tags(assemble이 spec에 없으면 여기서 승계)
}

// 이번 쿼리에서 모델이 마지막으로 describe_table/list_table_tags 한 테이블명 — 예측 호출 강제 유도 문구에 사용.
// (질문이 "실버"처럼 한글이면 질문 파싱은 불가 — 모델이 이미 해석해 도구 인자로 넘긴 영문 테이블명이 정답이다.)
// ⚠️ 앵커는 **포함 매치**여야 한다: 실제 user 메시지엔 스킬 힌트가 덧붙어 `content === currentQuery`가 절대 성립 안 함.
//    등호 매치 시절엔 앵커 실패 → start=0 → 세션 전체 스캔 → **이전 질문의 테이블**(SILVER)을 집어 엉뚱한 예측을
//    강제한 실사례("진동 예측해줘"에 실버 재예측). 앵커를 못 찾으면 통째로 포기('')하고 일반 문구로 유도한다.
function lastDescribedTable(agent) {
  var msgs = agent.messages, start = -1, i, j;
  var q = String(agent.currentQuery || '');
  for (i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && q && String(msgs[i].content || '').indexOf(q) >= 0) { start = i; break; }
  }
  if (start < 0) return ''; // 현재 질문 메시지를 못 찾으면 전체 스캔 금지(이전 질문 테이블 오채택 방지)
  var name = '';
  for (i = start; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (j = 0; j < m.toolCalls.length; j++) {
      var fn = m.toolCalls[j].function;
      if (!fn || (fn.name !== 'describe_table' && fn.name !== 'list_table_tags')) continue;
      var a = fn.arguments;
      if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = null; } }
      var t = a && (a.table_name || a.table);
      if (t) name = String(t).toUpperCase(); // 뒤에 나온 것(최신)을 채택
    }
  }
  return name;
}

// 리포트 저장이 아직 안 됐는데(reportSavePending) 재유도 캡까지 실패해 폴백에 도달한 경우의 최종 정화.
// 이 상태에서 답변에 있는 http(s) 링크·URL은 전부 위조(실제 저장이 없었으니 진짜 URL은 존재하지 않음) → 제거하고,
// 저장 실패를 사용자에게 정직하게 고지. 코드펜스 안(예제 URL 등)은 건드리지 않는다.
function stripFabricatedReportSave(text) {
  if (!text) return text;
  var lines = String(text).split('\n');
  var out = [], inFence = false, stripped = false;
  for (var i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) { inFence = !inFence; out.push(lines[i]); continue; }
    if (inFence) { out.push(lines[i]); continue; }
    var line = lines[i];
    if (/\]\(https?:\/\//.test(line) || /https?:\/\//.test(line)) {
      line = line.replace(/\[([^\]]*)\]\(https?:\/\/[^)]*\)/g, '$1'); // [텍스트](url) → 텍스트
      line = line.replace(/https?:\/\/\S+/g, '');                     // 남은 맨 URL 제거
      stripped = true;
    }
    out.push(line);
  }
  var result = out.join('\n');
  if (stripped) console.println('[Agent] 리포트 미저장 상태의 위조 URL 제거(stripFabricatedReportSave)');
  result += '\n\n> ⚠️ 리포트 파일이 실제로 저장되지 않았습니다. 위 본문의 링크/URL은 유효하지 않습니다. "리포트 저장"을 다시 요청해 주세요.';
  return result;
}

// 약한 모델이 코드블록 닫는 펜스(```)를 빠뜨려 두 블록이 병합되는 걸 복구 — 안 닫힌 ```tql 블록을 자동으로 닫음.
// (병합되면 "Run" 실행 시 ```tql 마크다운이 TQL에 섞여 컴파일 에러: "near `tql". 각 블록이 제대로 닫히면 각각 실행됨.)
function balanceFences(text) {
  if (!text) return text;
  // 안전장치: 펜스(```) 줄 수가 짝수면 균형(well-formed)으로 보고 손대지 않음 — 정상 답변 오손상 방지.
  // 홀수(닫는 펜스 누락 = 명백히 깨짐)일 때만 복구.
  if (((text.match(/^\s*```/gm) || []).length % 2) === 0) return text;
  var lines = text.split('\n'), out = [], inBlock = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\s*```/.test(line)) {
      var isOpen = /^\s*```[\w-]+\s*$/.test(line);          // ```tql 등 (lang 있음)
      if (!inBlock) { out.push(line); inBlock = true; }       // 블록 열기
      else if (isOpen) { out.push('```'); out.push(line); }   // 이전 블록 안 닫힘 → 닫고 새로 염
      else { out.push(line); inBlock = false; }               // bare ``` → 닫기
    } else out.push(line);
  }
  if (inBlock) out.push('```');                               // 끝까지 안 닫힘 → 닫음
  return out.join('\n');
}

// top-level 콤마로 분리(괄호 안 콤마는 무시) — ROLLUP('hour',1,TS) 같은 함수 내부 콤마 보호용.
function splitTopLevelCommas(s) {
  var parts = [], depth = 0, cur = '';
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
// SQL 정규화: 공백 축약·대문자화 + SELECT 컬럼을 정렬(순서차 흡수). 같은 태그·WHERE·집계면 컬럼순서만 달라도 같은 키.
function normalizeSqlKey(q) {
  q = q.replace(/\s+/g, ' ').trim().toUpperCase();
  var m = q.match(/^SELECT\s+([\s\S]*?)\s+FROM\s+([\s\S]*)$/i);
  if (!m) return q;
  var cols = splitTopLevelCommas(m[1]); cols.sort();
  return 'SELECT ' + cols.join(', ') + ' FROM ' + m[2];
}
// Ollama 약한 모델이 답변에 "사실상 같은 차트"의 ```tql 블록을 여러 번 중복 생성(차트 꾸밈·컬럼순서만 바꿔 재탕) → 제거.
// SQL 쿼리를 컬럼순서까지 정규화해 비교 → 같으면 첫 블록만 남김. SQL이 진짜 다르거나 없으면 유지. 결정론적.
function dedupeTqlBlocks(text) {
  if (!text) return text;
  var seen = {};
  var out = text.replace(/```([\w-]*)\r?\n([\s\S]*?)```/g, function (full, lang, body) {
    var m = body.match(/SQL\(\s*`([\s\S]*?)`\s*\)/i);
    if (!m) return full;                                  // SQL 없는 블록은 유지
    var key = normalizeSqlKey(m[1]);
    if (seen[key]) return '';                             // 사실상 같은 차트 재탕 → 제거
    seen[key] = true;
    return full;
  });
  return out.replace(/\n{3,}/g, '\n\n');                  // 제거로 생긴 과도한 빈 줄 정리
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
