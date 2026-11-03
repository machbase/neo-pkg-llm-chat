var { createToolCall } = require('../llm/types');
var { turnStart } = require('../guard/guard');

// 고급 분석 대시보드 대체 생성 — 도구를 못 쓰게 된 채(호출 잘림·반복 차단) 끝나려 할 때 runLoop가 사용
// · 이번 질문에서 저장에 성공한 차트(TQL file saved)로 create_dashboard_with_charts 호출을 만듦
// · 저장된 차트가 없거나 대시보드가 이미 있으면 null
// · 차트 경로는 도구 결과의 실제 저장 경로, 제목은 spec.output.title → 파일 이름
function autoDashboardCall(msgs) {
  var pending = [], charts = [], seen = {}, table = '';
  for (var i = turnStart(msgs); i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      pending = [];
      for (var j = 0; j < m.toolCalls.length; j++) {
        var fn = m.toolCalls[j].function || {};
        pending.push(fn.name === 'compile_tql_from_spec' ? (fn.arguments || {}) : null);
      }
    } else if (m.role === 'tool' && pending.length) {
      var args = pending.shift();
      var content = String(m.content || '');
      if (content.indexOf('Dashboard created') >= 0) return null;
      var saved = args && content.match(/TQL file saved:\s*(\S+\.tql)/i);
      if (!saved || seen[saved[1]]) continue;
      seen[saved[1]] = true;
      var spec = specOf(args);
      if (!table && spec.table) table = String(spec.table).split('.').pop();
      charts.push({ title: chartTitle(spec, saved[1]), tql_path: saved[1] });
    }
  }
  if (!charts.length) return null;
  var dir = charts[0].tql_path.replace(/\/[^\/]*$/, '');
  if (!table) table = dir.split('/').pop() || 'Analysis';
  return createToolCall('create_dashboard_with_charts', {
    filename: (dir ? dir + '/' : '') + table + '_Analysis.dsh',
    title: table + ' 심층 분석',
    charts: JSON.stringify(charts),
  });
}

function specOf(args) {
  var spec = args.spec;
  if (typeof spec === 'string') { try { spec = JSON.parse(spec); } catch (e) { spec = null; } }
  return spec && typeof spec === 'object' ? spec : {};
}

function chartTitle(spec, path) {
  var t = spec.output && spec.output.title;
  if (t) return String(t);
  return path.split('/').pop().replace(/\.tql$/i, '').replace(/_/g, ' ');
}

module.exports = { autoDashboardCall };
