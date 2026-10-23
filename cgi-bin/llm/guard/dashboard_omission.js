var { rePromptNoToolCalls, turnStart, finalizedWithoutTools } = require('./guard');

var MAX_PROMPTS = 2; // 질문당 재유도 상한 — 생성 실패 시 재유도 루프 장기화 방지(이후 답변 통과)

// 기본/고급 분석에서 대시보드를 만들지 않고 "생성했다"고 거짓 완료 보고하는 것 차단
// · 이번 턴 대시보드 생성 0개일 때 재유도
var DashboardOmissionGuard = {
  name: 'dashboard_omission',
  check: function (agent, msg) {
    if (agent.skillName !== 'BasicAnalysis' && agent.skillName !== 'AdvancedAnalysis') return msg;
    if (msg.toolCalls && msg.toolCalls.length > 0) return msg; // 최종 답변(도구 없음) 차례에만
    if (finalizedWithoutTools(agent)) return msg; // 완성 후 도구 없는 강제답변 차례 → 재유도 불가

    if (dashboardCreated(agent.messages)) return msg; // 이번 턴에 실제로 만들었으면 통과
    if ((agent._dashOmissionPrompts || 0) >= MAX_PROMPTS) return msg; // 상한 도달 → 통과

    console.println('  [guard] Dashboard omission: no dashboard created this turn but model finalizing');
    var hint = '아직 대시보드를 실제로 만들지 않았습니다(이번 요청에서 대시보드 생성 도구 호출이 없습니다). ' +
      '"생성했다/완성했다"고 보고하지 마세요. describe_table로 구조를 확인하고, ' +
      'compile_tql_from_spec로 차트들을 만든 뒤, create_dashboard_with_charts를 반드시 호출해 ' +
      '실제로 대시보드를 생성하세요. 그런 다음 [대시보드 열기](URL) 링크를 답변에 포함하세요.';
    agent._dashOmissionPrompts = (agent._dashOmissionPrompts || 0) + 1;
    return rePromptNoToolCalls(agent, msg, hint);
  },
};

// 이번 턴(마지막 실제 사용자 메시지 이후) 대시보드 생성 성공 여부
// — 이전 턴 대시보드가 이번 환각을 가리는 것 방지
function dashboardCreated(msgs) {
  for (var k = turnStart(msgs); k < msgs.length; k++) {
    var m = msgs[k];
    if (m.role === 'tool' && m.content &&
        (m.content.indexOf('Dashboard created') >= 0 || m.content.indexOf('대시보드 열기') >= 0)) {
      return true;
    }
  }
  return false;
}

module.exports = DashboardOmissionGuard;
