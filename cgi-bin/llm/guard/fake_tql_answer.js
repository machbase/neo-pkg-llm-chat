var { rePromptNoToolCalls } = require('./guard');

// 모델이 추측으로 지어낸 가짜 TQL 문법을 최종 답변에 쓴 경우 차단(답변 경로 환각 방지).
// 아래 마커들은 실재하는 Machbase TQL에 절대 없음 — 실제 TQL은 SQL(...) → SCRIPT(...) → CHART(...) 파이프라인.
// 따라서 오탐 0(정상 doc 인용/컴파일 출력엔 이 토큰이 없음). 검증된 TQL은 compile_tql_from_spec로만 생성.
var FAKE_TQL = /CHART_LINE\s*\(|CHART_BAR\s*\(|CHART_SCATTER\s*\(|SRC\s*=\s*SQL|SINK\s*=\s*CHART/i;

var FakeTqlAnswerGuard = {
  name: 'fake_tql_answer',
  check: function (agent, msg) {
    if (msg.toolCalls && msg.toolCalls.length > 0) return msg; // 최종 답변(도구 없음) 차례에만
    var content = msg.content || '';
    if (!FAKE_TQL.test(content)) return msg;

    console.println('  [guard] fake TQL syntax in answer, redirecting to compile_tql_from_spec');
    return rePromptNoToolCalls(agent, msg,
      '방금 답변의 TQL은 실재하지 않는 문법(CHART_LINE/CHART_BAR/SRC=/SINK=/MAP= 등)을 추측해 지어낸 것입니다. ' +
      '직접 작성하지 마세요. describe_table로 대상 테이블의 태그/컬럼/기간을 확인한 뒤 ' +
      'compile_tql_from_spec(filename 없이)로 검증된 TQL을 생성해, 받은 TQL을 그대로 ```tql 코드블록으로 제시하세요. ' +
      '여러 예제가 필요하면 compile_tql_from_spec를 여러 번(다른 spec으로) 호출하세요. 실제 TQL은 SQL(...) → SCRIPT(...) → CHART(...) 형식입니다.');
  },
};

module.exports = FakeTqlAnswerGuard;
