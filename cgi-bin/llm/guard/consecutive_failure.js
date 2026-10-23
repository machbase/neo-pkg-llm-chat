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
        if (failures >= 4 && toolName === 'compile_tql_from_spec') {
          // 무한 루프 방지: 그만 포기하고 지금까지 성공한 결과로 마무리하도록 유도
          // · 대시보드 도구가 있는 단계만 대시보드 완성 지시, 없으면(문서 예제·조회 등) 답변 지시
          if (hasTool(agent, 'create_dashboard_with_charts')) {
            hint = toolName + ' 이 ' + failures + '회 연속 실패했습니다. 이 차트는 **포기하고 건너뛰세요.** 같은 차트를 또 시도하지 말고, 지금까지 저장에 성공한 .tql 파일들만으로 **즉시 create_dashboard_with_charts를 호출**해 대시보드를 완성하고 작업을 끝내세요.';
          } else {
            hint = toolName + ' 이 ' + failures + '회 연속 실패했습니다. 이 예제는 **포기하고 건너뛰세요.** 같은 호출을 또 시도하지 말고, 지금까지 성공한 결과와 확인한 내용만으로 **바로 답변을 작성**하고 작업을 끝내세요.';
          }
        } else {
          hint = toolName + ' 도구가 연속 ' + failures + '회 실패했습니다. 에러 메시지를 다시 읽고 고치세요.';
          if (toolName === 'compile_tql_from_spec') {
            hint += ' 이 도구는 **spec(JSON)만** 받습니다(raw TQL 아님). 에러 메시지(TIR invalid 등)대로 **spec의 잘못된 필드만 고쳐 재호출**하세요. raw TQL을 직접 쓰지 마세요.';
          }
        }
        return rePrompt(agent, msg, hint);
      }
    }
    return msg;
  },
};

// 이번 호출에서 쓸 수 있는 도구인지
function hasTool(agent, name) {
  var tools = agent._activeTools || agent.toolDefs || [];
  for (var i = 0; i < tools.length; i++) {
    if (tools[i].function && tools[i].function.name === name) return true;
  }
  return false;
}

function countConsecutiveFailures(msgs, toolName) {
  var count = 0;
  for (var i = msgs.length - 1; i >= 0; i--) {
    var m = msgs[i];
    if (m.role === 'tool') {
      var content = m.content.toLowerCase();
      // 가드 취소 마커(rePrompt의 'cancelled: redirecting' / 결정론적 차단의 '취소됨')는 스트릭 유지
      // — 포기 에스컬레이션(>=4) 누적용
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
