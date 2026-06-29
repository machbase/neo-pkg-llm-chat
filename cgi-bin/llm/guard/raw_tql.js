var { rePromptNoToolCalls } = require('./guard');

// 답변에 들어간 ```tql 코드블록 중, 어떤 도구 결과(compile_tql_from_spec/문서)에도 없는 = 모델이 손으로 쓴 것을 탐지.
// 손으로 쓴 TQL은 시간범위 보정·0건·SQL 검증을 전부 건너뛰어 미래범위/빈 차트/깨진 바인딩이 그대로 나가므로,
// 도구로 다시 생성하도록 재유도(프롬프트 규칙을 약한 모델이 무시하는 경우의 하드 백스톱).
var RawTqlGuard = {
  name: 'raw_tql',
  check: function (agent, msg) {
    if (msg.toolCalls && msg.toolCalls.length > 0) return msg; // 최종 답변(도구 없음) 차례에만
    // compile_tql_from_spec를 쓸 수 있는 흐름에서만(이미 호출 이력이 있으면 사용 가능) — 도구 없는 스킬 오작동 방지
    if (!toolWasCalled(agent.messages, 'compile_tql_from_spec')) return msg;

    var blocks = extractTqlBlocks(msg.content || '');
    if (blocks.length === 0) return msg;

    // 모든 도구 결과 텍스트(검증된 TQL/문서 예제 포함)를 공백 정규화해 한 덩어리로
    var toolNorm = '';
    for (var i = 0; i < agent.messages.length; i++) {
      var m = agent.messages[i];
      if (m.role === 'tool' && m.content) toolNorm += ' ' + String(m.content).replace(/\s+/g, ' ');
    }

    var unbacked = 0;
    for (var b = 0; b < blocks.length; b++) {
      var sql = sqlOf(blocks[b]);
      if (sql && toolNorm.indexOf(sql) < 0) unbacked++; // 도구 결과 어디에도 없는 SQL → 손으로 쓴 것
    }
    if (unbacked === 0) return msg;

    console.println('  [guard] raw_tql: ' + unbacked + ' hand-written TQL block(s) not backed by any tool result');
    var hint = '답변의 TQL 중 ' + unbacked + '개가 도구를 거치지 않고 직접 작성됐습니다. ' +
      '손으로 쓴 TQL은 시간범위 보정·0건·SQL 검증을 건너뛰어 미래 시간범위/빈 차트/깨진 series 바인딩이 그대로 나갑니다. ' +
      '각 예제를 compile_tql_from_spec(filename 없이)로 생성하고, **도구가 돌려준 검증된 TQL만** ```tql 블록에 그대로 넣어 답변을 다시 작성하세요. 손으로 TQL을 쓰지 마세요.';
    return rePromptNoToolCalls(agent, msg, hint);
  },
};

function extractTqlBlocks(content) {
  var blocks = [], re = /```tql\s*([\s\S]*?)```/g, m;
  while ((m = re.exec(content))) blocks.push(m[1]);
  return blocks;
}

// 블록의 SQL(`...`) 안쪽을 공백 정규화해 반환(도구 결과와 substring 매칭용). SQL 없는 블록은 ''(검증 생략).
function sqlOf(block) {
  var m = /SQL\(\s*`([\s\S]*?)`\s*\)/.exec(block);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function toolWasCalled(msgs, name) {
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'assistant' && m.toolCalls) {
      for (var j = 0; j < m.toolCalls.length; j++) {
        if (m.toolCalls[j].function.name === name) return true;
      }
    }
  }
  return false;
}

module.exports = RawTqlGuard;
