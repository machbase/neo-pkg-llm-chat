// DocLookup에서 예제 생성 경로(EXCEPTION: describe_table→compile_tql_from_spec)와 순수 문서 설명
// 경로를 결정론적으로 가르는 분류기. EXCEPTION 발동 조건 = (예제/샘플/코드 명시 요청) AND
// (실재 테이블명이 질문에 명시) — 둘 다. 프롬프트의 이중조건(segments_ollama.js ⚠️)만으로는
// 약한 모델이 무시하므로 agent.js 가드가 이 모듈로 코드 강제한다.

var EXAMPLE_RE = /예제|샘플|코드|example|sample/i;
// '코드'가 '에러코드' 등 복합어에 부분일치해 예제 요청으로 오인되는 것 방지 — 판정 전에 제거.
// (goja가 lookbehind 미지원일 수 있어 부정 전방탐색 대신 치환 방식)
var EXAMPLE_FALSE_RE = /에러\s*코드|오류\s*코드|상태\s*코드|응답\s*코드|결과\s*코드|코드\s*값|샘플링|sampling/gi;
// "테이블 목록 알려줘" 류 데이터 탐색 질문 — 문서가 아니라 list_tables가 정답
var TABLE_LIST_RE = /(테이블|table)\s*(목록|리스트|list)|무슨\s*테이블|어떤\s*테이블|list\s+(all\s+)?tables|show\s+tables/i;
// "테이블 구조/컬럼 알려줘" 류 스키마 질문 — 문서가 아니라 describe_table이 정답(hint도 그렇게 지시)
var TABLE_STRUCT_RE = /구조|스키마|컬럼|칼럼|필드|structure|schema|columns?/i;

// 테이블 목록 확보 실패 시 폴백 휴리스틱에서 "식별자처럼 보여도 테이블이 아닌" 일반 용어
var STOP_WORDS = {
  tql: 1, sql: 1, tag: 1, log: 1, table: 1, tables: 1, rollup: 1, chart: 1, graph: 1,
  select: 1, insert: 1, update: 1, delete: 1, create: 1, drop: 1, alter: 1, truncate: 1,
  group: 1, order: 1, where: 1, join: 1, column: 1, columns: 1, index: 1, retention: 1,
  machbase: 1, neo: 1, json: 1, csv: 1, http: 1, api: 1, rest: 1, example: 1, sample: 1,
  examples: 1, samples: 1, code: 1, query: 1, queries: 1, script: 1, dashboard: 1,
  report: 1, timer: 1, time: 1, value: 1, name: 1, data: 1, database: 1, pivot: 1,
  min: 1, max: 1, avg: 1, sum: 1, count: 1, stddev: 1, sumsq: 1, fft: 1, rms: 1,
  datetime: 1, varchar: 1, double: 1, integer: 1, basetime: 1, summarized: 1,
};

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 질문이 예제/샘플/코드를 명시 요청하는가 ('에러코드' 같은 복합어는 제외)
function wantsExample(query) {
  return EXAMPLE_RE.test(String(query || '').replace(EXAMPLE_FALSE_RE, ''));
}

// 질문이 테이블 목록 탐색인가 (list_tables 허용용)
function asksTableList(query) { return TABLE_LIST_RE.test(String(query || '')); }

// 질문이 테이블 구조/스키마 질문인가 (describe_table 허용용 — 테이블명 실재와 조합해 판정)
function asksTableStructure(query) { return TABLE_STRUCT_RE.test(String(query || '')); }

// list_tables 결과(개행 구분 테이블명)를 배열로. 실패/형식이상 → null (호출측 휴리스틱 폴백).
function parseTableNames(raw) {
  if (raw === null || raw === undefined) return null;
  if (Object.prototype.toString.call(raw) === '[object Array]') return raw;
  var s = String(raw);
  if (s.indexOf('Error:') === 0) return null;
  var out = [];
  var lines = s.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(t)) out.push(t.toUpperCase());
  }
  return out.length ? out : null;
}

// 질문에 실재 테이블명이 단어 경계로 등장하면 그 이름을, 없으면 '' 반환.
// tableNames가 null(목록 확보 실패)이면 식별자 휴리스틱으로 폴백 — 일반 용어(STOP_WORDS)를 뺀
// 식별자 토큰이 있으면 테이블 언급으로 간주(과차단 방지 쪽으로 보수적).
function mentionsTable(query, tableNames) {
  var q = String(query || '');
  if (tableNames && tableNames.length) {
    for (var i = 0; i < tableNames.length; i++) {
      var re = new RegExp('(^|[^A-Za-z0-9_$])' + escapeRe(tableNames[i]) + '($|[^A-Za-z0-9_$])', 'i');
      if (re.test(q)) return tableNames[i];
    }
    return '';
  }
  var m = q.match(/[A-Za-z_][A-Za-z0-9_$]{2,}/g) || [];
  for (var j = 0; j < m.length; j++) {
    if (!STOP_WORDS[m[j].toLowerCase()]) return m[j];
  }
  return '';
}

// compile_tql_from_spec args에서 대상 테이블명 추출(spec이 객체/JSON문자열 모두 대응)
function extractSpecTable(args) {
  if (!args) return '';
  var s = args.spec;
  if (s && typeof s === 'object' && s.table) return String(s.table);
  if (typeof s === 'string') {
    var m = s.match(/["']?table["']?\s*[:=]\s*["']([^"']+)["']/i);
    if (m) return m[1];
  }
  if (args.table) return String(args.table);
  return '';
}

module.exports = {
  wantsExample: wantsExample,
  asksTableList: asksTableList,
  asksTableStructure: asksTableStructure,
  parseTableNames: parseTableNames,
  mentionsTable: mentionsTable,
  extractSpecTable: extractSpecTable,
};
