// Node unit test for doc_intent (DocLookup EXCEPTION 이중조건 분류기).
// Run: node cgi-bin/llm/agent/doc_intent.test.js
var di = require('./doc_intent');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

var TABLES = ['SENSOR_TEST', 'TAG', 'ELEC_GEN', 'WEATHER'];

console.log('\n== wantsExample ==');
ok('예제 요청 감지', di.wantsExample('SENSOR_TEST 데이터 TQL 예제 알려줘'));
ok('샘플/코드 감지', di.wantsExample('샘플 코드 보여줘'));
ok('영문 example 감지', di.wantsExample('show me an example'));
ok('개념 질문은 아님', !di.wantsExample('tql이 뭐야'));
ok('사용법 질문은 아님', !di.wantsExample('rollup 사용법 알려줘'));
ok('"에러코드"는 예제 요청 아님 (복합어 제외)', !di.wantsExample('SENSOR_TEST 에러코드 알려줘'));
ok('"에러 코드"(띄어쓰기)도 아님', !di.wantsExample('에러 코드 2049가 뭐야'));
ok('"다운샘플링"도 아님', !di.wantsExample('다운샘플링 방법 알려줘'));
ok('"에러코드 예제"는 예제 요청 맞음', di.wantsExample('에러코드 처리 예제 알려줘'));
ok('단독 "코드"는 예제 요청 맞음', di.wantsExample('SENSOR_TEST 조회 코드 알려줘'));

console.log('\n== asksTableStructure ==');
ok('"테이블 구조 알려줘" 감지', di.asksTableStructure('SENSOR_TEST 테이블 구조 알려줘'));
ok('"컬럼 알려줘" 감지', di.asksTableStructure('SENSOR_TEST 컬럼 알려줘'));
ok('영문 schema 감지', di.asksTableStructure('show me the schema of SENSOR_TEST'));
ok('개념 질문은 아님', !di.asksTableStructure('rollup이 뭐야'));

console.log('\n== mentionsTable (실재 테이블 목록 대조) ==');
ok('테이블명 명시 → 감지', di.mentionsTable('SENSOR_TEST 데이터 TQL 예제 알려줘', TABLES) === 'SENSOR_TEST');
ok('소문자 표기도 감지', di.mentionsTable('sensor_test 예제 만들어줘', TABLES) === 'SENSOR_TEST');
ok('테이블명 없는 일반 요청 → 미감지', di.mentionsTable('롤업 예제 알려줘', TABLES) === '');
ok('차트 예제(테이블 없음) → 미감지', di.mentionsTable('차트 예제 알려줘', TABLES) === '');
ok('부분 문자열은 오탐 아님 (SENSOR_TEST2)', di.mentionsTable('SENSOR_TEST2 예제', TABLES) === '');
ok('TAG 테이블 실재 + 언급 → 감지', di.mentionsTable('TAG 테이블 예제 줘', TABLES) === 'TAG');

console.log('\n== mentionsTable (목록 확보 실패 → 휴리스틱 폴백) ==');
ok('식별자스러운 토큰 → 테이블로 간주(보수적)', di.mentionsTable('MY_SENSOR 예제 알려줘', null) === 'MY_SENSOR');
ok('일반 용어만 있으면 미감지', di.mentionsTable('rollup 예제 알려줘', null) === '');
ok('tql/sql/차트 용어 미감지', di.mentionsTable('tql chart 예제 sample', null) === '');

console.log('\n== asksTableList ==');
ok('"테이블 목록 알려줘" 감지', di.asksTableList('테이블 목록 알려줘'));
ok('"무슨 테이블 있어?" 감지', di.asksTableList('무슨 테이블 있어?'));
ok('영어 show tables 감지', di.asksTableList('show tables please'));
ok('일반 질문은 아님', !di.asksTableList('rollup이 뭐야'));

console.log('\n== parseTableNames ==');
ok('개행 구분 목록 파싱', JSON.stringify(di.parseTableNames('SENSOR_TEST\nTAG\n')) === JSON.stringify(['SENSOR_TEST', 'TAG']));
ok('Error 결과 → null', di.parseTableNames('Error: db down') === null);
ok('빈/이상 결과 → null', di.parseTableNames('No tables found.') === null);
ok('배열 입력은 그대로', JSON.stringify(di.parseTableNames(['A'])) === JSON.stringify(['A']));

console.log('\n== extractSpecTable ==');
ok('spec 객체에서 추출', di.extractSpecTable({ spec: { table: 'SENSOR_TEST' } }) === 'SENSOR_TEST');
ok('spec JSON 문자열에서 추출', di.extractSpecTable({ spec: '{"table":"ELEC_GEN","kind":"metrics"}' }) === 'ELEC_GEN');
ok('최상위 table 폴백', di.extractSpecTable({ table: 'WEATHER' }) === 'WEATHER');
ok('없으면 빈 문자열', di.extractSpecTable({ spec: { kind: 'tags' } }) === '');

console.log('\n== EXCEPTION 판정 시나리오(가드 조합) ==');
function isException(q, tables) { return di.wantsExample(q) && !!di.mentionsTable(q, tables); }
ok('테이블+예제 → EXCEPTION', isException('SENSOR_TEST 차트 예제 알려줘', TABLES));
ok('예제만(테이블 없음) → 문서 모드', !isException('롤업 예제 알려줘', TABLES));
ok('테이블만(예제 없음) → 문서 모드', !isException('SENSOR_TEST 구조가 뭐야', TABLES));
ok('개념 질문 → 문서 모드', !isException('tql이 뭐임', TABLES));

console.log('\n----------------------------------------');
console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
