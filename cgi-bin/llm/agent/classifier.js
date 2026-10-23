// Time range parsing and skill hints for multi-turn support

var TIME_RANGE_KO_RE = /(최근|지난)\s*(\d+)\s*(시간|분|일|주|개월|년)/;
var TIME_RANGE_EN_RE = /(last|past|recent)\s+(\d+)\s*(hours?|minutes?|mins?|days?|weeks?|months?|years?)/i;

// 절대 날짜 토큰(시각 선택): 2023-10-01 / 2023/10/01 / 2023-10-01 00:00:00 / 2023-10-01T00:00
var ABS_DATE = '(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?)?)';
// 두 날짜 토큰 + 구분자(~ – — 부터 to -) — 사용자 명시 절대 기간
var ABS_RANGE_RE = new RegExp(ABS_DATE + '\\s*(?:~|–|—|부터|to|-)\\s*' + ABS_DATE, 'i');

// 날짜 문자열 → 로컬(서버 KST) Date. 엔진별 Date 문자열 파싱 편차를 피해 컴포넌트로 직접 생성. 실패 시 null.
function parseLocalDate(s) {
  var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(s).trim());
  if (!m) return null;
  var dt = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return isNaN(dt.getTime()) ? null : dt;
}

// "2023-10-01 ~ 2023-11-01" 류 절대 기간 → {start,end,label}. 못 잡거나 끝<=시작이면 null.
function parseAbsoluteRange(query) {
  var m = ABS_RANGE_RE.exec(query);
  if (!m) return null;
  var start = parseLocalDate(m[1]);
  var end = parseLocalDate(m[2]);
  if (!start || !end || end.getTime() <= start.getTime()) return null;
  return { start: start, end: end, label: m[1].trim() + ' ~ ' + m[2].trim() };
}

// ── 질문의 기간 해석 ──
// · kind: 'relative' = 지금 기준 길이("최근·지난 N…", "last N …") — 데이터가 없으면 도구가 데이터 끝으로 옮길 수 있음
//         'calendar' = 날짜·달력 표현(절대 기간·어제·지난주·2025년·3월·특정 날짜·A부터 B까지) — 옮기지 않음
// · 기준은 서버 현지 시간, 주는 월요일 시작. 지금보다 뒤로 가는 끝은 지금으로 자름
// · 우선순위: 절대 기간 → 두 시점을 잇는 범위 → 상대 기간 → 한 시점(질문에서 먼저 나온 것)
var YEAR_WORDS = { '올해': 0, '금년': 0, '작년': -1, '지난해': -1, '재작년': -2 };
var EN_MONTH = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
var EN_MONTH_SRC = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
// 연도 없는 월·일 — 올해. 아직 안 온 날이면 작년
function inferYear(now, mo, day) {
  var y = now.getFullYear();
  if (mo > now.getMonth() || (mo === now.getMonth() && day > now.getDate())) y -= 1;
  return y;
}
function dayOf(y, mo, d, explicit) {
  var s = new Date(y, mo, d);
  if (s.getMonth() !== ((mo % 12) + 12) % 12 || s.getDate() !== d) return null; // 2월 30일 같은 없는 날짜
  return { start: s, end: new Date(y, mo, d + 1), explicit: explicit, rebuild: function (ny) { return dayOf(ny, mo, d, true); } };
}
function monthOf(y, mo, explicit) {
  if (mo < 0 || mo > 11) return null;
  return { start: new Date(y, mo, 1), end: new Date(y, mo + 1, 1), explicit: explicit, rebuild: function (ny) { return monthOf(ny, mo, true); } };
}
function yearOf(y) { return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1), explicit: true }; }
function weekOf(now, back) {
  var mon = addDays(dayStart(now), -((now.getDay() + 6) % 7) - 7 * back);
  return { start: mon, end: back ? addDays(mon, 7) : now };
}

