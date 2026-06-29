var { createMessage } = require('../llm/types');

// 답변경로(filename 없는) compile_tql_from_spec / forecast_table는 **검증된 ```tql**을 도구 결과로 돌려준다.
// 그 차트가 화면에 그려지려면 그 ```tql이 모델의 **최종 답변 텍스트**에 들어가야 한다(프론트가 답변의 ```tql을 실행).
// 그런데 모델은 긴 TQL을 답변에 옮기다 **누락/손상**(쉼표 빠뜨림·잘림)하거나, 재촉받으면 "죄송합니다…빠뜨렸습니다"
// 같은 사과문만 뱉어 그게 답변으로 새어나온다.
//
// → 재촉(rePrompt)에 의존하지 않고, 하네스가 도구 결과의 **검증된 TQL을 답변에 결정론적으로 직접 박는다**(컴파일러 출력 == 렌더 보장).
//   (dashboard_answer가 대시보드 URL을 결정론적으로 붙이는 것과 같은 원리.)
//   모델이 이미 정확히 다 넣었으면 건드리지 않는다(최소 개입). 누락·손상 시에만 모델의 ```tql을 제거하고 canonical로 교체.
var TqlInjectGuard = {
  name: 'tql_inject',
  check: function (agent, msg) {
    if (msg.toolCalls && msg.toolCalls.length > 0) return msg; // 최종 답변(도구 없음) 차례에만

    var canon = collectCanonicalTqls(agent.messages);
    if (canon.length === 0) return msg; // 답변경로 검증 TQL이 없으면 대상 아님

    var content = msg.content || '';
    var normContent = norm(content);
    var allPresent = true;
    for (var i = 0; i < canon.length; i++) {
      if (normContent.indexOf(norm(canon[i])) < 0) { allPresent = false; break; }
    }
    if (allPresent && countTqlBlocks(content) >= canon.length) return msg; // 모델이 정확히 다 넣음 → 그대로

    console.println('  [guard] tql_inject: deterministically injecting ' + canon.length + ' validated TQL block(s) (model omitted/corrupted)');
    // 결정론적 재구성: 모델의 ```tql(누락/손상 가능)은 제거, 산문은 유지하되 사과/메타 문구는 걸러냄, 검증된 canonical 블록을 붙인다.
    // (재촉을 안 하므로 사과문은 보통 안 생기지만, 방어적으로 제거 → "죄송합니다…빠뜨렸습니다" 누출 0)
    var prose = cleanProse(stripTqlBlocks(content));
    var blocks = '';
    for (var j = 0; j < canon.length; j++) {
      blocks += (blocks ? '\n\n' : '') + '```tql\n' + canon[j] + '\n```';
    }
    var lead = prose ? prose + '\n\n' : '아래 검증된 차트입니다:\n\n';
    return createMessage('assistant', lead + blocks);
  },
};

function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function countTqlBlocks(s) { var re = /```tql\s*[\s\S]*?```/g, n = 0; while (re.exec(s)) n++; return n; }
function stripTqlBlocks(s) { return String(s).replace(/```tql\s*[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n'); }
// 재구성 시 사과/메타 문구 줄 제거(모델이 차트를 빠뜨려 사과하는 잔재가 답변에 남지 않게).
function cleanProse(s) {
  return String(s).split('\n').filter(function (ln) {
    return !/죄송|빠뜨|다시\s*제시|코드블록을\s*빠|차트를?\s*다시/.test(ln);
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 검증된 답변경로 TQL을 도구 결과에서 추출(중복 제거). compile_tql_from_spec/forecast_table(둘 다 filename 없음)만.
// chart_omission/tql_omission의 toolCall↔tool결과 페어링(pending 큐) 방식.
function collectCanonicalTqls(msgs) {
  var out = [], seen = {}, pending = [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'assistant' && m.toolCalls) {
      pending = [];
      for (var j = 0; j < m.toolCalls.length; j++) {
        var tc = m.toolCalls[j], isAns = false;
        if (tc.function && (tc.function.name === 'compile_tql_from_spec' || tc.function.name === 'forecast_table')) {
          var args = parseArgs(tc);
          if (!args.filename) isAns = true; // filename 없음 = 답변/인라인 경로(저장경로는 tql_path라 모델이 복사 안 함)
        }
        pending.push(isAns);
      }
    } else if (m.role === 'tool' && pending.length > 0) {
      var ans = pending.shift();
      if (ans && m.content && m.content.indexOf('Error:') !== 0) {
        // ```tql **다음 줄바꿈**을 요구 → 도구 결과 안내문의 inline 언급("(```tql 블록 …)")이 아니라 실제 코드펜스만 매치.
        var mt = /```tql\r?\n([\s\S]*?)```/.exec(m.content);
        if (mt) {
          var tql = mt[1].replace(/^\n+/, '').replace(/\s+$/, '');
          var k = norm(tql);
          if (tql && !seen[k]) { seen[k] = 1; out.push(tql); }
        }
      }
    }
  }
  return out;
}

function parseArgs(tc) {
  var a = tc.function && tc.function.arguments;
  if (!a) return {};
  if (typeof a === 'string') { try { return JSON.parse(a); } catch (e) { return {}; } }
  return a;
}

module.exports = TqlInjectGuard;
