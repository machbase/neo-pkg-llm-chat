var { turnStart } = require('./guard');
var { createMessage } = require('../llm/types');

// 도구가 바꾼 기준(단위·기간·태그)이 답변에 없으면 답변 끝에 값만 한 줄로 붙임(ollama)
// · 근거는 이번 질문 도구 결과의 [주의] 줄(compile_tql_from_spec)
// · 모델이 바뀐 값을 이미 적었으면 손대지 않음

var UNIT_ONE = { sec: '초', min: '분', hour: '시간', day: '일', week: '주', month: '월' };
var UNIT_N = { sec: '초', min: '분', hour: '시간', day: '일', week: '주', month: '개월' };
// 1배 단위를 달리 부르는 말 — "일 단위" 대신 "일별"로 적어도 적은 것으로 봄
var UNIT_ALIAS = {
  sec: ['초별', '초 단위', '1초', 'second'],
  min: ['분별', '분 단위', '1분', 'minute'],
  hour: ['시간별', '시간 단위', '1시간', 'hourly'],
  day: ['일별', '일 단위', '하루', '일간', '1일', 'daily'],
  week: ['주별', '주 단위', '주간', '1주', 'weekly'],
  month: ['월별', '월 단위', '월간', '1개월', 'monthly'],
};

var RANGE = /\((\d{4}-\d{2}-\d{2})( \d{2}:\d{2})?(?::\d{2})? ~ (\d{4}-\d{2}-\d{2})( \d{2}:\d{2})?(?::\d{2})?\)/;

var AppliedBasisGuard = {
  name: 'applied_basis',
  check: function (agent, msg) {
    if (msg.toolCalls && msg.toolCalls.length > 0) return msg; // 최종 답변 차례에만
    if (!agent.llm || agent.llm.type !== 'ollama') return msg;
    var content = String(msg.content || '');
    if (!content) return msg;
    var notes = turnNotes(agent.messages || []);
    if (!notes.length) return msg;
    // 본문만 봄 — 코드블록의 ROLLUP('day', …)·태그 이름은 사용자가 읽는 설명이 아님
    var prose = content.replace(/```[\s\S]*?```/g, '');
    var missing = [];
    for (var i = 0; i < notes.length; i++) {
      var bs = basisOf(notes[i]);
      for (var j = 0; j < bs.length; j++) {
        if (!bs[j].seen(prose) && missing.indexOf(bs[j].text) < 0) missing.push(bs[j].text);
      }
    }
    if (!missing.length) return msg;
    console.println('  [guard] applied_basis: 답변에 없는 적용 기준 ' + missing.length + '개 첨부');
    return createMessage('assistant', content.replace(/\s+$/, '') + '\n\n※ 적용 기준: ' + missing.join(' · '));
  },
};

// 이번 질문의 도구 결과에 있는 [주의] 줄
function turnNotes(msgs) {
  var out = [];
  for (var i = turnStart(msgs); i < msgs.length; i++) {
    if (msgs[i].role !== 'tool' || !msgs[i].content) continue;
    var m = String(msgs[i].content).match(/\[주의\][^\n]*/g);
    if (m) out = out.concat(m);
  }
  return out;
}

// [주의] 줄 → 적용 기준 [{ text: 붙일 값, seen(답변): 답변에 이미 있나 }]
function basisOf(note) {
  var out = [], m;
  if ((m = note.match(/요청 단위 \S+ → (\d*)([a-z]+)로 조정/))) {
    var n = parseInt(m[1], 10) || 1, u = m[2];
    if (UNIT_N[u]) {
      var forms = n > 1 ? [n + UNIT_N[u], n + ' ' + UNIT_N[u], n + u] : UNIT_ALIAS[u].concat([UNIT_ONE[u] + ' 단위', u]);
      out.push({ text: (n > 1 ? n + UNIT_N[u] : UNIT_ONE[u]) + ' 단위', seen: hasAny(forms) });
    }
  }
  if ((m = note.match(/태그 ([^()]+?)\(으\)로 만들었습니다/))) {
    var tags = m[1].split(/\s*,\s*/);
    out.push({ text: '태그 ' + tags.join(', '), seen: function (c) { return tags.every(function (t) { return c.indexOf(t) >= 0; }); } });
  }
  // 기간은 마지막 괄호 — 이동 안내는 "(요청 기간)은(는) … (옮긴 기간)로 옮겼습니다" 순서
  var ranges = note.match(new RegExp(RANGE.source, 'g'));
  if (ranges && (m = ranges[ranges.length - 1].match(RANGE))) {
    var withTime = (m[2] && m[2] !== ' 00:00') || (m[4] && m[4] !== ' 00:00');
    var s = m[1] + (withTime ? m[2] || '' : ''), e = m[3] + (withTime ? m[4] || '' : '');
    var a = m[1], b = m[3];
    out.push({ text: '기간 ' + s + ' ~ ' + e, seen: function (c) { return dateIn(c, a) && dateIn(c, b); } });
  }
  return out;
}

function hasAny(forms) {
  return function (c) { for (var i = 0; i < forms.length; i++) if (c.indexOf(forms[i]) >= 0) return true; return false; };
}

// 날짜가 답변에 있나 — 2025-09-23 / 2025년 9월 23일 / 9월 23일
function dateIn(c, ymd) {
  var p = ymd.split('-'), mo = parseInt(p[1], 10), d = parseInt(p[2], 10);
  return c.indexOf(ymd) >= 0 || c.indexOf(p[0] + '년 ' + mo + '월 ' + d + '일') >= 0 || c.indexOf(mo + '월 ' + d + '일') >= 0;
}

module.exports = AppliedBasisGuard;