// 한 시점 표현 — 질문에서 전부 찾은 뒤 위치·길이로 겹침을 정리해 고름
// · notAfter: 바로 앞 글자가 이것이면 무시("3개월"의 "3월" 오인 방지, lookbehind 대신)
var POINTS = [
  [/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g, function (m) { return dayOf(+m[1], +m[2] - 1, +m[3], true); }],
  [/(\d{4})\s*년\s*(\d{1,2})\s*월/g, function (m) { return monthOf(+m[1], +m[2] - 1, true); }],
  [/(올해|금년|작년|지난해|재작년)\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g, function (m, now) { return dayOf(now.getFullYear() + YEAR_WORDS[m[1]], +m[2] - 1, +m[3], true); }],
  [/(올해|금년|작년|지난해|재작년)\s*(\d{1,2})\s*월/g, function (m, now) { return monthOf(now.getFullYear() + YEAR_WORDS[m[1]], +m[2] - 1, true); }],
  [/(\d{4})\s*년/g, function (m) { return yearOf(+m[1]); }],
  [/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g, function (m) { return dayOf(+m[1], +m[2] - 1, +m[3], true); }],
  [/(\d{4})[-/.](\d{1,2})(?!\d)/g, function (m) { return monthOf(+m[1], +m[2] - 1, true); }],
  [/(\d{1,2})\s*월\s*(\d{1,2})\s*일/g, function (m, now) { return dayOf(inferYear(now, +m[1] - 1, +m[2]), +m[1] - 1, +m[2], false); }],
  [/(\d{1,2})\s*월(?!\s*(별|봉|단위))/g, function (m, now) { return monthOf(inferYear(now, +m[1] - 1, 0), +m[1] - 1, false); }, '개'],
  [/(\d+)\s*일\s*전/g, function (m, now) { var d = addDays(dayStart(now), -m[1]); return { start: d, end: addDays(d, 1) }; }],
  [/오늘|today/gi, function (m, now) { return { start: dayStart(now), end: now }; }],
  [/어제|yesterday/gi, function (m, now) { var d = addDays(dayStart(now), -1); return { start: d, end: addDays(d, 1) }; }],
  [/그저께|그제/g, function (m, now) { var d = addDays(dayStart(now), -2); return { start: d, end: addDays(d, 1) }; }],
  [/이번\s*주|금주|this\s+week/gi, function (m, now) { return weekOf(now, 0); }],
  [/지난\s*주|저번\s*주|전주|last\s+week/gi, function (m, now) { return weekOf(now, 1); }],
  [/이번\s*달|이달|금월|this\s+month/gi, function (m, now) { return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now }; }],
  [/지난\s*달|저번\s*달|전월|last\s+month/gi, function (m, now) { return now.getMonth() === 0 ? monthOf(now.getFullYear() - 1, 11, true) : monthOf(now.getFullYear(), now.getMonth() - 1, true); }],
  [/재작년/g, function (m, now) { return yearOf(now.getFullYear() - 2); }],
  [/올해|금년|this\s+year/gi, function (m, now) { return { start: new Date(now.getFullYear(), 0, 1), end: now }; }],
  [/작년|지난해|last\s+year/gi, function (m, now) { return yearOf(now.getFullYear() - 1); }],
  [new RegExp('\\b' + EN_MONTH_SRC + '\\.?\\s+(\\d{4})\\b', 'gi'), function (m) { return monthOf(+m[2], EN_MONTH[m[1].slice(0, 3).toLowerCase()], true); }],
  [new RegExp('\\bin\\s+' + EN_MONTH_SRC + '\\b', 'gi'), function (m, now) { var mo = EN_MONTH[m[1].slice(0, 3).toLowerCase()]; return monthOf(inferYear(now, mo, 0), mo, false); }],
  [/\bin\s+(\d{4})\b/gi, function (m) { return yearOf(+m[1]); }],
];

