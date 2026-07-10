// Node unit test for section-targeted retrieval (docs.js) + security howto exemption.
// Run: node cgi-bin/llm/tools/docs_section.test.js   (from repo root or anywhere)
var path = require('path');
process.chdir(path.join(__dirname, '..')); // cgi-bin/llm so findNeoDir() locates ./neo

var docs = require('./docs');
var security = require('./security');

// capture registered tools
var tools = {};
docs.register({ register: function (t) { tools[t.name] = t; } }, null);
function call(name, args) {
  var out;
  tools[name].fn(args, function (e, r) { out = r; });
  return out;
}

var DDL = 'dbms/sql-reference/sql-reference-ddl.md';
var FUNCS = 'dbms/sql-reference/sql-reference-functions.md';
var fs = require('fs');
var neoDir = 'neo';

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('\n== get_full_document_content: section targeting ==');

// 1) deep section now reachable
var r1 = call('get_full_document_content', { file_identifier: DDL, section: 'ADD COLUMN' });
ok('section="ADD COLUMN" returns the section', /ALTER TABLE ADD COLUMN/i.test(r1));
ok('section="ADD COLUMN" includes the example body (id4 float)', /id4 float/i.test(r1));
ok('section="ADD COLUMN" is NOT front-truncated', !/truncated, total 3/i.test(r1));
ok('section="ADD COLUMN" stays small (<16000)', r1.length < 16000, 'len=' + r1.length);

// 1b) section response carries an "other sections" footer (scope awareness, no body dump)
var foot1 = r1.split('이 문서의 다른 섹션:')[1] || '';
ok('section response appends "다른 섹션" footer', /이 문서의 다른 섹션:/.test(r1));
ok('footer lists a related op (RENAME/DROP COLUMN/RETENTION)', /(RENAME COLUMN|DROP COLUMN|RETENTION)/i.test(foot1));
ok('footer is titles-only (no other-section body like "id8 varchar")', !/id8 varchar/i.test(foot1));
ok('footer is compact (<1800 chars)', foot1.length < 1800, 'footLen=' + foot1.length);

// 2) substring returns related sections (ADD COLUMN + METADATA ADD COLUMN)
var r2 = call('get_full_document_content', { file_identifier: DDL, section: 'add column' });
ok('section="add column" includes METADATA ADD COLUMN too',
  /ALTER TABLE ADD COLUMN/i.test(r2) && /METADATA ADD COLUMN/i.test(r2));

// 3) no-section on a large doc returns a SECTION INDEX (titles), not hidden bodies
var r3 = call('get_full_document_content', { file_identifier: DDL });
ok('no-section large doc returns section list', /사용 가능한 섹션/.test(r3));
ok('section list contains the ADD COLUMN title', /-\s*ALTER TABLE ADD COLUMN/i.test(r3));
ok('section list does NOT dump bodies (no id4 float)', !/id4 float/i.test(r3));

// 4) code-fence fix: false-positive "## Column c1 ..." inside a SQL block is gone from the index
ok('code-fence: no fake "Column c1" section in index', !/-\s*Column c1/i.test(r3));

// 5) TO_CHAR parent-stub: must return real content, not the 170-char stub
var r4 = call('get_full_document_content', { file_identifier: FUNCS, section: 'TO_CHAR' });
ok('section="TO_CHAR" returns real content (not tiny stub)', r4.length > 1000, 'len=' + r4.length);
ok('section="TO_CHAR" includes a child (DATETIME)', /datetime/i.test(r4));

// 6) keyword not found -> section index, never an error
var r5 = call('get_full_document_content', { file_identifier: DDL, section: 'zzz_nope' });
ok('not-found returns "not found" + section list', /not found/i.test(r5) && /사용 가능한 섹션/.test(r5));

// 6b) Korean keyword (English titles) -> graceful section-index fallback (the known weak spot)
var r6 = call('get_full_document_content', { file_identifier: DDL, section: '컬럼 추가' });
ok('Korean keyword falls back to section index (no silent miss)', /사용 가능한 섹션/.test(r6));

// 7) backward-compat: small doc with no section returns full content (no index marker)
var small = 'dbms/table-types/tag-tables/table-types-tag-tables-deleting-data.md';
var rawLen = fs.readFileSync(path.join(neoDir, small), 'utf8').length;
var r7 = call('get_full_document_content', { file_identifier: small });
if (rawLen <= 16000) {
  ok('small doc returns full (no index marker)', !/사용 가능한 섹션/.test(r7) && r7.length > 0, 'rawLen=' + rawLen);
} else {
  ok('large doc (deleting-data) returns index', /사용 가능한 섹션/.test(r7), 'rawLen=' + rawLen);
}

