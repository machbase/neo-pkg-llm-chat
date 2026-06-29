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

// 가드 재유도 힌트(_guardHint)는 일회성 조향 메시지다. 캡 없이 누적되면 같은 문구(특히 "[대시보드 열기](URL)")가
// 컨텍스트를 반복 도배해 약한 모델(ollama)의 반복 degeneration을 유발한다 — 가드가 여러 번 발동하는 심층 분석에서 특히 심함.
// 새 힌트를 넣기 전 "이전 힌트들"의 본문만 중립화해 항상 살아있는 실효 힌트가 1개가 되게 한다.
// 핵심: 메시지를 '제거'하지 않고 '내용만' 비운다 → user 슬롯/교차(alternation) 구조·tool_use 짝이 그대로 유지돼
// Claude 400(연속 same-role / unexpected tool_use_id) 위험 없음. _guardHint 플래그는 유지(턴 경계 판정 등 기존 로직 보존).
var NEUTRALIZED_HINT = '(이전 가드 안내는 이미 반영됨)';
function neutralizePriorGuardHints(messages) {
  for (var i = 0; i < messages.length; i++) {
    if (messages[i] && messages[i]._guardHint && messages[i].content !== NEUTRALIZED_HINT) {
      messages[i].content = NEUTRALIZED_HINT;
    }
  }
}

// Re-prompt helper: appends msg + cancel results + hint, calls LLM again
function rePrompt(agent, msg, hint) {
  neutralizePriorGuardHints(agent.messages); // 누적 방지: 이전 힌트 본문 중립화(구조 보존)
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
    var resp = agent.llm.chatSync(msgs, agent.toolDefs);
    return resp.message;
  } catch (e) {
    console.println('  [guard] rePrompt failed: ' + (e.message || String(e)));
    return msg;
  }
}

// Re-prompt for post-loop (msg has no tool calls)
function rePromptNoToolCalls(agent, msg, hint) {
  neutralizePriorGuardHints(agent.messages); // 누적 방지: 이전 힌트 본문 중립화(구조 보존)
  agent.messages.push(msg);
  agent.messages.push({ role: 'user', content: hint, toolCalls: [], _guardHint: true });

  try {
    var resp = agent.llm.chatSync(agent.messages, agent.toolDefs);
    return resp.message;
  } catch (e) {
    console.println('  [guard] rePromptNoToolCalls failed: ' + (e.message || String(e)));
    return msg;
  }
}

module.exports = { createPipeline, rePrompt, rePromptNoToolCalls };
