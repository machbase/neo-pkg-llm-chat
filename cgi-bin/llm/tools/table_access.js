// 테이블 참조 해석과 접근 확인
// · M$SYS_TABLES는 세션 사용자가 접근 가능한 테이블만 보여줌(소유 + GRANT) → 소유자 조건 없이 조회
// · 이름은 [database.]owner.table — 접두 없는 이름은 접속 계정 소유로 해석

// 시스템/내부 테이블 — 접근 확인 대상 아님
var SYSTEM_TABLE = /^(M\$|V\$|_)/;

// 'MACHBASEDB.SYS.BITCOIN' → { db:'MACHBASEDB', owner:'SYS', table:'BITCOIN' }
// 'SYS.BITCOIN'            → { db:'',           owner:'SYS', table:'BITCOIN' }
// 'BITCOIN'                → { db:'',           owner:'',    table:'BITCOIN' }
function parseTableRef(name) {
  var parts = String(name || '').trim().split('.');
  for (var i = 0; i < parts.length; i++) parts[i] = parts[i].replace(/^"|"$/g, '').toUpperCase();
  var db = '', owner = '', table = '';
  if (parts.length >= 3) { db = parts[0]; owner = parts[1]; table = parts[2]; }
  else if (parts.length === 2) { owner = parts[0]; table = parts[1]; }
  else { table = parts[0]; }
  return makeRef(db, owner, table);
}

// prefix: 부속 객체(_<t>_meta, v$<t>_stat) 이름 앞에 붙일 'db.owner'
function makeRef(db, owner, table) {
  var prefix = owner;
  if (db && owner) prefix = db + '.' + owner;
  return { db: db, owner: owner, table: table, prefix: prefix, qualified: qualify(db, owner, table) };
}

function qualify(db, owner, table) {
  var out = table;
  if (owner) out = owner + '.' + out;
  if (db) out = db + '.' + out;
  return out;
}

// 접근 가능한 테이블 목록 [{db, owner, table}] (DB·유저·테이블 순 정렬). flagZeroOnly 면 FLAG=0 테이블만
// · 카탈로그 테이블 JOIN이 크게 느려지는 경우가 있어 유저·테이블을 각각 조회 후 여기서 결합
function listAccessible(mc, flagZeroOnly, cb) {
  mc.querySQL('SELECT USER_ID, NAME FROM M$SYS_USERS', '', '', '', function (errU, resU) {
    if (errU) return cb(errU);
    var users = {};
    try {
      var pu = JSON.parse(resU);
      if (!pu.success) return cb(new Error(pu.reason));
      var ur = (pu.data && pu.data.rows) || [];
      for (var u = 0; u < ur.length; u++) users[String(ur[u][0])] = String(ur[u][1]);
    } catch (e) { return cb(e); }
    var sql = 'SELECT DATABASE_NAME, USER_ID, NAME FROM M$SYS_TABLES' + (flagZeroOnly ? ' WHERE FLAG = 0' : '');
    mc.querySQL(sql, '', '', '', function (err, result) {
      if (err) return cb(err);
      try {
        var parsed = JSON.parse(result);
        if (!parsed.success) return cb(new Error(parsed.reason));
        var rows = (parsed.data && parsed.data.rows) || [];
        var out = [];
        for (var i = 0; i < rows.length; i++) {
          var owner = users[String(rows[i][1])];
          if (!owner || SYSTEM_TABLE.test(String(rows[i][2]))) continue;
          out.push({ db: String(rows[i][0]), owner: owner, table: String(rows[i][2]) });
        }
        out.sort(function (a, b) {
          return a.db < b.db ? -1 : a.db > b.db ? 1 : a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : a.table < b.table ? -1 : a.table > b.table ? 1 : 0;
        });
        cb(null, out);
      } catch (e) { cb(e); }
    });
  });
}

// 테이블 이름 → 접근 가능한 { db, owner } 목록
function sourcesByTable(accessible) {
  var map = {};
  for (var i = 0; i < accessible.length; i++) {
    var a = accessible[i];
    if (!map[a.table]) map[a.table] = [];
    var dup = false;
    for (var j = 0; j < map[a.table].length; j++) {
      if (map[a.table][j].db === a.db && map[a.table][j].owner === a.owner) { dup = true; break; }
    }
    if (!dup) map[a.table].push({ db: a.db, owner: a.owner });
  }
  return map;
}

