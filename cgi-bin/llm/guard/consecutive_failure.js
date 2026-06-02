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
        if (failures >= 4 && toolName === 'save_tql_file') {
          // 무한 루프 방지: 그만 포기하고 지금까지 성공한 차트로 마무리하도록 유도
          hint = 'save_tql_file 이 ' + failures + '회 연속 실패했습니다. 이 차트는 **포기하고 건너뛰세요.** 같은 파일을 또 저장하려 하지 말고, 지금까지 저장에 성공한 .tql 파일들만으로 **즉시 create_dashboard_with_charts를 호출**해 대시보드를 완성하고 작업을 끝내세요.';
        } else {
          hint = toolName + ' 도구가 연속 ' + failures + '회 실패했습니다. 에러 메시지를 다시 읽고 고치세요.';
          if (toolName === 'save_tql_file') {
            hint += ' CHART 옵션은 반드시 `chartOption({ ... })` 안에 넣으세요(title/grid/series를 CHART()에 직접 쓰면 안 됨) — 형식: `CHART(tz(\'Asia/Seoul\'), chartOption({ ... }))`. 골격은 tql/tql-chart-conventions.md 를 그대로 복사해 TABLE/TAG/기간만 바꾸세요. (TEMPLATE 문법 없음 — raw TQL 직접 작성)';
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
