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