// 문자열 리터럴 구간 — 그 안의 FROM/JOIN 토큰은 치환 제외
function stringRanges(sql) {
  var ranges = [], inStr = false, start = 0;
  for (var i = 0; i < sql.length; i++) {
    var ch = sql.charAt(i);
    if (!inStr && ch === "'") { inStr = true; start = i; }
    else if (inStr && ch === "'") { inStr = false; ranges.push([start, i]); }
  }
  return ranges;
}

// 테이블 이름 하나를 접근 가능 목록 기준 DB.유저.테이블 참조로 정규화
// · 1단: 후보 하나면 그것, 여럿이면 접속 계정 소유, 그래도 여럿이면 모호 오류
// · 2단: 앞부분이 그 테이블의 유저면 유저, 아니면 DB 이름으로 판별
// · 3단: 목록 대조만
// 반환 { ref } 또는 { error }
function normalizeRef(name, accessible, connectedUser) {
  var p = parseTableRef(name);
  if (!p.table) return { error: 'table name is required' };
  var cands = sourcesByTable(accessible)[p.table] || [];
  var pool = [];
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i];
    if (p.db) { if (c.db === p.db && c.owner === p.owner) pool.push(c); }
    else if (p.owner) { if (c.owner === p.owner) pool.push(c); }
    else pool.push(c);
  }
  if (pool.length === 0 && p.owner && !p.db) {
    for (var j = 0; j < cands.length; j++) if (cands[j].db === p.owner) pool.push(cands[j]);
  }
  if (pool.length === 0) return { error: 'table not found or no permission: ' + p.qualified };
  if (pool.length > 1) {
    var mine = [];
    for (var k = 0; k < pool.length; k++) if (pool[k].owner === connectedUser) mine.push(pool[k]);
    if (mine.length !== 1) return { error: ambiguousMessage(p.table, pool) };
    pool = mine;
  }
  return { ref: makeRef(pool[0].db, pool[0].owner, p.table) };
}

// 후보가 여럿일 때 돌려줄 문구 — 에이전트가 parseAmbiguity로 읽어 사용자 선택 질문으로 전환
function ambiguousMessage(table, sources) {
  var list = [];
  for (var i = 0; i < sources.length; i++) list.push(qualify(sources[i].db, sources[i].owner, table));
  return table + ' is ambiguous — candidates: ' + list.join(', ') +
    ' — ask the user which one instead of picking one.';
}

// 도구 결과에서 모호 문구 추출 → { table, candidates[] } 또는 null
function parseAmbiguity(text) {
  var m = String(text || '').match(/([A-Za-z0-9_$]+) is ambiguous — candidates: ([^—]+?) —/);
  if (!m) return null;
  return { table: m[1], candidates: m[2].split(',').map(function (s) { return s.trim(); }).filter(Boolean) };
}

// SQL/TQL 본문의 FROM/JOIN 뒤 테이블 이름을 정규화 이름으로 치환
// · 문자열 리터럴 안·시스템 테이블(M$/V$/_ 시작)은 제외
// · 해석 실패(없음·모호)는 첫 오류 반환
function qualifyTables(sql, accessible, connectedUser) {
  var text = String(sql || '');
  var ranges = stringRanges(text);
  function inString(pos) {
    for (var i = 0; i < ranges.length; i++) if (pos > ranges[i][0] && pos < ranges[i][1]) return true;
    return false;
  }
  var re = /\b(FROM|JOIN)(\s+)([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){0,2})(?![\w$.])/gi;
  var edits = [], changes = [], m;
  while ((m = re.exec(text)) !== null) {
    if (inString(m.index)) continue;
    if (SYSTEM_TABLE.test(parseTableRef(m[3]).table)) continue;
    var r = normalizeRef(m[3], accessible, connectedUser);
    if (r.error) return { error: r.error };
    if (r.ref.qualified === m[3].toUpperCase()) continue;
    var start = m.index + m[1].length + m[2].length;
    edits.push({ start: start, end: start + m[3].length, text: r.ref.qualified });
    changes.push(m[3] + ' → ' + r.ref.qualified);
  }
  for (var e = edits.length - 1; e >= 0; e--) {
    text = text.slice(0, edits[e].start) + edits[e].text + text.slice(edits[e].end);
  }
  return { sql: text, changes: changes };
}

// SQL/TQL 실행 전 테이블 이름 정규화(접근 확인 겸함)
// cb(err, preparedSql)
function prepareSql(mc, sql, cb) {
  listAccessible(mc, false, function (err, accessible) {
    if (err) return cb(err);
    var q = qualifyTables(sql, accessible, String(mc.user || '').toUpperCase());
    if (q.error) return cb(new Error(q.error));
    if (q.changes.length > 0) console.println('[Access] 테이블명 정규화: ' + q.changes.join(', '));
    cb(null, q.sql);
  });
}