// 8) path traversal guard still intact
var r8 = call('get_full_document_content', { file_identifier: '../configs/sys.json', section: 'x' });
ok('traversal guard rejects ../configs/sys.json', /Error/i.test(r8));

// 9) regression: tool results must NOT leak the doc file path (weak models echo it as a doc link)
ok('section response does NOT leak doc path (r1)', !/sql-reference-ddl\.md/i.test(r1));
ok('section index does NOT leak doc path (r3)', !/sql-reference-ddl\.md/i.test(r3));
ok('not-found index does NOT leak file_identifier= (r5)', !/file_identifier=/.test(r5));

console.log('\n== get_full_document_content: monolithic docs / h4 / excerpts ==');

// 10) 헤더 없는 대형 문서(에러코드 48KB, 섹션 1개): section=코드로 매치 중심 발췌
var EC = 'dbms/troubleshooting/troubleshooting-error-code.md';
var r10 = call('get_full_document_content', { file_identifier: EC, section: '3032' });
ok('error-code doc: section="3032" returns the deep row', /getting license meta/i.test(r10), 'got=' + String(r10).substring(0, 120));
ok('error-code excerpt stays small (<16000)', r10.length < 16000, 'len=' + r10.length);

// 10b) 미스 키워드 → 안내 + 앞부분(에러 아님)
var r10b = call('get_full_document_content', { file_identifier: EC, section: 'zzz_nope_9999' });
ok('error-code doc: miss keyword returns guidance (not error)', /다른 키워드/.test(r10b) && !/^Error/.test(r10b));

// 10c) 무인자 → 발췌 안내(본문 전체 덤프 금지)
var r10c = call('get_full_document_content', { file_identifier: EC });
ok('error-code doc: no-section returns search guidance', /section=/.test(r10c), 'len=' + r10c.length);
ok('error-code doc: no-section stays small (<8000)', r10c.length < 8000, 'len=' + r10c.length);

// 11) h4 하위 섹션 직접 주소화 (ddl.md의 #### TAG_PARTITION_COUNT)
var r11 = call('get_full_document_content', { file_identifier: DDL, section: 'TAG_PARTITION_COUNT' });
ok('h4 subsection is addressable (TAG_PARTITION_COUNT)', /TAG_PARTITION_COUNT/i.test(r11) && !/not found/i.test(r11));
ok('h4 result shows parent breadcrumb (›)', /›/.test(r11));

// 12) 섹션 인덱스 캡 (functions.md 66개 → 60개 + …외 N개)
var r12 = call('get_full_document_content', { file_identifier: FUNCS });
ok('section index is capped (functions.md)', /…외 \d+개/.test(r12), 'len=' + r12.length);
ok('section index stays small (<6000)', r12.length < 6000, 'len=' + r12.length);

console.log('\n== search_documents: multi-keyword ranking / no-dump fallback ==');

// 13) 다중 키워드(한국어+영어) 랭킹 매치
var s1 = call('search_documents', { keyword: 'rollup 삭제' });
ok('multi-keyword search finds docs', /Found \d+ document/.test(s1), 'got=' + String(s1).substring(0, 100));

// 14) 미스 → 카탈로그 전체 덤프 금지, 근사 후보만
var s2 = call('search_documents', { keyword: 'zzqx_totally_bogus_keyword' });
ok('no-match does NOT dump full catalog (<3000 chars)', s2.length < 3000, 'len=' + s2.length);
ok('no-match asks for retry', /다시 검색/.test(s2) || /No match/.test(s2));

// 15) 섹션 힌트: 매치 문서의 섹션 제목을 section= 재호출용으로 제공
var s3 = call('search_documents', { keyword: 'retention' });
ok('search returns section hints when titles match', /섹션 힌트/.test(s3), 'got=' + String(s3).substring(0, 200));

// 16) 단일 키워드 하위호환 (기존 스타일 결과 포맷 유지)
var s4 = call('search_documents', { keyword: 'PIVOT' });
ok('single keyword still works', /Found \d+ document/.test(s4) || /No match/.test(s4));

// 17) 근사 후보 0개면 빈 "비슷한 문서 후보:" 헤더를 붙이지 않음 (리뷰 확정 결함 수정)
var s5 = call('search_documents', { keyword: 'C(' });
ok('no-candidates: no empty 후보 header', /No match/.test(s5) && !/비슷한 문서 후보:\s*$/.test(s5), 'got=' + String(s5).substring(0, 120));

console.log('\n== 마무리 리뷰 확정 결함 회귀 (통합 랭킹 / 캡 / 경로누출) ==');

