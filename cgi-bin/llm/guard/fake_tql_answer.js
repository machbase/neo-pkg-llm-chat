var { rePromptNoToolCalls } = require('./guard');
var docIntent = require('../agent/doc_intent');

// 모델이 추측으로 지어낸 가짜 TQL 문법을 최종 답변에 쓴 경우 차단(답변 경로 환각 방지).
// ⚠️ CHART_LINE/CHART_BAR/CHART_SCATTER는 넣지 말 것 — 레거시지만 **실재하는** 싱크로 문서 예제에 다수 등장
//   (tql-guide.md Getting Started, tql-fft.md 등. tql-reading.md가 deprecated로 명시) → 문서 인용 답변이 오탐됨.
// SRC(/SINK(는 공백 없는 코드형만(문서 산문 "SRC (Data Source)"는 공백+괄호), SRC=SQL은 대소문자 구분
//   (ODBC 예제의 C 변수 'sRC = SQLAppendDataV2' 오탐 방지). 좌측 경계로 DATASRC( 류 합성어 제외.
var FAKE_TQL = /(^|[^A-Za-z0-9_])(SRC\s*=\s*SQL|SINK\s*=\s*CHART|SRC\(|SINK\()/;

var FakeTqlAnswerGuard = {
  name: 'fake_tql_answer',
  check: function (agent, msg) {
    if (msg.toolCalls && msg.toolCalls.length > 0) return msg; // 최종 답변(도구 없음) 차례에만
    var content = msg.content || '';
    if (!FAKE_TQL.test(content)) return msg;

    // DocLookup 문서 모드(= agent.js EXCEPTION 불성립: 예제요청 AND 실재테이블명 둘 다가 아님)에서는
    // compile/describe가 결정론 가드로 차단되므로 "compile로 생성하라" 조언이 모순(핑퐁 유발).
    // 문서 예제 인용으로 유도한다. 조건은 agent.js의 _exception과 동일하게 계산(캐시 재사용).
    var _q = agent.currentQuery || '';
    var _exception = docIntent.wantsExample(_q) &&
      !!docIntent.mentionsTable(_q, agent._docTableNames !== undefined ? agent._docTableNames : null);
    if (agent.skillName === 'DocLookup' && !_exception) {
      console.println('  [guard] fake TQL syntax in doc-mode answer, redirecting to doc quotation');
      return rePromptNoToolCalls(agent, msg,
        '방금 답변의 TQL 예제는 검증되지 않은 추측 문법(SRC(...)/SINK(...) 등)으로 지어낸 것입니다. ' +
        '답변을 다시 쓰되: **개념 설명(정의→용도→핵심 구성요소)은 그대로 유지**하고, 예제 부분만 방금 읽은 문서의 ' +
        '실제 코드 예제 **1~2개**를 한 글자도 바꾸지 말고 그대로 인용해 교체하세요(필요하면 extract_code_blocks로 추출, ' +
        '문서에 예제가 없으면 예제 생략). 사과·정정 과정 언급·문서 파일 경로(.md) 언급 금지 — 완성된 최종 답변만 새로 쓰세요.');
    }

    console.println('  [guard] fake TQL syntax in answer, redirecting to compile_tql_from_spec');
    return rePromptNoToolCalls(agent, msg,
      '방금 답변의 TQL은 검증되지 않은 추측 문법(SRC=/SINK=/SRC(...) 등)으로 지어낸 것입니다. ' +
      '직접 작성하지 마세요. describe_table로 대상 테이블의 태그/컬럼/기간을 확인한 뒤 ' +
      'compile_tql_from_spec(filename 없이)로 검증된 TQL을 생성해, 받은 TQL을 그대로 ```tql 코드블록으로 제시하세요. ' +
      '여러 예제가 필요하면 compile_tql_from_spec를 여러 번(다른 spec으로) 호출하세요. 실제 TQL은 SQL(...) → SCRIPT(...) → CHART(...) 형식입니다.');
  },
};

module.exports = FakeTqlAnswerGuard;
