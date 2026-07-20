var { createMessage } = require('../llm/types');

// save_html_report(일반 분석 리포트)를 만들어놓고 답변에서 **"예측 리포트"라고 부르는 것**을 막는다.
//
// 사용자가 "예측 리포트 만들어줘"라고 하면 정책상 Report 스킬 → save_html_report(일반 분석)로 간다.
// 그런데 모델은 사용자 표현을 그대로 되받아 "✅ SILVER 예측 분석 리포트가 완성되었습니다"라고 답한다.
// 이건 **검증(백테스트·MAPE)도 신뢰구간도 없는 과거 분석을 예측으로 위장**하는 것이다.
// (실제로 "차기 목표 95 / 중기 100~110" 같은 지어낸 목표가까지 붙었다 — 금융 템플릿 guide가 "시장 전망"을
//  요구해서 나온 정성 의견인데, 답변에서 예측처럼 옮겨지면 사용자가 검증된 수치로 오해한다.)
//
// 프롬프트로도 금지했지만 약한 모델은 무시한다 → **하네스가 결정론적으로 라벨을 교정**하고,
// 사용자가 예측을 원했던 정황이면 진짜 예측 경로("<테이블> 예측해줘")를 안내한다.
// forecast_table이 호출된 턴(=진짜 예측 리포트)에는 절대 발동하지 않는다.
var ForecastLabelGuard = {
  name: 'forecast_label',
  check: function (agent, msg) {
    if (msg.toolCalls && msg.toolCalls.length > 0) return msg; // 최종 답변 차례에만
    var content = msg.content || '';
    if (!content) return msg;

    var calls = toolNamesSince(agent.messages);
    if (calls.forecast) return msg;      // 진짜 예측 리포트 → 손대지 않음
    if (!calls.report) return msg;       // 일반 리포트를 만든 적 없음 → 대상 아님
    var table = calls.table || tableOf(agent);

    var out = content;
    var relabeled = false;

    // "예측 리포트"/"예측 분석 리포트"/"예측 보고서" → "분석 리포트"
    var re = /예측\s*(?:및\s*)?(?:분석\s*)?(리포트|보고서)/g;
    if (re.test(out)) { out = out.replace(re, '분석 $1'); relabeled = true; }

    // 사용자가 예측을 원했으면 진짜 예측 경로를 안내(중복 방지).
    var wanted = /예측|전망|향후|forecast|predict/i.test(String(agent.currentQuery || ''));
    if (wanted && out.indexOf('예측해줘') < 0) {
      out += '\n\n---\n\n> **참고** — 위 리포트는 **과거 데이터 분석**입니다(검증된 미래 예측이 아닙니다).\n' +
        '> 검증된 예측이 필요하면 **"' + table + ' 예측해줘"** 라고 요청하세요 — ' +
        '후보 모델 전수 비교·검증 오차(MAPE)·95% 신뢰구간이 포함된 **예측 전용 리포트**를 만듭니다.';
      relabeled = true;
    }

    if (!relabeled) return msg;
    console.println('  [guard] forecast_label: analysis report was described as a forecast → relabeled + forecast path hinted');
    return createMessage('assistant', out);
  },
};

// 이번 턴(마지막 user 메시지 이후)에 어떤 리포트 계열 도구가 불렸나 + 대상 테이블.
function toolNamesSince(msgs) {
  var start = 0, i;
  for (i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && !msgs[i]._guardHint) { start = i; break; }
  }
  var out = { report: false, forecast: false, table: '' };
  for (i = start; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (var j = 0; j < m.toolCalls.length; j++) {
      var fn = m.toolCalls[j].function;
      if (!fn) continue;
      if (fn.name === 'forecast_table') out.forecast = true;
      if (fn.name === 'save_html_report') {
        out.report = true;
        // 안내문에 쓸 테이블명은 **도구 인자에서** 가져온다 — 질문이 "실버 테이블"처럼 한글이면 질문 파싱은 실패한다.
        var a = fn.arguments;
        if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = null; } }
        if (a && a.table && !out.table) out.table = String(a.table).toUpperCase();
      }
    }
  }
  return out;
}

// 폴백: 질문에서 "<영문토큰> 테이블" 추출. 못 찾으면 일반 문구.
function tableOf(agent) {
  var m = /([A-Za-z_][A-Za-z0-9_]{2,})\s*(?:테이블|table)/i.exec(String(agent.currentQuery || ''));
  return m ? m[1].toUpperCase() : '<테이블>';
}

module.exports = ForecastLabelGuard;
