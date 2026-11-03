var { rePromptNoToolCalls } = require('./guard');

// 리포트 모드에서 save_html_report 미호출 탐지
var ReportOmissionGuard = {
  name: 'report_omission',
  check: function (agent, msg) {
    if (!agent.reportMode) return msg;
    if (msg.toolCalls && msg.toolCalls.length > 0) return msg;

    // ※ skill/report.js allowTools와 짝 — 목록 밖 도구로 만든 리포트는 미완성 판정 → 재촉으로 리포트 중복 생성
    var REPORT_TOOLS = ['save_html_report'];
    var reportCalled = false;
    for (var i = 0; i < agent.messages.length && !reportCalled; i++) {
      var m = agent.messages[i];
      if (m.role !== 'assistant' || !m.toolCalls) continue;
      for (var j = 0; j < m.toolCalls.length; j++) {
        if (m.toolCalls[j].function && REPORT_TOOLS.indexOf(m.toolCalls[j].function.name) >= 0) {
          reportCalled = true;
          break;
        }
      }
    }

    if (!reportCalled) {
      console.println('  [guard] Report omission: save_html_report never called');
      var hint = '리포트 모드입니다. save_html_report 도구를 호출하여 HTML 리포트를 생성하세요. ' +
        '사전 쿼리 없이 table 파라미터만 지정하면 됩니다.';
      return rePromptNoToolCalls(agent, msg, hint);
    }
    return msg;
  },
};

module.exports = ReportOmissionGuard;