function findPoints(q, now) {
  var all = [];
  for (var i = 0; i < POINTS.length; i++) {
    var re = POINTS[i][0], m;
    re.lastIndex = 0;
    while ((m = re.exec(q))) {
      if (POINTS[i][2] && q.charAt(m.index - 1) === POINTS[i][2]) continue;
      var p = POINTS[i][1](m, now);
      if (p) { p.idx = m.index; p.len = m[0].length; p.order = i; all.push(p); }
    }
  }
  all.sort(function (a, b) { return a.idx - b.idx || b.len - a.len || a.order - b.order; });
  var out = [], until = -1;
  for (var j = 0; j < all.length; j++) {
    if (all[j].idx < until) continue; // 앞서 고른 표현과 겹치면 버림("재작년" 안의 "작년" 등)
    out.push(all[j]);
    until = all[j].idx + all[j].len;
  }
  return out;
}

var LINK_RE = /^\s*(부터|에서|~|–|—|to|until|through)\s*$/i;
var OPEN_RE = /^\s*(부터|이후|since)/i;

function parseTimeRange(query, nowArg) {
  var now = nowArg ? new Date(nowArg) : new Date();
  var q = String(query || '');
  var start = null, end = null, label = '', kind = '';

  var abs = parseAbsoluteRange(q);
  if (abs) { start = abs.start; end = abs.end; label = abs.label; kind = 'calendar'; }

  var pts = abs ? [] : findPoints(q, now);
  // 두 시점을 잇는 범위: "3월부터 5월까지", "어제~오늘", "from March 2025 to May 2025"
  for (var i = 0; !start && i + 1 < pts.length; i++) {
    var a = pts[i], b = pts[i + 1];
    if (!LINK_RE.test(q.slice(a.idx + a.len, b.idx))) continue;
    if (b.explicit === false && a.explicit && b.rebuild) b = b.rebuild(a.start.getFullYear());
    if (b && b.end <= a.start && b.explicit === false && b.rebuild) b = b.rebuild(b.start.getFullYear() + 1);
    if (!b || b.end <= a.start) continue;
    start = a.start; end = b.end; kind = 'calendar';
    label = q.slice(a.idx, pts[i + 1].idx + pts[i + 1].len).trim();
  }

  // 상대 기간: "최근 N시간/분/일/주/개월/년", "last N days"
  if (!start) {
    var m = TIME_RANGE_KO_RE.exec(q), me = m ? null : TIME_RANGE_EN_RE.exec(q);
    var rn = m ? parseInt(m[2], 10) : me ? parseInt(me[2], 10) : 0;
    var ru = m ? m[3] : me ? me[3].toLowerCase().replace(/s$/, '') : '';
    var t = now.getTime(), y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
    var hh = now.getHours(), mi = now.getMinutes(), ss = now.getSeconds();
    if (ru === '분' || ru === 'minute' || ru === 'min') start = new Date(t - rn * 60000);
    else if (ru === '시간' || ru === 'hour') start = new Date(t - rn * 3600000);
    else if (ru === '일' || ru === 'day') start = new Date(t - rn * 86400000);
    else if (ru === '주' || ru === 'week') start = new Date(t - rn * 7 * 86400000);
    else if (ru === '개월' || ru === 'month') start = new Date(y, mo - rn, d, hh, mi, ss);
    else if (ru === '년' || ru === 'year') start = new Date(y - rn, mo, d, hh, mi, ss);
    if (start) { end = now; label = (m || me)[0]; kind = 'relative'; }
  }

  // 한 시점: 질문에서 먼저 나온 표현. 뒤에 "부터/이후/since"가 붙으면 그때부터 지금까지
  if (!start && pts.length) {
    var p = pts[0];
    start = p.start; end = p.end; kind = 'calendar';
    label = q.substr(p.idx, p.len).trim();
    var after = OPEN_RE.exec(q.slice(p.idx + p.len));
    if (after) { end = now; label += ' ' + after[1]; }
  }

  if (!start || !end) return null;
  if (!abs && end > now && start < now) end = now;
  if (end <= start) return null;
  return finishRange(start, end, label, kind);
}

