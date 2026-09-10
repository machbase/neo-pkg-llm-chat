// 테이블 참조 해석과 접근 확인.
//
// 세션이 사용자 자격으로 붙으므로 M$SYS_TABLES 는 그 사용자가 접근할 수 있는 테이블만
// 보여준다(소유한 것 + GRANT 받은 것). 그래서 소유자 조건을 걸지 않는다 — 걸면 GRANT 받은
// 테이블이 빠진다. 같은 조회가 소유자도 함께 주므로 접근 판정과 소유자 파악이 한 번에 끝난다.
//
// 이름은 [database.]owner.table 세 부분까지 올 수 있다. 접두 없는 이름은 접속 계정의 것으로
// 해석되므로, 남의 소유 테이블은 소유자를 붙여야 조회된다(GRANT 를 받았더라도).

// 시스템/내부 테이블 — 사용자 테이블 접근 확인 대상이 아니다.
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

// prefix 는 부속 객체(_<t>_meta, v$<t>_stat) 이름을 만들 때 붙일 'db.owner' 부분이다.
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

// SQL 의 FROM/JOIN 뒤 테이블 참조를 뽑는다. 세 부분 이름과 `$` 를 포함하는 시스템 테이블
// 이름까지 한 토큰으로 잡아야 한다 — `$` 를 빼면 M$SYS_TABLES 가 'M' 으로 잘려 사용자
// 테이블처럼 취급된다.
function extractTableRefs(sql) {
  var re = /\b(?:FROM|JOIN)\s+([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){0,2})/gi;
  var out = [], seen = {}, m;
  while ((m = re.exec(String(sql || ''))) !== null) {
    var ref = parseTableRef(m[1]);
    if (SYSTEM_TABLE.test(ref.table)) continue;
    if (seen[ref.qualified]) continue;
    seen[ref.qualified] = 1;
    out.push(ref);
  }
  return out;
}

