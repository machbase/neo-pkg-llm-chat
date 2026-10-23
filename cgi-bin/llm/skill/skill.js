function containsKeyword(s, keywords) {
  for (var i = 0; i < keywords.length; i++) {
    if (s.indexOf(keywords[i]) >= 0) return true;
  }
  return false;
}

function createRegistry() {
  var skills = {};
  var defaultSkill = null;

  function register(s) { skills[s.name] = s; }
  function get(name) { return skills[name] || null; }

  register(require('./basic')());
  register(require('./advanced')());
  register(require('./report')());
  register(require('./doclookup')());
  register(require('./dataquery')());
  register(require('./systeminfo')());
  register(require('./general')());
  defaultSkill = skills['General'];

  // 4.5 Forecast 분기 키워드 — 리포트/대시보드 언급 없는 순수 예측 요청용
  var FORECAST_ANY = ['예측', 'forecast', 'predict', 'prediction', '예상', '전망', '향후', '미래 값', 'extrapolat'];

  // 문서 질문 표지 — 규칙 4·8·9의 길이 추정보다 우선
  // · 짧은 문서 질문("버전 호환성", "컬럼 추가 방법")이 조회로 새는 것 방지
  var DOC_MARKER = [
    '뭐야', '뭐임', '뭔데', '뭐냐', '뭐지', '뭔가요', '뭔지', '란?', '이란', '개념',
    '사용법', '문법', '예제', '방법', '종류', '범위', '제약', '설명',
    '어떻게', '차이', '지원', '가능', '되나', '되는', '할 수 있',
    'how to', 'what is', 'what are', 'explain', 'usage', 'example', 'syntax', 'reference',
  ];
  // 조회 대상 지목 여부 — 대문자 식별자(TAG01/SENSOR_DATA)나 SQL 키워드
  // · NOT_TARGET: 형식·프로토콜·언어 이름 — 대문자여도 대상 아님("CSV 구분자를 바꾸려면")
  var NOT_TARGET = /^(SQL|TQL|API|CSV|TSV|JSON|XML|YAML|HTML|CSS|HTTP|HTTPS|MQTT|NATS|REST|GRPC|RPC|URL|URI|CLI|SDK|UI|DB|TCP|UDP|SSL|TLS|CPU|RAM|UTC|ISO|PDF|MD|WS|IP|GET|POST|PUT|HEAD|SCRIPT|CHART|FAKE|TAKE|DROP|FILTER|GROUP|MAPVALUE|MAPKEY|MAPDATA|PUSHKEY|PUSHVALUE|TIMEWINDOW|TENGO|BYTES|STRING|INSERT|APPEND)$/;
  function namesTarget(query, lower) {
    if (/\b(select|insert|update|delete|from|where)\b/i.test(lower)) return true;
    var ids = query.match(/(^|\s)[A-Z][A-Z0-9_]{2,}/g) || [];
    for (var i = 0; i < ids.length; i++) if (!NOT_TARGET.test(ids[i].trim())) return true;
    return false;
  }
  // 테이블 종류·제품 일반 용어 — 대문자로 쓰여도 특정 테이블을 지목한 게 아님("TAG 테이블 최대 컬럼 수")
  var TABLE_GENERIC = /^(TAG|LOG|VOLATILE|LOOKUP|ROLLUP|DBMS|MACHBASE|NEO|SYS|META|STAT|INDEX|PRIMARY|BASETIME|SUMMARIZED)$/;
  // 특정 테이블·태그를 지목했는가 — namesTarget에서 일반 용어 제외
  function namesTableTarget(query, lower) {
    if (/\b(select|insert|update|delete|from|where)\b/i.test(lower)) return true;
    var ids = query.match(/(^|\s)[A-Z][A-Z0-9_]{2,}/g) || [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i].trim();
      if (!NOT_TARGET.test(id) && !TABLE_GENERIC.test(id)) return true;
    }
    // "<이름> 테이블"(대소문자 무관)·밑줄/숫자 든 소문자 식별자(sensor_test, tag01)도 지목
    var named = query.match(/([A-Za-z][A-Za-z0-9_]{2,})\s*테이블/g) || [];
    for (var k = 0; k < named.length; k++) {
      var nm = named[k].replace(/\s*테이블$/, '').toUpperCase();
      if (!NOT_TARGET.test(nm) && !TABLE_GENERIC.test(nm)) return true;
    }
    var lowIds = query.match(/(^|\s)[a-z][a-z0-9]*[_0-9][a-z0-9_]*/g) || [];
    for (var m = 0; m < lowIds.length; m++) if (lowIds[m].trim().length >= 3) return true;
    return false;
  }

  // 조회 의도 어휘 — 규칙 5.5('알려줘' 데이터 질문)·9(조회 fallback) 공용
  var DATA_SIGNAL = [
    '조회', '확인', '최근', '최신', '태그', '몇건', '몇 건', '저장', '구조', '컬럼', '스키마',
    'schema', 'structure', 'columns', 'describe',
    'query', 'fetch', 'retrieve', 'select', 'count', 'how many',
    'latest', 'recent', 'list', 'get data', 'check', 'save',
    '데이터', 'data',
    // 집계·시간·목록 어휘 — 짧은 조회형("TAG01 평균", "어제 온도")이 기본값(DocLookup)으로 새는 것 방지
    // · 범용 명사와 달리 값을 물을 때만 쓰이는 말
    '평균', '최대', '최소', '최댓값', '최솟값', '합계', '개수', '목록',
    '어제', '오늘', '지난주', '지난달', '이번 달', '이번달', '마지막',
    'average', 'max', 'min', 'sum', 'total', 'yesterday', 'today', 'last week',
  ];
  // 측정 대상 낱말 — 규칙 5.6·5.7 공용. '값'·'수치' 같은 범용 낱말은 빠짐("기본값이 얼마야"는 문서 질문)
  var MEASURE_WORDS = ['가격', '온도', '습도', '거래량', '시세', '종가', '시가', '고가', '저가', '전력', '압력', '진동', '전압', '전류', '속도', '유량', '수위'];
  // 문서성 낱말 — 측정 낱말이 있어도 기능·설정을 묻는 질문("평균값 구하는 함수 알려줘")
  var DOCISH_WORDS = ['함수', '쿼리', '문법', '명령', '옵션', '설정', '파라미터', '방식', '원리', '기능', '제한', '한도', '크기', '용량', '타입', '형식'];

  function classify(query) {
    var lower = query.toLowerCase();
    var docMarked = containsKeyword(lower, DOC_MARKER);

    // 1. CodeExec — 실제 코드 포함 → 무조건 CodeExec
    if (containsKeyword(query, ['SQL(', 'CHART(', 'CSV(', 'SCRIPT(', 'FAKE('])) {
      return skills['CodeExec'];
    }

    // 2. Report — "리포트/보고서"가 붙으면 예측 여부와 무관하게 Report
    //    · "예측 리포트 만들어줘"도 일반 분석 리포트 · 예측 HTML 리포트는 4.5(순수 예측) 전용
    if (containsKeyword(lower, ['리포트', '보고서', 'report', 'summary report'])) {
      return skills['Report'];
    }

    // 3. 타이머 — 이 앱은 타이머를 등록·관리하지 않음 → 매뉴얼(문서 검색)로 안내
    if (containsKeyword(lower, ['타이머', 'timer', 'cron', '스케줄러', 'scheduler'])) return skills['DocLookup'];
    if (containsKeyword(lower, ['스케줄', 'schedule']) && containsKeyword(lower, [
      '만들', '생성', '추가', '등록', '시작', '중지', '삭제', '제거', '목록', '리스트',
      'create', 'add', 'start', 'stop', 'delete', 'remove', 'list',
    ])) return skills['DocLookup'];

    // 4. System status/version — "지금 이 서버"를 묻는 짧은 질문만
    //   · 버전·상태·패키지는 문서 질문에도 흔한 어휘 → 길이(≤25)로 구분
    //   · 대상 명시(서버/현재/지금)는 상한을 40으로 넓힐 뿐 — '지금·현재'는 문서 질문에도 섞임
    if (containsKeyword(lower, [
      '버전', '상태', '시스템 정보', '서버 정보', '패키지',
      'version', 'status', 'system info', 'server info',
    ]) && !docMarked && (lower.trim().length <= 25
      || (lower.trim().length <= 40 && containsKeyword(lower, ['서버', '현재', '지금', 'server', 'current'])))) {
      return skills['SystemInfo'];
    }

    // 4.5 Forecast(예측) — 리포트/대시보드 언급 없는 순수 예측 요청만("SILVER 예측해줘")
    //  · 대시보드가 붙으면 Basic/Advanced로 · 개념 질문(예측이 뭐야/사용법)은 제외
    if (containsKeyword(lower, FORECAST_ANY)
      && !containsKeyword(lower, ['뭐야', '뭐임', '뭔데', '뭐냐', '뭐지', '뭔가요', '란?', '이란', '사용법', '문법', '설명해', 'what is', 'how to'])
      && !containsKeyword(lower, ['대시보드', 'dashboard'])) {
      return skills['CodeExec'];
    }

    // 5. CodeExec — 실행 의도 확실한 키워드 (DocLookup 키워드 없을 때만)
    var hasDocKw = containsKeyword(lower, [
      '뭐야', '뭐임', '뭔데', '뭐냐', '뭐지', '뭔가요', '란?', '이란', '사용법', '문법', '예제', '알려줘', '설명해', '어떻게', '방법',
      '무엇인가요', '무엇인지', '무엇입니까', '무엇을', '어떤 점', '어떤 차이', '차이점', '차이가', '다른 점', '뭔지', '개념', 'difference', 'differs', 'differ', ' vs ', 'compared to', 
      'how to', 'what is', 'what are', 'explain', 'usage', 'example', 'syntax', 'help me understand',
      '문서', '매뉴얼', 'manual', 'doc', 'documentation', 'reference',
    ]);
    //   '실행'은 문서 질문에도 쓰임 → 짧거나(≤30) 대상 지목 시만(규칙 9와 같은 게이트)
    if (!hasDocKw && containsKeyword(lower, [
      '실행', '돌려',
      'run', 'execute',
    ]) && (namesTarget(query, lower) || lower.trim().length <= 30)) {
      return skills['CodeExec'];
    }

    // 5.5 '알려줘' 데이터 질문 — '알려줘'는 데이터·문서 양쪽에 쓰는 요청 표현이라 규칙 6의 문서 판정보다 먼저 가름
    //   특정 테이블·태그 지목(일반 용어 제외) + 조회 어휘 + 문서 표지 없음 → 조회
    if (containsKeyword(lower, ['알려줘', '알려 줘']) && !docMarked && namesTableTarget(query, lower)
      && (containsKeyword(lower, DATA_SIGNAL) || containsKeyword(lower, ['건수']))) {
      return skills['CodeExec'];
    }

    // 5.6 '알려줘' + 측정값 + 집계·시간 낱말 — 식별자 없이 한글 이름만 쓴 데이터 질문("비트코인 최근 가격 알려줘")
    //   함수·쿼리·설정 등 문서성 낱말이 있으면 제외("평균값 구하는 함수 알려줘")
    if (containsKeyword(lower, ['알려줘', '알려 줘']) && !docMarked
      && containsKeyword(lower, MEASURE_WORDS.concat(['값', '수치']))
      && containsKeyword(lower, ['최근', '최신', '평균', '최대', '최소', '최댓값', '최솟값', '합계', '개수', '건수', '어제', '오늘', '지난주', '지난달', '이번 달', '월별', '일별', '주별', '시간별'])
      && !containsKeyword(lower, DOCISH_WORDS)) {
      return skills['CodeExec'];
    }

    // 5.7 측정값 수치 질문 — "온도 몇 도야", "습도 얼마야", "지금 압력 몇이야"
    //   조회 어휘 없는 짧은 현재값 질문용
    //   짧거나 대상을 지목했을 때만 — 긴 상황 서술은 문서 질문 쪽("집계가 얼마나 밀렸는지")
    if (!docMarked && containsKeyword(lower, MEASURE_WORDS)
      && containsKeyword(lower, ['몇 도', '몇도', '얼마', '몇이야', '몇 이야', '몇이에요', '몇인지', '몇 정도'])
      && !containsKeyword(lower, DOCISH_WORDS)
      && (namesTarget(query, lower) || lower.trim().length <= 25)) {
      return skills['CodeExec'];
    }

    // 6. DocLookup — 구어 개념질문('뭐임/뭔데/뭐냐/뭐지', "tql 이 뭐임") 포함
    //    · 개념질문이 General로 새 DocLookup 가드가 무력화되는 것 방지
    if (containsKeyword(lower, [
      '뭐야', '뭐임', '뭔데', '뭐냐', '뭐지', '뭔가요', '란?', '이란', '사용법', '문법', '예제', '알려줘', '설명해', '어떻게',
      '무엇인가요', '무엇인지', '무엇입니까', '무엇을', '어떤 점', '어떤 차이', '차이점', '차이가', '다른 점', '뭔지', '개념', 'difference', 'differs', 'differ', ' vs ', 'compared to', 
      'how to', 'what is', 'what are', 'explain', 'usage', 'example', 'syntax', 'help me understand',
    ]) || containsKeyword(lower, ['문서', '매뉴얼', 'manual', 'doc', 'documentation', 'reference'])) {
      return skills['DocLookup'];
    }

    // 7. Advanced
    if (containsKeyword(lower, [
      '심층', '다각도', '고급', 'fft', 'rms', '스펙트럼', '엔벨로프',
      '진동 분석', '이상치', '이상 탐지',
      'advanced', 'spectrum', 'envelope', 'anomaly', 'vibration analysis',
      'frequency', 'crest factor', 'peak-to-peak',
    ])) {
      return skills['AdvancedAnalysis'];
    }

    // 8. BasicAnalysis — 명시적 차트/시각화/분석 의도만
    //   · 패턴·분석·비교·그래프는 문서 질문에도 흔함 → 짧거나(≤30) 지시형(그려/만들어/보여줘/해줘)일 때만
    if (containsKeyword(lower, [
      '분석', '대시보드', '차트', '시각화', '추세', '트렌드', '패턴', '비교', '그래프',
      'dashboard', 'chart', 'visualize', 'visualization', 'trend', 'pattern', 'compare', 'comparison',
      'plot', 'graph', 'analyze', 'analysis',
    ]) && !docMarked && (lower.trim().length <= 30
      || containsKeyword(lower, ['그려', '만들어', '보여줘', '해줘', 'draw', 'create', 'make']))) {
      return skills['BasicAnalysis'];
    }

    // 8.5 모호한 "보여줘/show me/display" — 차트 단어 없으면 단순 데이터 조회(SQL 표)
    //   · 문서 표지가 붙으면 설명 요구("지원하는 데이터 타입 보여줘") → 제외
    if (containsKeyword(lower, ['보여줘', '보여 줘', 'show me', 'display']) && !docMarked) {
      return skills['CodeExec'];
    }

    // 9. CodeExec — 범용 조회 키워드 fallback
    if (containsKeyword(lower, DATA_SIGNAL)
      // 범용 명사(컬럼·데이터·확인·저장·구조)는 문서 질문에도 흔함 → 문서 표지 없을 때만
      && !docMarked
      // 대상 지목(테이블명·SQL 키워드)이면 길이 무관 · 아니면 짧은(≤20) 질문만("데이터 타입" vs "TAG01 평균")
      && (namesTarget(query, lower) || lower.trim().length <= 20)) {
      return skills['CodeExec'];
    }

    // 10. 잡담 — 짧은 인사·감사·확인 응답만 · "안녕"에 문서 검색 도는 것 방지
    if (/^[\s]*(안녕|하이|헬로|반가|고마|감사|수고|잘\s*했|좋아|알겠|ok|okay|hi|hello|thanks|thank you|bye)/i.test(lower.trim())
      && lower.trim().length <= 20) {
      return defaultSkill;
    }

    // 11. 분류 실패 → DocLookup
    //   · 표지 없는 문서 질문이 General(도구·안내 없음)로 가면 사전지식 환각 — 방지용
    return skills['DocLookup'];
  }

  return { register: register, get: get, classify: classify };
}

module.exports = { createRegistry, containsKeyword };
