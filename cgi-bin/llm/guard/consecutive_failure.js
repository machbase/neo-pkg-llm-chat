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
        var hint = toolName + ' 도구가 연속 ' + failures + '회 실패했습니다. 다른 접근법을 사용하세요.';
        if (toolName === 'save_tql_file') {
          hint += ' TEMPLATE 형식(TEMPLATE:ID TABLE:테이블 TAG:태그 UNIT:단위)을 사용하세요.';
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
