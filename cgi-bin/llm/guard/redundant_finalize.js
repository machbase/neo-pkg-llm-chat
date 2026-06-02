var { rePrompt } = require('./guard');

// 대시보드 마무리 단계 도구. save_tql_file도 포함 — 대시보드 URL이 나온 뒤(=완성)의 save는
// 이미 만든 대시보드에 안 들어가고 재생성을 유발하므로 차단 (생성 전 초기 save들은 URL이 없어 통과).
var FINALIZE_TOOLS = { create_dashboard_with_charts: true, preview_dashboard: true, save_tql_file: true };

// 약한 모델이 대시보드 생성/미리보기를 끝낸 뒤에도 같은 도구를 2~3번 반복 호출하는 현상 차단.
// 이미 대시보드 URL이 나온 상태에서 finalize 도구를 또 부르면 → 취소하고 최종 답변으로 유도.
var RedundantFinalizeGuard = {
  name: 'redundant_finalize',
  check: function (agent, msg) {
    if (!msg.toolCalls || msg.toolCalls.length === 0) return msg;
    // 아직 URL이 안 나왔으면(첫 생성 진행 중 / 실패 후 재시도) 통과 — 정상 흐름 방해 금지
    if (!hasDashboardUrl(agent.messages)) return msg;

    var repeated = null;
    for (var i = 0; i < msg.toolCalls.length; i++) {
      var nm = msg.toolCalls[i].function.name;
      if (FINALIZE_TOOLS[nm] && priorCallCount(agent.messages, nm) >= 1) { repeated = nm; break; }
    }
    if (!repeated) return msg;

    console.println('  [guard] ' + repeated + ' repeated after dashboard URL exists, redirecting to final answer');
    return rePrompt(agent, msg,
      '대시보드가 이미 생성·미리보기까지 끝났고 URL도 받았습니다. **차트를 더 만들거나 도구를 더 호출하지 마세요** ' +
      '(추가 차트는 이미 만든 대시보드에 들어가지 않습니다). 받은 대시보드 URL로 최종 답변(분석 요약 + [대시보드 열기](URL) 마크다운 링크)을 바로 작성하세요.');
  },
};

function hasDashboardUrl(msgs) {
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
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
