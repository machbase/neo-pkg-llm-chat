var { rePromptNoToolCalls } = require('./guard');

// Detects when advanced analysis is done but charts are missing from dashboard
var ChartOmissionGuard = {
  name: 'chart_omission',
  check: function (agent, msg) {
    if (!agent.advanced) return msg;
    if (msg.toolCalls && msg.toolCalls.length > 0) return msg;

    var savedTQLs = getSavedTQLPaths(agent.messages);
    var chartCount = countDashboardCharts(agent.messages);

    if (savedTQLs.length > 0 && chartCount < savedTQLs.length) {
      console.println('  [guard] Chart omission: ' + chartCount + ' charts vs ' + savedTQLs.length + ' TQLs');
      var missing = savedTQLs.length - chartCount;
      var hint = '대시보드에 차트가 ' + missing + '개 부족합니다. ' +
        '저장된 TQL 파일 ' + savedTQLs.length + '개를 모두 차트로 추가하세요.';
      return rePromptNoToolCalls(agent, msg, hint);
    }
    return msg;
  },
};

function getSavedTQLPaths(msgs) {
  var paths = [];
  var pendingPaths = [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'assistant' && m.toolCalls) {
      pendingPaths = [];
      for (var j = 0; j < m.toolCalls.length; j++) {
        if (m.toolCalls[j].function.name === 'save_tql_file') {
          pendingPaths.push(m.toolCalls[j].function.arguments.filename || '');
        } else {
          pendingPaths.push('');
        }
      }
    } else if (m.role === 'tool' && pendingPaths.length > 0) {
      var p = pendingPaths.shift();
      if (p) {
        var content = m.content.toLowerCase();
        if (content.indexOf('error') < 0 && content.indexOf('fail') < 0) {
          paths.push(p);
        }
      }
    }
  }
  return paths;
}

function countDashboardCharts(msgs) {
  var count = 0;
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'assistant' && m.toolCalls) {
      for (var j = 0; j < m.toolCalls.length; j++) {
        var name = m.toolCalls[j].function.name;
        if (name === 'add_chart_to_dashboard') count++;
        if (name === 'create_dashboard_with_charts') {
          var charts = m.toolCalls[j].function.arguments.charts;
          if (typeof charts === 'string') {
            try { count += JSON.parse(charts).length; } catch (e) { /* ignore */ }
          } else if (Array.isArray(charts)) {
            count += charts.length;
          }
        }
      }
    }
  }
  return count;
}

module.exports = ChartOmissionGuard;
