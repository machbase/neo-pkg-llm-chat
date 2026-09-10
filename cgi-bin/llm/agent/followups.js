// Follow-up question chips shown under a finished answer.
//
// Runs as one extra tool-free LLM call after the answer has already been sent,
// so the chat is never blocked waiting for it. Anything that goes wrong ends as
// an empty list: the UI draws nothing when there are no chips, so a failure is
// invisible rather than broken.
//
// Skipped on ollama. Local models are both the slowest to answer and the least
// reliable at holding a fixed output shape, and they reset context per question
// anyway, so a follow-up chip there buys nothing.

'use strict';

var { createMessage } = require('../llm/types');

var MAX_ITEMS = 3;
// The prompt asks for TARGET; MAX_CHARS is only the safety net that rejects a
// runaway sentence. Keep the gap wide — models overshoot the asked length by a
// clause or two, and a tight net silently drops every candidate.
var TARGET_CHARS = 25;
var MAX_CHARS = 40;
// A table-shaped answer blows past a small cap and gets cut mid-row, leaving
// the model fewer concrete things to point at — which is when it starts
// inventing generic database questions.
var ANSWER_EXCERPT = 2400;

var SYSTEM = '## 역할\n' +
  '당신은 Machbase Neo AI 어시스턴트의 보조입니다.\n' +
  '방금 오간 질문과 답변을 보고, 사용자가 이어서 물어볼 만한 후속 질문을 만드세요.\n\n' +
  '## 출력 형식\n' +
  '- 정확히 ' + MAX_ITEMS + '개를 한 줄에 하나씩 출력하세요.\n' +
  '- 각 줄은 ' + TARGET_CHARS + '자 이내의 짧은 한국어 질문 또는 명령으로 쓰세요.\n' +
  '- 번호, 불릿, 따옴표, 설명은 붙이지 마세요. 질문 문장만 출력하세요.\n\n' +
  '## 무엇을 물을지\n' +
  '- **대상과 동작 둘 다 답변에 근거해야 합니다.** 답변에 나온 테이블명·태그명·컬럼명을 집어서, 그 답변에서 자연스럽게 이어지는 다음 단계를 물으세요.\n' +
  '- 다음 단계란 스키마 확인, 최근 데이터 조회, 기간별 집계, 대상 간 비교, 차트·리포트 작성 같은 것입니다.\n' +
  '- 답변이 이미 말한 내용을 되묻지 마세요.\n\n' +
  '## 무엇을 묻지 말지\n' +
  '- 답변에 없는 새 주제를 꺼내지 마세요. **이름만 답변에서 빌려오고 동작은 지어낸 질문**이 가장 흔한 실패입니다.\n' +
  '- 용량·백업·권한·서버 설정 같은 운영 주제는 답변이 그것을 다뤘을 때만 물으세요.\n';

/** One chip per line; strip the decorations models add anyway. */
function parseItems(text) {
    if (!text) return [];
    var lines = String(text).split('\n');
    var out = [];
    var seen = {};
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i]
            .replace(/^\s*[-*•]\s*/, '')
            .replace(/^\s*\d+[.)]\s*/, '')
            .replace(/^\s*["'`]+|["'`]+\s*$/g, '')
            .trim();
        if (!line) continue;
        // Models like to announce the list before giving it ("다음 질문입니다:")
        // and sometimes fence it. Neither is a chip.
        if (/[:：]$/.test(line)) continue;
        if (/^`{3,}/.test(line)) continue;
        if (line.length > MAX_CHARS) continue;
        if (seen[line]) continue;
        seen[line] = true;
        out.push(line);
        if (out.length >= MAX_ITEMS) break;
    }
    return out;
}

/**
 * @param {object} llmClient  provider client with .chat(messages, toolDefs, cb)
 * @param {string} provider   resolved provider name
 * @param {string} question   what the user asked
 * @param {string} answer     the answer that was just streamed
 * @param {function(string[])} cb  always called, with [] on any failure
 */
function generate(llmClient, provider, question, answer, cb) {
    if (String(provider || '').toLowerCase() === 'ollama') return cb([]);
    if (!question || !answer) return cb([]);

    var excerpt = String(answer).substring(0, ANSWER_EXCERPT);
    var messages = [
        createMessage('system', SYSTEM),
        createMessage('user', '[질문]\n' + question + '\n\n[답변]\n' + excerpt),
    ];

    var done = false;
    function finish(items) {
        if (done) return;
        done = true;
        cb(items);
    }

    try {
        llmClient.chat(messages, [], function (err, resp) {
            if (err) {
                console.println('[Followups] failed: ' + err.message);
                return finish([]);
            }
            var content = resp && resp.message ? resp.message.content : '';
            var items = parseItems(content);
            console.println('[Followups] kept ' + items.length + '/' + MAX_ITEMS);
            finish(items);
        });
    } catch (e) {
        console.println('[Followups] threw: ' + e.message);
        finish([]);
    }
}

module.exports = { generate, parseItems, SYSTEM };
