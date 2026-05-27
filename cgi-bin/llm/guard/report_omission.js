var { rePromptNoToolCalls } = require('./guard');

// Detects when report mode is active but save_html_report was never called
var ReportOmissionGuard = {
  name: 'report_omission',
  check: function (agent, msg) {
    if (!agent.reportMode) return msg;
    if (msg.toolCalls && msg.toolCalls.length > 0) return msg;

    // Check if save_html_report was ever called successfully
    var reportCalled = false;
    for (var i = 0; i < agent.messages.length; i++) {
      var m = agent.messages[i];
      if (m.role === 'assistant' && m.toolCalls) {
        for (var j = 0; j < m.toolCalls.length; j++) {
          if (m.toolCalls[j].function.name === 'save_html_report') {
            reportCalled = true;
            break;
          }
        }
      }
      if (reportCalled) break;
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
