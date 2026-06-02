// 테이블 소유권 검증 공통 모듈

// SQL에서 FROM/JOIN 뒤 유저 테이블명 추출 (시스템 테이블 M$, V$, _ 제외)
function extractUserTables(sql) {
  var re = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  var tables = [];
  var m;
  while ((m = re.exec(sql)) !== null) {
    var name = m[1].toUpperCase();
    if (name.indexOf('M$') === 0 || name.indexOf('V$') === 0 || name.charAt(0) === '_') continue;
    if (tables.indexOf(name) === -1) tables.push(name);
  }
  return tables;
}

function checkTableOwnership(mc, tables, cb) {
  if (tables.length === 0) return cb(null);
  var owner = (mc.user || 'SYS').toUpperCase();
  var inList = tables.map(function (t) { return "'" + t + "'"; }).join(',');
  mc.querySQL("SELECT COUNT(*) FROM M$SYS_TABLES AS st JOIN M$SYS_USERS AS su ON st.USER_ID = su.USER_ID WHERE su.NAME = '" + owner + "' AND st.NAME IN (" + inList + ")", '', '', '', function (err, result) {
    if (err) return cb(err);
    try {
      var parsed = JSON.parse(result);
      if (!parsed.success) return cb(new Error(parsed.reason));
      if (parsed.data.rows[0][0] < tables.length) return cb(new Error('table not found or no permission'));
      cb(null);
    } catch (e) { cb(e); }
  });
}

module.exports = { extractUserTables, checkTableOwnership };