// 도구 인자의 테이블 이름 하나를 정규화 참조로 변환 — 부속 객체(_<t>_meta, v$<t>_stat, 롤업)도 이 접두 사용
// 없음·모호면 cb(Error)
function resolveTableRef(mc, name, cb) {
  listAccessible(mc, false, function (err, rows) {
    if (err) return cb(err);
    var r = normalizeRef(name, rows, String(mc.user || '').toUpperCase());
    if (r.error) return cb(new Error(r.error));
    cb(null, r.ref);
  });
}

// 태그 통계 뷰 이름 — 'MACHBASEDB.SYS.V$BITCOIN_STAT'
function statViewName(ref) {
  return (ref.prefix ? ref.prefix + '.' : '') + 'V$' + ref.table + '_STAT';
}

// 태그 이름 목록 — _<t>_meta 우선, 실패하면 V$<t>_STAT(데이터 있는 태그만)
// · 비SYS 소유 태그 테이블은 GRANT로 메타 권한이 따라오지 않아 메타 조회가 실패함
// · nameCol 미지정이면 메타의 _ID 아닌 첫 컬럼 사용
// cb(err, tags, source: 'meta' | 'stat')
function readTagNames(mc, ref, nameCol, cb) {
  var pre = ref.prefix ? ref.prefix + '.' : '';
  var metaSql = 'SELECT ' + (nameCol || '*') + ' FROM ' + pre + '_' + ref.table.toLowerCase() + '_meta';
  queryNames(mc, metaSql, function (errM, tags) {
    if (!errM) return cb(null, tags, 'meta');
    queryNames(mc, 'SELECT NAME FROM ' + statViewName(ref), function (errS, statTags) {
      if (errS) return cb(errM);
      cb(null, statTags, 'stat');
    });
  });
}

// 첫 번째 비 _ID 컬럼 값 목록 — cb(err, values)
function queryNames(mc, sql, cb) {
  mc.querySQL(sql, '', '', '', function (err, res) {
    if (err) return cb(err);
    try {
      var p = JSON.parse(res);
      if (!p.success) return cb(new Error(p.reason));
      var cols = (p.data && p.data.columns) || [], rows = (p.data && p.data.rows) || [];
      var ci = 0;
      while (ci < cols.length - 1 && String(cols[ci]).toUpperCase() === '_ID') ci++;
      var out = [];
      for (var i = 0; i < rows.length; i++) out.push(String(rows[i][ci]));
      cb(null, out);
    } catch (e) { cb(e); }
  });
}

// ROLLUP 개수 — V$ROLLUP을 원본 테이블·소유자로 조회. cb(개수)
// · M$SYS_TABLES는 계정 권한대로 걸러져, 권한 받은 남의 테이블은 ROLLUP 내부 테이블이 안 보임 → 쓰지 않음
// · SEC 단계는 데이터 파티션마다 한 줄씩 나와 DISTINCT
// · 소유자 없는 이름은 접속 계정 기준, 실패하면 0(호출측은 DATE_TRUNC로 내려감)
function countRollups(mc, name, cb) {
  var ref = parseTableRef(name);
  var owner = ref.owner || String(mc.user || '').toUpperCase();
  if (!ref.table || !owner) return cb(0);
  var esc = function (s) { return String(s).replace(/'/g, "''"); };
  mc.querySQL("SELECT COUNT(DISTINCT ROLLUP_TABLE) FROM V$ROLLUP WHERE ROOT_TABLE = '" + esc(ref.table) + "'" +
    " AND USER_ID = (SELECT USER_ID FROM M$SYS_USERS WHERE NAME = '" + esc(owner) + "' LIMIT 1)", '', '', '', function (err, res) {
    if (err) return cb(0);
    var n = 0;
    try {
      var p = JSON.parse(res);
      if (p && p.success && p.data && p.data.rows && p.data.rows.length) n = parseInt(String(p.data.rows[0][0]), 10) || 0;
    } catch (e) {}
    cb(n);
  });
}

module.exports = {
  parseTableRef,
  qualify,
  listAccessible,
  normalizeRef,
  prepareSql,
  resolveTableRef,
  parseAmbiguity,
  readTagNames,
  statViewName,
  countRollups,
};