// 접근 가능한 테이블 목록을 [{owner, table}] 로 돌려준다. flagZeroOnly 면 TAG 테이블만.
function listAccessible(mc, flagZeroOnly, cb) {
  // DATABASE_NAME 이 카탈로그에 이미 있어 추가 조회 없이 세 부분 이름을 만들 수 있다.
  // 단 이 카탈로그는 현재 database 범위다 — 다른 database 의 테이블은 USE 없이는 안 보인다.
  var sql = 'SELECT st.DATABASE_NAME, su.NAME, st.NAME FROM M$SYS_TABLES AS st ' +
    'JOIN M$SYS_USERS AS su ON st.USER_ID = su.USER_ID' +
    (flagZeroOnly ? ' WHERE st.FLAG = 0' : '') +
    ' ORDER BY st.DATABASE_NAME, su.NAME, st.NAME';
  mc.querySQL(sql, '', '', '', function (err, result) {
    if (err) return cb(err);
    try {
      var parsed = JSON.parse(result);
      if (!parsed.success) return cb(new Error(parsed.reason));
      var rows = (parsed.data && parsed.data.rows) || [];
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        if (SYSTEM_TABLE.test(String(rows[i][2]))) continue;
        out.push({ db: String(rows[i][0]), owner: String(rows[i][1]), table: String(rows[i][2]) });
      }
      cb(null, out);
    } catch (e) { cb(e); }
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

// 문자열 리터럴 구간 — 그 안의 FROM/JOIN 토큰은 치환 대상이 아니다.
function stringRanges(sql) {
  var ranges = [], inStr = false, start = 0;
  for (var i = 0; i < sql.length; i++) {
    var ch = sql.charAt(i);
    if (!inStr && ch === "'") { inStr = true; start = i; }
    else if (inStr && ch === "'") { inStr = false; ranges.push([start, i]); }
  }
  return ranges;
}

// FROM/JOIN 뒤 접두 없는 이름에 소유자를 채운다. 붙일 소유자는 고정값이 아니라 접근 가능
// 목록에서 온다. 손대지 않는 경우가 셋: 접속 계정 소유일 때(이미 맞음), 목록에 없을 때(치환해도
// 실패라 기존 오류 흐름에 맡김), 소유자가 여럿이라 어느 것인지 모호할 때(엉뚱한 테이블을 조용히
// 읽는 것이 제일 위험하므로 고르지 않고 알린다).
function qualifyBareTables(sql, accessible, connectedUser) {
  var text = String(sql || '');
  var ranges = stringRanges(text);
  function inString(pos) {
    for (var i = 0; i < ranges.length; i++) if (pos > ranges[i][0] && pos < ranges[i][1]) return true;
    return false;
  }
  var sources = sourcesByTable(accessible);
  var re = /\b(FROM|JOIN)(\s+)([A-Za-z_$][A-Za-z0-9_$]*)(?![\w$.])/gi;
  var edits = [], changes = [], ambiguous = [], m;
  while ((m = re.exec(text)) !== null) {
    if (inString(m.index)) continue;
    var name = m[3].toUpperCase();
    if (SYSTEM_TABLE.test(name)) continue;
    var cands = sources[name];
    if (!cands || cands.length === 0) continue;
    var own = false;
    for (var c = 0; c < cands.length; c++) if (cands[c].owner === connectedUser) own = true;
    if (own) continue;
    if (cands.length > 1) { ambiguous.push({ table: name, sources: cands }); continue; }
    var pre = makeRef(cands[0].db, cands[0].owner, name).prefix;
    var start = m.index + m[1].length + m[2].length;
    edits.push({ start: start, end: start + m[3].length, text: pre + '.' + m[3] });
    changes.push(name + ' → ' + pre + '.' + name);
  }
  for (var e = edits.length - 1; e >= 0; e--) {
    text = text.slice(0, edits[e].start) + edits[e].text + text.slice(edits[e].end);
  }
  return { sql: text, changes: changes, ambiguous: ambiguous };
}

// 참조들이 모두 접근 가능한지 확인. 문제가 있으면 메시지, 없으면 null.
function verifyRefs(refs, accessible, connectedUser) {
  var sources = sourcesByTable(accessible);
  for (var i = 0; i < refs.length; i++) {
    var r = refs[i];
    if (!r.table || SYSTEM_TABLE.test(r.table)) continue;
    var cands = sources[r.table];
    if (!cands || cands.length === 0) return 'table not found or no permission: ' + r.qualified;
    if (r.owner) {
      var ok = false;
      for (var c = 0; c < cands.length; c++) {
        if (cands[c].owner !== r.owner) continue;
        if (r.db && cands[c].db !== r.db) continue;
        ok = true;
      }
      if (!ok) return 'table not found or no permission: ' + r.qualified;
    } else {
      var own = false;
      for (var c2 = 0; c2 < cands.length; c2++) if (cands[c2].owner === connectedUser) own = true;
      if (!own) {
        var full = makeRef(cands[0].db, cands[0].owner, r.table).qualified;
        return 'use the qualified name ' + full +
          ' — ' + r.table + ' alone resolves to ' + (connectedUser || 'the current user') + "'s schema";
      }
    }
  }
  return null;
}

// SQL/TQL 을 실행 전에 다듬는다: 접두 없는 이름에 소유자를 채우고, 남은 참조의 접근을 확인한다.
// cb(err, preparedSql)
function prepareSql(mc, sql, cb) {
  listAccessible(mc, false, function (err, accessible) {
    if (err) return cb(err);
    var connected = String(mc.user || '').toUpperCase();
    var q = qualifyBareTables(sql, accessible, connected);
    if (q.ambiguous.length > 0) {
      var a = q.ambiguous[0];
      var list = [];
      for (var i = 0; i < a.sources.length; i++) list.push(makeRef(a.sources[i].db, a.sources[i].owner, a.table).qualified);
      return cb(new Error(a.table + ' is ambiguous — it exists as ' + list.join(', ') + '. Use the qualified name.'));
    }
    if (q.changes.length > 0) console.println('[Access] 소유자 접두 자동 보정: ' + q.changes.join(', '));
    var problem = verifyRefs(extractTableRefs(q.sql), accessible, connected);
    if (problem) return cb(new Error(problem));
    cb(null, q.sql);
  });
}

// 참조 목록만 확인할 때(치환 없이).
function checkTableAccess(mc, refs, cb) {
  var wanted = [];
  for (var i = 0; i < refs.length; i++) {
    wanted.push((typeof refs[i] === 'string') ? parseTableRef(refs[i]) : refs[i]);
  }
  if (wanted.length === 0) return cb(null);
  listAccessible(mc, false, function (err, accessible) {
    if (err) return cb(err);
    var problem = verifyRefs(wanted, accessible, String(mc.user || '').toUpperCase());
    cb(problem ? new Error(problem) : null);
  });
}

// 이름 하나를 소유자까지 채운 참조로 바꾼다. 소유자가 생략됐으면 접근 가능한 테이블 중에서
// 찾되 접속 계정 소유를 우선한다. 못 찾으면 cb(Error).
// 부속 객체(_<t>_meta, v$<t>_stat, 롤업)도 같은 소유자 접두를 써야 하므로 도구들이 이걸 거친다.
function resolveTableRef(mc, name, cb) {
  var ref = parseTableRef(name);
  if (!ref.table) return cb(new Error('table name is required'));
  if (ref.owner) return cb(null, ref);

  listAccessible(mc, false, function (err, rows) {
    if (err) return cb(err);
    var cands = sourcesByTable(rows)[ref.table];
    if (!cands || cands.length === 0) return cb(new Error('table not found or no permission: ' + ref.table));
    var connected = String(mc.user || '').toUpperCase();
    var pick = cands[0];
    for (var i = 0; i < cands.length; i++) if (cands[i].owner === connected) pick = cands[i];
    cb(null, makeRef(pick.db, pick.owner, ref.table));
  });
}

module.exports = {
  parseTableRef, makeRef, qualify, extractTableRefs, listAccessible, qualifyBareTables,
  prepareSql, checkTableAccess, resolveTableRef, SYSTEM_TABLE,
};
