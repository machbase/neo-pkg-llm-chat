var { createMessage } = require('../llm/types');

// 답변경로(filename 없는) compile_tql_from_spec 검증 TQL을 최종 답변에 결정론적으로 삽입
// · 프론트가 답변의 ```tql 실행 → 모델이 옮기다 누락·손상하거나 사과문만 남기는 것 방지
// · 모델이 정확히 다 넣었으면 무개입, 누락·손상 시에만 모델 ```tql 제거 후 canonical로 교체
// · forecast_table은 결과 본문 전체를 collectForecastBodies로 정본화
var TqlInjectGuard = {
  name: 'tql_inject',
  check: function (agent, msg) {
    if (msg.toolCalls && msg.toolCalls.length > 0) return msg; // 최종 답변(도구 없음) 차례에만

    // ⚠️ 수집 범위 = 현재 턴만 — 세션 전체 스캔 시 이전 질문 forecast 결과까지 답변에 겹쳐 붙음
    var msgs = currentTurnMsgs(agent);

    // ── forecast_table: 도구 결과가 곧 답변 본문, 모델은 리드 문장만 허용 ──
    // · 표 개별 강제 시 나머지 표를 모델이 풀어씀 → 레이아웃 전체를 도구가 확정
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

    // 리더보드 표 본문 누락 시 삽입 — 모델이 산문 요약만 쓰고 표 생략하는 경우 대응
    var missBoards = [];
    for (i = 0; i < boards.length; i++) {
      if (normContent.indexOf(norm(tableOf(boards[i]))) < 0) missBoards.push(boards[i]);
    }

    // 메타 문구(차트 블록 설명·사과·도구 지시문 복사)는 누락 없어도 제거 — 프롬프트 지시로 안 막힘
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
    // 범례는 차트 뒤 배치 — 모델이 차트 위에 쓰거나 임의로 풀어쓰는 것 방지
    var legend = collectCanonicalLegend(msgs);
    if (blocks && legend) out += '\n\n' + legend;
    return createMessage('assistant', out);
  },
};

function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

// 현재 턴 메시지만 추출 — 현재 질문을 포함하는 마지막 user 메시지부터 끝까지
// · 등호 비교 금지 — 실제 user 메시지엔 스킬 힌트가 덧붙음
// · 앵커 없으면 마지막 user 메시지로 폴백, 세션 전체 스캔 안 함
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
// 리더보드 존재 판정은 표 본문(| … | 행)으로만 — 안내 문구만 베끼고 표는 빠뜨린 경우 탐지용
function tableOf(lb) {
  return String(lb).split('\n').filter(function (ln) { return /^\s*\|/.test(ln); }).join('\n');
}
// ⚠️ ```tql 다음 줄바꿈 필수 — `\s*`면 산문 속 인라인 언급("위의 ```tql 블록은 …")을
//    펜스 시작으로 오인해 다음 ```까지 답변 통째 삭제
function countTqlBlocks(s) { var re = /```tql\r?\n[\s\S]*?```/g, n = 0; while (re.exec(s)) n++; return n; }
function stripTqlBlocks(s) { return String(s).replace(/```tql\r?\n[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n'); }
// 재구성 시 메타 문구 줄 제거
// · ① 사과 잔재("죄송합니다…빠뜨렸습니다")
// · ② 차트 블록 자체를 설명하는 문장("위의 ```tql 블록은 … 상세 예측 차트입니다") — 차트를 보는 사용자에겐 노이즈
function cleanProse(s) {
  return String(s).split('\n').filter(function (ln) {
    if (/죄송|빠뜨|다시\s*제시|코드블록을\s*빠|차트를?\s*다시/.test(ln)) return false;
    if (/(tql|코드)\s*블록/.test(ln) || /블록은/.test(ln)) return false;
    if (/\[지시[·,]?\s*답변에\s*옮기지/.test(ln)) return false; // 도구 지시문을 그대로 베낀 경우
    // 모델이 차트 위에 쓴 자작 범례·차트 안내 제거 — 정본 범례는 차트 뒤에 재부착
    // · 정본 범례를 옮겨 적은 줄도 제거 — 안 지우면 재구성 시 위·아래 두 번 출력
    if (/^실측\(파란 실선\)/.test(ln.trim())) return false;
    if (/아래\s*차트|차트에서.*확인|파란\s*(색\s*)?선|주황\s*(색\s*)?점선|시각적으로\s*확인/.test(ln)) return false;
    return true;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 도구 결과에서 검증된 답변경로 TQL 추출(중복 제거) — compile_tql_from_spec(filename 없음)만
// · toolCall↔tool 결과는 pending 큐로 페어링
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
        // ```tql 다음 줄바꿈 요구 — 안내문 인라인 언급("(```tql 블록 …)") 제외, 실제 코드펜스만 매치
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

// forecast_table 결과의 모델 비교 표(리더보드) 추출 — 저장·인라인 경로 모두 대상
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
        // 끝 경계 = 차트 지시문·코드펜스·문자열 끝 — 꼬리 문구 의존 시 문구 수정마다 깨짐
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

// forecast_table 도구 결과 본문 전체(모델용 지시문만 제거) — 예측 답변 정본
// ⚠️ 중복 제거 필수 — 약한 모델이 "데이터 부족" 후 rollup만 바꿔 같은 호출 반복 시 같은 표 N번 반복
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
      // 되묻기(태그 5개 초과)·데이터 부족 등 본문 아닌 응답은 정본화 제외 — 모델이 자연어로 풀어야 함
      // · 마커 = 요약표에 항상 포함되는 '지표 읽는 법'(METRIC_LEGEND), 리포트 생성 실패 시에도 요약표는 출력
      if (c.indexOf('지표 읽는 법') < 0) continue;
      // 모델용 지시문([지시…] 줄) 제거
      var body = c.replace(/\n*\[지시[^\n]*\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      var k = norm(body);
      if (!seen[k]) { seen[k] = 1; out.push(body); }
    }
  }
  return out;
}

// 모델 산문에서 리드만 추출 — 표·제목·불릿 시작(도구 결과 재작성 시작) 지점에서 절단
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

// 렌더 실패할 강조 제거 — 닫는 `**` 앞이 구두점·뒤가 조사면 CommonMark상 미종료로 별표 노출
// · 예: "**1위 prophet (26.6%)**이"
function fixBrokenBold(s) {
  return String(s).replace(/\*\*([^*\n]*[^\w\s*])\*\*(?=[가-힣])/g, '$1');
}

// forecast_table 결과의 차트 범례 한 줄(도구가 ```tql 뒤에 붙인 것) — 답변에서도 차트 뒤 배치
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
