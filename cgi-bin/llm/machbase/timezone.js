// 사용자 시간대 기준 시각 문자열
// · offsetMin은 UTC 대비 분, null이면 서버 시간대(그 시각의 서머타임 반영)

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// epoch ms → "YYYY-MM-DD HH:MM:SS"
function wallTime(ms, offsetMin) {
  var off = offsetMin == null ? -new Date(ms).getTimezoneOffset() : offsetMin;
  return new Date(ms + off * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

// UTC 대비 분 → "UTC+09:00"
function utcLabel(offsetMin) {
  var a = Math.abs(offsetMin);
  return 'UTC' + (offsetMin < 0 ? '-' : '+') + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
}

// 서버 시간대의 지금 UTC 대비 분
function serverOffset() { return -new Date().getTimezoneOffset(); }

// 사용자 시간대 이름(쿼리·차트용) — 없으면 'Local'(서버 시간대)
function zoneName(mc) { return mc && mc.timezone ? mc.timezone() : 'Local'; }

// 사용자 시간대 정보 — 브라우저 시간대가 없으면 서버 시간대
function userZone(mc) {
  var off = mc && mc.timezoneOffset ? mc.timezoneOffset() : null;
  var name = zoneName(mc);
  if (off == null || name === 'Local') return { label: utcLabel(serverOffset()), offsetMin: null };
  return { label: name, offsetMin: off };
}

module.exports = { wallTime, utcLabel, serverOffset, zoneName, userZone };
