var { argStr, argInt } = require('./registry');
var { extractUserTables, checkTableOwnership } = require('./ownership');
var rangeCache = require('./range_cache');
var security = require('./security');

// Machbase SQL 방언 자동교정 — 약한 모델이 자주 틀리는 "기계적으로 항상 틀린" 형태를 실행 전에 결정론적으로 바로잡는다.
// 프롬프트(규칙 안내)는 확률적이라 약한 모델이 안 지킴 → 도구 실행 직전 교정이 확실한 방어(normalizeHan/normalizeSpec와 동일 철학).
var TRUNC_UNIT = /^(sec|min|hour|day|week|month|year)$/i;
function sanitizeSql(sql) {
  var before = sql;
  // DATE_TRUNC(col, 'unit') → DATE_TRUNC('unit', col). Machbase는 단위가 먼저. 뒤집힌 형태만 매칭(올바른 형태는 첫 인자가
  // 따옴표라 제외돼 오탐 0). 방치하면 ERR-2037 → EXTRACT(EPOCH) 헛짚기 → "계산 불가" 환각으로 이어진다.
  sql = sql.replace(/DATE_TRUNC\s*\(\s*([^,'()]+?)\s*,\s*'([A-Za-z]+)'\s*\)/gi, function (m, col, unit) {
    return TRUNC_UNIT.test(unit) ? "DATE_TRUNC('" + unit.toLowerCase() + "', " + col.trim() + ")" : m;
  });
  if (sql !== before) console.println('[SQL] DATE_TRUNC 인자순서 자동교정(sanitizeSql)');
  // 한글(비ASCII) 컬럼 별칭 → 안전한 ASCII 별칭. Machbase는 별칭에 한글 불가(ERR-2010) → 약한 모델의 `AS 변동폭` 같은
  // 실수가 에러→재시도 degeneration의 첫 도미노가 됨. 별칭은 결과값에 무관한 표시 라벨이라 이름만 바꾸는 건 무조건 안전.
  // AS 뒤 한글 식별자와, 그 별칭을 참조하는 GROUP BY/ORDER BY/HAVING의 동일 토큰까지 함께 치환(문자열 리터럴 속 한글은
  // 실무상 없음 — 태그명·값은 영문). split/join 리터럴 치환이라 정규식 이스케이프 불필요.
  var aliasRe = /\bAS\s+"?([가-힣][^\s,()"']*)"?/gi, aliasMap = {}, ai = 0, am;
  while ((am = aliasRe.exec(sql)) !== null) { if (!aliasMap[am[1]]) aliasMap[am[1]] = 'col' + (++ai); }
  var aliasKeys = Object.keys(aliasMap);
  if (aliasKeys.length) {
    aliasKeys.forEach(function (kw) { sql = sql.split('"' + kw + '"').join(aliasMap[kw]).split(kw).join(aliasMap[kw]); });
    console.println('[SQL] 한글 별칭 → ASCII 자동교정(sanitizeSql): ' + aliasKeys.join(', '));
  }
  // 버킷 GROUP BY(DATE_TRUNC/ROLLUP) + SELECT/ORDER BY의 raw TIME → 무조건 ERR-2044로 실패가 확정된 쿼리.
  // 에러 힌트(HINT_GROUPBY)로는 약한 모델이 ORDER BY만 고치고 SELECT의 raw TIME은 못 고침 →
  // raw TIME을 GROUP BY의 버킷식으로 결정론 치환. 실패 확정 쿼리만 건드리므로 "무조건 옳은 교정" 원칙 유지.
  // 서브쿼리(FROM ( )가 있으면 절 경계가 모호해 스킵(힌트 폴백). t.TIME/AS TIME/함수 안 TIME은 치환 제외.
  var fixed = fixRawTimeWithBucketGroupBy(sql);
  if (fixed !== sql) { console.println('[SQL] 버킷 GROUP BY + raw TIME → 버킷식 자동교정(sanitizeSql)'); sql = fixed; }
  return sql;
}

// SELECT-list의 괄호깊이 0 단독 컬럼 토큰 수집(함수명·AS 별칭·점표기 제외, 평면 쿼리 전용) —
// 버킷 GROUP BY에서 2044를 확정시키는 bare NAME/VALUE 진단용(sanitize NAME 추가 + 2044 동적 힌트 공용).
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

// SELECT-list/ORDER BY 절의 괄호깊이 0인 단독 TIME 토큰을 버킷식으로 치환. 전체 SQL을 단일 패스로 걸으며
// 절 상태(select/orderby)를 추적 — 세그먼트 잘라붙이기(split/join)는 " TIME" 같은 짧은 조각이 다른 위치까지
// 치환돼 이중 래핑되는 버그가 있어 금지. 함수 인자 속 TIME(depth>0)·t.TIME·AS TIME(별칭)은 건드리지 않는다.
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
  // 잔여 bare NAME(비집계 식별컬럼)이 SELECT에 있는데 GROUP BY에 없으면 → GROUP BY에 추가.
  // 2044 확정 쿼리의 정석 해석(선택한 식별컬럼 = 그룹핑 컬럼)이라 무위험. VALUE는 의미(AVG? MAX-MIN?)를
  // 추측해야 해서 재작성 금지 — 2044 동적 힌트로 위임.
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

// 알려진 오류코드에 교정 힌트를 붙여 모델이 올바른 형태로 재시도하게 한다(원문 에러만 주면 약한 모델이 "기능 제한"으로 포기).
function hintForError(reason, sql) {
  var r = String(reason || '');
  var s = String(sql || '');
  var HINT_TRUNC = ' (힌트: 시간버킷은 DATE_TRUNC(\'hour\', TIME) — 단위 먼저. ROLLUP 있으면 ROLLUP(\'hour\',1,TIME) 우선. STDDEV는 ROLLUP 불가라 DATE_TRUNC+GROUP BY)';
  var HINT_TAG = ' (힌트: 태그 이름을 컬럼처럼 쓰지 마세요. 태그 필터는 WHERE NAME=\'태그명\', 값 조건은 VALUE 컬럼을 씁니다. 예: WHERE NAME=\'TAG01\' AND VALUE > 12 AND VALUE < 15)';
  var HINT_GROUPBY = ' (힌트: ERR-2044는 DATE_TRUNC/ROLLUP 고장이 아닙니다 — GROUP BY에서 정상 작동합니다. 원인은 SELECT나 ORDER BY에서 raw TIME을 쓴 것입니다. 시간버킷으로 그룹했으면 ORDER BY·SELECT의 시간도 raw TIME 대신 같은 버킷식(또는 그 별칭)을 쓰세요. 예: SELECT DATE_TRUNC(\'hour\',TIME) AS bucket, MAX(VALUE)-MIN(VALUE) AS band FROM ... GROUP BY DATE_TRUNC(\'hour\',TIME) ORDER BY bucket)';
  // 특정 에러코드를 먼저 판정한다. 에러 reason은 문제의 SQL 전체를 echo하므로, 텍스트 매칭(예: /DATE_TRUNC/)을
  // 코드보다 먼저 두면 ERR-2010(별칭) 오류인데 SQL에 DATE_TRUNC 단어가 있다는 이유로 엉뚱한 DATE_TRUNC 힌트로
  // 새서 모델이 회복하지 못한다. 텍스트 매칭은 폴백으로.
  if (/2129/.test(r)) return ' (힌트: 서수 GROUP BY 1 미지원 → GROUP BY엔 표현식/별칭 전체를 쓰세요)';
  if (/2010/.test(r)) {
    // ± INTERVAL '따옴표' 산술이 원인일 땐 토큰('86400' 등)만 보면 별칭으로 오진단해 모델이 회복 못 한다.
    // (따옴표 없는 INTERVAL 1 DAY는 정상 동작이라 따옴표 형태만 잡음)
    if (/[-+]\s*INTERVAL\s*'/i.test(s)) return ' (힌트: INTERVAL \'숫자\' 단위 문법이 오류를 냈습니다. INTERVAL 1 DAY처럼 따옴표 없이 쓰거나, TO_DATE(\'YYYY-MM-DD HH24:MI:SS\') 리터럴 두 개로 범위를 직접 쓰세요. 질문에 기간이 명시되지 않았다면 TIME 필터를 아예 빼고 전체 기간으로 조회하세요.)';
    // ERR-2010 "near token (X FROM ..." → X가 문제의 별칭. 한글이냐 예약어냐를 구분해야 모델이 회복한다 —
    // 뭉뚱그려 "한글 별칭"이라 안내하면 AS RANGE(예약어) 오류를 오진단해 모델이 RANGE를 고집하며 무한 실패.
    var m2010 = r.match(/near token \(\s*([^\s)]+)/);
    var tok = m2010 ? m2010[1] : '';
    if (tok && /[^\x00-\x7F]/.test(tok)) return ' (힌트: 별칭 "' + tok + '"이 한글입니다 — 컬럼 별칭은 영어만 됩니다. 예: AS band)';
    if (tok) return ' (힌트: 별칭 "' + tok + '"이 예약어이거나 허용되지 않는 이름입니다. RANGE·VALUE·TIME·NAME·DATE 같은 예약어를 피해 평범한 영어 별칭을 쓰세요. 예: AS band, AS diff, AS val_range)';
    return ' (힌트: 컬럼 별칭은 예약어(RANGE·VALUE·TIME 등)·한글을 피하고 평범한 영어 단어를 쓰세요. 예: AS band)';
  }
  if (/2056/.test(r)) return HINT_TAG;
  if (/2044/.test(r)) {
    // 문제의 bare 컬럼을 콕 집어 안내 — 범용 raw TIME 설명만으론 약한 모델이 VALUE/NAME 케이스를 못 고친다.
    var _bare = bareSelectCols(s), _extra = '';
    if (_bare.indexOf('VALUE') >= 0) _extra += ' 특히 이 쿼리는 SELECT에 raw VALUE가 있습니다 — GROUP BY 집계에서는 집계함수로 감싸야 합니다(평균은 AVG(VALUE), 변동폭은 MAX(VALUE)-MIN(VALUE)).';
    if (_bare.indexOf('NAME') >= 0) _extra += ' SELECT의 NAME은 GROUP BY 목록에 NAME을 추가하면 됩니다.';
    return HINT_GROUPBY + _extra;
  }
  if (/2037/.test(r)) return HINT_TRUNC;
  // ERR-2251 "duplicate flag (SUMMARIZED)" — TAG 테이블에 SUMMARIZED 값 컬럼을 2개 이상 정의(모델이 온도·습도를 둘 다 값으로).
  // 어느 컬럼을 남길지는 의도(설계) 선택이라 자동 재작성 금지 → 넛지로 모델이 고르게(값 하나만 SUMMARIZED, 나머지 일반 컬럼 or 태그 분리).
  if (/2251|duplicate flag/i.test(r)) return ' (힌트: TAG 테이블은 SUMMARIZED(값) 컬럼을 하나만 가질 수 있습니다. 값 컬럼 하나에만 SUMMARIZED를 붙이고 나머지는 일반 컬럼으로 하세요. 예: temperature DOUBLE SUMMARIZED, humidity DOUBLE. 값이 여러 개면 태그를 분리하는 것도 방법입니다: name=\'dev_temp\', name=\'dev_hum\'.)';
  // MACHCLI-ERR-300 "Invalid date value" — 잘못된 날짜 리터럴/TO_DATE 오용(예: 두 번째 인자에 'INTERVAL DAY + 1').
  // 힌트 없이는 모델이 같은 SQL만 반복하다 교착한다.
  if (/MACHCLI-ERR-300|Invalid date value/i.test(r)) return ' (힌트: 날짜 리터럴/형식 오류입니다. TO_DATE(\'2024-01-01\') 또는 TO_DATE(\'2024-01-01 09:00:00\', \'YYYY-MM-DD HH24:MI:SS\') 형태만 쓰세요. TO_DATE의 두 번째 인자는 형식 문자열만 가능하며 INTERVAL 식은 넣을 수 없습니다. 질문에 기간이 명시되지 않았다면 TIME 필터를 아예 빼고 전체 기간으로 조회하세요.)';
  // 코드로 못 잡은 경우에만 텍스트 휴리스틱 폴백(에러코드 없는 변형 대비)
  if (/Column name .* not found/i.test(r)) return HINT_TAG;
  if (/Not a GROUP BY expression/i.test(r)) return HINT_GROUPBY;
  if (/DATE_TRUNC/i.test(r)) return HINT_TRUNC;
  return '';
}

function register(registry, mc) {
  // list_tables
  registry.register({
    name: 'list_tables',
    description: 'List all TAG tables in Machbase Neo database.',
    parameters: { type: 'object', properties: {} },
    fn: function (args, cb) {
      var owner = (mc.user || 'SYS').toUpperCase();
      mc.querySQL("SELECT st.NAME FROM M$SYS_TABLES AS st JOIN M$SYS_USERS AS su ON st.USER_ID = su.USER_ID WHERE su.NAME = '" + owner + "' AND st.FLAG = 0 ORDER BY st.NAME", '', '', '', function (err, result) {
        if (err) return cb(null, 'Error: ' + err.message);
        try {
          var parsed = JSON.parse(result);
          if (!parsed.success) return cb(null, 'Error: ' + parsed.reason);
          var rows = parsed.data.rows;
          var out = '';
          for (var i = 0; i < rows.length; i++) out += rows[i][0] + '\n';
          cb(null, out.trim() || 'No tables found.');
        } catch (e) { cb(null, 'Error: ' + e.message); }
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
      checkTableOwnership(mc, [table.toUpperCase()], function (ownerErr) {
        if (ownerErr) return cb(null, 'Error: ' + ownerErr.message);
        mc.querySQL("SELECT NAME FROM _" + table.toLowerCase() + "_meta", '', '', '', function (err, result) {
          if (err) return cb(null, 'Error: ' + err.message);
          try {
            var parsed = JSON.parse(result);
            if (!parsed.success) return cb(null, 'Error: ' + parsed.reason);
            var rows = parsed.data.rows;
            var tags = [];
            for (var i = 0; i < rows.length; i++) tags.push(rows[i][0]);
            cb(null, '[' + table + '] ' + tags.join(', '));
          } catch (e) { cb(null, 'Error: ' + e.message); }
        });
      });
    },
  });

  // describe_table
  registry.register({
    name: 'describe_table',
    description: 'Get table type (TAG/LOG) and column structure (name, type, role). Call this BEFORE generating TQL/SQL to know the actual column names. Includes ownership check.',
    parameters: {
      type: 'object',
      properties: {
        table_name: { type: 'string', description: 'Table name to describe' },
        profile: { type: 'boolean', description: 'If true (TAG tables), also return tag list, per-tag stats (count/avg/min/max) and time range(ms) for dashboard building.' },
      },
      required: ['table_name'],
    },
    fn: function (args, cb) {
      var table = argStr(args, 'table_name', '');
      if (!table) return cb(null, 'Error: table_name is required');
      var profile = (args.profile === true || String(args.profile) === 'true');
      var owner = (mc.user || 'SYS').toUpperCase();

      var upperTable = table.toUpperCase();

      // 테이블 타입 + 컬럼 정보를 한번에 조회
      var sql = "SELECT m1.TYPE AS TABLE_TYPE, m2.NAME AS COLUMN_NAME, m2.TYPE AS COL_TYPE, m2.FLAG AS COL_FLAG, m2.ID AS COL_ID " +
        "FROM M$SYS_TABLES m1, M$SYS_COLUMNS m2 " +
        "WHERE m1.ID = m2.TABLE_ID AND m1.DATABASE_ID = m2.DATABASE_ID " +
        "AND m1.USER_ID = (SELECT USER_ID FROM M$SYS_USERS WHERE NAME = '" + owner + "' LIMIT 1) " +
        "AND m1.NAME = '" + upperTable + "' AND m1.FLAG = 0 " +
        "ORDER BY m2.ID";

      // 롤업 테이블 개수 조회 (correlated subquery 미지원이므로 별도 쿼리)
      var rollupSQL = "SELECT COUNT(*) FROM M$SYS_TABLES WHERE NAME LIKE '_" + upperTable + "_ROLLUP_%' AND FLAG = 2";

      mc.querySQL(sql, '', '', '', function (err, result) {
        if (err) return cb(null, 'Error: ' + err.message);
        try {
          var parsed = JSON.parse(result);
          if (!parsed.success) return cb(null, 'Error: ' + parsed.reason);
          var rows = parsed.data.rows;
          if (!rows || rows.length === 0) return cb(null, 'Error: table not found or no permission');

          var tableType = rows[0][0] === 6 ? 'TAG' : 'LOG';
          var TYPE_NAMES = { 5: 'varchar', 6: 'datetime', 8: 'int32', 12: 'int64', 16: 'float', 20: 'double' };
          var out = '[' + upperTable + '] type: ' + tableType + '\n';

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
          mc.querySQL(rollupSQL, '', '', '', function (err2, result2) {
            var rollupCount = 0;
            if (!err2) {
              try {
                var p2 = JSON.parse(result2);
                if (p2.success && p2.data.rows && p2.data.rows.length > 0) rollupCount = p2.data.rows[0][0];
              } catch (e) {}
            }
            if (rollupCount > 0) out += 'ROLLUP: available (' + rollupCount + ' rollup tables)\n';
            else out += 'ROLLUP: not available\n';
            // 태그별 요약통계 가상뷰 — 항상 존재(TAG 테이블). 태그별 개수/최소/최대/기간 질문에서 모델이
            // GROUP BY 조합을 직접 만들다 컬럼(MIN/MAX(VALUE) 등)을 빼먹는 것 방지.
            out += 'STAT: v$' + upperTable + '_stat (per-tag WHOLE-RANGE summary: name, row_count, min_value, max_value, min_time, max_time) — 태그별 "전체 기간" 개수·최소·최대·기간 요약 전용. 시간별/일별 등 시간 버킷 집계에는 사용 금지 — 그 경우 ROLLUP/DATE_TRUNC를 쓰세요\n';
            if (!profile) return cb(null, out.trim());
            appendProfile(mc, upperTable, nameCol || 'NAME', timeCol || 'TIME', valueCol || 'VALUE', out, cb);
          });
        } catch (e) { cb(null, 'Error: ' + e.message); }
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
        timezone: { type: 'string', description: 'Timezone (e.g., UTC, Asia/Seoul)' },
        limit: { type: 'integer', description: 'Max rows to return (default: 500)', default: 500 },
      },
      required: ['sql_query'],
    },
    fn: function (args, cb) {
      var rawSql = argStr(args, 'sql_query', '');
      if (!rawSql) return cb(null, 'Error: sql_query is required');
      var sql = sanitizeSql(rawSql); // 방언 자동교정(DATE_TRUNC 인자순서 등) — 약한 모델 기계적 실수 결정론 방어
      // 교정됐으면 실제 실행 SQL을 같은 포맷으로 로그 — 평가 채점기(raw의 sql_query: 라인 재실행)가
      // 모델의 원본(실행 불가)이 아니라 실제 실행된 쿼리를 검증할 수 있게.
      if (sql !== rawSql) console.println('  |- sql_query: ' + sql);

      var upper = sql.toUpperCase().trim();
      // Defense-in-depth (also enforced at registry.execute chokepoint): refuse mutation/
      // privilege statements, multi-statement, and credential-table reads; allow SELECT + setup CREATE.
      var denied = security.sqlDenied(sql);
      if (denied) return cb(null, 'Error: ' + denied);

      var format = argStr(args, 'format', 'csv');
      // 기본값을 KST 읽기형으로: 빈 timeformat은 epoch(ms) 숫자를 반환해 사용자에게 비친화적 + epoch는 절대시각이라 tz 무의미.
      // Default(읽기형) + Asia/Seoul이라야 "2024-01-01 00:00:00"(KST)로 나온다(서울시 배포 = KST). 모델이 인자로 오버라이드 가능.
      var timeformat = argStr(args, 'timeformat', 'Default');
      var timezone = argStr(args, 'timezone', 'Asia/Seoul');
      // 표시용 쿼리엔 KST 읽기형 강제: 프롬프트가 timeformat:"ms"를 지시해 약한 모델이 ms(epoch 숫자)를 넘겨도,
      // 사용자에게 보여줄 결과는 epoch가 아니라 KST 읽기형이어야 한다(epoch는 절대시각이라 tz도 무의미). 단 시간범위
      // 계산(MIN/MAX(TIME))은 ms 숫자가 필요하므로 그 쿼리만 예외로 ms 유지. timezone은 위 기본 Asia/Seoul 그대로.
      if (/^(ms|us|ns)$/i.test(timeformat) && !/\b(MIN|MAX)\s*\(\s*TIME\s*\)/i.test(sql)) {
        timeformat = 'Default';
        console.println('[SQL] 표시용 쿼리 timeformat ms→Default(KST 읽기형) 자동교정');
      }
      var limit = argInt(args, 'limit', 500);

      if (upper.indexOf('LIMIT') === -1 && upper.indexOf('SELECT') === 0) {
        sql = sql.replace(/;?\s*$/, '') + ' LIMIT ' + limit;
      }

      var userTables = extractUserTables(sql);
      var finalSQL = sql;
      checkTableOwnership(mc, userTables, function (ownerErr) {
        if (ownerErr) return cb(null, 'Error: ' + ownerErr.message);
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
            // Ground-truth row count footer — prevents weak models from confabulating
            // a count from the LIMIT clause (e.g. reporting "50 rows" when only 9 returned).
            var n = rows.length;
            // effective LIMIT: explicit LIMIT in the SQL, else the auto-applied limit param
            var limM = upper.match(/\bLIMIT\s+(\d+)/);
            var effLimit = limM ? parseInt(limM[1], 10) : limit;
            var footer = '\n\n(' + n + ' row' + (n === 1 ? '' : 's') + ')';
            if (n >= effLimit) footer += ' — capped at LIMIT ' + effLimit + ', more rows may exist';
            cb(null, out + footer);
          } catch (e) { cb(null, result); }
        });
      });
    },
  });
}

// Append dashboard profile (tags + per-tag stats + time range) for TAG tables — one-call exploration.
function appendProfile(mc, table, nameCol, timeCol, valueCol, out, cb) {
  var tableLower = table.toLowerCase();
  mc.querySQL('SELECT ' + nameCol + ' FROM _' + tableLower + '_meta', '', '', '', function (errT, resT) {
    var tags = [];
    if (!errT) {
      try {
        var pT = JSON.parse(resT);
        if (pT.success && pT.data && pT.data.rows) {
          for (var i = 0; i < pT.data.rows.length; i++) tags.push(pT.data.rows[i][0]);
        }
      } catch (e) {}
    }
    out += 'tags (' + tags.length + '): ' + tags.join(', ') + '\n';

    mc.querySQL('SELECT MIN(' + timeCol + '), MAX(' + timeCol + ') FROM ' + table, 'ms', '', '', function (errR, resR) {
      if (!errR) {
        try {
          var pR = JSON.parse(resR);
          if (pR.success && pR.data && pR.data.rows && pR.data.rows.length > 0) {
            var mn = pR.data.rows[0][0], mx = pR.data.rows[0][1];
            if (mn != null && mx != null) {
              out += 'time range (ms): ' + mn + ' ~ ' + mx + '\n';
              rangeCache.set(table, parseInt(String(mn), 10), parseInt(String(mx), 10));
            }
          }
        } catch (e) {}
      }

      var statsSQL = 'SELECT ' + nameCol + ', COUNT(*), ROUND(AVG(' + valueCol + '),2), ROUND(MIN(' + valueCol + '),2), ROUND(MAX(' + valueCol + '),2) FROM ' + table + ' GROUP BY ' + nameCol;
      mc.querySQL(statsSQL, '', '', '', function (errS, resS) {
        if (!errS) {
          try {
            var pS = JSON.parse(resS);
            if (pS.success && pS.data && pS.data.rows && pS.data.rows.length > 0) {
              var srows = pS.data.rows;
              var STAT_CAP = 50;
              out += 'tag stats:\n';
              var cap = srows.length > STAT_CAP ? STAT_CAP : srows.length;
              for (var j = 0; j < cap; j++) {
                var r = srows[j];
                out += '  ' + r[0] + '  count=' + r[1] + '  avg=' + r[2] + '  min=' + r[3] + '  max=' + r[4] + '\n';
              }
              if (srows.length > STAT_CAP) out += '  …(+' + (srows.length - STAT_CAP) + ' more tags)\n';
            }
          } catch (e) {}
        }
        cb(null, out.trim());
      });
    });
  });
}

module.exports = { register, bareSelectCols };
