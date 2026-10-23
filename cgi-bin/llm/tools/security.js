/**
 * 도구 실행 보안 관문 — 모든 LLM 백엔드의 도구 호출마다 검사 + 사용자 질의 사전 검사
 * · 이름 차단: 서버 제어·쉘 도구
 * · SQL: 첫 키워드 기준(주석 제거·다중 문 거부) — 변경·권한 문 거부, DROP은 콘솔 안내, 데이터 테이블·INDEX·ROLLUP CREATE만 허용
 * · TQL: 금지 require 거부, SQL(`...`) 본문은 같은 SQL 규칙
 * · TQL 싱크 APPEND()/INSERT()는 미차단(타이머 수집용), SQL INSERT INTO ... VALUES는 차단
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

  // DROP은 콘솔 직접 실행 안내
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

// 사용자 출력의 자격증명 마스킹 — 모델이 기억·문서에서 옮기는 비밀까지 차단(도구 경계 밖)
// · 구조는 유지하고 값만 가림
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
  // Machbase Neo API token (nt_<id>_<secret>).
  out = out.replace(/\bnt_[A-Za-z0-9]+_[A-Za-z0-9_\-]{20,}/g, '[보안 비공개]');

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

// 강한 거절 — 자격증명 노출·서버 제어·쉘·프롬프트 유출(프로바이더 정책 거부에도 사용)
var REFUSAL_TEXT = '보안 정책상 해당 요청은 수행하거나 관련 정보를 제공해 드릴 수 없습니다. 관리자 계정·접속 정보, 서버 제어, 권한 외 데이터 변경 등은 지원되지 않습니다.';

// 안내 거절 — 계정·비밀번호 관리(변경·생성·삭제)는 권한 확인 불가라 직접 수행 안 함, 콘솔로 안내
var MGMT_GUIDANCE_TEXT = '보안상 사용자 계정·비밀번호를 제가 직접 생성·변경·삭제해 드릴 수는 없습니다(요청자 권한을 확인할 수 없습니다). 권한 있는 관리자가 SQL 콘솔에서 직접 수행하셔야 합니다. 구체적인 명령/절차가 필요하시면 "~방법 알려줘"라고 문의해 주세요.';

// 요청 어미 — 동사 뒤에 붙으면 "시키는 말"(해줘·해·시켜·주세요·해줄 수 있어). 하면·하는·해야·해도·해? 같은 묻는 말은 해당 없음
var REQ_TAIL = '(?:(?:해|시켜)\\s*(?:줘|주세요|주십시오|주실래|줄래|줄\\s*수|달라|봐)(?![가-힣])|(?:해|시켜|해라|하라|하세요|하십시오|하시오|하자)(?=\\s*(?:$|[.!~,])))';
function cmdOf(stems) { return '(?:' + stems + ')\\)?\\s*' + REQ_TAIL; }
// 어간 자체가 명령형인 동사(지워·꺼·넣어…) — 줘·라·버려가 붙거나 문장이 끝날 때만(지워져·꺼지면 제외)
function bareCmdOf(stems) { return '(?:' + stems + ')(?:\\s*(?:줘|주세요|주십시오|라|버려)(?![가-힣])|(?=\\s*(?:$|[.!~,])))'; }
// 영어 명령형 — 문장 첫머리 또는 please·can you 뒤
var EN_CMD = '(?:^|[.!?]\\s+|\\b(?:please|pls|now|immediately|just|can you|could you|would you)\\s+)';
// 묻는 말 표지 — 실행 지시가 없을 때만 통과 근거로 사용
var QUESTION = /(\?|뭐|무엇|어떻게|어디|언제|왜|되나|돼\s*$|하면|문법|구문|사용법|방법|예제|예시|차이|의미|뜻|설명|how\s+(to|do|can|could|would|should)|\bwhat\b|\bwhy\b|syntax)/i;

// 1) 자격증명 노출 — 자격증명 바로 뒤(16자 안)의 노출 동사. 대신·없이·말고(다른 인증 방식)·방법·정책 같은 속성 질문은 제외
var CRED_G = /(비밀번호|비번|패스워드|password|passwd|\bpwd\b|\bpw\b|암호(?!화)|api[ _\-]?(?:key|키)|apikey|access[ _\-]?key|시크릿|secret\s*key|접속\s*(?:계정|정보|아이디|id)|관리자\s*(?:계정|아이디|id)|로그인\s*(?:계정|정보|id|아이디)|계정\s*정보|유저\s*(?:id|아이디|명|네임|이름)|user\s*(?:id|name)|username|인증\s*정보|자격\s*증명|크리덴셜|credential)/gi;
var CRED_DISC = /(알려|보여|출력|공개|말해|뭐|뭔지|무엇|내놔|내놓|까줘|까봐|토해|불어|읊어)/;
var CRED_ATTR = /(대신|없이|말고|안\s*쓰|방법|법|정책|규칙|설정|변경|바꾸|바꿀|재설정|초기화|만드|만들|생성|형식|길이|조건|위치|어디|저장|암호화|해시|옵션|입력|넣|지정|발급|등록|관리|만료|복잡도)/;
function credDisclosure(q) {
  var m;
  CRED_G.lastIndex = 0;
  while ((m = CRED_G.exec(q)) !== null) {
    var tail = q.slice(m.index + m[0].length, m.index + m[0].length + 16), d = tail.search(CRED_DISC);
    if (d < 0) continue;
    var gap = tail.slice(0, d);
    if (/[.?!\n]/.test(gap) || CRED_ATTR.test(gap)) continue;
    return true;
  }
  if (/\b(reveal|show|tell|give|print|dump|display|expose|share)\b[\s\S]{0,20}?\b(password|passwd|api\s*key|secret|credential|login)/i.test(q)
      && !/\bhow\s+(to|do|can)|\b(change|reset|rotate|policy)\b/i.test(q)) return true;
  return /\bwhat('?s|\s+is)\s+(the\s+)?(\w+\s+)?(password|passwd|api\s*key|secret)\b/i.test(q);
}

// 5) 서버 제어 — 서버·프로세스 + 종료·재시작·구동을 시키는 말
var SERVER_NOUN = /(서버|server|machbase[ -]?neo|\bneo\b|데몬|daemon|프로세스|process|서비스)/i;
var STOP_N = '종료|중지|중단|정지|셧다운|재시작|재구동|재기동|리부트|리스타트|구동|가동|기동';
var STOP_CMD = new RegExp(cmdOf(STOP_N) + '|' + bareCmdOf('꺼|죽여|내려|멈춰|없애|날려')
  + '|(?:' + STOP_N + ')[^.?!\\n]{0,12}?(?:' + cmdOf('실행|수행|진행') + '|' + bareCmdOf('돌려') + ')');
var STOP_EN = new RegExp(EN_CMD + '(?:shut\\s*down|stop|kill|restart|reboot|turn\\s*off|power\\s*off|take\\s*down)\\b', 'i');

// 6) 변경 SQL 원문 — 실행 지시가 있거나 묻는 말이 아니면 차단
var SQL_MUT = /(DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|ALTER\s+TABLE|TRUNCATE\s+(TABLE\s+)?\S|DROP\s+TABLE)/i;
var EXEC_CMD = new RegExp(cmdOf('실행|수행|적용|진행|반영|삭제|추가|입력|삽입|변경|수정|제거|초기화') + '|' + bareCmdOf('넣어|지워|돌려|날려|비워|바꿔')
  + '|\\b(?:execute|run\\s+(?:it|this|that)|apply\\s+(?:it|this))\\b', 'i');

// 6b) 데이터·스키마 변경 지시(자연어)
var MUT_KO = new RegExp('(?:데이터|테이블|레코드|행|로그|컬럼|칼럼|필드|스키마|구조)[\\s\\S]{0,8}?(?:'
  + cmdOf('삭제|제거|드롭|입력|삽입|추가|등록|변경|수정|초기화') + '|' + bareCmdOf('지워|비워|날려|없애|넣어|바꿔') + ')');
var MUT_EN = new RegExp(EN_CMD + '(?:delete|drop|truncate|wipe|erase|purge|remove|insert|inject|write|add|alter|modify|change)\\b[\\s\\S]{0,20}?\\b(?:data|rows?|records?|values?|tables?|everything|schema|columns?|table\\s+structure)\\b', 'i');
var ENUM_EN = new RegExp(EN_CMD + '(?:list|show|enumerate|dump)\\b[\\s\\S]{0,12}?\\b(?:users?|accounts?|logins?)\\b', 'i');

// 7) 시스템 프롬프트·도구 정의 유출
var LEAK_OBJ = /(시스템\s*프롬프트|system\s*prompt|내부\s*(지시|지침|규칙)|(너|네|당신)[가-힣\s]{0,10}(지시문|지침|프롬프트)|(지시문|지침|프롬프트)\s*(원문|전체|그대로)|도구\s*(정의|목록)|tool\s*(definition|list)|your\s+(tools|instructions|prompt))/i;
var LEAK_VERB = /(보여|출력|알려|공개|그대로|전체|빠짐없이|reveal|show|print|dump|output|list|give|tell|full|entire|verbatim|expose|share|provide)/i;

// 8) 계정·비밀번호·권한 관리 지시 — 안내 거절(방법 질문은 통과)
var MGMT_KO = [
  new RegExp('(?:유저|user|사용자|계정|account)[\\s\\S]{0,8}?(?:' + cmdOf('삭제|제거|생성|추가|등록') + '|' + bareCmdOf('지워|없애|만들어') + ')', 'i'),
  new RegExp('(?:비밀번호|암호(?!화)|패스워드|password|\\bpw\\b)[\\s\\S]{0,20}?(?:' + cmdOf('변경|재설정|초기화') + '|' + bareCmdOf('바꿔') + ')', 'i'),
  new RegExp('권한[\\s\\S]{0,6}?' + cmdOf('부여|회수|변경|제거')),
];
var MGMT_EN = [
  new RegExp(EN_CMD + '(?:create|add|make|delete|remove|drop|disable|enable)\\b[\\s\\S]{0,16}?\\b(?:users?|accounts?|logins?)\\b', 'i'),
  new RegExp(EN_CMD + '(?:change|reset|update|set|modify)\\b[\\s\\S]{0,22}?\\b(?:password|passwd|credentials?)\\b', 'i'),
  new RegExp(EN_CMD + '(?:grant|revoke)\\b[\\s\\S]{0,12}?\\b(?:access|privileges?|permissions?|roles?)\\b', 'i'),
];
var MGMT_SQL = /(\b(grant|revoke)\s+\w|(CREATE|DROP|ALTER)\s+USER\b)/i;
function anyMatch(list, q) { for (var i = 0; i < list.length; i++) if (list[i].test(q)) return true; return false; }

// 계정별 설정 파일 이름(configs/*.json) — 워커가 시작할 때 실제 목록으로 채움. 기본은 sys.json
var _configFiles = ['sys.json'];
function setConfigFiles(names) {
  var out = [];
  (names || []).forEach(function (n) { n = String(n).toLowerCase(); if (/\.json$/.test(n) && out.indexOf(n) < 0) out.push(n); });
  if (out.indexOf('sys.json') < 0) out.push('sys.json');
  _configFiles = out;
}
function mentionsConfigFile(q) {
  var lq = String(q).toLowerCase();
  for (var i = 0; i < _configFiles.length; i++) {
    var at = lq.indexOf(_configFiles[i]);
    if (at >= 0 && !/[a-z0-9_.-]/.test(lq.charAt(at - 1) || '')) return true;
  }
  return false;
}

// 사용자 질의 사전 검사(LLM 호출 전) — 보안 "지시"는 차단, "질문"은 통과, 섞이면 지시 우선
// · 반환: REFUSAL_TEXT(강한 거절) / MGMT_GUIDANCE_TEXT(계정 관리 안내) / null(통과)
function screenQuery(query) {
  if (!query || typeof query !== 'string') return null;
  var q = query;
  var en = !/[가-힣]/.test(q); // 영어 명령형 규칙은 순수 영어 문장만 — 한국어 속 SQL 키워드(CREATE USER·ALTER TABLE)는 6·8번이 판정

  // 1) Credentials / API keys disclosure (1a/1b/1c)
  if (credDisclosure(q)) return REFUSAL_TEXT;

  // 2) Account / session enumeration (1a)
  if (/(M\$SYS_USERS|V\$SESSION|사용자\s*계정\s*목록|전체\s*(사용자|계정)\s*(목록|계정)|등록된\s*(전체\s*)?(사용자|계정))/i.test(q)) return REFUSAL_TEXT;

  // 3) Config-file path traversal / direct secret-file access (1b/1c)
  if (/(\.\.[\/\\])|config\.js|configs?[\/\\]/i.test(q) || mentionsConfigFile(q)) return REFUSAL_TEXT;

  // 4) Shell / process execution (2c)
  if (/(child_process|require\(\s*['"`]?\s*(@jsh\/process|service|child_process|\bos\b|\bfs\b)|exec\s*\(|spawn\s*\()/i.test(q)
      || (/(쉘|shell)/i.test(q) && /(명령|command|커맨드|실행|돌려|돌릴)/i.test(q))
      || /(시스템|os)\s*명령(어)?\s*(을|를)?\s*(실행|돌려|수행)/i.test(q)
      || /명령어\s*(을|를)?\s*(실행|돌려|돌릴)/i.test(q)) return REFUSAL_TEXT;

  // 5) Server control (2a/2b) — 서버·프로세스 + 종료·재시작·구동을 시키는 말
  if (SERVER_NOUN.test(q) && (STOP_CMD.test(q) || (en && STOP_EN.test(q)))) return REFUSAL_TEXT;

  // 6) Raw data-mutation SQL (3a/3b/3c) — 실행 지시가 있거나 묻는 말이 아니면 차단
  if (SQL_MUT.test(q) && (EXEC_CMD.test(q) || !QUESTION.test(q))) return REFUSAL_TEXT;

  // 6b) Natural-language data/schema mutation COMMANDS
  if (MUT_KO.test(q) || (en && (MUT_EN.test(q) || ENUM_EN.test(q)))) return REFUSAL_TEXT;

  // 7) System prompt / tool definition leak (10)
  if (LEAK_OBJ.test(q) && LEAK_VERB.test(q)) return REFUSAL_TEXT;

  // 8) Privileged account/credential MANAGEMENT — GUIDED refusal
  if (anyMatch(MGMT_KO, q) || (en && anyMatch(MGMT_EN, q))) return MGMT_GUIDANCE_TEXT;
  if (MGMT_SQL.test(q) && (EXEC_CMD.test(q) || !QUESTION.test(q))) return MGMT_GUIDANCE_TEXT;

  return null;
}

module.exports = {
  checkToolCall: checkToolCall,
  sqlDenied: sqlDenied,
  redactSecrets: redactSecrets,
  screenQuery: screenQuery,
  setConfigFiles: setConfigFiles,
  MGMT_GUIDANCE_TEXT: MGMT_GUIDANCE_TEXT,
};