// 기간 → 반환 객체(ms·datetime·label·unit·kind) — 기간이 짧을수록 잘게 ROLLUP 단위 제안
function finishRange(startTime, endDate, label, kind) {
  var dur = endDate.getTime() - startTime.getTime();
  var rollupUnit = "'day'";
  if (dur <= 2 * 60 * 60 * 1000) rollupUnit = "'sec'";
  else if (dur <= 24 * 60 * 60 * 1000) rollupUnit = "'min'";
  else if (dur <= 7 * 24 * 60 * 60 * 1000) rollupUnit = "'hour'";
  return {
    startMs: String(startTime.getTime()),
    endMs: String(endDate.getTime()),
    startDt: formatDatetime(startTime),
    endDt: formatDatetime(endDate),
    label: label,
    unit: rollupUnit,
    kind: kind,
  };
}

// ── 질문의 기간·버킷 단위 명시 여부 (컴파일 도구의 "기간 > 단위" 우선순위용) ──
// · 단위: 숫자+단위+버킷어("1분 평균", "5분 단위", "10초 간격", "1시간마다", "5분봉"), 시간별·일별·주별·월별·분당 등
// · 기간: 단위 표현을 지운 나머지에서 판정 — "1분 평균"의 "1분"을 기간으로 보지 않게
var Q_UNIT_KO = { '초': 'sec', '분': 'min', '시간': 'hour', '일': 'day', '주': 'week', '개월': 'month', '달': 'month' };
var Q_UNIT_NUM_RE = /(\d+)\s*(초|분|시간|일|주|개월|달)\s*(평균|단위|간격|마다|별|봉|버킷|집계|합계|합|최대|최소|최댓값|최솟값|최고|최저|씩)/g;
var Q_UNIT_EN = { s: 'sec', sec: 'sec', secs: 'sec', second: 'sec', seconds: 'sec', m: 'min', min: 'min', mins: 'min', minute: 'min', minutes: 'min',
  h: 'hour', hr: 'hour', hrs: 'hour', hour: 'hour', hours: 'hour', d: 'day', day: 'day', days: 'day', w: 'week', week: 'week', weeks: 'week', month: 'month', months: 'month' };
var Q_UNIT_NUM_EN_RE = /(\d+)\s*-?\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?)\s*(avg|average|mean|interval|buckets?|candles?|bars?)\b/gi;
var Q_UNIT_WORDS = [
  [/(\d*)\s*분봉/, 'min'], [/일봉/, 'day'], [/주봉/, 'week'], [/월봉/, 'month'],
  [/분당|per\s*minute/i, 'min'], [/초당|per\s*second/i, 'sec'],
  [/시간별|시간대별|시간\s*단위|hourly/i, 'hour'], [/일별|날짜별|일\s*단위|하루\s*단위|daily/i, 'day'],
  [/주별|주\s*단위|weekly/i, 'week'], [/월별|월\s*단위|monthly/i, 'month'],
];
var Q_PERIOD_RE = /(오늘|어제|그제|그저께|이번\s*(주|달)|지난\s*(주|달)|지난주|지난달|올해|작년|금년|재작년|이달|당일|당월|today|yesterday|this\s+(week|month|year)|last\s+(week|month|year)|\d{4}\s*년|\d{1,2}\s*월|\d{4}[-/.]\d{1,2}|\d+\s*(초|분|시간|일|주일?|주|개월|달|년)\s*(전|간|동안|이내|이후|이전|치)|(최근|지난|last|past)\s*\d+|부터|까지|사이|between|since)/i;

