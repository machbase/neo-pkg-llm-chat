var { rePrompt } = require('./guard');
var { DASHBOARD_TOOLS } = require('../fixer/fixer');

// Prevents dashboard creation before all TQL templates are saved (advanced mode only)
var DashboardEarlyGuard = {
  name: 'dashboard_early',
  check: function (agent, msg) {
    if (!agent.advanced) return msg;
    if (!msg.toolCalls || msg.toolCalls.length === 0) return msg;

    var hasDashboardCall = false;
    for (var i = 0; i < msg.toolCalls.length; i++) {
      if (DASHBOARD_TOOLS[msg.toolCalls[i].function.name]) {
        hasDashboardCall = true;
        break;
      }
    }
    if (!hasDashboardCall) return msg;

    // Count saved TQL templates
    var savedCount = countSavedTQLs(agent.messages);
    var expectedCount = 4; // minimum (범용: 3-1~3-4)

    if (savedCount < expectedCount) {
      console.println('  [guard] Dashboard too early: ' + savedCount + '/' + expectedCount + ' TQLs saved');
      var hint = '아직 TQL 템플릿이 ' + savedCount + '개만 저장되었습니다. ' +
        '해당 유형의 모든 템플릿을 먼저 저장한 후 대시보드를 생성하세요.';
      return rePrompt(agent, msg, hint);
    }
    return msg;
  },
};

function countSavedTQLs(msgs) {
  // 저장 성공을 도구 이름이 아니라 결과로 카운트: save_tql_file·compile_tql_from_spec(filename 경로)
  // 둘 다 성공 시 "TQL file saved: ..." 를 반환(후자는 save_tql_file에 위임). 답변 경로("실행 검증됨")·에러는 자연히 제외.
  var count = 0;
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'tool' && m.content && m.content.toLowerCase().indexOf('tql file saved') >= 0) {
      count++;
    }
  }
  return count;
}

module.exports = DashboardEarlyGuard;
