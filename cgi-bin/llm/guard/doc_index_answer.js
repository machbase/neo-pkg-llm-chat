var { rePromptNoToolCalls } = require('./guard');

// DocLookup 마지막 문서 도구 결과가 "섹션 목록/탐색 안내"뿐인데 재조회 없이 최종 답변 → 본문 조회 강제
// · 목록 제목·자체 지식으로 지어낸 답변, section= 안내 에코 방지
// · 마커는 docs.js 안내문과 동기화: 사용 가능한 섹션(sectionIndex)·섹션 구분 없음(모놀리식 무인자)
//   ·가 이 문서에 없습니다(모놀리식 키워드 미스)·No match for:(검색 미스)
var INDEX_MARKERS = ['사용 가능한 섹션', '섹션 구분 없음', '가 이 문서에 없습니다', 'No match for:'];

var DocIndexAnswerGuard = {
  name: 'doc_index_answer',
  check: function (agent, msg) {
    if (msg.toolCalls && msg.toolCalls.length > 0) return msg; // 최종 답변 차례에만
    if (agent.skillName !== 'DocLookup') return msg;
    if (agent._docIndexNudged) return msg; // 쿼리당 1회만(교정 실패 시 루프 방지, 답변은 내보냄)

    var last = null;
    for (var i = agent.messages.length - 1; i >= 0; i--) {
      if (agent.messages[i].role === 'tool') { last = String(agent.messages[i].content || ''); break; }
    }
    if (!last) return msg;
    var isIndex = false;
    for (var k = 0; k < INDEX_MARKERS.length; k++) {
      if (last.indexOf(INDEX_MARKERS[k]) >= 0) { isIndex = true; break; }
    }
    if (!isIndex) return msg;

    agent._docIndexNudged = true;
    console.println('  [guard] doc_index_answer: 섹션 목록/안내만 받고 답변 시도 → 본문 조회 재유도');
    return rePromptNoToolCalls(agent, msg,
      '방금 받은 도구 결과는 문서 본문이 아니라 목록/안내문입니다. 그것만 보고 답하면 내용을 지어내게 됩니다. ' +
      '안내에 따라 도구를 다시 호출해 — 섹션 목록이면 질문과 가장 맞는 **영어 섹션 제목**을 section=에 넣어 같은 문서를 재조회, ' +
      '검색 미스면 다른 키워드(영어 권장)로 재검색 — 본문을 읽은 뒤 그 내용으로 답변하세요.');
  },
};

module.exports = DocIndexAnswerGuard;