function parseQuestionTime(query, nowArg) {
  var s = String(query || '');
  var unit = null, n = 1, rest = s, m;
  Q_UNIT_NUM_RE.lastIndex = 0;
  if ((m = Q_UNIT_NUM_RE.exec(s))) { unit = Q_UNIT_KO[m[2]]; n = parseInt(m[1], 10) || 1; }
  rest = rest.replace(Q_UNIT_NUM_RE, ' ');
  if (!unit) {
    Q_UNIT_NUM_EN_RE.lastIndex = 0;
    if ((m = Q_UNIT_NUM_EN_RE.exec(s))) { unit = Q_UNIT_EN[m[2].toLowerCase()]; n = parseInt(m[1], 10) || 1; }
  }
  rest = rest.replace(Q_UNIT_NUM_EN_RE, ' ');
  for (var i = 0; i < Q_UNIT_WORDS.length; i++) {
    var w = Q_UNIT_WORDS[i][0].exec(rest);
    if (!w) continue;
    if (!unit) { unit = Q_UNIT_WORDS[i][1]; n = (w[1] && parseInt(w[1], 10)) || 1; }
    rest = rest.replace(Q_UNIT_WORDS[i][0], ' ');
  }
  var tr = parseTimeRange(s, nowArg);
  var period = !!tr || Q_PERIOD_RE.test(rest);
  if (!unit && !period) return null;
  var out = { period: period, unit: unit, n: unit ? n : 1 };
  // 해석된 기간 — 컴파일 도구가 모델 값 대신 사용(kind로 데이터 없을 때 처리가 갈림)
  if (tr) { out.start = +tr.startMs; out.end = +tr.endMs; out.kind = tr.kind; out.label = tr.label; }
  return out;
}

function formatDatetime(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

// 사용자 메시지에 붙는 스킬 힌트 — 문구는 스킬 파일의 hint 하나에서만 관리
// · hint 안의 {time} 자리에 기간 힌트를 넣음
// · 스킬의 timeHint: 'tool' = 도구가 기간 처리(리포트), 'describe' = describe_table 기간 사용(분석)
function buildSkillHint(query, activeSkill, timeRange) {
  var h = typeof activeSkill.hint === 'function' ? activeSkill.hint(query) : activeSkill.hint;
  if (!h) return '';
  var t = timeHintText(activeSkill.timeHint, timeRange);
  return '[시스템 힌트: ' + h.replace('{time}', function () { return t; }) + ']';
}

function timeHintText(kind, timeRange) {
  if (!kind) return '';
  if (timeRange) {
    return ' 시간 범위가 지정되었습니다. time_start=' + timeRange.startMs + ', time_end=' + timeRange.endMs +
      ' (' + timeRange.label + '). 이 값을 그대로 사용하세요. ROLLUP UNIT은 ' + timeRange.unit + '을 사용하세요.';
  }
  if (kind === 'describe') return ' 시간 범위는 describe_table 결과의 time range(ms)를 사용하세요(별도 조회 불필요).';
  return ' 기간을 언급하지 않았으니 time_start/time_end는 넣지 마세요. MIN/MAX 등 사전 조회도 하지 마세요 — 도구가 전체 데이터를 자동 처리(폭에 맞춘 롤업)합니다.';
}

// Compact history: remove tool_calls and tool results, keep user + final assistant
function compactHistory(messages) {
  var result = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (msg.role === 'tool') continue;
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) continue;
    result.push(msg);
  }
  return result;
}

// Infer table name from messages history
function inferTableName(messages) {
  var knownTables = [];
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m.role === 'tool' && i > 0) {
      var prev = messages[i - 1];
      if (prev.toolCalls) {
        for (var j = 0; j < prev.toolCalls.length; j++) {
          if (prev.toolCalls[j].function.name === 'list_tables') {
            var lines = m.content.trim().split('\n');
            for (var k = 0; k < lines.length; k++) {
              var t = lines[k].trim();
              if (t && t !== 'NAME' && t.indexOf(' ') < 0) {
                knownTables.push(t);
              }
            }
          }
        }
      }
    }
  }

  if (knownTables.length === 0) return '';
  if (knownTables.length === 1) return knownTables[0];

  // Find mentioned table in user/assistant messages
  var searchText = '';
  for (var i2 = 0; i2 < messages.length; i2++) {
    if (messages[i2].role === 'user' || messages[i2].role === 'assistant') {
      searchText += ' ' + messages[i2].content.toUpperCase();
    }
  }
  for (var k2 = 0; k2 < knownTables.length; k2++) {
    if (searchText.indexOf(knownTables[k2]) >= 0) return knownTables[k2];
  }
  return '';
}

module.exports = { parseTimeRange, parseQuestionTime, buildSkillHint, compactHistory, inferTableName };
