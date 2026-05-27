// Time range parsing and skill hints for multi-turn support

var TIME_RANGE_KO_RE = /(최근|지난)\s*(\d+)\s*(시간|분|일|주|개월|년)/;
var TIME_RANGE_EN_RE = /(last|past|recent)\s+(\d+)\s*(hours?|minutes?|mins?|days?|weeks?|months?|years?)/i;

function parseTimeRange(query) {
  var now = new Date();
  var startTime = null;
  var label = '';

  // "오늘" / "today"
  if (query.indexOf('오늘') >= 0 || /\btoday\b/i.test(query)) {
    startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    label = query.indexOf('오늘') >= 0 ? '오늘' : 'today';
  }

  // Korean: "최근 N시간/분/일/주/개월/년"
  if (!label) {
    var m = TIME_RANGE_KO_RE.exec(query);
    if (m) {
      var n = parseInt(m[2], 10);
      var unit = m[3];
      switch (unit) {
        case '분': startTime = new Date(now.getTime() - n * 60 * 1000); break;
        case '시간': startTime = new Date(now.getTime() - n * 60 * 60 * 1000); break;
        case '일': startTime = new Date(now.getTime() - n * 24 * 60 * 60 * 1000); break;
        case '주': startTime = new Date(now.getTime() - n * 7 * 24 * 60 * 60 * 1000); break;
        case '개월':
          startTime = new Date(now.getFullYear(), now.getMonth() - n, now.getDate(),
            now.getHours(), now.getMinutes(), now.getSeconds());
          break;
        case '년':
          startTime = new Date(now.getFullYear() - n, now.getMonth(), now.getDate(),
            now.getHours(), now.getMinutes(), now.getSeconds());
          break;
      }
      label = m[0];
    }
  }

  // English: "last/past/recent N hours/minutes/days/weeks/months/years"
  if (!label) {
    var me = TIME_RANGE_EN_RE.exec(query);
    if (me) {
      var ne = parseInt(me[2], 10);
      var ue = me[3].toLowerCase().replace(/s$/, '');
      switch (ue) {
        case 'minute': case 'min':
          startTime = new Date(now.getTime() - ne * 60 * 1000); break;
        case 'hour':
          startTime = new Date(now.getTime() - ne * 60 * 60 * 1000); break;
        case 'day':
          startTime = new Date(now.getTime() - ne * 24 * 60 * 60 * 1000); break;
        case 'week':
          startTime = new Date(now.getTime() - ne * 7 * 24 * 60 * 60 * 1000); break;
        case 'month':
          startTime = new Date(now.getFullYear(), now.getMonth() - ne, now.getDate(),
            now.getHours(), now.getMinutes(), now.getSeconds());
          break;
        case 'year':
          startTime = new Date(now.getFullYear() - ne, now.getMonth(), now.getDate(),
            now.getHours(), now.getMinutes(), now.getSeconds());
          break;
      }
      label = me[0];
    }
  }

  if (!label || !startTime) return null;

  // Select ROLLUP unit based on duration
  var dur = now.getTime() - startTime.getTime();
  var rollupUnit = "'day'";
  if (dur <= 2 * 60 * 60 * 1000) rollupUnit = "'sec'";
  else if (dur <= 24 * 60 * 60 * 1000) rollupUnit = "'min'";
  else if (dur <= 7 * 24 * 60 * 60 * 1000) rollupUnit = "'hour'";

  return {
    startMs: String(startTime.getTime()),
    endMs: String(now.getTime()),
    startDt: formatDatetime(startTime),
    endDt: formatDatetime(now),
    label: label,
    unit: rollupUnit,
  };
}

function formatDatetime(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

// Build skill-specific hint for user message
function buildSkillHint(query, activeSkill, timeRange) {
  var timeHint = ' 반드시 SELECT MIN(TIME), MAX(TIME) FROM 테이블 (timeformat=\'ms\')로 시간 범위를 먼저 조회하고, ' +
    '그 결과를 time_start/time_end에 문자열로 전달하세요. now-1h 등 상대값 사용 금지!';

  if (timeRange) {
    timeHint = ' 시간 범위가 지정되었습니다. time_start=' + timeRange.startMs + ', time_end=' + timeRange.endMs +
      ' (' + timeRange.label + '). 이 값을 그대로 사용하세요. ROLLUP UNIT은 ' + timeRange.unit + '을 사용하세요.';
  }

  switch (activeSkill.name) {
    case 'Report':
      return '[시스템 힌트: HTML 분석 리포트 요청입니다. ' +
        '사전 쿼리 없이 save_html_report(table=테이블명)을 바로 호출하세요. ' +
        '오직 save_html_report만 사용하세요. ' +
        '리포트 생성 후 URL을 최종 답변에 포함하세요!' + timeHint + ']';
    case 'AdvancedAnalysis':
      return '[시스템 힌트: 고급 분석 키워드가 감지되었습니다. 고급 분석(TQL 템플릿) 절차를 따르세요.' + timeHint +
        ' ★ 마지막에 반드시 preview_dashboard를 호출하고, 반환된 URL을 최종 답변에 포함하세요!]';
    case 'BasicAnalysis':
      return '[시스템 힌트: 기본 분석 요청입니다. 기본 분석(table-based 차트, create_dashboard_with_charts) 절차를 따르세요. ' +
        'TQL 파일/템플릿/save_tql_file/create_folder를 절대 사용하지 마세요.' + timeHint +
        ' ★ 마지막에 반드시 preview_dashboard를 호출하고, 반환된 URL을 최종 답변에 포함하세요!]';
    case 'Timer':
      return '[시스템 힌트: 타이머 요청입니다. 시스템 프롬프트의 타이머 생성 워크플로우를 따르세요.\n' +
        '★ "예제 타이머 만들어줘" = 샘플 타이머를 직접 생성하라는 의미입니다. 설명/안내 금지! 도구를 호출하여 실제로 만드세요.\n' +
        '★ "제거/삭제해줘" = 반드시 stop_timer → delete_timer → delete_file → DROP TABLE 순서로 도구를 각각 호출하세요. 한번에 완료 보고 금지!\n' +
        '★ 코드를 텍스트로 보여주지 말고 도구를 직접 호출하세요.]';
    default:
      // Use skill's own hint if defined
      if (activeSkill.hint) {
        var h = typeof activeSkill.hint === 'function' ? activeSkill.hint(query) : activeSkill.hint;
        return '[시스템 힌트: ' + h + ']';
      }
      return '';
  }
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

module.exports = { parseTimeRange, buildSkillHint, compactHistory, inferTableName };
