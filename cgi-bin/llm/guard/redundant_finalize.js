var { rePrompt, turnStart } = require('./guard');

// 대시보드 마무리 단계 도구 — URL 나온 뒤(=완성) 반복 호출은 최종 답변으로 재유도(고아 파일 양산 방지)
var FINALIZE_TOOLS = { create_dashboard_with_charts: true, preview_dashboard: true, compile_tql_from_spec: true };

var RedundantFinalizeGuard = {
  name: 'redundant_finalize',
  check: function (agent, msg) {
    if (!msg.toolCalls || msg.toolCalls.length === 0) return msg;

    // ── 중복 create_dashboard_with_charts 하드 차단 ──
    // 턴당 첫 1개만 남기고 나머지 create 호출 제거 — 같은 턴 .dsh 중복 생성 방지(재유도는 무시됨)
    var createdThisTurn = dashboardUrlThisTurn(agent.messages);
    var seenCreate = createdThisTurn, dropped = false, kept = [];
    for (var i = 0; i < msg.toolCalls.length; i++) {
      if (msg.toolCalls[i].function.name === 'create_dashboard_with_charts') {
        if (seenCreate) { dropped = true; continue; } // 이번 턴 두 번째+ create → 제거
        seenCreate = true;
      }
      kept.push(msg.toolCalls[i]);
    }
    if (dropped) {
      console.println('  [guard] dropped duplicate create_dashboard_with_charts (dashboard already created this turn)');
      msg.toolCalls = kept;
      if (msg.toolCalls.length === 0) return msg; // 전부 중복이면 최종 답변 차례로(dashboard_answer가 URL 보장)
    }

    // ── URL 이후 finalize 도구 반복 스팸 → 소프트 재유도(최종 답변으로) ──
    if (!createdThisTurn) return msg;
    var repeated = null;
    for (var k = 0; k < msg.toolCalls.length; k++) {
      var nm = msg.toolCalls[k].function.name;
      if (FINALIZE_TOOLS[nm] && priorCallCount(agent.messages, nm) >= 1) { repeated = nm; break; }
    }
    if (!repeated) return msg;

    console.println('  [guard] ' + repeated + ' repeated after dashboard URL exists, redirecting to final answer');
    return rePrompt(agent, msg,
      '대시보드가 이미 생성·미리보기까지 끝났고 URL도 받았습니다. **차트를 더 만들거나 도구를 더 호출하지 마세요** ' +
      '(추가 차트는 이미 만든 대시보드에 들어가지 않습니다). 받은 대시보드 URL로 최종 답변(분석 요약 + [대시보드 열기](URL) 마크다운 링크)을 바로 작성하세요.');
  },
};

// 이번 턴(마지막 user 메시지 이후)에 대시보드 생성 성공(URL) 흔적이 있는지 — 이전 턴 대시보드는 제외.
function dashboardUrlThisTurn(msgs) {
  // 마지막 실제 사용자 메시지 기준(가드 힌트·에이전트 넛지는 턴 경계 아님)
  for (var k = turnStart(msgs); k < msgs.length; k++) {
    var m = msgs[k];
    if (m.role === 'tool' && m.content && m.content.indexOf('대시보드 열기') >= 0) return true;
  }
  return false;
}

function priorCallCount(msgs, name) {
  var c = 0;
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'assistant' && m.toolCalls) {
      for (var j = 0; j < m.toolCalls.length; j++) {
        if (m.toolCalls[j].function.name === name) c++;
      }
    }
  }
  return c;
}

module.exports = RedundantFinalizeGuard;
