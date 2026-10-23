// Guard pipeline - runs checks before tool execution and after loop completion

function createPipeline(preToolGuards, postLoopGuards) {
  return {
    preTool: preToolGuards || [],
    postLoop: postLoopGuards || [],

    runPreTool: function (agent, msg) {
      for (var i = 0; i < this.preTool.length; i++) {
        msg = this.preTool[i].check(agent, msg);
      }
      return msg;
    },

    runPostLoop: function (agent, msg) {
      for (var i = 0; i < this.postLoop.length; i++) {
        msg = this.postLoop[i].check(agent, msg);
      }
      return msg;
    },
  };
}

// 이전 가드 재유도 힌트(_guardHint) 본문 중립화 — 실효 힌트 1개 유지
// · 같은 힌트 반복 도배로 약한 모델(ollama) 반복 degeneration 유발 방지
// · 메시지 제거 없이 내용만 비움 — role 교차·tool_use 짝 유지(Claude 400 방지)
// · _guardHint 플래그 유지 — 턴 경계 판정용
var NEUTRALIZED_HINT = '(이전 가드 안내는 이미 반영됨)';
function neutralizePriorGuardHints(messages) {
  for (var i = 0; i < messages.length; i++) {
    if (messages[i] && messages[i]._guardHint && messages[i].content !== NEUTRALIZED_HINT) {
      messages[i].content = NEUTRALIZED_HINT;
    }
  }
}

// 에이전트가 끼워 넣는 지시용 user 메시지(마무리·재촉 넛지) — 턴 경계로 보지 않도록 표시
function internalUserMessage(content) {
  return { role: 'user', content: content || '', toolCalls: [], _internal: true };
}

// 이번 턴 시작 인덱스 — 마지막 실제 사용자 메시지
// · 가드 재유도 힌트(_guardHint)·에이전트 넛지(_internal)는 경계 아님
function turnStart(msgs) {
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && !msgs[i]._guardHint && !msgs[i]._internal) return i;
  }
  return 0;
}

// 재유도 호출 도구 — 이번 LLM 호출에 쓴 도구 목록(완성 후 강제답변이면 빈 목록), 없으면 전체
function promptTools(agent) {
  return agent._activeTools || agent.toolDefs;
}

// 완성 후 답변 강제 단계(도구 실행 차단) — 도구 호출을 요구하는 누락 가드는 재유도해도 충족 불가
function finalizedWithoutTools(agent) {
  return !!agent.dashboardFinalized && !!agent._finalizePhase;
}

// 도구 인자 잘림 — 모델이 인자 안에서 같은 내용을 반복하다 출력 상한에서 끊김(ollama HTTP 500)
// · 같은 요청 재시도는 대개 같은 반복 → 실패 1회에 출력 상한만큼 시간 소모
// · 도구 없이 답변 강제: 연달아 잘림(재시도도 잘림) 또는 질문당 TRUNCATION_CAP회
var TRUNCATION_CAP = 3;
var TRUNCATION_STREAK_CAP = 2; // 성공 호출 없이 연달아 잘린 횟수 상한 — 성공하면 runLoop가 0으로 되돌림
function isTruncatedToolCall(err) {
  var m = String((err && err.message) || err || '');
  return /invalid tool call arguments/i.test(m) && /unexpected end of JSON/i.test(m);
}
function noteTruncation(agent) {
  agent._truncations = (agent._truncations || 0) + 1;
  agent._truncStreak = (agent._truncStreak || 0) + 1;
  if (agent._truncations >= TRUNCATION_CAP || agent._truncStreak >= TRUNCATION_STREAK_CAP) agent._truncForceAnswer = true;
}

// 재유도 실패 처리 — 미리 넣은 메시지 되돌림(같은 호출이 기록에 두 번 남는 것 방지) + 잘림 집계
function rePromptFailed(agent, mark, e, label) {
  agent.messages.length = mark;
  if (isTruncatedToolCall(e)) noteTruncation(agent);
  console.println('  [guard] ' + label + ' failed: ' + (e.message || String(e)));
}

// Re-prompt helper: appends msg + cancel results + hint, calls LLM again
function rePrompt(agent, msg, hint) {
  neutralizePriorGuardHints(agent.messages); // 누적 방지: 이전 힌트 본문 중립화(구조 보존)
  var mark = agent.messages.length;
  var msgs = agent.messages.slice();
  msgs.push(msg);
  for (var i = 0; i < (msg.toolCalls ? msg.toolCalls.length : 0); i++) {
    msgs.push({ role: 'tool', content: 'cancelled: redirecting', toolCalls: [] });
  }
  msgs.push({ role: 'user', content: hint, toolCalls: [], _guardHint: true });

  // Update agent messages too
  agent.messages.push(msg);
  for (var j = 0; j < (msg.toolCalls ? msg.toolCalls.length : 0); j++) {
    agent.messages.push({ role: 'tool', content: 'cancelled: redirecting', toolCalls: [] });
  }
  agent.messages.push({ role: 'user', content: hint, toolCalls: [], _guardHint: true });

  try {
    var resp = agent.llm.chatSync(msgs, promptTools(agent));
    return resp.message;
  } catch (e) {
    rePromptFailed(agent, mark, e, 'rePrompt');
    return msg;
  }
}

// Re-prompt for post-loop (msg has no tool calls)
// · 잘림 반복으로 도구 없이 답변하는 단계면 재유도 안 함 — 도구를 요구하는 재유도는 충족 불가, 답변만 예고문으로 바뀜
function rePromptNoToolCalls(agent, msg, hint) {
  if (agent._truncForceAnswer) return msg;
  neutralizePriorGuardHints(agent.messages); // 누적 방지: 이전 힌트 본문 중립화(구조 보존)
  var mark = agent.messages.length;
  agent.messages.push(msg);
  agent.messages.push({ role: 'user', content: hint, toolCalls: [], _guardHint: true });

  try {
    var resp = agent.llm.chatSync(agent.messages, promptTools(agent));
    return resp.message;
  } catch (e) {
    rePromptFailed(agent, mark, e, 'rePromptNoToolCalls');
    return msg;
  }
}

module.exports = { createPipeline, rePrompt, rePromptNoToolCalls, internalUserMessage, turnStart, finalizedWithoutTools,
  TRUNCATION_CAP, isTruncatedToolCall, noteTruncation };
