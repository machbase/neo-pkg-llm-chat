var { createMessage } = require('../llm/types');

// 답변경로(filename 없는) compile_tql_from_spec는 **검증된 ```tql**을 도구 결과로 돌려준다.
// (forecast_table은 v3.0부터 인라인 ```tql을 반환하지 않는다 — 결과 본문 전체를 collectForecastBodies가 정본화.)
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

    // ⚠️ 수집 범위 = **현재 턴만**. 세션 전체(agent.messages)를 스캔했더니 이전 질문들의 forecast 결과까지
    //    끌려와 답변에 SILVER+BEARING×2 세 덩어리가 붙은 실사례("이건 뭐지"). 정본은 이번 질문의 도구 결과뿐이다.
    var msgs = currentTurnMsgs(agent);

    // ── forecast_table: **도구 결과가 곧 답변 본문**. 모델에겐 리드 한 문장만 허용한다. ──
    // 표 하나(리더보드)를 강제하면 다른 표(태그 요약)를 자기 말로 풀어쓰고, 그것도 막으면 또 다른 데서 샌다.
    // 부분 강제는 두더지잡기가 된다 → 예측 답변은 **레이아웃 전체를 도구가 확정**하고 모델은 요약 문장만 얹는다.
    var fcBodies = collectForecastBodies(msgs);
    if (fcBodies.length) {
      var lead = leadOf(msg.content || '');
      var body = (lead ? lead + '\n\n' : '') + fcBodies.join('\n\n---\n\n');
      if (norm(body) === norm(msg.content || '')) return msg; // 이미 동일 → 무개입
      console.println('  [guard] tql_inject: forecast answer rebuilt from canonical tool body (lead ' +
        (lead ? lead.length + 'ch' : 'none') + ')');
      return createMessage('assistant', body);
    }

    var canon = collectCanonicalTqls(msgs);
    var boards = collectCanonicalBoards(msgs);
    if (canon.length === 0 && boards.length === 0) return msg; // 주입 대상 없음

    var content = msg.content || '';
    var normContent = norm(content);

    var tqlOk = true, i;
    for (i = 0; i < canon.length; i++) {
      if (normContent.indexOf(norm(canon[i])) < 0) { tqlOk = false; break; }
    }
    if (tqlOk && countTqlBlocks(content) < canon.length) tqlOk = false;

    // 리더보드도 모델이 **산문으로 요약해버리고 표는 안 옮기는** 일이 잦다("1위 prophet 26.6%"만 쓰고 표는 생략).
    // → TQL과 동일하게, 표 본문이 그대로 있는지 확인하고 없으면 박아 넣는다.
    var missBoards = [];
    for (i = 0; i < boards.length; i++) {
      if (normContent.indexOf(norm(tableOf(boards[i]))) < 0) missBoards.push(boards[i]);
    }

    // 메타 문구(차트 블록 설명·사과·도구 지시문 복사)는 **누락이 없어도** 걷어낸다 — 프롬프트로는 안 지켜졌다.
    var proseRaw = stripTqlBlocks(content);
    var prose = cleanProse(proseRaw);
    var hadMeta = norm(prose) !== norm(proseRaw);

    if (tqlOk && missBoards.length === 0 && !hadMeta) return msg; // 모델이 다 넣고 군더더기도 없음 → 그대로(최소 개입)

    console.println('  [guard] tql_inject: injecting ' + (tqlOk ? 0 : canon.length) + ' TQL + ' +
      missBoards.length + ' leaderboard block(s)' + (hadMeta ? ', stripped meta prose' : ''));
    var blocks = '';
    for (var j = 0; j < canon.length; j++) {
      blocks += (blocks ? '\n\n' : '') + '```tql\n' + canon[j] + '\n```';
    }
    var out = prose || (canon.length ? '아래 검증된 차트입니다:' : '');
    for (i = 0; i < missBoards.length; i++) out += (out ? '\n\n' : '') + missBoards[i];
    if (blocks) out += (out ? '\n\n' : '') + blocks;
    // 범례는 **차트 뒤**. 모델은 이걸 차트 위에 쓰거나 제멋대로 풀어쓴다("아래 차트에서 실측(파란선)…을 확인할 수 있습니다").
    var legend = collectCanonicalLegend(msgs);
    if (blocks && legend) out += '\n\n' + legend;
    return createMessage('assistant', out);
  },
};

