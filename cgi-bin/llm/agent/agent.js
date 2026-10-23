var process = require('process'); // jsh에선 process가 전역이 아님 → 명시적 require (catalog 로드의 process.cwd()용)
var { createMessage } = require('../llm/types');
var { createBuilder } = require('../context/builder');
var { listReportTemplates, matchCustomByQuery, matchBuiltinByQuery } = require('../tools/report_templates');
var { createRegistry: createSkillRegistry } = require('../skill/skill');
var { createFixerContext, fix, fixDashboardTime, captureResults } = require('../fixer/fixer');
var { parseTimeRange, parseQuestionTime, buildSkillHint, compactHistory, inferTableName } = require('./classifier');
var security = require('../tools/security');
var { bareSelectCols } = require('../tools/sql'); // 버킷 GROUP BY + bare VALUE 실행 전 차단용
var { parseAmbiguity, resolveTableRef, countRollups } = require('../tools/table_access'); // 테이블 이름 모호 → 사용자 선택 질문 전환용
var docIntent = require('./doc_intent');
var { wallTime, utcLabel, serverOffset, userZone } = require('../machbase/timezone');

var { createPipeline, internalUserMessage, isTruncatedToolCall, noteTruncation, TRUNCATION_CAP } = require('../guard/guard');
var ConsecutiveFailureGuard = require('../guard/consecutive_failure');
var DashboardEarlyGuard = require('../guard/dashboard_early');
var ChartOmissionGuard = require('../guard/chart_omission');
var ReportOmissionGuard = require('../guard/report_omission');
var RedundantFinalizeGuard = require('../guard/redundant_finalize');
var DashboardAnswerGuard = require('../guard/dashboard_answer');
var FakeTqlAnswerGuard = require('../guard/fake_tql_answer');
var DashboardOmissionGuard = require('../guard/dashboard_omission');
var RawTqlGuard = require('../guard/raw_tql');
var AppliedBasisGuard = require('../guard/applied_basis');
var TqlOmissionGuard = require('../guard/tql_omission');
var ForecastLabelGuard = require('../guard/forecast_label');
var DocIndexAnswerGuard = require('../guard/doc_index_answer');

var MAX_STEPS = 60;
var COMPILE_FAIL_CAP = 6; // compile·예측이 이만큼 연속 실패하면 결정론적으로 더 실행 안 함(무한루프 하드캡)
var DOC_EXAMPLE_CAP = 3;  // DocLookup 예제요청 시 compile_tql_from_spec 최대 개수(과잉생성·num_predict 초과 truncation 방지)
var DOC_READ_CAP = 8;     // DocLookup 문서 조회(get_full_document_content 등) 최대 횟수(과잉탐색 degeneration 차단, 설치 6문서 정당조회는 통과)
var FAILED_SECTION_CAP = 3; // 존재하지 않는 섹션(한국어명 헛짚기 등) 조회 하드캡. 실패는 새 내용 0이라 DOC_READ_CAP 예산을 안 먹되(되돌림), 무한 추측은 이 캡이 끊음
var LLM_ERROR_RETRIES = 2; // LLM 호출 실패(ollama 간헐적 tool_call XML 파싱오류 HTTP500·일시 네트워크) 시 같은 step 재시도 횟수
var TRUNC_RETRY_PREDICT = 2048; // 도구 인자 잘림 뒤 재시도의 출력 상한 — 또 반복해도 기본(4096)의 절반 시간에 끊김
var TRUNC_RECOVERY_TEMP = 0.5;  // 잘림 뒤 이 질문의 온도 — 온도 0으로 돌아가면 같은 반복에 다시 빠짐
var REPEAT_CALL_CAP = 2;  // 같은 도구+같은 인자를 이만큼 실행한 뒤 또 부르면 차단(스텁 문서 무한 재조회 등 degeneration 하드캡)
var REPEAT_BLOCK_CAP = 3; // 반복 차단이 이만큼 쌓이면 도구 없이 답변 강제(차단만 무한반복하며 step 소진하는 것 방지)
var SQL_RUN_CAP = 8;      // 한 질문의 execute_sql_query 실행 상한(ollama) — 인자만 바꿔 반복하면 같은 호출 상한에 안 걸림
var FINALIZE_ROUND_CAP = 3; // 완성(dashboardFinalized) 후 도구 없는 답변 강제 LLM 라운드 상한 — 모델이 넛지를 무시하고 공회전하면 URL 폴백으로 결정론 종료
var SCHEMA_LOOP_TOOLS = { describe_table: 1, list_tables: 1, list_table_tags: 1 }; // 스키마 확인 도구 — 데이터질문서 이것만 반복하면 execute_sql_query로 넘어가야 할 신호
var SCHEMA_LOOP_NUDGE_CAP = 2; // 스키마도구 반복 시 "execute 실행하라" 콕집어 유도 최대 횟수(초과 시 일반 반복차단 경로로 폴백)
var UNIT_MISMATCH_CAP = 2; // 질문 시간단위(주 단위 등) vs SQL 버킷단위(day 등) 불일치 시 재작성 유도 최대 횟수(초과 시 통과 — 무한루프 방지)
var REPORT_SAVE_NUDGE_CAP = 2; // save_html_report 1차(데이터조회) 후 2차 저장호출을 안 하고 완료 위조 시, 재호출 강제 유도 최대 횟수
var FORECAST_CALL_NUDGE_CAP = 2; // 예측 의도 질문(CodeExec)에서 forecast_table을 안 부르고 되묻기/답변 종료 시, 호출 강제 유도 최대 횟수
var FORECAST_SHORTAGE_CAP = 2;   // forecast_table "전 태그 데이터 부족"이 이 횟수면 추가 호출 차단 — 약한 모델이 rollup만 바꿔가며 재시도하는 루프 방지(인자가 달라 REPEAT_CALL_CAP에 안 걸림)
// 예측 의도 키워드 — CodeExec 스킬 게이트와 결합해야 순수 예측 요청만 잡힘
var FORECAST_INTENT_RE = /예측|forecast|predict|예상|전망|향후|미래\s*값|extrapolat/i;
// "선언 후 미실행" 감지(ollama) — 조회를 미래형으로 예고("~하겠습니다/할 것입니다")만 하고 미실행
// · 조회/가져올/추출/쿼리 + 미래형만 — 리포트 서술("분석하겠습니다") 오탐 방지
var ANNOUNCE_NO_ACTION_RE = /(조회하겠|조회할 것|가져오겠|가져올 것|추출하겠|추출할 것|불러오겠|쿼리로 가져|select[^.\n]{0,40}(가져|조회|실행))/i;
// 질문에 "기간"이 명시됐는지 감지 — 있으면 TIME 필터가 정당(today-filter 교정 힌트 미발동). "시간별"처럼 버킷단위는 범위 아님(숫자+단위만 인정).
var TIME_RANGE_RE = /(오늘|어제|그제|내일|모레|최근|요새|지난|저번|이번|작년|올해|금년|이달|당일|당월|처음|마지막|최신|\d{4}\s*년|\d{1,2}\s*월|\d{4}-\d{1,2}|\d+\s*(일|주일?|개월|달|년|시간|분|초)\s*(전|간|동안|이내|이후|이전)?|기간|부터|까지|사이|이후|이전|이래|동안|범위)/;

