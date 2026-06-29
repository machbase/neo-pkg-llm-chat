// 테이블별 실제 데이터 시간 경계(min/max, ms) 캐시.
// describe_table(profile)가 채우고 dashboard/tql이 읽어 시간 스냅에 재사용 — 반복 MIN/MAX 조회 방지.
// 워커 프로세스가 세션별로 격리되므로 동시성 안전(report.js _paramsCache와 동일 패턴).
var _cache = {};
var TTL = 10 * 60 * 1000; // 10분 — 라이브 적재 테이블도 이 주기로 max가 갱신됨

function set(table, minMs, maxMs) {
  if (!table || !(minMs > 0) || !(maxMs > 0)) return;
  _cache[String(table).toUpperCase()] = { min: minMs, max: maxMs, ts: Date.now() };
}

function get(table) {
  if (!table) return null;
  var key = String(table).toUpperCase();
  var e = _cache[key];
  if (!e) return null;
  if (Date.now() - e.ts > TTL) { delete _cache[key]; return null; }
  return { min: e.min, max: e.max };
}

module.exports = { set: set, get: get };
