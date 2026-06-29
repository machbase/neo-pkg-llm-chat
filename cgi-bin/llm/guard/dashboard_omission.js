var { rePromptNoToolCalls } = require('./guard');

// 분석/대시보드 플로우(기본/고급)에서 대시보드를 실제로 만들지 않고
// (약한 모델이 도구를 하나도 안 부른 채) "대시보드를 생성했다"고 거짓 완료 보고하며 끝내는 것을 막는다.
// report_omission(리포트)·chart_omission(일부 차트 누락)이 못 잡는 "아예 0개 생성" 케이스 담당.
var DashboardOmissionGuard = {
  name: 'dashboard_omission',
  check: function (agent, msg) {
    if (agent.skillName !== 'BasicAnalysis' && agent.skillName !== 'AdvancedAnalysis') return msg;
    if (msg.toolCalls && msg.toolCalls.length > 0) return msg; // 최종 답변(도구 없음) 차례에만

    if (dashboardCreated(agent.messages)) return msg; // 이번 턴에 실제로 만들었으면 통과

    console.println('  [guard] Dashboard omission: no dashboard created this turn but model finalizing');
    var hint = '아직 대시보드를 실제로 만들지 않았습니다(이번 요청에서 대시보드 생성 도구 호출이 없습니다). ' +
      '"생성했다/완성했다"고 보고하지 마세요. describe_table로 구조를 확인하고, ' +
      'compile_tql_from_spec로 차트들을 만든 뒤, create_dashboard_with_charts를 반드시 호출해 ' +
      '실제로 대시보드를 생성하세요. 그런 다음 [대시보드 열기](URL) 링크를 답변에 포함하세요.';
    return rePromptNoToolCalls(agent, msg, hint);
  },
};

// 이번 턴(마지막 user 메시지 이후)에 대시보드 생성 성공 흔적이 있는지.
// 전체 히스토리가 아니라 현재 턴만 봐서, 이전 턴에 만든 대시보드가 이번 환각을 가리지 않게 한다.
function dashboardCreated(msgs) {
  var start = 0;
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && !msgs[i]._guardHint) { start = i; break; } // 가드 재유도 hint는 건너뜀
  }
  for (var k = start; k < msgs.length; k++) {
    var m = msgs[k];
    if (m.role === 'tool' && m.content &&
        (m.content.indexOf('Dashboard created') >= 0 || m.content.indexOf('대시보드 열기') >= 0)) {
      return true;
    }
  }
  return false;
}

module.exports = DashboardOmissionGuard;