// · mc는 가드가 DB를 확인할 때 씀(없으면 확인 생략)
function createAgent(llmClient, registry, mc) {
  var agent = {
    llm: llmClient,
    registry: registry,
    mc: mc || null,
    messages: [],
    maxSteps: MAX_STEPS,
    skillName: '',
    toolDefs: null,
    docCatalog: '',
    advanced: false,
    reportMode: false,
    cancelled: false,
    // 대시보드 완성(create_dashboard_with_charts 성공) 후 같은 쿼리 내 추가 차트 생성 차단 플래그 — 도구 실행 레벨 차단
    // · 쿼리마다 리셋 → 후속 "차트 추가해줘" 허용
    dashboardFinalized: false,
    // compile·예측 연속 실패 횟수. COMPILE_FAIL_CAP 도달 시 결정론적으로 추가 compile 차단(무한 거부루프 하드캡).
    compileFailStreak: 0,
    fixerCtx: createFixerContext(),
    guard: createPipeline(
      [ConsecutiveFailureGuard, DashboardEarlyGuard, RedundantFinalizeGuard],
      [DashboardOmissionGuard, ChartOmissionGuard, ReportOmissionGuard, DashboardAnswerGuard, TqlOmissionGuard,
       ForecastLabelGuard, DocIndexAnswerGuard, RawTqlGuard, FakeTqlAnswerGuard, AppliedBasisGuard]
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
  // LLM 실행 전 결정론 보안 차단 — 자격증명·서버제어·셸·설정파일·프롬프트 유출·변경 SQL 요청 거절
  // · 공격 형태만 대상, 정상 사용법·기능 질문은 통과
  // · 특권 계정/자격증명 관리 → 콘솔 안내형 거절
  var _refusal = security.screenQuery(query);
  if (_refusal) {
    return cb(null, _refusal);
  }
  agent.dashboardFinalized = false; // 새 쿼리 시작 → 이전 쿼리의 대시보드 완성 상태 해제 (후속 차트 추가 허용)
  agent.compileFailStreak = 0;      // 새 쿼리 시작 → 연속 실패 카운터 리셋
  agent.currentQuery = query;       // 리포트 커스텀 쿼리-라우팅용(executeToolCalls에서 사용)
  agent.fixerCtx.questionTime = parseQuestionTime(query); // 컴파일 도구의 기간·단위 우선순위 판정용
  agent.fixerCtx.question = query;                        // 컴파일 도구의 질문 태그 강제용
  agent._finalizeNudged = false;    // 완성 가드: 이번 턴 "보고서 작성" 지시 주입 여부(1회용)
  agent._finalizeResult = '';       // 완성 가드: 마무리 도구 결과(URL 포함) — 빈 보고서 폴백용
  agent._lastTableList = '';        // list_tables 표 원본 — 답변에 다시 붙은 표를 지우는 기준
  agent._finalizeRounds = 0;        // 완성 후 강제답변 LLM 라운드 수(FINALIZE_ROUND_CAP 공회전 하드캡용)
  agent._activeTools = null;        // 이번 LLM 호출 도구 목록(가드 재유도용) — 첫 호출 전엔 전체 도구
  agent._dashOmissionPrompts = 0;   // 대시보드 누락 가드 재유도 횟수(질문당 상한용)
  agent.reportSavePending = false;  // save_html_report 1차 호출(데이터조회)만 되고 실제 파일 저장(2차 호출)이 아직 안 된 상태
  agent._reportSaveNudges = 0;      // 저장 재호출 강제 유도 누적 횟수(REPORT_SAVE_NUDGE_CAP 상한)
  agent._forecastCalled = false;    // 이번 쿼리에서 forecast_table을 시도했는지(성공·도구 되묻기·에러 무관) — 되묻기 가드 전제
  agent._forecastCallNudges = 0;    // 예측 의도인데 미호출 답변 시 호출 강제 유도 누적 횟수(FORECAST_CALL_NUDGE_CAP 상한)
  agent._forecastShortages = 0;     // forecast_table "전 태그 데이터 부족" 누적(FORECAST_SHORTAGE_CAP 도달 시 추가 호출 차단)
  agent.docExampleCompiles = 0;     // DocLookup 예제 생성 개수(DOC_EXAMPLE_CAP 하드캡용)
  agent._docExampleCapped = false;  // DocLookup 예제 상한 도달(ollama) — raw_tql 가드 문구 분기용
  agent._rawTqlPrompts = 0;         // raw_tql 가드 재유도 횟수(질문당 상한)
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
  agent._sqlRuns = 0;               // 이번 쿼리의 execute_sql_query 실행 횟수(SQL_RUN_CAP 상한용)
  agent._repeatForceAnswer = false; // 반복 교착 → 도구 제거 답변 강제 플래그
  agent._schemaLoopNudges = 0;      // 스키마도구(describe/list) 반복 시 execute 실행 유도 횟수(SCHEMA_LOOP_NUDGE_CAP 상한)
  agent._unitMismatchNudges = 0;    // 질문단위 vs SQL버킷단위 불일치 재작성 유도 횟수(UNIT_MISMATCH_CAP 상한)
  agent._multiTagNudged = false;    // 다중 태그 합산집계(GROUP BY NAME 누락) 재작성 유도 1회 플래그
  agent._bareValueNudges = 0;       // 버킷 GROUP BY + bare VALUE(임의 행 값 반환) 재작성 유도 횟수(UNIT_MISMATCH_CAP 상한)
  agent._lastQueryHadRows = false;  // 마지막 execute_sql_query가 실데이터 행을 반환했는지(숫자 없는 답변 재촉용)
  agent._noNumbersNudged = false;   // 데이터 있는데 답변에 숫자 0개 → 수치 포함 재작성 재촉 1회 플래그
  agent._forceExecNudged = false;   // 반복교착 강제답변에서 execute_sql_query만 남길 때 실행 지시 1회 플래그
  agent._llmErrorRetries = 0;       // LLM 호출 실패 재시도 카운터(LLM_ERROR_RETRIES 상한)
  agent._truncations = 0;           // 도구 인자 잘림 횟수(TRUNCATION_CAP 도달 시 도구 없이 답변 강제)
  agent._truncStreak = 0;           // 성공 호출 없이 연달아 잘린 횟수
  agent._truncForceAnswer = false;  // 잘림 반복 → 도구 제거 답변 강제 플래그
  agent._truncNudged = false;       // 잘림 답변 강제 지시 1회 플래그
  agent._tableClarify = null;       // 테이블 이름 모호 감지 결과 { table, candidates } — 설정되면 선택 질문으로 턴 종료
  if (agent.llm.type === 'ollama' && agent.llm.temperature !== 0) agent.llm.temperature = 0; // 이전 턴 재시도 온도 잔재 원복
  restoreNumPredict(agent);         // 이전 턴 잘림 재시도 출력 상한 잔재 원복
  if (agent.messages.length === 0) {
    initMessages(agent, query, function () {
      runLoop(agent, 0, cb);
    });
  } else {
    continueMessages(agent, query);
    runLoop(agent, 0, cb);
  }
}

// Report 스킬 프롬프트용 리포트 템플릿 목록(빌트인 + 설치 커스텀) — 주제 맞는 커스텀(C-*) 우선 선택용
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

// 분 차이 → "13시간을 더한"·"5시간 30분을 뺀"
function shiftPhrase(diffMin) {
  var a = Math.abs(diffMin), h = Math.floor(a / 60), m = a % 60;
  return (h ? h + '시간' : '') + (h && m ? ' ' : '') + (m ? m + '분' : '') + (diffMin > 0 ? '을 더한' : '을 뺀');
}

function buildSystemPrompt(agent, activeSkill) {
  var isOllama = (agent.llm.type === 'ollama');
  var builder = createBuilder();
  if (isOllama) builder.setOllama();
  if (!activeSkill.skipCore) { builder.addCore(); } else { builder.addSegment('Role'); }
  if (activeSkill.workflows && activeSkill.workflows.length > 0) builder.addWorkflow.apply(builder, activeSkill.workflows);
  if (activeSkill.toolGroups && activeSkill.toolGroups.length > 0) builder.addToolPrompts.apply(builder, activeSkill.toolGroups);
  // 문서 카탈로그 주입 — ollama는 search_documents 허용 스킬에만(프리필·희석 감소), 그 외 모델은 항상
  var skillUsesCatalog = !activeSkill.allowTools || activeSkill.allowTools.indexOf('search_documents') >= 0;
  if (agent.docCatalog && (!isOllama || skillUsesCatalog)) {
    // ollama는 경량본(path+제목만) — 키워드 열은 search_documents가 디스크에서 읽음
    builder.setCatalog(isOllama ? leanCatalog(agent.docCatalog) : agent.docCatalog);
  }
  var prompt = builder.build();
  // 현재 시각 — 사용자 시간대 기준
  // · 날짜 문자열(TO_DATE)은 서버 시간대로 해석되므로 사용자 시간대와 다르면 차이를 알림
  var zone = agent.zone || userZone(null);
  var serverOff = serverOffset();
  var userOff = zone.offsetMin == null ? serverOff : zone.offsetMin;
  prompt += '\n\n현재 날짜/시간: ' + wallTime(Date.now(), zone.offsetMin) + ' (시간대: ' + zone.label + ')' +
    (userOff === serverOff
      ? '\nTO_DATE(\'YYYY-MM-DD HH:MI:SS\') 같은 날짜 문자열은 이 시간대로 해석되고, 조회 결과 시각도 이 시간대로 표시됩니다.'
      : '\n조회 결과 시각은 이 시간대로 표시됩니다. 단 TO_DATE(\'YYYY-MM-DD HH:MI:SS\') 같은 날짜 문자열은 서버 시간대(' + utcLabel(serverOff) + ')로 해석되므로, 사용자 시각을 넣을 땐 ' + shiftPhrase(serverOff - userOff) + ' 서버 시각으로 쓰세요.') +
    '\n시간 범위를 임의로 추측하지 마세요. 반드시 SELECT MIN(TIME), MAX(TIME) FROM 테이블 (timeformat="ms")로 실제 데이터 범위를 먼저 조회하세요.';
  if (activeSkill.workflows && activeSkill.workflows.indexOf('HTMLReportWorkflow') >= 0) {
    prompt += buildReportTemplateList();
  }
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
// 직전 답변이 테이블 선택 질문인지 — 그 답은 새 질문이 아니라 이어지는 대화로 처리
function lastAnswerIsTableClarify(messages) {
  for (var i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return !!messages[i]._tableClarify;
  }
  return false;
}
// 테이블 선택 질문 문구
function tableClarifyQuestion(amb) {
  var lines = ['`' + amb.table + '` 테이블이 여러 곳에 있어 어느 것인지 확인이 필요합니다.', ''];
  for (var i = 0; i < amb.candidates.length; i++) lines.push('- `' + amb.candidates[i] + '`');
  lines.push('', '어느 테이블로 진행할까요?');
  return lines.join('\n');
}
// 이전 분석 작업 흔적(완성된 대시보드 URL 또는 분석 도구 호출)이 있으면 true.
// · 완성 URL 이 없는 실패·잘린 이전 시도도 포함 — 새 요청 시 그 잔재를 compact 로 청소
function historyHasPriorAnalysisWork(messages) {
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m.content && String(m.content).indexOf('대시보드 열기') >= 0) return true;
    if (m.role === 'assistant' && m.toolCalls) {
      for (var j = 0; j < m.toolCalls.length; j++) {
        var nm = m.toolCalls[j].function.name;
        if (nm === 'describe_table' || nm === 'compile_tql_from_spec' || nm === 'forecast_table' ||
            nm === 'create_dashboard_with_charts') return true;
      }
    }
  }
  return false;
}

// 분석 스킬 + 이전 분석 흔적 + 후속 마커 없음 → 히스토리 압축 대상 — 세션 오염 방지
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
  var prevSkill = agent.skillName;
  // 테이블 선택 질문에 대한 답 → 직전 스킬·대화 유지(새 질문으로 분류·초기화하지 않음)
  var answeringClarify = lastAnswerIsTableClarify(agent.messages) && !!skillRegistry.get(prevSkill);
  var activeSkill = answeringClarify ? skillRegistry.get(prevSkill)
    : skillRegistry.classify(query);

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

  // ollama: 후속 마커 없으면 매 질문 풀 리셋 — 이전 맥락의 새 답변 오염 방지
  // · 스킬 동일 시 기존 system 객체 재사용 — KV 프리픽스 캐시 유지
  if (agent.llm.type === 'ollama' && !hasFollowupMarker(query) && !answeringClarify) {
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

  // 스킬 동일해도 이전 분석 흔적 뒤 새 분석 요청이면 압축 — 세션 오염 방지
  var newAnalysis = (!skillSwitched && !answeringClarify && shouldCompactForNewAnalysis(agent.messages, query, activeSkill));
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

// 잘림 재시도로 낮춘 출력 상한 원복
function restoreNumPredict(agent) {
  if (agent._baseNumPredict == null) return;
  agent.llm.numPredict = agent._baseNumPredict;
  agent._baseNumPredict = null;
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

  // 테이블 이름 모호 → 모델 호출 없이 사용자 선택 질문으로 턴 종료
  if (agent._tableClarify) {
    var askText = tableClarifyQuestion(agent._tableClarify);
    var askMsg = createMessage('assistant', askText);
    askMsg._tableClarify = true;
    agent.messages.push(askMsg);
    console.println('[Agent] Table name ambiguous → asking the user to choose (no LLM call)');
    console.println('============================================================');
    return cb(null, askText);
  }

  // ollama 답변 강제 조건 — 재탐색 대신 답변 작성 후 종료
  // · (a) 대시보드/리포트 완성 후: 도구 목록 유지·실행 차단
  // · (b) 동일 호출 반복 차단 누적 교착(_repeatForceAnswer): 도구 제거
  // · (c) 도구 인자 잘림 반복(_truncForceAnswer): 도구 제거
  var _forceAnswer = (agent.llm.type === 'ollama' && (agent.dashboardFinalized || agent._repeatForceAnswer || agent._truncForceAnswer));
  // 완성 후 강제답변 공회전 하드캡 — 차단 경로는 step 미소모라 maxSteps 백스톱 미도달
  // · 상한 초과 시 완성 도구 결과(URL 포함)로 결정론 종료
  if (_forceAnswer && agent.dashboardFinalized) {
    agent._finalizeRounds = (agent._finalizeRounds || 0) + 1;
    if (agent._finalizeRounds > FINALIZE_ROUND_CAP) {
      console.println('[Agent] Post-finalize churn: round ' + agent._finalizeRounds + ' > cap ' + FINALIZE_ROUND_CAP + ' → deterministic completion.');
      console.println('============================================================');
      return cb(null, agent._finalizeResult || '작업이 완료되었습니다.');
    }
  }
  if (agent.dashboardFinalized && _forceAnswer && !agent._finalizeNudged) {
    // 마무리 도구 성공 후 보고서 작성 직접 지시(1회) — 미지시 시 약한 모델 침묵
    agent._finalizeNudged = true;
    agent.messages.push(internalUserMessage('작업 완료: 대시보드/리포트가 생성되었습니다. 추가 도구 호출 없이, 앞서 조회한 통계·결과를 인용해 한국어 분석 보고서를 작성하고 종료하세요. URL이 있으면 [열기](URL) 형식으로 포함하세요.'));
  }
  // 완성 후 단계 — 도구 목록은 그대로 두고(바꾸면 ollama가 프롬프트 전체 재처리) 호출은 executeToolCalls에서 차단
  agent._finalizePhase = !!(_forceAnswer && agent.dashboardFinalized);
  var _callTools = (_forceAnswer && !agent.dashboardFinalized) ? [] : agent.toolDefs;
  // 반복교착 강제답변 + 데이터 질문 + 쿼리 0회 → execute_sql_query만 유지 — 선언만 하고 끝나는 것 방지
  // · DocLookup·완성 후·이미 쿼리함·잘림 반복이면 전부 제거
  // · REPEAT_BLOCK_CAP×2 초과 시 전부 제거 — 목록 밖 도구 환각 호출 차단 루프 방지
  if (_forceAnswer && !agent.dashboardFinalized && !agent._truncForceAnswer && agent.skillName !== 'DocLookup' && !agent._ranQuery &&
      agent._repeatBlocks < REPEAT_BLOCK_CAP * 2) {
    _callTools = [];
    for (var _ti = 0; _ti < agent.toolDefs.length; _ti++) {
      if (agent.toolDefs[_ti].function && agent.toolDefs[_ti].function.name === 'execute_sql_query') _callTools.push(agent.toolDefs[_ti]);
    }
    if (_callTools.length && !agent._forceExecNudged) {
      agent._forceExecNudged = true;
      console.println('[Agent] Force-answer on data question with no query ran → keep execute_sql_query only.');
      agent.messages.push(internalUserMessage(
        '다른 도구는 모두 차단되었습니다. 지금 execute_sql_query로 질문에 답할 SQL을 한 번 실행하고, 그 결과만으로 최종 답변을 작성하세요.'));
    }
  }
  if (agent._truncForceAnswer && !agent.dashboardFinalized && !agent._truncNudged) {
    agent._truncNudged = true;
    console.println('[Agent] Tool-call truncation cap reached → answer without tools.');
    agent.messages.push(internalUserMessage(
      '도구 호출이 반복해서 잘려 더 이상 도구를 쓸 수 없습니다. 지금까지 확인한 내용만으로 사용자 질문에 대한 답변을 한국어로 지금 작성하세요.'));
  }
  agent._activeTools = _callTools; // 가드 재유도도 이번 호출의 도구 목록을 따름
  agent.llm.chat(agent.messages, _callTools, function (err, resp) {
    if (agent.cancelled) {
      console.println('[Agent] Cancelled after LLM response at step ' + step);
      console.println('============================================================');
      return cb(null, '(중단됨)');
    }
    if (err) {
      // 도구 인자 잘림(같은 내용 반복 → 출력 상한) — 같은 요청 재시도 대신
      // · 재시도: 출력 상한 낮추고 반복 말라는 지시, 이후 이 질문은 온도 TRUNC_RECOVERY_TEMP 유지(온도 0이면 다시 반복)
      // · 연달아 잘림·TRUNCATION_CAP 도달: 도구 없이 답변 강제(출력 상한 원복)
      if (agent.llm.type === 'ollama' && !agent._truncForceAnswer && isTruncatedToolCall(err)) {
        noteTruncation(agent);
        console.println('[Agent] Tool-call arguments truncated (' + agent._truncations + '/' + TRUNCATION_CAP + ', streak ' + agent._truncStreak + '): ' + err.message);
        agent.llm.temperature = TRUNC_RECOVERY_TEMP;
        if (agent._truncForceAnswer) {
          restoreNumPredict(agent);
        } else {
          if (agent._baseNumPredict == null) agent._baseNumPredict = agent.llm.numPredict;
          agent.llm.numPredict = TRUNC_RETRY_PREDICT;
          agent.messages.push(internalUserMessage(
            '직전 도구 호출의 인자가 같은 내용을 반복하다 출력 상한에서 잘려 실행되지 않았습니다. 같은 호출을 되풀이하지 말고, 인자를 짧게 고쳐 한 번만 호출하세요.'));
        }
        return runLoop(agent, step, cb);
      }
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
      restoreNumPredict(agent);
      return cb(null, '일시적으로 응답 생성에 실패했습니다(모델 오류). 같은 질문을 다시 시도해 주세요.');
    }
    agent._llmErrorRetries = 0; // 성공 → step별 재시도 카운터 리셋
    agent._truncStreak = 0;     // 성공 → 연속 잘림 리셋
    // 재시도로 올렸던 온도 원복 — 이 질문에서 잘림이 있었으면 회복 온도 유지
    var _baseTemp = agent._truncations ? TRUNC_RECOVERY_TEMP : 0;
    if (agent.llm.type === 'ollama' && agent.llm.temperature !== _baseTemp) agent.llm.temperature = _baseTemp;
    restoreNumPredict(agent); // 잘림 재시도로 낮췄던 출력 상한 원복

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
      // ollama 리포트 저장 가드 — save_html_report 2차(저장) 호출 없이 완료·URL 위조 차단
      // · 방금 쓴 분석 보존 + 재호출 지시(REPORT_SAVE_NUDGE_CAP까지)
      if (agent.llm.type === 'ollama' && agent.reportSavePending && agent._reportSaveNudges < REPORT_SAVE_NUDGE_CAP) {
        agent._reportSaveNudges++;
        console.println('[Agent] Report NOT saved but model answered without re-calling save_html_report → forcing re-call (nudge ' + agent._reportSaveNudges + '/' + REPORT_SAVE_NUDGE_CAP + ')');
        if (msg.content) agent.messages.push(createMessage('assistant', msg.content)); // 모델이 방금 작성한 분석 본문 보존
        agent.messages.push(internalUserMessage(
          '아직 리포트 파일이 저장되지 않았습니다. 위에서 작성한 분석 내용을 analysis와 recommendations 인자에 담아 save_html_report를 반드시 다시 호출하세요. ' +
          'URL·파일명·링크를 직접 지어내 답하지 마세요 — 실제 링크는 저장 도구만 생성합니다.'));
        return runLoop(agent, step + 1, cb);
      }
      // ollama 예측 되묻기 가드 — CodeExec 예측 의도인데 forecast_table 미호출 답변(태그 되묻기 등) 시 호출 강제
      // · 태그 판단은 도구 소관
      // · forecast_table 시도 이력 있으면 미발동 — 도구 자신의 되묻기는 정당
      if (agent.llm.type === 'ollama' && agent.skillName === 'CodeExec' && !agent._forecastCalled &&
          FORECAST_INTENT_RE.test(String(agent.currentQuery || '')) &&
          agent._forecastCallNudges < FORECAST_CALL_NUDGE_CAP) {
        agent._forecastCallNudges++;
        var _fcTable = lastDescribedTable(agent);
        console.println('[Agent] Forecast intent but model answered without calling forecast_table → forcing call (nudge ' + agent._forecastCallNudges + '/' + FORECAST_CALL_NUDGE_CAP + ')');
        if (msg.content) agent.messages.push(createMessage('assistant', msg.content)); // 방금 낸 답변 보존(인덱스 페어링 유지)
        agent.messages.push(internalUserMessage(
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
          // (b) 그 외 강제답변(DOC_READ_CAP 등) 빈응답 → 1회 재촉, 그래도 비면 정직 폴백 종료
          if (!agent._forceEmptyRetried) {
            agent._forceEmptyRetried = true;
            console.println('[Agent] Forced-answer empty → one strong retry.');
            agent.messages.push(internalUserMessage(
              '빈 응답은 허용되지 않습니다. 방금 조회한 문서 내용을 근거로 사용자 질문에 대한 답변을 지금 바로, 한국어로 작성하세요.'));
            return runLoop(agent, step + 1, cb);
          }
          console.println('[Agent] Forced-answer still empty → honest fallback.');
          console.println('============================================================');
          return cb(null, '문서를 확인했지만 답변 생성에 실패했습니다. 질문을 조금 더 구체적으로 다시 시도해 주세요.');
        }
        console.println('[Agent] Empty response, retrying...');
        agent.messages.push(internalUserMessage('작업이 완료되지 않았습니다. 다음 단계를 계속 진행하세요.'));
        return runLoop(agent, step + 1, cb);
      }
      // "선언 후 미실행" 가드(ollama) — 조회 예고만 하고 execute_sql_query 미실행 시 1회 재유도
      // · DocLookup 제외 — 넛지문 답변 누출 방지
      if (agent.llm.type === 'ollama' && agent.skillName !== 'DocLookup' && !agent._ranQuery && !agent._intentNudged && ANNOUNCE_NO_ACTION_RE.test(msg.content)) {
        agent._intentNudged = true;
        console.println('[Agent] Announced a query but never executed one → nudge to actually run it.');
        agent.messages.push(createMessage('assistant', msg.content)); // 방금 낸 선언 보존(인덱스 페어링 유지)
        agent.messages.push(internalUserMessage(
          '방금 답에서 조회하겠다고 말만 하고 실제로 실행하지 않았습니다. 지금 execute_sql_query 도구를 실제로 호출해 데이터를 가져온 뒤, 그 결과로 답하세요. 예고하지 말고 도구를 지금 호출하세요.'));
        return runLoop(agent, step + 1, cb);
      }
      // 숫자 없는 데이터 답변 재촉(ollama·1회) — 실데이터 행 반환 + 답변에 숫자 0개면 값 포함 재작성 유도
      // · 0건/에러 결과면 미발동
      if (agent.llm.type === 'ollama' && agent.skillName !== 'DocLookup' && agent._ranQuery &&
          agent._lastQueryHadRows && !agent._noNumbersNudged && msg.content && !/\d/.test(msg.content)) {
        agent._noNumbersNudged = true;
        console.println('[Agent] Data answer contains no numbers → nudge to include actual values.');
        agent.messages.push(createMessage('assistant', msg.content));
        agent.messages.push(internalUserMessage(
          '방금 답변에 조회 결과의 실제 수치가 하나도 없습니다. 위에서 조회한 결과의 값들을 표로 포함해 완전한 답변을 지금 작성하세요.'));
        return runLoop(agent, step + 1, cb);
      }
      var finalContent = collapseRepeatedBlocks(msg.content);
      finalContent = normalizeProductName(finalContent);                             // 제품명 오표기 정정(마하베이스→마크베이스) — 전 프로바이더
      finalContent = fixDuplicateSummarized(finalContent);                           // TAG 테이블 CREATE에 SUMMARIZED 값컬럼 2개+ → 첫 개만 유지(ERR-2251 항상 무효) — 전 프로바이더
      finalContent = csvDumpsToTables(finalContent, agent);                          // 도구가 준 조회 결과 CSV를 그대로 붙여넣은 블록 → 마크다운 표 — 전 프로바이더
      finalContent = stripDuplicateListTable(finalContent, agent);                  // 모델이 옮겨 적은 표 제거(행 합침·건수 오류의 자리) — 전 프로바이더
      finalContent = injectListTable(finalContent, agent);                          // 도구 원본 표 삽입(설명과 한 답변에) — 전 프로바이더
      if (agent.llm.type === 'ollama') finalContent = normalizeHan(finalContent);   // 약한 모델 한자/중국어 누출 보정
      if (agent.llm.type === 'ollama') finalContent = balanceFences(finalContent);  // 안 닫힌 ```tql 펜스 복구(블록 병합→실행오류 방지)
      if (agent.llm.type === 'ollama') finalContent = dedupeTqlBlocks(finalContent); // 같은 SQL의 ```tql 블록 재탕 제거
      if (agent.llm.type === 'ollama') finalContent = reflowMarkdown(finalContent); // 깨진 목록 골격 복원(번호 뒤 공백·인라인 불릿 줄바꿈)
      if (agent.llm.type === 'ollama') finalContent = stripToolInternals(finalContent); // 도구 안내문(section= 등) 사용자 조언으로 에코된 줄 제거
      // 답변 본문의 도구호출 XML 마크업 제거 — 화면이 HTML 태그로 삼켜 조각만 보이는 것 방지
      if (agent.llm.type === 'ollama') {
        var beforeTC = finalContent;
        finalContent = stripToolCallMarkup(finalContent);
        if (beforeTC !== finalContent && !finalContent.replace(/\s/g, '')) {
          if (!agent._toolCallLeakRetried) {
            agent._toolCallLeakRetried = true;
            console.println('[Agent] Answer was tool-call markup only → stripped to empty → one strong retry.');
            agent.messages.push(internalUserMessage(
              '방금 응답에 도구 호출 형식이 그대로 들어갔습니다. 도구를 더 부르지 말고, 지금까지 확인한 내용만으로 사용자 질문에 대한 답변을 한국어 문장으로 지금 작성하세요.'));
            return runLoop(agent, step + 1, cb);
          }
          console.println('[Agent] Still tool-call markup after retry → honest fallback.');
          console.println('============================================================');
          return cb(null, '답변 생성에 실패했습니다. 질문을 조금 더 구체적으로 다시 시도해 주세요.');
        }
      }
      // 저장 재유도(캡) 소진 후에도 미저장 → 지어낸 URL/링크 제거 + 정직 고지
      if (agent.llm.type === 'ollama' && agent.reportSavePending) finalContent = stripFabricatedReportSave(finalContent);
      // DocLookup 답변의 내부 문서 경로(.md) 노출 줄 제거
      if (agent.llm.type === 'ollama' && agent.skillName === 'DocLookup') {
        finalContent = stripDocPathLines(finalContent);
        // 경로 줄만 있던 답변 → 제거 후 빈 답변: 1회 재촉, 그래도 비면 정직 폴백
        // · 위 !msg.content 분기는 후처리 전에만 검사
        if (!finalContent.replace(/\s/g, '')) {
          if (!agent._strippedEmptyRetried) {
            agent._strippedEmptyRetried = true;
            console.println('[Agent] Answer was doc-path line(s) only → stripped to empty → one strong retry.');
            agent.messages.push(internalUserMessage(
              '문서 경로(.md)만 답하지 말고, 방금 조회한 문서 내용을 근거로 사용자 질문에 대한 실제 답변(설명 + SQL 예시)을 지금 바로 한국어로 작성하세요.'));
            return runLoop(agent, step + 1, cb);
          }
          console.println('[Agent] Still doc-path-only after retry → honest fallback.');
          console.println('============================================================');
          return cb(null, '문서를 확인했지만 답변 생성에 실패했습니다. 질문을 조금 더 구체적으로 다시 시도해 주세요.');
        }
      }
      // 보안 백스톱 — 사용자 답변의 자격증명·키·계정 나열 마스킹(모델 무관)
      var _mc = agent.registry && agent.registry.client;
      finalContent = security.redactSecrets(finalContent, _mc && _mc.secrets ? _mc.secrets() : []);
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

  // 같은 배치에서 테이블 선택 대기 중 → 나머지 도구 미실행(도구 결과 짝은 유지)
  if (agent._tableClarify) {
    console.println('  \\- SKIPPED: waiting for the user to choose a table');
    agent.messages.push(createMessage('tool', 'skipped: waiting for the user to choose a table'));
    return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  }

  // 스킬 허용 목록 밖 도구 실행 차단(전 모델) — 목록에 없는 도구를 이름으로 부르는 것 방지
  // · 코드 내부 호출(registry.get(name).fn 등)은 이 경로를 안 거침
  if (Array.isArray(agent.toolDefs) && !hasToolDef(agent.toolDefs, toolName)) {
    agent._repeatBlocks++;
    var _allowedNames = agent.toolDefs.map(function (d) { return d.function && d.function.name; }).filter(Boolean);
    console.println('  \\- BLOCKED: 스킬(' + agent.skillName + ') 허용 목록 밖 도구 ' + toolName + ' (누적 ' + agent._repeatBlocks + ')');
    console.println('------------------------------------------------------------');
    agent.messages.push(createMessage('tool',
      '취소됨: 이 단계에서는 ' + toolName + ' 도구를 쓸 수 없습니다. ' +
      (_allowedNames.length ? '사용할 수 있는 도구: ' + _allowedNames.join(', ') + '. 이 도구들로 진행하거나, ' : '') +
      '지금까지 확인한 내용으로 답하세요.'));
    if (agent.llm.type === 'ollama' && agent._repeatBlocks >= REPEAT_BLOCK_CAP) {
      agent._repeatForceAnswer = true;
      console.println('  \\- 반복 차단 ' + agent._repeatBlocks + '회 → 도구 없이 답변 강제');
    }
    return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  }

  // 완성 후 답변 강제 단계(ollama) — 도구 목록은 유지하되 어떤 도구도 실행하지 않음
  if (agent._finalizePhase) {
    console.println('  \\- BLOCKED: finalize phase, skipping ' + toolName + ' (answer only)');
    console.println('------------------------------------------------------------');
    agent.messages.push(createMessage('tool',
      '취소됨: 작업이 이미 완료되었습니다. 도구를 호출하지 말고, 앞서 조회한 결과를 인용해 지금 바로 최종 답변을 작성하세요. ' +
      'URL이 있으면 [열기](URL) 형식으로 포함하세요.'));
    return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  }
  // 대시보드 완성 후 차트 생성(compile/forecast)·재탐색(describe_table/list_tables) 차단 — 같은 배치 뒤 호출의 고아 .tql·재탐색 방지
  // · forecast_table은 filename 무관 차단 — 호출 자체가 리포트 산출
  if (agent.dashboardFinalized && (toolName === 'compile_tql_from_spec' ||
      toolName === 'forecast_table' || toolName === 'describe_table' || toolName === 'list_tables')) {
    console.println('  \\- BLOCKED: dashboard already finalized, skipping ' + toolName + ' (post-finalize tool block)');
    console.println('------------------------------------------------------------');
    agent.messages.push(createMessage('tool',
      '취소됨: 대시보드가 이미 생성·완성되었습니다. 추가 차트는 기존 대시보드에 포함되지 않으므로 만들지 마세요. ' +
      '받은 대시보드 URL로 최종 답변(분석 요약 + [대시보드 열기](URL))을 작성하세요.'));
    return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  }
  // 대시보드 스킬(기본·심층)은 예측 차트 금지 — forecast_table은 스킬 도구 목록에서 제외, 컴파일 kind=forecast는 여기서 차단
  if ((agent.skillName === 'BasicAnalysis' || agent.skillName === 'AdvancedAnalysis') &&
      toolName === 'compile_tql_from_spec' && specKind(tc.function.arguments) === 'forecast') {
    console.println('  \\- BLOCKED: forecast chart in dashboard');
    console.println('------------------------------------------------------------');
    agent.messages.push(createMessage('tool',
      '취소됨: 대시보드에는 예측 차트를 넣지 않습니다. 예측 없이 실측 데이터 차트(metrics·tags 등)만으로 대시보드를 완성하세요.'));
    return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  }

  // DocLookup 결정론 가드(전 프로바이더) — EXCEPTION(예제 생성 경로) = 예제/코드 명시 요청 AND 실재 테이블명 명시
  // · 판정은 doc_intent(실재 테이블 목록 대조)
  var _docGuarded = toolName === 'compile_tql_from_spec' || toolName === 'describe_table' || toolName === 'list_tables' ||
    toolName === 'search_documents' || toolName === 'get_full_document_content' || toolName === 'get_document_sections';
  if (agent.skillName === 'DocLookup' && _docGuarded) {
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
      // "무슨 테이블 있어?" 류 목록 탐색 질문 → list_tables 차단 제외
      var _isListQ = toolName === 'list_tables' && docIntent.asksTableList(_dq);
      // "SENSOR_TEST 테이블 구조/컬럼 알려줘" 류 스키마 질문 → describe_table 차단 제외
      var _isStructQ = toolName === 'describe_table' && _structQ && !!_qTable;
      if (!_exception && !_isListQ && !_isStructQ) {
        var _why = _wantsEx
          ? '질문에 특정 테이블명이 없으므로 예제 생성 대상이 아닙니다. search_documents로 문서를 찾아 해당 섹션을 읽고 문서 기반으로 설명하세요(문서 코드 예제는 extract_code_blocks로 추출 가능).'
          : '이 질문은 개념/사용법 설명 요청입니다. 테이블 탐색·차트 생성 없이, 검색·조회한 문서 내용만으로 설명하세요.';
        // REPEAT_CALL_CAP 체크 이전이라 차단 누적 별도 집계 — 캡 도달 시 도구 없이 답변 강제(재호출 무한루프 방지)
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
      // EXCEPTION인데 질문에 없는 다른 테이블로 컴파일 → 차단(환각 테이블 방지) · DB·유저 접두 제외 비교
      if (_exception && toolName === 'compile_tql_from_spec') {
        var _argTable = docIntent.extractSpecTable(tc.function.arguments || {});
        var _argBare = docIntent.bareTable(_argTable);
        if (_argTable && _argBare !== docIntent.bareTable(_qTable) &&
            _dq.toUpperCase().indexOf(_argBare) < 0) {
          console.println('  \\- BLOCKED: DocLookup 질문에 없는 테이블(' + _argTable + ')로 컴파일 시도 차단');
          console.println('------------------------------------------------------------');
          agent.messages.push(createMessage('tool',
            '질문에 언급된 테이블(' + _qTable + ')로만 예제를 만드세요. spec.table을 ' + _qTable + '로 고쳐 재호출하세요.'));
          return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
        }
      }
    }

    // 거울 가드: EXCEPTION(테이블명+예제)일 때만 문서 도구 차단 → describe→compile 직행 유도
    // · 조건 확장 금지 — 테이블명 없는 예제 질문까지 문서 차단 시 교착
    if (_exception && (toolName === 'search_documents' || toolName === 'get_full_document_content' || toolName === 'get_document_sections')) {
      console.println('  \\- BLOCKED: DocLookup 테이블 예제 요청(' + _qTable + ') → ' + toolName + ' 차단 (문서 없이 describe→compile)');
      console.println('------------------------------------------------------------');
      agent.messages.push(createMessage('tool',
        '테이블(' + _qTable + ') 예제 요청입니다. 문서 검색 없이 describe_table로 태그·컬럼을 확인한 뒤 compile_tql_from_spec(filename 없이)로 검증된 TQL 예제를 생성하세요.'));
      return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
    }
  }

  // DocLookup 문서 조회 하드캡(ollama) — 과잉탐색 degeneration 차단
  // · 초과 시 도구 없이 답변 강제(_repeatForceAnswer), search_documents는 제외
  if (agent.llm.type === 'ollama' && agent.skillName === 'DocLookup' &&
      (toolName === 'get_full_document_content' || toolName === 'get_document_sections' || toolName === 'extract_code_blocks')) {
    if (agent._docReads >= DOC_READ_CAP || agent._failedDocSections >= FAILED_SECTION_CAP) {
      agent._repeatForceAnswer = true;
      var _capHitSection = agent._failedDocSections >= FAILED_SECTION_CAP;
      console.println('  \\- BLOCKED: DocLookup ' + (_capHitSection ? '섹션 헛짚기 ' + agent._failedDocSections + '회' : '문서 조회 ' + DOC_READ_CAP + '회') + ' 도달 → 도구 없이 답변 강제');
      console.println('------------------------------------------------------------');
      // 원 질문 재명시 + 읽은 문서 인용 지시 — 비대한 컨텍스트에서 질문과 무관한 답변 방지
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

  // forecast_table "데이터 부족" 반복 차단 — rollup만 바꾼 재호출 루프 방지
  // · 버킷 단위는 도구가 구간 기준 최소로 잡아 인자 변경 무의미
  if (toolName === 'forecast_table' && agent._forecastShortages >= FORECAST_SHORTAGE_CAP) {
    console.println('  \\- BLOCKED: forecast_table 데이터 부족 ' + agent._forecastShortages + '회 → 추가 호출 차단');
    console.println('------------------------------------------------------------');
    agent.messages.push(createMessage('tool',
      '취소됨: 이 테이블은 예측에 필요한 데이터가 부족합니다(이미 ' + agent._forecastShortages + '회 확인). ' +
      '다시 호출하지 말고, 앞의 "데이터 부족" 표를 그대로 사용자에게 전달하며 데이터가 더 쌓인 뒤 시도하라고 안내하세요.'));
    return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  }

  // 무한 거부루프 하드캡 — compile·예측 COMPILE_FAIL_CAP회 연속 실패 시 실행 생략·건너뜀 유도
  if ((toolName === 'compile_tql_from_spec' || toolName === 'forecast_table') && agent.compileFailStreak >= COMPILE_FAIL_CAP) {
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

  // forecast_table 태그 임의축소 교정(전 프로바이더) — 질문에 없는 tag/tags 제거, 태그 결정은 도구 소관
  if (toolName === 'forecast_table') normalizeForecastTags(agent, args);

  // 동일 호출 반복 차단(전 프로바이더) — 같은 도구+인자 REPEAT_CALL_CAP회 실행 후 재호출 차단(degeneration 하드캡)
  var _callSig = toolName + '|' + safeArgSig(args);
  if ((agent._callCounts[_callSig] || 0) >= REPEAT_CALL_CAP) {
    // 스키마 도구 반복(ollama·非DocLookup·쿼리 0회) → 도구 유지한 채 execute_sql_query 실행 유도(SCHEMA_LOOP_NUDGE_CAP회)
    // · 일반 반복차단은 도구 전부 제거로 이어져 선언만 하고 끝남 방지, 캡 초과 시 일반 경로 폴백
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
    // 스키마 도구 반복 + 쿼리 0회면 execute_sql_query 실행 지시, 그 외 범용 반복 차단 문구
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

  // SQL 실행 상한(ollama) — 인자만 바꾼 반복은 동일 호출 상한 미적용
  // · 차단은 반복 차단 누적에 합산 → REPEAT_BLOCK_CAP이면 도구 없이 답변 강제
  if (toolName === 'execute_sql_query' && agent.llm.type === 'ollama' && (agent._sqlRuns || 0) >= SQL_RUN_CAP) {
    agent._repeatBlocks++;
    console.println('  \\- BLOCKED: SQL 실행 ' + SQL_RUN_CAP + '회 상한, 추가 실행 차단 (누적 ' + agent._repeatBlocks + ')');
    console.println('------------------------------------------------------------');
    agent.messages.push(createMessage('tool',
      '취소됨: 이 질문에서 SQL을 이미 ' + SQL_RUN_CAP + '번 실행했습니다. 더 조회하지 말고, 지금까지의 조회 결과로 지금 바로 답변하세요.'));
    if (agent._repeatBlocks >= REPEAT_BLOCK_CAP) {
      agent._repeatForceAnswer = true;
      console.println('  \\- 반복 차단 ' + agent._repeatBlocks + '회 → 도구 없이 답변 강제');
    }
    return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  }
  agent._callCounts[_callSig] = (agent._callCounts[_callSig] || 0) + 1;

  // 시간단위 불일치 넛지(ollama·데이터질문·캡) — 질문 버킷 단위와 SQL 버킷 단위가 다르거나 버킷 누락 시 실행 전 차단·재작성 유도
  // · 잘못된 버킷도 에러 없이 성공하므로 실행 전 차단 필요
  if (toolName === 'execute_sql_query' && agent.llm.type === 'ollama' && agent.skillName !== 'DocLookup' &&
      (agent._unitMismatchNudges || 0) < UNIT_MISMATCH_CAP) {
    var _qUnit = detectQuestionBucketUnit(agent.currentQuery);
    var _sUnit = detectSqlBucketUnit(args.sql_query);
    // (a) 다른 버킷: 질문 week인데 SQL day 등
    // (b) 버킷 누락: 버킷 없이 VALUE 집계 — MIN(TIME) 등 무버킷 탐색쿼리는 통과
    // · 질문에 버킷어 없으면 _qUnit=null → 둘 다 스킵
    var _wrongBucket = _qUnit && _sUnit && _qUnit !== _sUnit;
    // 버킷 누락 판정 대상: VALUE 집계 · stat 가상뷰(v$_stat, 전체기간 요약) · 개수 의도 질문의 무버킷 COUNT(
    // · MIN/MAX(TIME) 탐색은 예외
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
      return guardBucketExpr(agent.mc, args.sql_query, _qUnit, function (_bx) {
        agent.messages.push(createMessage('tool',
          '취소됨: 질문은 "' + _qUnit + '" 단위 시간별 집계를 요구하는데 이 쿼리는 ' +
          (_missingBucket ? '시간 버킷 없이 전체를 한 값으로 집계했습니다.' : '"' + _sUnit + '" 버킷입니다.') + ' ' +
          '시간 버킷을 ' + _qUnit + '(으)로 넣어 다시 실행하세요(질문에 기간이 없으면 TIME 필터도 넣지 마세요). ' +
          '예: SELECT ' + _bx + ' AS bucket, ' + _aggEx + ' FROM 테이블 WHERE NAME=\'태그\' GROUP BY bucket ORDER BY bucket.'));
        return executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
      });
    }
  }

  // 다중태그 합산 방어(ollama·1회) — 다중 태그 WHERE + VALUE 집계 + GROUP BY NAME 없음 → 실행 전 차단·재작성 유도
  // · 합산이 의도면 같은 쿼리 재실행 시 통과
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

  // bare VALUE 방어(ollama·캡) — 버킷 GROUP BY의 비집계 VALUE는 에러 없이 그룹 임의 행 값 반환 → 실행 전 차단
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

  // 리포트 커스텀 쿼리-라우팅 — 질문에 커스텀 고유 주제 키워드가 있으면 그 template_id 주입
  // · 모델이 이미 C-* 커스텀을 골랐으면 존중, generic 슬러그(sample)는 미매칭
  if (toolName === 'save_html_report') {
    var curTpl = String((args && args.template_id) || '');
    if (!/^C-/i.test(curTpl)) {
      var customId = matchCustomByQuery(agent.currentQuery || '');
      if (customId) {
        args.template_id = customId;
        console.println('  [report] custom routed by query → ' + customId + ' (was "' + (curTpl || '(none)') + '")');
      } else if (!curTpl || /^R-0/i.test(curTpl)) {
        // 빌트인 쿼리-라우팅 — template_id 누락/R-0-general이면 질문 토큰으로 빌트인 주입
        // · 모델이 고른 구체적 빌트인(R-1/R-2/R-3)은 존중
        var builtinId = matchBuiltinByQuery(agent.currentQuery || '');
        if (builtinId && !/^R-0/i.test(builtinId)) {
          args.template_id = builtinId;
          console.println('  [report] builtin routed by query → ' + builtinId + ' (was "' + (curTpl || '(none)') + '")');
        }
      }
    }
  }

  // 문서 검색에 원문 질문 동봉(숨은 인자, 스키마 비노출) — 모델 검색어에서 빠진 질문 단서 보완용
  // ollama 한정 — 강한 모델은 자체 검색어가 원문보다 정확해 섞으면 순위 하락
  if (toolName === 'search_documents' && args && agent.currentQuery && agent.llm && agent.llm.type === 'ollama') {
    args._userQuery = String(agent.currentQuery);
  }

  // Execute tool
  agent.registry.execute(toolName, args, function (execErr, result) {
    if (toolName === 'execute_sql_query') {
      agent._ranQuery = true; // 조회 시도함 → "선언 후 미실행" 넛지 대상에서 제외(에러여도 시도는 한 것)
      agent._sqlRuns = (agent._sqlRuns || 0) + 1;
    }
    if (execErr) {
      result = 'Error: ' + (execErr.message || String(execErr));
      console.println('  \\- ERROR: ' + result);
    } else {
      if (result === null || result === undefined) result = '';
      result = String(result);
      // 로그 표시용 절단(모델에는 원본 전달) — 짧으면 로그 진단 시 검색 결과 누락으로 오독
      console.println('  \\- OK: ' + truncate(result, 3000));
      if (toolName === 'list_tables') agent._lastTableList = result;
      // 대시보드 생성 성공 → 완성 플래그 ON(추가 차트 차단·ollama 답변 강제)
      // · 실패도 'Error: …' 문자열 결과로 오므로 성공 문구가 있을 때만 완성 처리
      if (toolName === 'create_dashboard_with_charts' && result.indexOf('Dashboard created') >= 0) {
        agent.dashboardFinalized = true; agent._finalizeResult = result;
      }
      // 리포트 저장 완료("리포트 열기" URL 반환) → 완성 신호
      // · 1차 호출(결과에 "다시 호출" 안내)만 됐으면 reportSavePending — runLoop 가드의 저장 재호출 강제용
      if (toolName === 'save_html_report') {
        if (result.indexOf('리포트 열기') >= 0 || result.indexOf('Report saved') >= 0) {
          agent.dashboardFinalized = true; agent._finalizeResult = result; agent.reportSavePending = false; // 저장 완료
        } else if (result.indexOf('다시 호출') >= 0) {
          agent.reportSavePending = true; // 데이터만 조회됨(1차) 또는 한쪽만 수집(부분) → 아직 저장 안 됨
        }
      }
      // forecast_table 리포트 링크 반환 → 완성 신호(되묻기·에러 결과엔 링크 없음)
      // · _finalizeResult는 빈응답 폴백 시 최종 답변 → 모델용 지시문([지시…] 줄) 제거 필수
      if (toolName === 'forecast_table' && result.indexOf('리포트 열기') >= 0) {
        agent.dashboardFinalized = true;
        agent._finalizeResult = result.replace(/\n*\[지시[^\n]*\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      }
      // DocLookup 예제요청에서 compile 성공 개수 카운트(DOC_EXAMPLE_CAP 하드캡용) — 에러 결과는 제외.
      if (agent.skillName === 'DocLookup' && toolName === 'compile_tql_from_spec' &&
          result.indexOf('Error:') !== 0 && result.indexOf('TIR invalid') < 0) agent.docExampleCompiles++;
      // 예제 상한 도달 표시 — raw_tql 가드가 추가 compile 대신 만든 예제만 쓰라고 지시(상한 차단과 핑퐁 방지)
      if (agent.llm.type === 'ollama' && agent.skillName === 'DocLookup' && agent.docExampleCompiles >= DOC_EXAMPLE_CAP) agent._docExampleCapped = true;
      // 없는 섹션(한국어명 헛짚기 등) 조회 → DOC_READ_CAP 예산 되돌림 + 헛짚기 카운터 증가(FAILED_SECTION_CAP 대상)
      if (agent.skillName === 'DocLookup' && toolName === 'get_full_document_content' &&
          (result.indexOf('" not found.') >= 0 || result.indexOf('이 문서에 없습니다') >= 0)) {
        if (agent._docReads > 0) agent._docReads--;
        agent._failedDocSections++;
      }
      // 마지막 쿼리의 실데이터 반환 여부 — 숫자 없는 답변 재촉(post-loop)의 전제
      if (toolName === 'execute_sql_query') {
        var _rowsM = String(result).match(/\((\d+) rows?\)/);
        agent._lastQueryHadRows = !!(_rowsM && +_rowsM[1] > 0 && String(result).indexOf('Error:') !== 0 && !queryReturnedNoData(result));
      }
      // today-filter 오적용 방어(ollama) — 기간 없는 질문에 TIME 필터로 0행·날짜 오류·COUNT=0이면 필터 제거 재조회 힌트 첨부
      // · WHERE 직접 제거 금지(오늘/최근 질문 훼손) → 힌트만
      var _dateErr = /MACHCLI-ERR-300|Invalid date value/i.test(String(result || ''));
      // COUNT 포함 SQL의 1행 전부 0 → 실질 no data(COUNT는 0건에도 NULL 대신 0 반환)
      var _countZero = /\bCOUNT\s*\(/i.test(String(args.sql_query || '')) && countReturnedAllZero(result);
      if (agent.llm.type === 'ollama' && toolName === 'execute_sql_query' &&
          (queryReturnedNoData(result) || _dateErr || _countZero) &&
          /\bTIME\s*(>=|>|<=|<|=|BETWEEN)/i.test(String(args.sql_query || '')) &&
          !TIME_RANGE_RE.test(String(agent.currentQuery || ''))) {
        console.println('  \\- HINT: 질문에 기간 없음 + TIME 필터 ' + (_dateErr ? '날짜 오류' : (_countZero ? 'COUNT=0' : '데이터 0건(집계 NULL 포함)')) + ' → 필터 제거 재조회 유도(today-filter 방어)');
        result += '\n\n⚠ ' + (_dateErr ? '날짜 필터에서 오류가 났습니다.' : '이 기간에 데이터가 없습니다(0행, 집계 NULL 또는 COUNT=0).') + ' 질문에 기간(오늘/최근/특정 날짜)이 명시되지 않았는데 WHERE에 TIME 조건이 들어갔습니다. WHERE에서 TIME 조건을 완전히 제거하고 전체 기간으로 다시 조회하세요. (현재 날짜로 필터를 만들지 마세요 — 데이터는 과거 시점일 수 있습니다.)';
      }
      // ROLLUP + COUNT(*) → COUNT(VALUE) 재조회 힌트(ollama) — ROLLUP 경로 COUNT(*)는 롤업 행 수(버킷당 1)를 셈
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
    // compile·예측 연속 실패 스트릭 갱신(하드캡용). 도구는 실패를 'Error:' 문자열로도 반환(execErr 없이) → 둘 다 검사. 성공이면 리셋.
    if (toolName === 'compile_tql_from_spec' || toolName === 'forecast_table') {
      var compileFailed = !!execErr || String(result).indexOf('Error:') === 0 || String(result).indexOf('TIR invalid') >= 0;
      agent.compileFailStreak = compileFailed ? (agent.compileFailStreak + 1) : 0;
    }
    console.println('------------------------------------------------------------');

    // 테이블 이름 모호 → 다음 runLoop에서 선택 질문으로 전환
    var amb = parseAmbiguity(result);
    if (amb) agent._tableClarify = amb;

    // Report result to UI
    if (agent.onProgress) {
      // 결과가 마크다운 표로 시작하면 표만 펜스 없이·자르지 않고 전송(UI가 표로 렌더)
      // · 표 뒤의 모델용 지시문·전체 이름 목록은 제외
      var uiTable = leadingMarkdownTable(result);
      if (amb) agent.onProgress('테이블 확인 필요: ' + amb.table + ' → ' + amb.candidates.join(', '));
      else if (uiTable) agent.onProgress(uiTable);
      else agent.onProgress('```\n' + truncate(result, 300) + '\n```');
    }

    captureResults(tc, result, execErr, agent.fixerCtx);
    agent.messages.push(createMessage('tool', result));

    executeToolCalls(agent, toolCalls, idx + 1, step, doneCb);
  });
}

// 결과 맨 앞 마크다운 표 블록 반환(표 행 + 빈 줄 + "(N ...)" 꼬리까지)
// · 표가 아니면 null — 호출부는 펜스 방식 폴백
function leadingMarkdownTable(s) {
  var lines = String(s || '').split('\n');
  if (!/^\s*\|.*\|\s*$/.test(lines[0] || '')) return null;
  if (!/^\s*\|[-\s|:]+\|\s*$/.test(lines[1] || '')) return null;
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (/^\s*\|.*\|\s*$/.test(ln) || /^\s*$/.test(ln) || /^\s*\(\d+\s/.test(ln)) { out.push(ln); continue; }
    break;
  }
  return out.join('\n').trim();
}

function truncate(s, max) {
  if (s === null || s === undefined) return '';
  s = String(s);
  if (s.length <= max) return s;
  return s.substring(0, max) + '... (total ' + s.length + ' chars)';
}

// 1행 결과의 숫자 셀이 전부 0(NULL 셀 허용)이면 true — COUNT( 포함 SQL 전용(VALUE 실제 0과 구분)
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

// execute_sql_query 결과의 실질 데이터 없음 판정(today-filter 방어용)
// · ① 0행 ② 집계 1행인데 값이 전부 NULL/빈칸
// · 결과 포맷: "헤더\n데이터행들\n\n(N rows)", NULL 셀은 빈칸 → 영숫자 값 유무로 판정
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

// 질문의 시간 버킷 단위 의도 추출(단위-불일치 넛지용)
// · 복합 버킷어(주별/주 단위/weekly 등)만 인정, bare 글자(주/일/월/시간/분) 금지 — 오탐 방지
// · 정확히 1개 단위일 때만 반환, 0개·2개 이상은 null
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

// 도구 정의 목록에 이 이름이 있나
function hasToolDef(defs, name) {
  for (var i = 0; i < defs.length; i++) if (defs[i].function && defs[i].function.name === name) return true;
  return false;
}

// 단위 재작성 예시의 버킷식 — 쿼리 테이블에 ROLLUP이 없으면 DATE_TRUNC(ROLLUP 예시를 따르면 ERR-2264)
// · 테이블을 못 읽거나 DB 확인 수단(mc)이 없으면 ROLLUP
function guardBucketExpr(mc, sql, unit, cb) {
  var rollupEx = "ROLLUP('" + unit + "',1,TIME)", truncEx = "DATE_TRUNC('" + unit + "', TIME)";
  var m = String(sql || '').match(/\bFROM\s+([A-Za-z0-9_$.]+)/i);
  if (!mc || !m) return cb(rollupEx);
  resolveTableRef(mc, m[1].toUpperCase(), function (err, ref) {
    if (err || !ref) return cb(rollupEx);
    countRollups(mc, ref.qualified, function (n) { cb(n > 0 ? rollupEx : truncEx); });
  });
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

// ollama 답변 한자/중국어 누출 → 흔한 도메인 용어 치환(삭제는 문장 깨짐)
// · 긴 키 먼저 — 부분치환 방지 · 맵에 없는 한자는 경고 로그
var HAN_MAP = [
  // 문서 QA·기술 설명 답변 상용 표현
  ['进行', '진행'], ['处理', '처리'], ['支持', '지원'], ['执行', '실행'],
  ['生成', '생성'], ['定义', '정의'], ['结果', '결과'], ['格式', '형식'], ['文件', '파일'], ['读取', '읽기'],
  ['写入', '쓰기'], ['返回', '반환'], ['类型', '타입'], ['参数', '파라미터'], ['配置', '설정'], ['默认', '기본값'],
  ['语法', '문법'], ['名称', '이름'], ['需要', '필요'], ['可以', '가능'], ['通过', '통해'], ['或者', '또는'], ['以及', '및'],
  ['成交量', '거래량'], ['波动性', '변동성'], ['传感器', '센서'], ['开盘', '시가'], ['收盘', '종가'],
  ['最高', '최고'], ['最低', '최저'], ['最大', '최대'], ['最小', '최소'], ['平均', '평균'],
  ['价格', '가격'], ['时间戳', '타임스탬프'], ['时间', '시간'], ['分析', '분석'], ['数据源', '데이터소스'], ['数据', '데이터'], ['趋势', '추세'],
  ['波动', '변동'], ['设备', '디바이스'], ['温度', '온도'], ['振动', '진동'], ['图表', '차트'],
  ['报告', '보고서'], ['统计', '통계'], ['日期', '날짜'], ['总量', '총량'],
  ['来源', '소스'], ['输出', '출력'], ['输入', '입력'], ['转换', '변환'], ['查询', '쿼리'], ['函数', '함수'],
  ['制造商', '제조사'], ['信息', '정보'], ['单位', '단위'], ['描述', '설명'], ['属性', '속성'], ['字段', '필드'], ['例如', '예를 들어'], ['等等', '등'], ['等', '등'],
  // 금융/리포트 답변 상용 표현 — 3글자→2글자→1글자 순(부분치환 방지)
  ['可适当', '적절히'], ['适当', '적절히'], ['交易日', '거래일'], ['交易', '거래'], ['成交', '거래'], ['指标', '지표'], ['风险', '리스크'], ['投资', '투자'],
  ['资产', '자산'], ['市场', '시장'], ['建议', '권고'], ['收益', '수익'], ['波幅', '변동폭'], ['支撑', '지지'], ['阻力', '저항'],
  // 모니터링/대시보드 답변·차트 제목에서 새는 표현
  ['使用率', '사용률'], ['使用', '사용'], ['日均', '일평균'], ['内存', '메모리'], ['状态', '상태'], ['错误', '오류'],
  ['请求', '요청'], ['响应', '응답'], ['连接', '연결'], ['服务', '서비스'], ['数量', '개수'],
  ['也不行', '역시 불가'], ['不行', '불가'], ['识别', '식별'], ['也', '또한'], ['是', '는'], ['子', '자'],
  // 지시어·수량 — "23.5这一个 값입니다"
  ['这一个', ' 하나의'], ['这个', '이'], ['一个', '하나의'], ['这', '이'],
  // 진동 리포트 본문 — "시점附近에서"
  ['附近', ' 부근'], ['回落', '하락'],
  // '的'는 조사라 어떤 단어 뒤에도 붙을 수 있어 맨 뒤 단독 폴백.
  ['从现在起', '지금부터'], ['毫秒', '밀리초'], ['的差异', '의 차이'], ['差异', '차이'],
  ['육眼', '육안'], ['眼前', '눈앞'], ['眼', '안'], ['前', '전'], ['的', '의']
];
// 답변에 에코된 문서 도구 안내문(section= 등) 제거용 패턴
// · ① 괄호 꼬리만 제거 → ② 그래도 토큰이 남는 줄만 삭제 · 코드펜스 안은 보존
var TOOL_INTERNALS_RE = /section\s*=|file_identifier|search_documents|get_full_document_content|get_document_sections|extract_code_blocks|list_available_documents|이 문서의 주요 섹션|이 문서의 다른 섹션/;
var TOOL_INTERNALS_PAREN_RE = /\s*[(（][^()（）]*(?:section\s*=|file_identifier|search_documents|get_full_document_content|get_document_sections|extract_code_blocks|list_available_documents)[^()（）]*[)）]/g;
// 도구호출 마크업 제거 — `<tool_call>…</tool_call>` 블록은 통째로, 흩어진 `<parameter=…>`·`</parameter>`·`<function…>` 조각은 줄 단위로
// · 코드펜스 안은 보존(XML 예제 가능)
function stripToolCallMarkup(text) {
  if (!text || String(text).indexOf('<') < 0) return text;
  var removed = 0;
  function clean(s) {
    // 블록 먼저 — 태그만 지우면 인자 값이 본문처럼 남음
    s = s.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, function () { removed++; return ''; });
    s = s.replace(/<tool_call>[\s\S]*$/i, function () { removed++; return ''; });        // 닫히지 않은 채 끝난 경우
    s = s.replace(/<parameter\s*=[^>]*>[\s\S]*?<\/parameter>/gi, function () { removed++; return ''; });
    var TAG = /^\s*<\/?(?:tool_call|function|parameter)\b[^>]*>\s*$/i;                    // 흩어진 조각
    return s.split('\n').filter(function (l) { if (TAG.test(l)) { removed++; return false; } return true; }).join('\n');
  }
  // 코드펜스 밖만 정리
  var parts = String(text).split(/(```[\s\S]*?```)/g);
  for (var i = 0; i < parts.length; i++) if (i % 2 === 0) parts[i] = clean(parts[i]);
  var out = parts.join('');
  if (removed) console.println('[Agent] 도구호출 마크업 ' + removed + '조각 제거(stripToolCallMarkup)');
  return out.replace(/\n{3,}/g, '\n\n');
}

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

// 답변 펜스에 붙여넣은 도구 결과 CSV → 마크다운 표
// · 비코드 펜스(CSV_FENCE_LANGS) 중 도구 결과와 겹치는 CSV만 대상, 나머지는 유지
var CSV_FENCE_LANGS = { '': 1, csv: 1, txt: 1, text: 1, plain: 1, plaintext: 1 }; // 실행 코드가 아닌 펜스만 대상
function csvDumpsToTables(text, agent) {
  if (!text || String(text).indexOf('```') < 0) return text;
  var msgs = (agent && agent.messages) || [];
  var toolOutputs = [];
  for (var m = 0; m < msgs.length; m++) {
    if (msgs[m] && msgs[m].role === 'tool') toolOutputs.push(String(msgs[m].content || ''));
  }
  if (!toolOutputs.length) return text;

  // 펜스 짝을 줄 단위로 매칭 — 단일 정규식은 닫는 펜스를 여는 펜스로 오인
  var lines = String(text).split('\n');
  var out = [], i = 0, converted = 0;
  while (i < lines.length) {
    var open = /^[ \t]*```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?$/.exec(lines[i]);
    if (!open) { out.push(lines[i++]); continue; }
    var body = [], j = i + 1, closed = false;
    for (; j < lines.length; j++) {
      if (/^[ \t]*```[ \t]*\r?$/.test(lines[j])) { closed = true; break; }
      body.push(lines[j]);
    }
    if (!closed) { out.push(lines[i++]); continue; }   // 안 닫힌 펜스 → 원문 그대로
    var table = CSV_FENCE_LANGS[open[1].toLowerCase()] ? csvBodyToTable(body.join('\n'), toolOutputs) : null;
    if (table) {
      out.push(table);
      converted++;
    } else {
      out.push(lines[i]);
      for (var k = 0; k < body.length; k++) out.push(body[k]);
      out.push(lines[j]);
    }
    i = j + 1;
  }
  if (converted) console.println('[Agent] 답변 속 원본 CSV ' + converted + '블록 → 마크다운 표 변환(csvDumpsToTables)');
  return out.join('\n');
}

// CSV 본문 → 마크다운 표. 표로 바꿀 조건이 아니면 null(호출부가 원본 블록 유지).
function csvBodyToTable(body, toolOutputs) {
  var lines = String(body).split('\n');
  var rows = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\r$/, '').trim();
    if (!line) continue;
    if (/^\(\d+ rows?\)/.test(line)) continue;   // 도구 결과의 행 수 꼬리 — 표에는 불필요
    rows.push(line);
  }
  if (rows.length < 2) return null;              // 헤더 + 최소 1행
  var cols = rows[0].split(',').length;
  if (cols < 2) return null;
  var matched = 0;
  for (var r = 0; r < rows.length; r++) {
    if (rows[r].split(',').length !== cols) return null;   // 열 수가 들쭉날쭉 → CSV가 아님
    for (var t = 0; t < toolOutputs.length; t++) {
      if (toolOutputs[t].indexOf(rows[r]) >= 0) { matched++; break; }
    }
  }
  // 도구 결과와 실제로 겹칠 때만 — 절반 이상, 최소 2줄.
  if (matched < 2 || matched < rows.length * 0.5) return null;

  var cells = function (line) {
    return line.split(',').map(function (c) { return c.trim().split('|').join('\\|'); });
  };
  var md = ['| ' + cells(rows[0]).join(' | ') + ' |', '|' + new Array(cols + 1).join(' --- |')];
  for (var k = 1; k < rows.length; k++) md.push('| ' + cells(rows[k]).join(' | ') + ' |');
  return md.join('\n');
}

// DocLookup 답변의 내부 문서 경로(.md) 노출 줄 제거 — 코드펜스 안은 보존
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

// 제품명 한국어 오표기 정정("마하베이스" → "마크베이스") — 전 프로바이더
function normalizeProductName(s) {
  if (!s) return s;
  return s.split('마하베이스').join('마크베이스').split('마하 베이스').join('마크베이스');
}

// 답변 CREATE TAG TABLE의 SUMMARIZED 중복 교정 — 첫 SUMMARIZED만 유지(TAG 테이블은 하나만 허용, ERR-2251)
// · 각 CREATE의 컬럼목록 괄호블록만 대상(중첩 괄호 깊이 추적)
function fixDuplicateSummarized(s) {
  if (!s || !/CREATE\s+TAG\s+TABLE/i.test(s)) return s;
  var re = /CREATE\s+TAG\s+TABLE\b/gi, m, edits = [];
  while ((m = re.exec(s)) !== null) {
    var p = s.indexOf('(', m.index);
    if (p < 0) { re.lastIndex = m.index + 15; continue; }
    var depth = 0, close = -1;
    for (var j = p; j < s.length; j++) {
      var ch = s.charAt(j);
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { close = j; break; } }
    }
    if (close < 0) break;
    var block = s.slice(p, close + 1);
    if ((block.match(/\bSUMMARIZED\b/gi) || []).length >= 2) {
      var seen = false;
      var fixed = block.replace(/\s*\bSUMMARIZED\b/gi, function (mm) {
        if (!seen) { seen = true; return mm; } // 첫 개는 그대로 유지
        return ''; // 나머지는 앞 공백까지 제거 → 일반 컬럼
      });
      edits.push({ start: p, end: close + 1, text: fixed });
    }
    re.lastIndex = close + 1;
  }
  if (!edits.length) return s;
  for (var e = edits.length - 1; e >= 0; e--) s = s.slice(0, edits[e].start) + edits[e].text + s.slice(edits[e].end);
  console.println('[Answer] TAG 테이블 중복 SUMMARIZED 자동교정(첫 값컬럼만 유지)');
  return s;
}

// list_tables 원본 표를 답변 첫 문단 뒤에 삽입 — 설명과 표를 한 답변에
// · 답변에 이미 표가 있으면 그대로
function injectListTable(content, agent) {
  var src = String((agent && agent._lastTableList) || '');
  if (!src) return content;
  var m = /^(\|[^\n]*\|\n\|[-\s|:]+\|\n(?:\|[^\n]*\|\n?)*)/.exec(src);
  if (!m) return content;
  var table = m[1].trim();
  var body = String(content || '').trim();
  if (!body) return table;
  if (/^[ \t]*\|[^\n]*\|[ \t]*\n[ \t]*\|[-\s|:]+\|/m.test(body)) return body;  // 이미 표가 있으면 그대로
  var parts = body.split(/\n\s*\n/);
  if (parts.length <= 1) return body + '\n\n' + table;
  return parts[0] + '\n\n' + table + '\n\n' + parts.slice(1).join('\n\n');
}

// 모델이 답변에 옮겨 적은 list_tables 표 제거(원본은 injectListTable이 삽입)
// · 열 구성 무관 판정 — 모델마다 표 형태가 다름
// · 조회(execute_sql_query) 없던 턴 → 표 전부 제거
// · 조회 있던 턴 → 도구가 준 테이블 이름이 2개 이상 등장하는 표 블록만 제거
// · 남은 빈 제목도 정리
function stripDuplicateListTable(content, agent) {
  var src = String((agent && agent._lastTableList) || '');
  if (!src || !content) return content;
  var listOnly = !(agent && agent._ranQuery);

  var names = [], labels = [], srcLines = src.split('\n'), i, sm;
  for (i = 0; i < srcLines.length; i++) {
    sm = /^\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(srcLines[i]);
    if (!sm || /^[-:\s]+$/.test(sm[1])) continue;
    var nm = sm[2].toUpperCase(), db = sm[1].toUpperCase();
    if (nm && nm !== '테이블' && names.indexOf(nm) < 0) names.push(nm);
    if (db && db !== '데이터베이스' && labels.indexOf(db) < 0) labels.push(db);
  }
  var sectionLabels = labels.concat(names);   // 지운 표의 구역 제목 후보(DB명·테이블명)
  if (!listOnly && names.length === 0) return content;

  function knownHits(block) {
    var up = block.toUpperCase(), hits = 0;
    for (var k = 0; k < names.length; k++) if (up.indexOf(names[k]) >= 0) hits++;
    return hits;
  }

  var lines = String(content).split('\n'), out = [];
  i = 0;
  while (i < lines.length) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) { out.push(lines[i++]); continue; }
    var start = i;
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) i++;
    if (listOnly || knownHits(lines.slice(start, i).join('\n')) >= 2) continue;
    for (var k2 = start; k2 < i; k2++) out.push(lines[k2]);
  }
  return dropEmptyHeadings(out.join('\n'), sectionLabels).replace(/\n{3,}/g, '\n\n').trim();
}

// 내용 없는 제목 줄 제거 — 상위 제목도 비면 지울 게 없을 때까지 반복
function dropEmptyHeadings(text, sectionLabels) {
  var labels = sectionLabels || [];
  // 지운 표의 구역 라벨 제목("### FACTORY_A (1개)" 등) — 뒤에 문장이 있어도 삭제 대상
  function isSectionLabel(line) {
    var t = String(line).replace(/^\s*#{1,6}\s*/, '').replace(/\s*\([^)]*\)\s*$/, '').trim().toUpperCase();
    return !!t && labels.indexOf(t) >= 0;
  }
  var lines = String(text || '').split('\n');
  for (var pass = 0; pass < 4; pass++) {
    var out = [], changed = false;
    for (var i = 0; i < lines.length; i++) {
      if (/^\s*#{1,6}\s/.test(lines[i])) {
        if (isSectionLabel(lines[i])) { changed = true; continue; }
        var j = i + 1;
        while (j < lines.length && /^\s*$/.test(lines[j])) j++;
        if (j >= lines.length || /^\s*#{1,6}\s/.test(lines[j])) { changed = true; continue; }
      }
      out.push(lines[i]);
    }
    lines = out;
    if (!changed) break;
  }
  return lines.join('\n');
}

// ollama 답변의 깨진 마크다운 목록 골격 복원 — 공백·줄바꿈만 수정
// · ① 번호 뒤 공백 누락 ② 문장 뒤에 이어진 하위 불릿 줄 분리 ③ 문단에 붙은 번호 목록 앞 빈 줄 ④ 번호 항목에 붙은 불릿 들여쓰기
// · 코드펜스·표 행·인라인코드 제외, 소수점(3.14)·절 번호(3.5)는 뒤가 숫자라 제외
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

// 도구 인자의 한자 누출 정규화(저장물 제목·본문) — 제목·본문류 필드만 대상
// · SQL/TQL·테이블/태그/파일명 제외(중문 식별자가 실데이터일 수 있음), panel_title도 제외(기존 제목 매칭용)
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

// 한국어 금융 태그 별칭 — "종가 예측해줘"처럼 한글 지칭도 언급된 태그로 인정
var FC_TAG_ALIASES = { '종가': 'close', '시가': 'open', '고가': 'high', '저가': 'low', '거래량': 'volume' };

// forecast_table 인자 교정: 질문에 없는 tag/tags 제거(전부 없으면 도구 자동결정, 일부만 언급이면 그것만 유지)
// · spec(객체/JSON 문자열)과 최상위 인자 둘 다 대상
// · 대명사 지칭("그 태그")은 태그명이 없어 전체 예측으로 처리
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

// compile_tql_from_spec 인자의 spec.kind(문자열 spec도 해석) — 없으면 ''
function specKind(args) {
  var sp = args && args.spec;
  if (typeof sp === 'string') { try { sp = JSON.parse(sp); } catch (e) { sp = null; } }
  return sp && typeof sp === 'object' ? String(sp.kind || '').toLowerCase() : '';
}

// 이번 쿼리에서 마지막으로 describe_table/list_table_tags 한 테이블명 — 예측 호출 강제 유도 문구용
// · 현재 질문 앵커는 포함 매치 필수(user 메시지에 스킬 힌트가 덧붙음), 못 찾으면 ''
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

// 리포트 미저장(reportSavePending) 폴백 정화 — 답변의 http(s) 링크·URL은 위조라 제거 + 저장 실패 고지
// · 코드펜스 안(예제 URL 등)은 보존
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

// 안 닫힌 ``` 블록 자동 닫기 — 블록 병합 시 Run 컴파일 에러("near `tql") 방지
function balanceFences(text) {
  if (!text) return text;
  // 펜스 줄 수가 짝수면 미수정, 홀수(닫는 펜스 누락)일 때만 복구 — 정상 답변 오손상 방지
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
// 문자열 리터럴 비우기 — 리터럴 안 괄호(SQL `... AVG(VALUE) ...`)의 깊이 계산 교란 방지
function stripTqlLiterals(s) {
  return String(s)
    .replace(/`[^`]*`/g, '``')
    .replace(/'[^'\r\n]*'/g, "''")
    .replace(/"[^"\r\n]*"/g, '""');
}
// 블록의 SINK(파이프라인 마지막 최상위 함수) 이름 — 인자 제외(꾸밈만 바꾼 재탕도 같은 키)
function sinkName(body) {
  var s = stripTqlLiterals(body), depth = 0, name = '', last = '';
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if (/[A-Za-z0-9_]/.test(c)) { if (depth === 0) name += c; continue; }
    if (c === '(') { if (depth === 0 && name) last = name.toUpperCase(); depth++; name = ''; continue; }
    if (c === ')') { if (depth > 0) depth--; name = ''; continue; }
    if (depth === 0) name = '';
  }
  return last;
}
// 사실상 같은 차트의 tql 블록 중복 제거(꾸밈·컬럼순서만 바꾼 재탕)
// · 키 = SQL + SINK 이름 — SINK만 다른 출력 형식 비교 예제 보존
function dedupeTqlBlocks(text) {
  if (!text) return text;
  var seen = {};
  var out = text.replace(/```([\w-]*)\r?\n([\s\S]*?)```/g, function (full, lang, body) {
    var m = body.match(/SQL\(\s*`([\s\S]*?)`\s*\)/i);
    if (!m) return full;                                  // SQL 없는 블록은 유지
    var key = normalizeSqlKey(m[1]) + ' >> ' + sinkName(body);
    if (seen[key]) return '';                             // SQL·SINK 모두 같은 재탕 → 제거
    seen[key] = true;
    return full;
  });
  return out.replace(/\n{3,}/g, '\n\n');                  // 제거로 생긴 과도한 빈 줄 정리
}

// 최종 답변의 같은 블록 N번 반복(degeneration) 축약
function collapseRepeatedBlocks(content) {
  if (!content) return content;
  var s = String(content).replace(/\s+$/, '');
  if (s.length < 400) return content;          // 짧은 답변은 손대지 않음
  var n = s.length;
  // 끝에서 반복되는 블록 탐지 — 주기 L을 작은 값부터(primitive period), 반복이 본문 40%+일 때만 unit 1개로 축약
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

module.exports = { createAgent, runLoop, guardBucketExpr }; // runLoop·guardBucketExpr: 유닛 테스트용
