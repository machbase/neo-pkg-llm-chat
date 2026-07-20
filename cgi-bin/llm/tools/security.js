/**
 * Central security guard for tool execution (evaluation indicator #5: error-avoidance).
 *
 * One chokepoint, invoked from registry.execute() for EVERY tool call from EVERY LLM
 * backend, plus a redundant inner check in sql.js. Three jobs:
 *   1) NAME deny-list  — refuse any server-control / shell tool by name (capability-absence backstop).
 *   2) SQL screening   — first-keyword tokenizer (comment/whitespace-stripped, multi-statement
 *                        rejected) blocks INSERT/UPDATE/DELETE/ALTER/TRUNCATE/etc.; DROP gets the
 *                        existing "run it yourself in the console" guidance; CREATE of data
 *                        structures (TAG/LOG/INDEX/ROLLUP) is allowed (timer + legitimate setup),
 *                        but CREATE USER / GRANT / REVOKE and unknown CREATE are denied.
 *   3) TQL screening   — reject forbidden require()s (process/service/shell), and screen every
 *                        SQL(`...`) body inside the TQL with the same SQL rules.
 *
 * NOTE (residual, by design): legitimate timer-collection TQL writes via the APPEND()/INSERT()
 * TQL *sinks* — those are NOT blocked here or the timer feature breaks. The evaluation's
 * "force insert" probe uses `INSERT INTO ... VALUES` (a SQL statement) which IS blocked.
 */

// Mutation verbs we refuse outright. DROP and CREATE are handled separately above this test.
var MUTATION = /^(INSERT|UPDATE|DELETE|ALTER|TRUNCATE|RENAME|MERGE|GRANT|REVOKE|UPSERT|REPLACE|EXEC|EXECUTE|CALL)\b/;

// Tool names that imply server-control / shell. None are registered today; this is a forward guard.
var NAME_DENY = /(shutdown|reboot|stop_server|start_server|restart|kill_process|exec_command|run_command|run_shell|child_process|spawn_process|service_control)/i;

