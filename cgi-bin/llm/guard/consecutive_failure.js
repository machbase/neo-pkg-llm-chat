var { rePrompt } = require('./guard');

// Triggers when same tool fails 2+ times consecutively
var ConsecutiveFailureGuard = {
  name: 'consecutive_failure',
  check: function (agent, msg) {
    if (!msg.toolCalls || msg.toolCalls.length === 0) return msg;

    for (var i = 0; i < msg.toolCalls.length; i++) {
      var toolName = msg.toolCalls[i].function.name;
      var failures = countConsecutiveFailures(agent.messages, toolName);
      if (failures >= 2) {
        console.println('  [guard] ' + toolName + ' failed ' + failures + 'x consecutively, re-prompting');
        var hint;
        if (failures >= 4 && (toolName === 'save_tql_file' || toolName === 'compile_tql_from_spec')) {
          // 무한 루프 방지: 그만 포기하고 지금까지 성공한 차트로 마무리하도록 유도
          hint = toolName + ' 이 ' + failures + '회 연속 실패했습니다. 이 차트는 **포기하고 건너뛰세요.** 같은 차트를 또 시도하지 말고, 지금까지 저장에 성공한 .tql 파일들만으로 **즉시 create_dashboard_with_charts를 호출**해 대시보드를 완성하고 작업을 끝내세요.';
        } else {
          hint = toolName + ' 도구가 연속 ' + failures + '회 실패했습니다. 에러 메시지를 다시 읽고 고치세요.';
          if (toolName === 'compile_tql_from_spec') {
            hint += ' 이 도구는 **spec(JSON)만** 받습니다(raw TQL 아님). 에러 메시지(TIR invalid 등)대로 **spec의 잘못된 필드만 고쳐 재호출**하세요. raw TQL을 직접 쓰거나 save_tql_file로 전환하지 마세요(특수 차트가 아닌 한).';
          } else if (toolName === 'save_tql_file') {
            hint += ' 가능하면 raw TQL 대신 compile_tql_from_spec(spec)로 생성하세요(문법/레이아웃을 서버가 보장). 꼭 raw가 필요하면 CHART 옵션은 `CHART(tz(\'Asia/Seoul\'), chartOption({ ... }))` 안에 넣으세요(title/grid/series를 CHART()에 직접 쓰면 "no sink"/"invalid token" 에러).';
          }
        }
        return rePrompt(agent, msg, hint);
      }
    }
    return msg;
  },
};

function countConsecutiveFailures(msgs, toolName) {
  var count = 0;
  for (var i = msgs.length - 1; i >= 0; i--) {
    var m = msgs[i];
    if (m.role === 'tool') {
      var content = m.content.toLowerCase();
      // 가드가 끼워넣은 취소 마커(rePrompt의 'cancelled: redirecting' / 결정론적 차단의 '취소됨')는
      // 실패 스트릭을 끊지 않음 → give-up 에스컬레이션(>=4)이 신뢰성 있게 누적되도록.
      if (content.indexOf('cancelled') >= 0 || content.indexOf('redirecting') >= 0 || content.indexOf('취소됨') >= 0) {
        continue;
      }
      if (content.indexOf('failed') >= 0 || content.indexOf('error') >= 0 || content.indexOf('failure') >= 0) {
        count++;
      } else {
        break;
      }
    } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      var hasTarget = false;
      for (var j = 0; j < m.toolCalls.length; j++) {
        if (m.toolCalls[j].function.name === toolName) hasTarget = true;
      }
      if (!hasTarget) break;
    } else if (m.role === 'user') {
      continue;
    } else {
      break;
    }
  }
  return count;
}

module.exports = ConsecutiveFailureGuard;
