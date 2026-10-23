var { argStr, argInt } = require('./registry');
var { prepareSql, resolveTableRef, listAccessible, qualify, readTagNames, statViewName, countRollups } = require('./table_access');
var rangeCache = require('./range_cache');
var security = require('./security');
var { wallTime, zoneName, userZone } = require('../machbase/timezone');

// Machbase SQL 방언 자동교정 — 항상 실패하는 형태만 실행 전에 결정론적으로 교정
var TRUNC_UNIT = /^(sec|min|hour|day|week|month|year)$/i;
function sanitizeSql(sql) {
  var before = sql;
  // DATE_TRUNC(col, 'unit') → DATE_TRUNC('unit', col) — Machbase는 단위가 먼저(뒤집힌 형태만 매칭)
  sql = sql.replace(/DATE_TRUNC\s*\(\s*([^,'()]+?)\s*,\s*'([A-Za-z]+)'\s*\)/gi, function (m, col, unit) {
    return TRUNC_UNIT.test(unit) ? "DATE_TRUNC('" + unit.toLowerCase() + "', " + col.trim() + ")" : m;
  });
  if (sql !== before) console.println('[SQL] DATE_TRUNC 인자순서 자동교정(sanitizeSql)');
  // 한글 컬럼 별칭 → ASCII 별칭(col1…) — Machbase는 별칭에 한글 불가(ERR-2010)
  // · SQL 전체의 같은 토큰 치환(GROUP BY/ORDER BY/HAVING 참조 포함)
  var aliasRe = /\bAS\s+"?([가-힣][^\s,()"']*)"?/gi, aliasMap = {}, ai = 0, am;
  while ((am = aliasRe.exec(sql)) !== null) { if (!aliasMap[am[1]]) aliasMap[am[1]] = 'col' + (++ai); }
  var aliasKeys = Object.keys(aliasMap);
  if (aliasKeys.length) {
    aliasKeys.forEach(function (kw) { sql = sql.split('"' + kw + '"').join(aliasMap[kw]).split(kw).join(aliasMap[kw]); });
    console.println('[SQL] 한글 별칭 → ASCII 자동교정(sanitizeSql): ' + aliasKeys.join(', '));
  }
  // 버킷 GROUP BY + SELECT/ORDER BY의 raw TIME(ERR-2044 확정) → raw TIME을 버킷식으로 치환
  var fixed = fixRawTimeWithBucketGroupBy(sql);
  if (fixed !== sql) { console.println('[SQL] 버킷 GROUP BY + raw TIME → 버킷식 자동교정(sanitizeSql)'); sql = fixed; }
  return sql;
}

// SELECT-list의 괄호깊이 0 단독 컬럼 토큰 수집(함수명·AS 별칭·점표기 제외, 서브쿼리면 빈 배열)
// · 버킷 GROUP BY의 bare NAME/VALUE 진단용(NAME 자동 추가·2044 힌트)
var SELECT_KEYWORDS = { SELECT: 1, DISTINCT: 1, ALL: 1, AS: 1, CASE: 1, WHEN: 1, THEN: 1, ELSE: 1, END: 1, AND: 1, OR: 1, NOT: 1, NULL: 1, TRUE: 1, FALSE: 1 };
function bareSelectCols(sql) {
  var s = String(sql || '');
  if (/FROM\s*\(/i.test(s)) return [];
  var selM = s.match(/^\s*SELECT\b([\s\S]*?)\bFROM\b/i);
  if (!selM) return [];
  var seg = selM[1], cols = [], depth = 0, inStr = false, i = 0, prevUp = '';
  while (i < seg.length) {
    var ch = seg.charAt(i);
    if (inStr) { if (ch === "'") inStr = false; i++; continue; }
    if (ch === "'") { inStr = true; i++; continue; }
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') { depth--; i++; continue; }
    if (/[A-Za-z_]/.test(ch)) {
      var m = seg.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      var word = m[0], up = word.toUpperCase();
      var nextNonSpace = ((seg.slice(i + word.length).match(/^\s*(\S)/) || [])[1]) || '';
      var prevCh = i > 0 ? seg.charAt(i - 1) : '';
      if (depth === 0 && !SELECT_KEYWORDS[up] && nextNonSpace !== '(' && nextNonSpace !== '.' &&
          prevCh !== '.' && prevUp !== 'AS' && cols.indexOf(up) < 0) cols.push(up);
      prevUp = up; i += word.length; continue;
    }
    i++;
  }
  return cols;
}

// SELECT/ORDER BY 절의 괄호깊이 0 단독 TIME → 버킷식 치환
// · 단일 패스로 절 상태 추적 — 이중 래핑 방지
// · 함수 인자 속 TIME·t.TIME·AS TIME은 제외, 서브쿼리는 스킵
function fixRawTimeWithBucketGroupBy(sql) {
  var s = String(sql || '');
  if (/FROM\s*\(/i.test(s)) return sql;                                  // 서브쿼리 → 스킵
  var gb = s.match(/\bGROUP\s+BY\b([\s\S]*?)(?:\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|$)/i);
  if (!gb) return sql;
  var bucket = (gb[1].match(/(?:DATE_TRUNC|ROLLUP)\s*\((?:[^()]|\([^()]*\))*\)/i) || [])[0];
  if (!bucket) return sql;                                                // 버킷 GROUP BY 아님 → 스킵
  if (/\bTIME\b/i.test(gb[1].replace(/(?:DATE_TRUNC|ROLLUP)\s*\((?:[^()]|\([^()]*\))*\)/gi, ''))) return sql; // GROUP BY에 raw TIME도 있으면(합법일 수 있음) 스킵
  var out = '', depth = 0, inStr = false, i = 0, clause = '', prevWordUp = '';
  while (i < s.length) {
    var ch = s.charAt(i);
    if (inStr) { out += ch; if (ch === "'") inStr = false; i++; continue; }
    if (ch === "'") { inStr = true; out += ch; i++; continue; }
    if (ch === '(') { depth++; out += ch; i++; continue; }
    if (ch === ')') { depth--; out += ch; i++; continue; }
    if (/[A-Za-z_]/.test(ch)) {
      var m = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      var word = m[0], up = word.toUpperCase();
      if (depth === 0) {
        if (up === 'SELECT') clause = 'select';
        else if (up === 'FROM' || up === 'LIMIT' || up === 'HAVING') clause = '';
        else if (up === 'BY' && prevWordUp === 'ORDER') clause = 'orderby';
        else if (up === 'BY' && prevWordUp === 'GROUP') clause = 'groupby';
        else if (up === 'TIME' && (clause === 'select' || clause === 'orderby')) {
          var prevCh = (out.match(/(\S)\s*$/) || [])[1] || '';
          var nextCh = s.charAt(i + word.length);
          if (prevCh !== '.' && nextCh !== '.' && prevWordUp !== 'AS') {
            out += bucket; prevWordUp = up; i += word.length; continue;
          }
        }
      }
      out += word; prevWordUp = up; i += word.length; continue;
    }
    out += ch; i++;
  }
  // SELECT의 bare NAME이 GROUP BY에 없으면 GROUP BY에 추가
  // · bare VALUE는 집계 의도를 알 수 없어 미변경(2044 힌트로 위임)
  if (bareSelectCols(out).indexOf('NAME') >= 0) {
    var gb2 = out.match(/\bGROUP\s+BY\b([\s\S]*?)(?:\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|$)/i);
    if (gb2 && !/\bNAME\b/i.test(gb2[1])) {
      out = out.replace(/(\bGROUP\s+BY\b)([\s\S]*?)(\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|$)/i, function (_all, a, b, c) {
        return a + b.replace(/\s+$/, '') + ', NAME ' + c;
      });
    }
  }
  return out;
}

// 쿼리의 ROLLUP(...) 식 → 같은 단위의 DATE_TRUNC 식(ROLLUP 오류 힌트 예시용)
// · 배수는 DATE_TRUNC가 받는 범위(하루 이내)일 때만 세 번째 인자로 옮김
var TRUNC_MAX_N = { sec: 86400, min: 1440, hour: 24 };
function truncFromRollup(sql) {
  var m = String(sql || '').match(/ROLLUP\s*\(\s*'([a-z]+)'\s*,\s*(\d+)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)/i);
  if (!m) return "DATE_TRUNC('hour', TIME)";
  var unit = m[1].toLowerCase(), n = parseInt(m[2], 10);
  return "DATE_TRUNC('" + unit + "', " + m[3] + (n > 1 && n <= (TRUNC_MAX_N[unit] || 0) ? ', ' + n : '') + ')';
}

// 알려진 오류코드별 교정 힌트 — 모델의 올바른 형태 재시도 유도
function hintForError(reason, sql) {
  var r = String(reason || '');
  var s = String(sql || '');
  var HINT_TRUNC = ' (힌트: 시간버킷은 DATE_TRUNC(\'hour\', TIME) — 단위 먼저. ROLLUP 있으면 ROLLUP(\'hour\',1,TIME) 우선. STDDEV는 ROLLUP 불가라 DATE_TRUNC+GROUP BY)';
  var HINT_TAG = ' (힌트: 태그 이름을 컬럼처럼 쓰지 마세요. 태그 필터는 WHERE NAME=\'태그명\', 값 조건은 VALUE 컬럼을 씁니다. 예: WHERE NAME=\'TAG01\' AND VALUE > 12 AND VALUE < 15)';
  var HINT_GROUPBY = ' (힌트: ERR-2044는 DATE_TRUNC/ROLLUP 고장이 아닙니다 — GROUP BY에서 정상 작동합니다. 원인은 SELECT나 ORDER BY에서 raw TIME을 쓴 것입니다. 시간버킷으로 그룹했으면 ORDER BY·SELECT의 시간도 raw TIME 대신 같은 버킷식(또는 그 별칭)을 쓰세요. 예: SELECT DATE_TRUNC(\'hour\',TIME) AS bucket, MAX(VALUE)-MIN(VALUE) AS band FROM ... GROUP BY DATE_TRUNC(\'hour\',TIME) ORDER BY bucket)';
  // 에러코드 판정 먼저, 텍스트 매칭은 폴백 — reason이 SQL 전체를 echo해 텍스트 매칭이 오판함
  if (/2129/.test(r)) return ' (힌트: 서수 GROUP BY 1 미지원 → GROUP BY엔 표현식/별칭 전체를 쓰세요)';
  // ROLLUP 쿼리 실패 — 둘 다 DATE_TRUNC로 바꾸면 됨(2264: ROLLUP 없는 테이블, 2816: ROLLUP이 못 하는 집계·비집계 컬럼)
  if (/ERR-2264/.test(r)) {
    var bx = truncFromRollup(s);
    return ' (힌트: 이 테이블에는 ROLLUP이 없어 ROLLUP(...) 쿼리를 쓸 수 없습니다. ' + bx + '로 바꿔 다시 실행하세요. 예: SELECT ' + bx + ' AS bucket, AVG(VALUE) FROM ... GROUP BY bucket ORDER BY bucket)';
  }
  if (/ERR-2816/.test(r)) return ' (힌트: ROLLUP 쿼리는 AVG·SUM·MIN·MAX·COUNT·SUMSQ 집계만 됩니다. STDDEV 같은 다른 집계나 집계하지 않은 컬럼이 있으면 ROLLUP(...) 대신 ' + truncFromRollup(s) + '로 바꿔 다시 실행하세요)';
  if (/2010/.test(r)) {
    // ± INTERVAL '따옴표' 산술 원인 — 별칭 오진단 방지(따옴표 없는 INTERVAL 1 DAY는 정상)
    if (/[-+]\s*INTERVAL\s*'/i.test(s)) return ' (힌트: INTERVAL \'숫자\' 단위 문법이 오류를 냈습니다. INTERVAL 1 DAY처럼 따옴표 없이 쓰거나, TO_DATE(\'YYYY-MM-DD HH24:MI:SS\') 리터럴 두 개로 범위를 직접 쓰세요. 질문에 기간이 명시되지 않았다면 TIME 필터를 아예 빼고 전체 기간으로 조회하세요.)';
    // ERR-2010 "near token (X FROM ..." → X가 문제의 별칭, 한글/예약어 구분 안내
    var m2010 = r.match(/near token \(\s*([^\s)]+)/);
    var tok = m2010 ? m2010[1] : '';
    if (tok && /[^\x00-\x7F]/.test(tok)) return ' (힌트: 별칭 "' + tok + '"이 한글입니다 — 컬럼 별칭은 영어만 됩니다. 예: AS band)';
    if (tok) return ' (힌트: 별칭 "' + tok + '"이 예약어이거나 허용되지 않는 이름입니다. RANGE·VALUE·TIME·NAME·DATE 같은 예약어를 피해 평범한 영어 별칭을 쓰세요. 예: AS band, AS diff, AS val_range)';
    return ' (힌트: 컬럼 별칭은 예약어(RANGE·VALUE·TIME 등)·한글을 피하고 평범한 영어 단어를 쓰세요. 예: AS band)';
  }
  if (/2056/.test(r)) return HINT_TAG;
  if (/2044/.test(r)) {
    // 문제의 bare 컬럼(VALUE/NAME) 콕 집어 안내
    var _bare = bareSelectCols(s), _extra = '';
    if (_bare.indexOf('VALUE') >= 0) _extra += ' 특히 이 쿼리는 SELECT에 raw VALUE가 있습니다 — GROUP BY 집계에서는 집계함수로 감싸야 합니다(평균은 AVG(VALUE), 변동폭은 MAX(VALUE)-MIN(VALUE)).';
    if (_bare.indexOf('NAME') >= 0) _extra += ' SELECT의 NAME은 GROUP BY 목록에 NAME을 추가하면 됩니다.';
    return HINT_GROUPBY + _extra;
  }
  if (/2037/.test(r)) return HINT_TRUNC;
  // ERR-2251 "duplicate flag (SUMMARIZED)" — TAG 테이블에 SUMMARIZED 컬럼 2개 이상(남길 컬럼은 모델이 선택)
  if (/2251|duplicate flag/i.test(r)) return ' (힌트: TAG 테이블은 SUMMARIZED(값) 컬럼을 하나만 가질 수 있습니다. 값 컬럼 하나에만 SUMMARIZED를 붙이고 나머지는 일반 컬럼으로 하세요. 예: temperature DOUBLE SUMMARIZED, humidity DOUBLE. 값이 여러 개면 태그를 분리하는 것도 방법입니다: name=\'dev_temp\', name=\'dev_hum\'.)';
  // MACHCLI-ERR-300 "Invalid date value" — 잘못된 날짜 리터럴/TO_DATE 오용(예: 두 번째 인자에 'INTERVAL DAY + 1')
  if (/MACHCLI-ERR-300|Invalid date value/i.test(r)) return ' (힌트: 날짜 리터럴/형식 오류입니다. TO_DATE(\'2024-01-01\') 또는 TO_DATE(\'2024-01-01 09:00:00\', \'YYYY-MM-DD HH24:MI:SS\') 형태만 쓰세요. TO_DATE의 두 번째 인자는 형식 문자열만 가능하며 INTERVAL 식은 넣을 수 없습니다. 질문에 기간이 명시되지 않았다면 TIME 필터를 아예 빼고 전체 기간으로 조회하세요.)';
  // 코드로 못 잡은 경우에만 텍스트 휴리스틱 폴백(에러코드 없는 변형 대비)
  if (/Column name .* not found/i.test(r)) return HINT_TAG;
  if (/Not a GROUP BY expression/i.test(r)) return HINT_GROUPBY;
  if (/DATE_TRUNC/i.test(r)) return HINT_TRUNC;
  return '';
}

// 순수 기간 조회인가 — SELECT 항목이 전부 MIN/MAX(컬럼)[ AS 별칭]이고 GROUP BY 없음
function isPureTimeRange(sql) {
  if (/\bGROUP\s+BY\b/i.test(sql)) return false;
  var m = String(sql).match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\s/i);
  if (!m) return false;
  var items = m[1].split(',');
  for (var i = 0; i < items.length; i++) {
    if (!/^\s*(MIN|MAX)\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)(\s+(AS\s+)?[A-Za-z_][A-Za-z0-9_]*)?\s*$/i.test(items[i])) return false;
  }
  return true;
}

// epoch ms → "YYYY-MM-DD HH:MM:SS"
// · zone을 안 주면 서버 시간대
function msToLocal(ms, zone) {
  return wallTime(ms, zone ? zone.offsetMin : null);
}

// epoch 결과 옆에 사용자 시간대 시각 병기 — 모델의 직접 변환 오답 방지(최대 10개)
function epochNote(rows, timeformat, zone) {
  var div = /^ns$/i.test(timeformat) ? 1e6 : /^us$/i.test(timeformat) ? 1e3 : 1;
  var seen = {}, notes = [];
  for (var i = 0; i < rows.length && notes.length < 10; i++) {
    for (var j = 0; j < rows[i].length && notes.length < 10; j++) {
      var v = String(rows[i][j]);
      if (!/^\d{13,19}$/.test(v) || seen[v]) continue;
      var ms = Math.floor(Number(v) / div);
      if (!(ms > 946684800000 && ms < 4102444800000)) continue; // 2000~2100년만
      seen[v] = 1;
      notes.push(v + ' = ' + msToLocal(ms, zone));
    }
  }
  return notes.length ? '\n' + '(시각 표기 ' + (zone || userZone(null)).label + ': ' + notes.join(', ') + ')' : '';
}

function register(registry, mc) {
  // list_tables
  registry.register({
    name: 'list_tables',
    description: 'List accessible TAG tables as fully qualified names (e.g. MACHBASEDB.SYS.BITCOIN). Use the name exactly as listed in SQL/TQL — an unqualified name resolves to the connected account and fails for tables owned by others.',
    parameters: { type: 'object', properties: {} },
    fn: function (args, cb) {
      // 소유자 조건 없음 — DB가 세션 사용자 기준으로 거름(조건 걸면 GRANT 테이블 누락)
      listAccessible(mc, true, function (err, rows) {
        if (err) return cb(null, 'Error: ' + err.message);
        if (rows.length === 0) return cb(null, 'No tables found.');
        // 데이터베이스·테이블 표 + 건수 + 쿼리용 전체 이름 목록 — 건수는 도구가 확정(모델 계수 오답 방지)
        var out = '| 데이터베이스 | 테이블 |\n|---|---|\n';
        var full = [];
        for (var i = 0; i < rows.length; i++) {
          out += '| ' + rows[i].db + ' | ' + rows[i].table + ' |\n';
          full.push(qualify(rows[i].db, rows[i].owner, rows[i].table));
        }
        out += '\n(' + rows.length + ' tables)\n\n'
          + 'The table above is already displayed to the user — do not repeat it in your answer. '
          + 'Use these full names when writing SQL/TQL:\n'
          + full.join('\n');
        cb(null, out);
      });
    },
  });

  // list_table_tags
  registry.register({
    name: 'list_table_tags',
    description: 'List all tag names (NAME column distinct values) in a specific TAG table.',
    parameters: {
      type: 'object',
      properties: {
        table_name: { type: 'string', description: 'Table name to query tags from' },
      },
      required: ['table_name'],
    },
    fn: function (args, cb) {
      var table = argStr(args, 'table_name', '');
      if (!table) return cb(null, 'Error: table_name is required');
      resolveTableRef(mc, table, function (refErr, ref) {
        if (refErr) return cb(null, 'Error: ' + refErr.message);
        readTagNames(mc, ref, '', function (err, tags, source) {
          if (err) return cb(null, 'Error: ' + err.message);
          cb(null, '[' + ref.qualified + '] ' + tags.join(', ') +
            (source === 'stat' ? '\n(메타 테이블 조회 불가 → 통계 뷰 기준, 데이터가 있는 태그만 표시)' : ''));
        });
      });
    },
  });

  // describe_table
  registry.register({
    name: 'describe_table',
    description: 'Get table type (TAG/LOG) and column structure (name, type, role). Call this BEFORE generating TQL/SQL to know the actual column names. Accepts an owner-qualified name (e.g. SYS.BITCOIN) and verifies access.',
    parameters: {
      type: 'object',
      properties: {
        table_name: { type: 'string', description: 'Table name to describe' },
        profile: { type: 'boolean', description: 'If true (TAG tables), also return tag list, per-tag stats (count/min/max) and time range(ms) for dashboard building.' },
      },
      required: ['table_name'],
    },
    fn: function (args, cb) {
      var table = argStr(args, 'table_name', '');
      if (!table) return cb(null, 'Error: table_name is required');
      var profile = (args.profile === true || String(args.profile) === 'true');

      // 소유자 해석 — GRANT 받은 남의 테이블과 부속 객체(_meta·v$stat) 조회용
      resolveTableRef(mc, table, function (refErr, ref) {
      if (refErr) return cb(null, 'Error: ' + refErr.message);
      var owner = ref.owner;
      var upperTable = ref.table;

      // 테이블 타입 + 컬럼 정보를 한번에 조회
      var sql = "SELECT m1.TYPE AS TABLE_TYPE, m2.NAME AS COLUMN_NAME, m2.TYPE AS COL_TYPE, m2.FLAG AS COL_FLAG, m2.ID AS COL_ID " +
        "FROM M$SYS_TABLES m1, M$SYS_COLUMNS m2 " +
        "WHERE m1.ID = m2.TABLE_ID AND m1.DATABASE_ID = m2.DATABASE_ID " +
        "AND m1.USER_ID = (SELECT USER_ID FROM M$SYS_USERS WHERE NAME = '" + owner + "' LIMIT 1) " +
        "AND m1.NAME = '" + upperTable + "' AND m1.FLAG = 0 " +
        "ORDER BY m2.ID";

      mc.querySQL(sql, '', '', '', function (err, result) {
        if (err) return cb(null, 'Error: ' + err.message);
        try {
          var parsed = JSON.parse(result);
          if (!parsed.success) return cb(null, 'Error: ' + parsed.reason);
          var rows = parsed.data.rows;
          if (!rows || rows.length === 0) return cb(null, 'Error: table not found or no permission');

          var tableType = rows[0][0] === 6 ? 'TAG' : 'LOG';
          var TYPE_NAMES = { 5: 'varchar', 6: 'datetime', 8: 'int32', 12: 'int64', 16: 'float', 20: 'double' };
          var out = '[' + ref.qualified + '] type: ' + tableType + '\n';

          var nameCol = '', timeCol = '', valueCol = '';
          for (var i = 0; i < rows.length; i++) {
            var colName = rows[i][1];
            var colType = TYPE_NAMES[rows[i][2]] || 'type(' + rows[i][2] + ')';
            var colFlag = rows[i][3];
            var colId = rows[i][4];

            // 내부 컬럼 건너뛰기
            if (colId === 65534) continue;
            if (colId === 0 && (colName === '_ROWID' || colName === '_ARRIVAL_TIME')) continue;

            var role = '';
            // 비트 AND — ROLLUP 테이블은 SUMMARIZED 컬럼 플래그에 rollup 비트가 더해짐(예 570425344) → 정확비교(===)로는 누락
            if (colFlag & 134217728) { role = ' PRIMARY KEY'; nameCol = colName; }
            else if (colFlag & 16777216) { role = ' BASETIME'; timeCol = colName; }
            else if (colFlag & 33554432) { role = ' SUMMARIZED'; valueCol = colName; }

            out += '- ' + colName + ' (' + colType + ')' + role + '\n';
          }

          // TAG 테이블이면 롤업 존재 여부를 실제 확인
          if (tableType !== 'TAG') {
            out += 'ROLLUP: not available\n';
            return cb(null, out.trim());
          }
          countRollups(mc, ref.qualified, function (rollupCount) {
            if (rollupCount > 0) out += 'ROLLUP: available (' + rollupCount + ' rollup tables)\n';
            else out += 'ROLLUP: not available\n';
            // 태그별 요약통계 가상뷰(TAG 테이블엔 항상 존재) — 모델이 GROUP BY 집계를 직접 짜다 컬럼 빠뜨리는 것 방지
            out += 'STAT: ' + ref.prefix + '.v$' + upperTable + '_stat (per-tag WHOLE-RANGE summary: name, row_count, min_value, max_value, min_time, max_time) — 태그별 "전체 기간" 개수·최소·최대·기간 요약 전용. 시간별/일별 등 시간 버킷 집계에는 사용 금지 — 그 경우 ROLLUP/DATE_TRUNC를 쓰세요\n';
            if (!profile) return cb(null, out.trim());
            appendProfile(mc, ref, nameCol || 'NAME', timeCol || 'TIME', valueCol || 'VALUE', out, cb);
          });
        } catch (e) { cb(null, 'Error: ' + e.message); }
      });
      });
    },
  });

  // execute_sql_query
  registry.register({
    name: 'execute_sql_query',
    description: 'Execute a SQL query on Machbase Neo and return results. Use timeformat parameter for time formatting (not inside SQL). UPDATE/DELETE/DROP statements are not allowed.',
    parameters: {
      type: 'object',
      properties: {
        sql_query: { type: 'string', description: 'SQL query to execute' },
        format: { type: 'string', description: 'Output format: csv (default) or json', default: 'csv' },
        timeformat: { type: 'string', description: 'Time format: default, ms, us, ns' },
        timezone: { type: 'string', description: 'Timezone for displayed times (e.g., UTC, Asia/Seoul). Pass only when the user asks for one — defaults to the user\'s browser time zone' },
        limit: { type: 'integer', description: 'Max rows to return (default: 500)', default: 500 },
      },
      required: ['sql_query'],
    },
    fn: function (args, cb) {
      var rawSql = argStr(args, 'sql_query', '');
      if (!rawSql) return cb(null, 'Error: sql_query is required');
      var sql = sanitizeSql(rawSql); // 방언 자동교정(DATE_TRUNC 인자순서 등)
      // 교정됐으면 실행 SQL을 같은 sql_query: 형식으로 로그
      if (sql !== rawSql) console.println('  |- sql_query: ' + sql);

      var upper = sql.toUpperCase().trim();
      // 보안 재검사(교정 후 SQL 기준) — 변경·권한 문·다중 문·자격증명 테이블 조회 거부
      var denied = security.sqlDenied(sql);
      if (denied) return cb(null, 'Error: ' + denied);

      var format = argStr(args, 'format', 'csv');
      // 시각은 읽기형(Default) + 사용자 시간대가 기본 — 빈 timeformat은 epoch 숫자라 사용자에게 비친화적
      // · timezone은 사용자가 따로 요청했을 때만 모델이 넘김
      var timeformat = argStr(args, 'timeformat', 'Default');
      var timezone = argStr(args, 'timezone', '') || zoneName(mc);
      // ms/us/ns 요청도 표시용 쿼리는 읽기형 강제
      // · 순수 기간 조회(MIN/MAX(컬럼)뿐, GROUP BY 없음)만 epoch 유지 — 다음 도구 인자(대시보드 기간 등)용
      var keepEpoch = /^(ms|us|ns)$/i.test(timeformat) && isPureTimeRange(sql);
      if (/^(ms|us|ns)$/i.test(timeformat) && !keepEpoch) {
        timeformat = 'Default';
        console.println('[SQL] 표시용 쿼리 timeformat ms→Default(읽기형) 자동교정');
      }
      var limit = argInt(args, 'limit', 500);

      if (upper.indexOf('LIMIT') === -1 && upper.indexOf('SELECT') === 0) {
        sql = sql.replace(/;?\s*$/, '') + ' LIMIT ' + limit;
      }

      var finalSQL = sql;
      // 접근 확인 + 소유자 접두 자동 보정(실행 전)
      prepareSql(mc, finalSQL, function (accessErr, preparedSQL) {
        if (accessErr) return cb(null, 'Error: ' + accessErr.message);
        finalSQL = preparedSQL;
        // Always request JSON from Machbase, format to CSV in code if needed
        mc.querySQL(finalSQL, timeformat, timezone, '', function (err, result) {
          if (err) return cb(null, 'Error: ' + err.message + hintForError(err.message, finalSQL));
          if (format === 'json') return cb(null, result);
          try {
            var parsed = JSON.parse(result);
            if (!parsed.success) return cb(null, 'Error: ' + parsed.reason + hintForError(parsed.reason, finalSQL));
            var cols = parsed.data.columns;
            var rows = parsed.data.rows;
            var out = cols.join(',') + '\n';
            for (var i = 0; i < rows.length; i++) out += rows[i].join(',') + '\n';
            out = out.trim();
            // 실제 행 수 footer — LIMIT 값을 건수로 지어내는 것 방지
            var n = rows.length;
            // effective LIMIT: explicit LIMIT in the SQL, else the auto-applied limit param
            var limM = upper.match(/\bLIMIT\s+(\d+)/);
            var effLimit = limM ? parseInt(limM[1], 10) : limit;
            var footer = '\n\n(' + n + ' row' + (n === 1 ? '' : 's') + ')';
            if (n >= effLimit) footer += ' — capped at LIMIT ' + effLimit + ', more rows may exist';
            if (keepEpoch) footer += epochNote(rows, timeformat, userZone(mc));
            cb(null, out + footer);
          } catch (e) { cb(null, result); }
        });
      });
    },
  });
}

// Append dashboard profile (tags + per-tag stats + time range) for TAG tables — one-call exploration.
function appendProfile(mc, ref, nameCol, timeCol, valueCol, out, cb) {
  var table = ref.qualified;
  readTagNames(mc, ref, nameCol, function (errT, tags, source) {
    if (errT) tags = [];
    out += 'tags (' + tags.length + (source === 'stat' ? ', 통계 뷰 기준·데이터 있는 태그만' : '') + '): ' + tags.join(', ') + '\n';

    mc.querySQL('SELECT MIN(' + timeCol + '), MAX(' + timeCol + ') FROM ' + table, 'ms', '', '', function (errR, resR) {
      if (!errR) {
        try {
          var pR = JSON.parse(resR);
          if (pR.success && pR.data && pR.data.rows && pR.data.rows.length > 0) {
            var mn = pR.data.rows[0][0], mx = pR.data.rows[0][1];
            if (mn != null && mx != null) {
              // ms는 도구 인자(time_start/time_end)용, 읽기형은 모델이 읽는 기간(직접 변환 오답 방지)
              var zone = userZone(mc);
              out += 'time range (ms): ' + mn + ' ~ ' + mx +
                ' (' + zone.label + ' ' + msToLocal(parseInt(String(mn), 10), zone) + ' ~ ' + msToLocal(parseInt(String(mx), 10), zone) + ')\n';
              rangeCache.set(table, parseInt(String(mn), 10), parseInt(String(mx), 10));
            }
          }
        } catch (e) {}
      }

      // 태그별 건수·최소·최대 — 통계 뷰(전체 스캔 회피), 실패 시 GROUP BY 집계
      var statsSQL = 'SELECT NAME, ROW_COUNT, ROUND(MIN_VALUE,2), ROUND(MAX_VALUE,2) FROM ' + statViewName(ref) + ' ORDER BY NAME';
      var groupSQL = 'SELECT ' + nameCol + ', COUNT(*), ROUND(MIN(' + valueCol + '),2), ROUND(MAX(' + valueCol + '),2) FROM ' + table + ' GROUP BY ' + nameCol;
      function writeStats(srows) {
        if (!srows || srows.length === 0) return;
        var STAT_CAP = 50;
        out += 'tag stats:\n';
        var cap = srows.length > STAT_CAP ? STAT_CAP : srows.length;
        for (var j = 0; j < cap; j++) {
          var r = srows[j];
          out += '  ' + r[0] + '  count=' + r[1] + '  min=' + (r[2] == null ? '-' : r[2]) + '  max=' + (r[3] == null ? '-' : r[3]) + '\n';
        }
        if (srows.length > STAT_CAP) out += '  …(+' + (srows.length - STAT_CAP) + ' more tags)\n';
      }
      function statRows(err, res) {
        if (err) return null;
        try {
          var p = JSON.parse(res);
          return (p.success && p.data && p.data.rows && p.data.rows.length > 0) ? p.data.rows : null;
        } catch (e) { return null; }
      }
      mc.querySQL(statsSQL, '', '', '', function (errS, resS) {
        var srows = statRows(errS, resS);
        if (srows) { writeStats(srows); return cb(null, out.trim()); }
        mc.querySQL(groupSQL, '', '', '', function (errG, resG) {
          writeStats(statRows(errG, resG));
          cb(null, out.trim());
        });
      });
    });
  });
}

module.exports = { register, bareSelectCols };
