var { rePromptNoToolCalls } = require('./guard');
var { createMessage } = require('../llm/types');

// 대시보드가 성공적으로 생성됐는데(URL 발급) 최종 답변이 그 URL을 빠뜨린 경우를 구제.
// 증상: 약한 모델이 초반 compile 실패(예: candlestick 거부) 등으로 혼란에 빠져 "파일 확인 도구가 없다/사과/재확인 요청"
// 같은 헛소리로 끝냄 → 사용자는 멀쩡히 만들어진 대시보드 링크를 못 받음.
// 대응: (1) 실제 URL+차트수를 박아 한 번 재유도 (2) 그래도 URL이 빠지면 결정론적으로 링크를 덧붙여 보장.
var DashboardAnswerGuard = {
  name: 'dashboard_answer',
  check: function (agent, msg) {
    if (msg.toolCalls && msg.toolCalls.length > 0) return msg; // 최종 답변(도구 없음) 차례에만
    var url = lastDashboardUrl(agent.messages);
    if (!url) return msg; // 대시보드 안 만든 흐름(리포트/조회 등)은 건드리지 않음

    var content = msg.content || '';
    if (content.indexOf(url) >= 0) return msg; // 이미 클릭 가능한 링크 포함 → 정상

    console.println('  [guard] dashboard created but final answer omits URL, rescuing');
    var n = countDashboardCharts(agent.messages);
    var hint = '대시보드가 이미 성공적으로 생성·완성되었습니다(' + n + '개 차트, URL: ' + url + '). ' +
      '사과하거나 저장 파일을 재확인하려 하지 말고, 간단한 분석 요약과 함께 반드시 ' +
      '[대시보드 열기](' + url + ') 마크다운 링크를 포함해 최종 답변을 작성하세요.';
    var newMsg = rePromptNoToolCalls(agent, msg, hint);

    // 재유도 후에도 URL 누락(또 혼란) → 결정론적으로 링크 보장. (도구를 다시 부르면 루프가 처리하므로 손대지 않음)
    if ((!newMsg.toolCalls || newMsg.toolCalls.length === 0) && (newMsg.content || '').indexOf(url) < 0) {
      var base = (newMsg.content || '').trim();
      return createMessage('assistant', (base ? base + '\n\n' : '') + '[대시보드 열기](' + url + ')');
    }
    return newMsg;
  },
};

function lastDashboardUrl(msgs) {
  var url = '';
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'tool' && m.content && m.content.indexOf('대시보드 열기') >= 0) {
      var match = /\((https?:\/\/[^\s)]+)\)/.exec(m.content);
      if (match) url = match[1];
    }
  }
  return url;
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

module.exports = DashboardAnswerGuard;