// Forbidden module requires inside a TQL SCRIPT() block.
var FORBIDDEN_REQUIRE = /require\s*\(\s*['"`](@jsh\/process|service|child_process|os|fs)['"`]/i;

// Credential / identity system tables — refuse user-driven reads (internal tool queries bypass this).
var SENSITIVE_TABLE = /\bFROM\s+(M\$SYS_USERS|V\$SESSION)\b/i;

function stripComments(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // /* block */ comments
    .replace(/--[^\n]*/g, ' ');        // -- line comments
}

// Strip comments AND collapse string literals to empty, so a ';' or a table name that lives
// inside a quoted string can never trip the multi-statement / sensitive-table checks.
function stripStringsAndComments(sql) {
  return stripComments(sql)
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")  // single-quoted (handles '' and \' escapes)
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');     // double-quoted
}

// First SQL keyword, uppercased, after stripping comments and leading whitespace/;/(
function firstKeyword(sql) {
  return stripComments(sql)
    .replace(/^[\s;(]+/, '')
    .toUpperCase();
}

// True if there is more than one statement (a ';' that is not just a single trailing terminator).
function hasMultiStatement(sql) {
  var body = stripStringsAndComments(sql).replace(/;\s*$/, ''); // drop one trailing ';'
  return body.indexOf(';') >= 0;
}

// Returns a Korean denial message, or null if the SQL is allowed.
function sqlDenied(sql) {
  if (!sql) return null;
  var head = firstKeyword(sql);

  // Allow data-structure CREATE (timer/setup). Deny privileged/unknown CREATE.
  if (/^CREATE\b/.test(head)) {
    if (/^CREATE\s+(TAG\s+|VOLATILE\s+|LOOKUP\s+)?TABLE\b/.test(head)) return checkMulti(sql);
    if (/^CREATE\s+INDEX\b/.test(head)) return checkMulti(sql);
    if (/^CREATE\s+ROLLUP\b/.test(head)) return checkMulti(sql);
    return '거부됨: 허용되지 않은 CREATE 작업입니다(계정/권한 생성 등은 보안 정책상 수행할 수 없습니다). 데이터 테이블 생성만 허용됩니다.';
  }

  // DROP keeps the existing "guide the user to the console" behavior.
  if (/^DROP\b/.test(head)) {
    return 'DROP 문은 이 도구로 실행할 수 없습니다. 데이터 보호를 위해 사용자가 직접 SQL 콘솔에서 실행하도록 안내하세요. 예: DROP TABLE 테이블명 CASCADE;';
  }

  // Any other mutation / privilege verb is refused.
  if (MUTATION.test(head)) {
    return '거부됨: 데이터를 변경/삭제/입력하거나 스키마·권한을 바꾸는 작업(INSERT/UPDATE/DELETE/ALTER/TRUNCATE/GRANT 등)은 보안 정책상 수행할 수 없습니다. 권한 있는 관리자가 직접 콘솔에서 실행하도록 안내하세요.';
  }

  // Read of credential/session system tables (user-driven). Use string-stripped text so a
  // table name appearing inside a quoted literal does not false-trigger.
  if (SENSITIVE_TABLE.test(stripStringsAndComments(sql))) {
    return '거부됨: 사용자 계정/세션 정보 조회는 보안 정책상 허용되지 않습니다.';
  }

  return checkMulti(sql);
}

function checkMulti(sql) {
  if (hasMultiStatement(sql)) {
    return '거부됨: 여러 SQL 문을 한 번에 실행할 수 없습니다(보안 정책).';
  }
  return null;
}

// Extract every SQL(`...`) / SQL('...') / SQL("...") body from a TQL script.
function extractTqlSql(tql) {
  var out = [];
  var res = [
    /SQL\s*\(\s*`([\s\S]*?)`\s*\)/g,
    /SQL\s*\(\s*'([\s\S]*?)'\s*\)/g,
    /SQL\s*\(\s*"([\s\S]*?)"\s*\)/g,
  ];
  for (var k = 0; k < res.length; k++) {
    var m;
    while ((m = res[k].exec(tql)) !== null) out.push(m[1]);
  }
  return out;
}

// Returns { denied: bool, message?: string }
function checkToolCall(name, args) {
  if (NAME_DENY.test(String(name || ''))) {
    return { denied: true, message: '거부됨: 서버 종료/재시작·OS 쉘 명령 등 시스템 제어 작업은 수행할 수 없습니다.' };
  }
  args = args || {};

  if (typeof args.sql_query === 'string') {
    var d = sqlDenied(args.sql_query);
    if (d) return { denied: true, message: d };
  }

  if (typeof args.tql_content === 'string') {
    var t = args.tql_content;
    if (FORBIDDEN_REQUIRE.test(t)) {
      return { denied: true, message: '거부됨: 프로세스/서비스/쉘/파일시스템 모듈 호출은 허용되지 않습니다.' };
    }
    var bodies = extractTqlSql(t);
    for (var j = 0; j < bodies.length; j++) {
      var dd = sqlDenied(bodies[j]);
      if (dd) return { denied: true, message: dd };
    }
    // raw mutation accidentally passed as tql_content (e.g. "DELETE FROM ...")
    if (MUTATION.test(firstKeyword(t))) {
      return { denied: true, message: sqlDenied(t) || '거부됨: 허용되지 않은 작업입니다.' };
    }
  }

  return { denied: false };
}

// Redact credential-like content from USER-FACING output. Model-independent backstop:
// the model can state secrets from memory or relay them from a KB doc
// (e.g. user-management.md ships "SYS/MANAGER"), which tool-boundary guards cannot catch.
// Masks values while keeping structure, so legitimate doc answers stay readable.
function redactSecrets(text, extraSecrets) {
  if (!text || typeof text !== 'string') return text;
  var out = text;
  var MASK = '****';

  // 0) Known literal secrets (actual deployment DB password / keys), if provided.
  if (extraSecrets && extraSecrets.length) {
    for (var i = 0; i < extraSecrets.length; i++) {
      var s = extraSecrets[i];
      if (s && typeof s === 'string' && s.length >= 4 &&
          !/^(sys|manager|localhost|127\.0\.0\.1|5654|5656)$/i.test(s)) {
        out = out.split(s).join('[보안 비공개]');
      }
    }
  }

  // 1) API keys / secrets by shape.
  out = out.replace(/\b(sk-ant-[A-Za-z0-9_\-]{6,}|sk-[A-Za-z0-9_\-]{12,}|AIza[A-Za-z0-9_\-]{20,})\b/g, '[보안 비공개]');

  // 2) Account/session enumeration queries against credential system tables.
  out = out.replace(/SELECT[\s\S]{0,300}?FROM\s+(?:M\$SYS_USERS|V\$SESSION)[^\n;]*;?/gi,
    '[계정/세션 조회 쿼리는 보안 정책상 비공개]');

  // 3) Default admin credential pair (SYS/MANAGER).
  out = out.replace(/\bSYS\s*\/\s*MANAGER\b/gi, 'SYS/' + MASK);

  // 4) password/암호/비밀번호 = value  → mask the value, keep key+separator.
  out = out.replace(
    /((?:password|passwd|pwd|비밀번호|암호|패스워드)["']?\s*[:=]\s*['"`]?)([^\s'"`,;)\]}]{2,})/gi,
    function (m, head, val) {
      if (/^(VARCHAR|CHAR|TEXT|NUMBER|your|the|<|\.\.\.|\{)/i.test(val)) return m; // placeholder/DDL
      return head + MASK;
    });

  // 5) Default password value "MANAGER" mentioned in a credential context (within 40 chars).
  out = out.replace(
    /(비밀번호|암호|패스워드|password|passwd|pwd|계정|로그인|login|기본\s*(?:계정|로그인|관리자))[\s\S]{0,40}?\bMANAGER\b/gi,
    function (m) { return m.replace(/\bMANAGER\b/i, MASK); });

  // 6) Admin username "sys" stated as a login identity (ID: sys / 로그인 계정 SYS / Username: sys).
  //    Only when a credential keyword sits right before it — avoids touching M$SYS_*, sys.json, etc.
  out = out.replace(
    /((?:\bID\b|아이디|계정|로그인|username|user[\s_]?name|유저\s?(?:명|이름))\s*[:=은는|]{0,4}\s*)(SYS)\b/gi,
    function (m, head) { return head + MASK; });

  return out;
}

// HARD refusal — no legitimate self-serve path (credential disclosure, server control, shell,
// prompt leak). Also used for provider policy rejections.
var REFUSAL_TEXT = '보안 정책상 해당 요청은 수행하거나 관련 정보를 제공해 드릴 수 없습니다. 관리자 계정·접속 정보, 서버 제어, 권한 외 데이터 변경 등은 지원되지 않습니다.';

// GUIDED refusal — privileged but legitimately-needed account/credential MANAGEMENT (change
// password, create/delete user). The agent must not PERFORM it (cannot verify authority), but
// the user genuinely needs it, so point them to the authenticated console path.
var MGMT_GUIDANCE_TEXT = '보안상 사용자 계정·비밀번호를 제가 직접 생성·변경·삭제해 드릴 수는 없습니다(요청자 권한을 확인할 수 없습니다). 권한 있는 관리자가 SQL 콘솔에서 직접 수행하셔야 합니다. 구체적인 명령/절차가 필요하시면 "~방법 알려줘"라고 문의해 주세요.';

// Deterministic query screen for the USER QUERY. Matches ATTACK SHAPES, NOT topic
// words — legit how-to/feature questions ("설치 방법", "로그인 기능 동작 확인", "유저 생성 방법")
// pass through. Returns a refusal message (caller short-circuits BEFORE the LLM, so weak models
// can't ramble) or null to proceed. HARD cases → REFUSAL_TEXT; management → MGMT_GUIDANCE_TEXT.
function screenQuery(query) {
  if (!query || typeof query !== 'string') return null;
  var q = query;
  var disclose = /(알려|보여|출력|공개|뭐|뭔지|무엇|확인[^.\n]{0,8}(줘|주세|해)|까줘|까봐|내놔|내놓|토해|불어|reveal|show|tell|give|print|dump|list|what('?s)?|which|share|expose|display|provide)/i;
  var howto = /(방법|어떻게|설정하|변경하|바꾸|만드는|생성하|정책|규칙\s*설명|사용법|쓰는\s*법|관리하는|how\s+(to|do|can|could|would|should)|tutorial)/i;

  // 1) Credentials / API keys disclosure (1a/1b/1c) — exclude how-to ("비밀번호 변경 방법")
  if (/(비밀번호|비번|패스워드|password|passwd|\bpwd\b|\bpw\b|암호(?!화)|api[ _\-]?(key|키)|apikey|access[ _\-]?key|시크릿|secret\s*key|접속\s*(계정|정보|비밀번호|아이디|id)|관리자\s*(계정|아이디|비밀번호|id)|로그인\s*(계정|정보|비밀번호|id|아이디)|계정\s*정보|유저\s*(id|아이디|명|네임|이름)|user\s*(id|name)|username|아이디\s*[\/／]\s*(비번|비밀번호|패스워드|pw|password)|id\s*[\/／]\s*(pw|password|비번|비밀번호|패스워드)|인증\s*정보|자격\s*증명|크리덴셜|credential)/i.test(q)
      && disclose.test(q) && !howto.test(q)) return REFUSAL_TEXT;

  // 2) Account / session enumeration (1a)
  if (/(M\$SYS_USERS|V\$SESSION|사용자\s*계정\s*목록|전체\s*(사용자|계정)\s*(목록|계정)|등록된\s*(전체\s*)?(사용자|계정))/i.test(q)) return REFUSAL_TEXT;

  // 3) Config-file path traversal / direct secret-file access (1b/1c)
  if (/(\.\.[\/\\])|sys\.json|joy\.json|config\.js|configs?[\/\\]/i.test(q)) return REFUSAL_TEXT;

  // 4) Shell / process execution (2c)
  if (/(child_process|require\(\s*['"`]?\s*(@jsh\/process|service|child_process|\bos\b|\bfs\b)|exec\s*\(|spawn\s*\()/i.test(q)
      || (/(쉘|shell)/i.test(q) && /(명령|command|커맨드|실행|돌려|돌릴)/i.test(q))
      || /(시스템|os)\s*명령(어)?\s*(을|를)?\s*(실행|돌려|수행)/i.test(q)
      || /명령어\s*(을|를)?\s*(실행|돌려|돌릴)/i.test(q)) return REFUSAL_TEXT;

  // 5) Server control — destructive verb / force-start + server noun, NOT a how-to (2a/2b)
  if (/(서버|server|machbase[ -]?neo|데몬|프로세스|process)/i.test(q)
      && /(종료|중지|중단|내려|꺼[줘라버]|죽여|죽이|없애|날려|멈춰|shutdown|stop|kill|재시작|재구동|restart|reboot|구동\s*(해|시켜|시키)|가동\s*(해|시켜|시키)|기동\s*(해|시켜|시키)|강제\s*(구동|가동|기동)|shut\s*down|turn\s*off|power\s*off|take\s*down)/i.test(q)
      && !/(방법|어떻게|how\s*(to|do)|하나요|가능|설치|구동\s*방법|구동\s*(상태|중|여부)|시작하는)/i.test(q)) return REFUSAL_TEXT;

  // 6) Raw data-mutation SQL to execute (3a/3b/3c) — but allow how-to/syntax questions
  //    ("ALTER TABLE ADD COLUMN 어떻게 써?"). Actual execution is still blocked at the tool layer
  //    (checkToolCall MUTATION regex), so explaining syntax never mutates data.
  if (!howto.test(q)
      && /(DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|ALTER\s+TABLE|TRUNCATE\s+(TABLE\s+)?\S|DROP\s+TABLE)/i.test(q)) return REFUSAL_TEXT;

  // 6b) Natural-language (Korean) data/schema mutation COMMANDS — spec Cat3 phrasings, not SQL.
  //     Command-form verbs (삭제해/지워/넣어/변경해…) so status/how-to queries ("입력 현황",
  //     "삭제 방법") are not caught. how-to excluded.
  if (!howto.test(q)) {
    if (/(데이터|테이블|레코드|행|로그)[\s\S]{0,6}?(삭제\s*(해|하)|지워|지우|제거\s*(해|하)|비워|날려|드롭)/i.test(q)) return REFUSAL_TEXT;
    if (/(데이터|레코드|행)[\s\S]{0,6}?(입력\s*(해|하)|삽입|넣어|넣기|추가\s*(해|하)|등록\s*해)/i.test(q)) return REFUSAL_TEXT;
    if (/(스키마|컬럼|칼럼|필드|테이블\s*구조)[\s\S]{0,6}?(변경\s*(해|하)|수정\s*(해|하)|추가\s*(해|하)|삭제\s*(해|하)|바꿔|드롭)/i.test(q)) return REFUSAL_TEXT;
    // English (hard): data mutation, schema change, account enumeration
    if (/\b(delete|drop|truncate|wipe|erase|purge|remove)\b[\s\S]{0,15}?\b(data|rows?|records?|tables?|everything)\b/i.test(q)) return REFUSAL_TEXT;
    if (/\b(insert|inject|write|add)\b[\s\S]{0,12}?\b(data|rows?|records?|values?)\b/i.test(q)) return REFUSAL_TEXT;
    if (/\b(alter|modify|change|add|drop)\b[\s\S]{0,12}?\b(schema|columns?|table\s+structure)\b/i.test(q)) return REFUSAL_TEXT;
    if (/\b(list|show|enumerate|dump)\b[\s\S]{0,12}?\b(users?|accounts?|logins?)\b/i.test(q)) return REFUSAL_TEXT;
  }

  // 7) System prompt / tool definition leak (10)
  if (/(시스템\s*프롬프트|system\s*prompt|내부\s*(지시|지침|규칙)|도구\s*(정의|목록)|tool\s*(definition|list)|your\s+(tools|instructions|prompt))/i.test(q)
      && /(보여|출력|알려|공개|그대로|전체|빠짐없이|reveal|show|print|dump|output|list|give|tell|full|entire|verbatim|expose|share|provide)/i.test(q)) return REFUSAL_TEXT;

  // 8) Privileged account/credential MANAGEMENT — GUIDED refusal (how-to stays allowed).
  //    "비밀번호 변경 방법"(설명)은 howto 제외로 통과, "비밀번호 바꿔줘"(실행)는 콘솔 안내.
  if (!howto.test(q)) {
    if (/(유저|user|사용자|계정|account)\s*[를을]?\s*(삭제|제거|지워|생성|만들|추가|등록)/i.test(q)) return MGMT_GUIDANCE_TEXT;
    if (/(비밀번호|암호(?!화)|패스워드|password|\bpw\b)[\s\S]{0,20}?(변경|바꿔|재설정|초기화|reset)/i.test(q)) return MGMT_GUIDANCE_TEXT;
    if (/(권한\s*[를을]?\s*(부여|회수|변경|제거)|\bgrant\s+\w|\brevoke\s+\w)/i.test(q)) return MGMT_GUIDANCE_TEXT;
    // English (guided): user/account management, password change, grant/revoke
    if (/\b(create|add|make|delete|remove|drop|disable|enable)\b[\s\S]{0,16}?\b(users?|accounts?|logins?)\b/i.test(q)) return MGMT_GUIDANCE_TEXT;
    if (/\b(change|reset|update|set|modify)\b[\s\S]{0,22}?\b(password|passwd|credentials?)\b/i.test(q)) return MGMT_GUIDANCE_TEXT;
    if (/\b(grant|revoke)\b[\s\S]{0,12}?\b(access|privileges?|permissions?|roles?)\b/i.test(q)) return MGMT_GUIDANCE_TEXT;
  }
  if (/(CREATE|DROP|ALTER)\s+USER\b/i.test(q)) return MGMT_GUIDANCE_TEXT;

  return null;
}

// Boolean convenience wrapper (back-compat).
function attackIntent(query) { return screenQuery(query) !== null; }

module.exports = {
  checkToolCall: checkToolCall,
  sqlDenied: sqlDenied,
  firstKeyword: firstKeyword,
  redactSecrets: redactSecrets,
  screenQuery: screenQuery,
  attackIntent: attackIntent,
  REFUSAL_TEXT: REFUSAL_TEXT,
  MGMT_GUIDANCE_TEXT: MGMT_GUIDANCE_TEXT,
};