// 18) 통합 랭킹: h4 정확 일치가 h1-3 substring 매치(arrange())를 이김
var r18 = call('get_full_document_content', { file_identifier: 'tql/tql-src.md', section: 'range()' });
ok('range() returns the h4 definition first (not arrange())', /› range\(\)/.test(r18) && r18.indexOf('## arrange()') !== 0, 'head=' + String(r18).substring(0, 80));

// 19) get_document_sections 총량 캡 (기존 39KB → 16KB 내)
var r19 = call('get_document_sections', { file_identifier: 'dbms/configuration/configuration-property.md' });
ok('get_document_sections is capped (<17000)', r19.length < 17000, 'len=' + r19.length);
ok('get_document_sections cap notes omissions', /생략/.test(r19));

// 20) 레거시 도구 에러가 서버 절대경로를 누출하지 않음
var r20 = call('get_document_sections', { file_identifier: 'no/such/doc.md' });
var r21 = call('extract_code_blocks', { file_identifier: 'no/such/doc.md' });
ok('get_document_sections error has no absolute path', /Error/.test(r20) && !/[A-Za-z]:\\|\/Users\//.test(r20), 'got=' + r20);
ok('extract_code_blocks error has no absolute path', /Error/.test(r21) && !/[A-Za-z]:\\|\/Users\//.test(r21), 'got=' + r21);

console.log('\n== 개념질문 라이브 실측 결함 회귀 (무태그 펜스 / 하위 섹션 동봉) ==');

// 21) extract_code_blocks: 무태그 펜스가 language 필터를 통과 (tql-guide 예제 26개 전멸 버그)
var GUIDE = 'tql/tql-guide.md';
var e1 = call('extract_code_blocks', { file_identifier: GUIDE, language: 'tql' });
ok('extract_code_blocks(tql) returns untagged blocks', e1.indexOf('No code blocks found') < 0 && /```/.test(e1), 'got=' + String(e1).substring(0, 80));
ok('extract_code_blocks stays capped (<17000)', e1.length < 17000, 'len=' + e1.length);

// 22) 제목 매칭 섹션에 하위 섹션 동봉 (TQL Concepts → SRC/SINK/MAP Functions)
var e2 = call('get_full_document_content', { file_identifier: GUIDE, section: 'TQL Concepts' });
ok('TQL Concepts includes SRC Functions child', /SRC Functions/i.test(e2), 'len=' + e2.length);
ok('TQL Concepts includes MAP Functions child', /MAP Functions/i.test(e2));
ok('descendants stay capped (<16000)', e2.length < 16000, 'len=' + e2.length);
var foot2 = e2.split('이 문서의 다른 섹션:')[1] || '';
ok('footer does not re-list included children', !/SRC Functions/.test(foot2));

console.log('\n== 전체 문서 조회에 주요 섹션 footer 부착(개념질문 폭 확보) ==');

// 23) 작은 문서 전체 조회 → 본문 + "이 문서의 주요 섹션" footer (h2 제목만)
var g1 = call('get_full_document_content', { file_identifier: GUIDE });
ok('whole small doc has 주요 섹션 footer', /이 문서의 주요 섹션: /.test(g1), 'tail=' + g1.substring(g1.length - 200));
ok('footer lists h2 topics (What is TQL/TQL Concepts)', /What is TQL\?|TQL Concepts/.test(g1.split('이 문서의 주요 섹션: ')[1] || ''));
ok('footer excludes doc H1 title', (g1.split('이 문서의 주요 섹션: ')[1] || '').indexOf('Machbase Neo TQL Guide') < 0);
ok('footer excludes h3 child (SRC Functions)', (g1.split('이 문서의 주요 섹션: ')[1] || '').indexOf('SRC Functions') < 0);
ok('footer nudges ~3 topics', /3개 정도/.test(g1));
ok('doc body still present (What is TQL? section)', /Transforming Query Language/i.test(g1));

console.log('\n== security.screenQuery: howto exemption (rule 6) ==');
var REF = security.REFUSAL_TEXT;
ok('ALTER TABLE howto passes', security.screenQuery('ALTER TABLE ADD COLUMN 어떻게 써?') === null);
ok('ADD COLUMN 사용법 passes', security.screenQuery('ADD COLUMN 사용법 알려줘') === null);
ok('TRUNCATE 방법 passes', security.screenQuery('TRUNCATE TABLE 방법 알려줘') === null);
ok('raw "DELETE FROM sensor" still refused', security.screenQuery('DELETE FROM sensor') === REF);
ok('NL "테이블 데이터 삭제해줘" still refused', security.screenQuery('테이블 데이터 삭제해줘') === REF);
ok('howto "데이터 삭제하는 방법" passes (regression)', security.screenQuery('데이터 삭제하는 방법 알려줘') === null);

console.log('\n----------------------------------------');
console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