function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

// 현재 턴의 메시지만 잘라낸다: **현재 질문을 포함하는** 마지막 user 메시지부터 끝까지.
// 등호 비교는 금지 — 실제 user 메시지엔 스킬 힌트가 덧붙는다(lastDescribedTable에서 이미 밟은 함정).
// 앵커를 못 찾으면(비정상) 마지막 user 메시지로 폴백 — 어느 쪽이든 세션 전체 스캔은 하지 않는다.
function currentTurnMsgs(agent) {
  var msgs = agent.messages || [], q = String(agent.currentQuery || ''), i;
  for (i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && q && String(msgs[i].content || '').indexOf(q) >= 0) return msgs.slice(i);
  }
  for (i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') return msgs.slice(i);
  }
  return msgs;
}
// 리더보드 존재 판정은 **표 본문**(| … | 행)으로만 한다 — 모델이 안내 문구만 베끼고 표는 빼먹는 경우를 잡기 위해.
function tableOf(lb) {
  return String(lb).split('\n').filter(function (ln) { return /^\s*\|/.test(ln); }).join('\n');
}
// ⚠️ ```tql **다음 줄바꿈**을 반드시 요구한다. `\s*`로 두면 산문 속 인라인 언급("위의 ```tql 블록은 …")을
//    코드펜스 시작으로 오인해 거기서부터 다음 ```까지 **답변을 통째로 먹어버린다**(실제로 그렇게 깨졌다).
function countTqlBlocks(s) { var re = /```tql\r?\n[\s\S]*?```/g, n = 0; while (re.exec(s)) n++; return n; }
function stripTqlBlocks(s) { return String(s).replace(/```tql\r?\n[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n'); }
// 재구성 시 **메타 문구** 줄 제거.
//  ① 사과 잔재("죄송합니다…빠뜨렸습니다")
//  ② 차트 블록 자체를 설명하는 군더더기("위의 ```tql 블록은 … 상세 예측 차트입니다") —
//     사용자는 차트를 **보고 있다**. 블록을 설명하는 문장은 언제나 노이즈다(모델이 도구 지시문을 답변으로 옮긴 흔적).
function cleanProse(s) {
  return String(s).split('\n').filter(function (ln) {
    if (/죄송|빠뜨|다시\s*제시|코드블록을\s*빠|차트를?\s*다시/.test(ln)) return false;
    if (/(tql|코드)\s*블록/.test(ln) || /블록은/.test(ln)) return false;
    if (/\[지시[·,]?\s*답변에\s*옮기지/.test(ln)) return false; // 도구 지시문을 그대로 베낀 경우
    // 모델이 차트 **위에** 써놓는 자작 범례/차트 안내 → 제거. 정본 범례는 차트 **뒤에** 다시 붙인다.
    // (정본 범례를 모델이 옮겨 적은 경우도 여기서 지운다 — 안 지우면 재구성 때 위·아래 **두 번** 나온다.)
    if (/^실측\(파란 실선\)/.test(ln.trim())) return false;
    if (/아래\s*차트|차트에서.*확인|파란\s*(색\s*)?선|주황\s*(색\s*)?점선|시각적으로\s*확인/.test(ln)) return false;
    return true;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 검증된 답변경로 TQL을 도구 결과에서 추출(중복 제거). compile_tql_from_spec(filename 없음)만.
// chart_omission/tql_omission의 toolCall↔tool결과 페어링(pending 큐) 방식.
function collectCanonicalTqls(msgs) {
  var out = [], seen = {}, pending = [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'assistant' && m.toolCalls) {
      pending = [];
      for (var j = 0; j < m.toolCalls.length; j++) {
        var tc = m.toolCalls[j], isAns = false;
        if (tc.function && tc.function.name === 'compile_tql_from_spec') {
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

// forecast_table 결과의 **모델 비교** 표(리더보드)를 추출. 저장/인라인 경로 모두 대상(리더보드는 어느 쪽이든 답변에 있어야 할 정보).
function collectCanonicalBoards(msgs) {
  var out = [], seen = {}, pending = [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'assistant' && m.toolCalls) {
      pending = [];
      for (var j = 0; j < m.toolCalls.length; j++) {
        var tc = m.toolCalls[j];
        pending.push(!!(tc.function && tc.function.name === 'forecast_table'));
      }
    } else if (m.role === 'tool' && pending.length > 0) {
      var isFc = pending.shift();
      if (isFc && m.content && m.content.indexOf('Error:') !== 0) {
        // 끝 경계는 **차트 지시문/코드펜스/문자열 끝**으로 잡는다(꼬리 문구에 의존하면 문구를 손볼 때마다 조용히 깨진다).
        var mt = /\*\*모델 비교\*\*[\s\S]*?(?=\n\n\[지시|\n\n```tql|$)/.exec(m.content);
        if (mt) {
          var lb = mt[0], k = norm(lb);
          if (!seen[k]) { seen[k] = 1; out.push(lb); }
        }
      }
    }
  }
  return out;
}

// forecast_table 도구 결과의 **본문 전체**(모델용 지시문만 제거). 이게 예측 답변의 정본이다.
// ⚠️ **중복 제거 필수**: 약한 모델이 "데이터 부족"을 받고 rollup만 바꿔 같은 호출을 반복하면 동일 본문이 N개 쌓이고,
//    전부 이어붙이면 답변에 같은 표가 N번 반복된다(BEARING에서 6회 반복 실사례).
function collectForecastBodies(msgs) {
  var out = [], seen = {}, pending = [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'assistant' && m.toolCalls) {
      pending = [];
      for (var j = 0; j < m.toolCalls.length; j++) {
        var tc = m.toolCalls[j];
        pending.push(!!(tc.function && tc.function.name === 'forecast_table'));
      }
    } else if (m.role === 'tool' && pending.length > 0) {
      var isFc = pending.shift();
      if (!isFc || !m.content) continue;
      var c = String(m.content);
      if (c.indexOf('Error:') === 0) continue;
      // 되묻기(태그 5개 초과)·데이터부족 같은 **본문 아닌 응답**은 모델이 자연어로 풀어야 하니 정본화하지 않는다.
      // 마커는 요약표에 **항상** 들어가는 '지표 읽는 법'(METRIC_LEGEND) — 리포트 생성 실패 시에도 요약표는 나온다.
      if (c.indexOf('지표 읽는 법') < 0) continue;
      // 모델용 지시문([지시…] 줄)은 답변에 나가면 안 된다.
      var body = c.replace(/\n*\[지시[^\n]*\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      var k = norm(body);
      if (!seen[k]) { seen[k] = 1; out.push(body); }
    }
  }
  return out;
}

// 모델 프로즈에서 **리드만** 추출: 표/제목/불릿이 시작되면 거기서 끊는다(= 도구 결과를 자기 말로 다시 쓰기 시작한 지점).
function leadOf(s) {
  var p = cleanProse(stripTqlBlocks(String(s || '')));
  var lines = p.split('\n'), out = [];
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i].trim();
    if (!ln) { if (out.length) break; else continue; }
    if (/^[|#>\-*•\d]/.test(ln)) break; // 표·헤딩·불릿·번호목록 → 재작성 시작
    out.push(ln);
    if (out.length >= 2) break;
  }
  return fixBrokenBold(out.join(' '));
}

// 한국어에서 **…(26.6%)**이 처럼 **닫는 `**` 앞이 구두점 + 뒤가 조사**면 CommonMark상 강조가 닫히지 않아
// 별표가 그대로 노출된다("**1위 prophet (26.6%)**이"). 렌더 실패할 강조는 그냥 벗긴다.
function fixBrokenBold(s) {
  return String(s).replace(/\*\*([^*\n]*[^\w\s*])\*\*(?=[가-힣])/g, '$1');
}

// forecast_table 결과의 **차트 범례 한 줄**(도구가 ```tql 뒤에 붙여 보낸 것). 답변에서도 차트 뒤에 와야 한다.
function collectCanonicalLegend(msgs) {
  for (var i = msgs.length - 1; i >= 0; i--) {
    var m = msgs[i];
    if (m.role !== 'tool' || !m.content) continue;
    var mt = /^실측\(파란 실선\)[^\n]*/m.exec(m.content);
    if (mt) return mt[0];
  }
  return '';
}

function parseArgs(tc) {
  var a = tc.function && tc.function.arguments;
  if (!a) return {};
  if (typeof a === 'string') { try { return JSON.parse(a); } catch (e) { return {}; } }
  return a;
}

module.exports = TqlInjectGuard;
