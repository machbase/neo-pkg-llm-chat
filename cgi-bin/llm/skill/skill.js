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
  register(require('./timer')());
  register(require('./systeminfo')());
  register(require('./general')());
  defaultSkill = skills['General'];

  // 4.5 Forecast 분기가 잡는 키워드. **리포트/대시보드 언급이 없는 순수 예측 요청**에만 쓰인다
  // (리포트가 붙으면 2단계 Report가, 대시보드가 붙으면 Basic/Advanced가 가져간다 — 둘 다 forecast_table을 갖고 있다).
  var FORECAST_ANY = ['예측', 'forecast', 'predict', 'prediction', '예상', '전망', '향후', '미래 값', 'extrapolat'];

  // 문서 질문임을 드러내는 표지. 아래 규칙 4·8·9는 길이로 조회 의도를 추정하는데,
  // 짧은 문서 질문("버전 호환성", "컬럼 추가 방법")이 그 추정에 걸려 샜다.
  // 표지가 있으면 길이 추정보다 우선한다 — 추정보다 명시가 강하다.
  var DOC_MARKER = [
    '뭐야', '뭐임', '뭔데', '뭐냐', '뭐지', '뭔가요', '뭔지', '란?', '이란', '개념',
    '사용법', '문법', '예제', '방법', '종류', '범위', '제약', '설명',
    '어떻게', '차이', '지원', '가능', '되나', '되는', '할 수 있',
    'how to', 'what is', 'what are', 'explain', 'usage', 'example', 'syntax', 'reference',
  ];
  // 조회 대상을 실제로 지목했는가 — 대문자 식별자(TAG01/SENSOR_DATA)나 SQL 키워드.
  // 짧은 명사구라도 대상이 없으면 개념 질문 쪽이다("데이터 타입" vs "TAG01 평균").
  // 형식·프로토콜·언어 이름은 대문자로 쓰여도 조회 대상이 아니다 — 문서 질문의 주어로 그대로 쓰인다
  // ("CSV 구분자를 바꾸려면"). 이게 대상 지목으로 잡히면 길이 게이트가 무력해져 문서 질문이 조회로 샌다.
  var NOT_TARGET = /^(SQL|TQL|API|CSV|TSV|JSON|XML|YAML|HTML|CSS|HTTP|HTTPS|MQTT|NATS|REST|GRPC|RPC|URL|URI|CLI|SDK|UI|DB|TCP|UDP|SSL|TLS|CPU|RAM|UTC|ISO|PDF|MD|WS|IP|GET|POST|PUT|HEAD|SCRIPT|CHART|FAKE|TAKE|DROP|FILTER|GROUP|MAPVALUE|MAPKEY|MAPDATA|PUSHKEY|PUSHVALUE|TIMEWINDOW|TENGO|BYTES|STRING|INSERT|APPEND)$/;
  function namesTarget(query, lower) {
    if (/\b(select|insert|update|delete|from|where)\b/i.test(lower)) return true;
    var ids = query.match(/(^|\s)[A-Z][A-Z0-9_]{2,}/g) || [];
    for (var i = 0; i < ids.length; i++) if (!NOT_TARGET.test(ids[i].trim())) return true;
    return false;
  }

  function classify(query) {
    var lower = query.toLowerCase();
    var docMarked = containsKeyword(lower, DOC_MARKER);

    // 1. CodeExec — 실제 코드 포함 → 무조건 CodeExec
    if (containsKeyword(query, ['SQL(', 'CHART(', 'CSV(', 'SCRIPT(', 'FAKE('])) {
      return skills['CodeExec'];
    }

    // 2. Report — "리포트/보고서"가 붙으면 **무조건 여기**(예측이든 아니든). 리포트 요청의 주인은 항상 Report 스킬.
    //    → "예측 리포트 만들어줘"도 여기로 와서 **일반 분석 리포트**가 나온다(현재 정책상 이게 맞다).
    //      예측 HTML 리포트는 **"예측해줘"(리포트 언급 없는 순수 예측)** 로만 만든다 — 아래 4.5.
    if (containsKeyword(lower, ['리포트', '보고서', 'report', 'summary report'])) {
      return skills['Report'];
    }

    // 3. Timer
    var hasTimerKw = containsKeyword(lower, [
      '타이머', '스케줄', '스케줄러', '주기적', '반복 실행', '수집 설정',
      'timer', 'scheduler', 'schedule', 'cron', 'periodic', 'interval',
    ]);
    if (hasTimerKw) {
      var isTimerAction = containsKeyword(lower, [
        '만들', '생성', '추가', '등록', '시작', '중지', '삭제', '제거', '목록', '리스트',
        'create', 'add', 'start', 'stop', 'delete', 'remove', 'list',
      ]);
      if (isTimerAction) return skills['Timer'];
    }

    // 4. System status/version — "지금 이 서버"를 묻는 질문만.
    //   버전·상태·패키지는 문서 질문에도 흔히 나오는 명사라 어휘만으로는 못 가른다
    //   ("어느 버전부터 되는 거야?" / "어느 포트로 접속해?"는 문서 질문이다).
    //   정당한 시스템 질문은 짧고, 같은 어휘를 쓰는 문서 문항은 길다 — 길이로 가른다.
    //   길이만으로 가르면 취약하므로 대상 명시(서버/현재/지금)를 OR로 둔다.
    if (containsKeyword(lower, [
      '버전', '상태', '시스템 정보', '서버 정보', '패키지',
      'version', 'status', 'system info', 'server info',
    //   '지금·현재'도 문서 질문에 섞여 나온다("지금 실행 중인지는 어디서 확인해?").
    //   대상 명시는 길이 상한을 넓혀줄 뿐 없애지는 않는다 — 정당한 시스템 질문은 이 길이를 넘지 않는다.
    ]) && !docMarked && (lower.trim().length <= 25
      || (lower.trim().length <= 40 && containsKeyword(lower, ['서버', '현재', '지금', 'server', 'current'])))) {
      return skills['SystemInfo'];
    }

    // 4.5 Forecast(예측) — **리포트/대시보드 언급 없는 순수 예측 요청**만("SILVER 예측해줘").
    //  · 리포트가 붙으면 위 2단계가 이미 Report로 보냈다(Report도 forecast_table을 갖는다).
    //  · 대시보드가 붙으면 Basic/Advanced로(거기서 .tql 저장 후 대시보드에 꽂는다).
    //  · 순수 문서 질문(예측이 뭐야/사용법)은 제외해 DocLookup으로.
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
    //   '실행'은 문서 질문에도 그대로 나온다("실행 방식을 지시하는 것도 있어?").
    //   위 hasDocKw는 DOC_MARKER보다 좁아('가능'·'지원'·'할 수 있'이 없다) 표지만으로는 못 거른다.
    //   규칙 9와 같은 게이트를 둔다 — 정당한 실행 요청은 짧거나 대상을 지목한다.
    if (!hasDocKw && containsKeyword(lower, [
      '실행', '돌려',
      'run', 'execute',
    ]) && (namesTarget(query, lower) || lower.trim().length <= 30)) {
      return skills['CodeExec'];
    }

    // 6. DocLookup — '뭐임/뭔데/뭐냐/뭐지' 같은 구어 개념질문("tql 이 뭐임")도 잡는다.
    //    이 토큰들이 없으면 개념질문이 General로 새서 DocLookup 가드가 전부 무력화된다.
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

    // 8. BasicAnalysis — 명시적 차트/시각화/분석 의도만.
    //   패턴·분석·비교·그래프는 문서 질문에서 지나가는 말로 자주 쓰인다
    //   ("구분자로 자를 때랑 패턴으로 뽑아낼 때 어떤 키를 써?"는 문서 질문이다).
    //   짧게 지시하거나(그려줘/보여줘/만들어줘) 대상을 지목했을 때만 분석으로 본다.
    if (containsKeyword(lower, [
      '분석', '대시보드', '차트', '시각화', '추세', '트렌드', '패턴', '비교', '그래프',
      'dashboard', 'chart', 'visualize', 'visualization', 'trend', 'pattern', 'compare', 'comparison',
      'plot', 'graph', 'analyze', 'analysis',
    ]) && !docMarked && (lower.trim().length <= 30
      || containsKeyword(lower, ['그려', '만들어', '보여줘', '해줘', 'draw', 'create', 'make']))) {
      return skills['BasicAnalysis'];
    }

    // 8.5 모호한 "보여줘/show me/display" — 위에서 차트 단어가 안 걸렸으면 단순 데이터 조회(SQL 표)로.
    //  ("데이터 보여줘"=표 조회 / "차트 보여줘"=위 규칙 8에서 이미 BasicAnalysis 처리됨)
    //   문서 표지가 붙은 "보여줘"는 조회가 아니라 설명 요구다("지원하는 데이터 타입 보여줘").
    if (containsKeyword(lower, ['보여줘', '보여 줘', 'show me', 'display']) && !docMarked) {
      return skills['CodeExec'];
    }

    // 9. CodeExec — 범용 조회 키워드 fallback
    if (containsKeyword(lower, [
      '조회', '확인', '최근', '최신', '태그', '몇건', '몇 건', '저장', '구조', '컬럼', '스키마',
      'schema', 'structure', 'columns', 'describe',
      'query', 'fetch', 'retrieve', 'select', 'count', 'how many',
      'latest', 'recent', 'list', 'get data', 'check', 'save',
      '데이터', 'data',
      // 짧은 조회형("TAG01 평균", "어제 온도", "테이블 목록")은 위 어휘에 하나도 안 걸려
      // 기본값으로 떨어진다. 기본값이 DocLookup이 된 뒤로는 조회가 문서로 새므로
      // 집계·시간·목록처럼 "조회 의도의 실제 신호"를 여기에 둔다.
      // (컬럼·데이터 같은 범용 명사와 달리, 이 말들은 값을 물을 때만 쓰인다)
      '평균', '최대', '최소', '최댓값', '최솟값', '합계', '개수', '목록',
      '어제', '오늘', '지난주', '지난달', '이번 달', '이번달', '마지막',
      'average', 'max', 'min', 'sum', 'total', 'yesterday', 'today', 'last week',
    ])
      // 위 어휘 대부분(컬럼·데이터·확인·저장·구조)은 문서 질문에도 그대로 나오는 범용 명사다.
      // SQL을 통째로 붙여넣는 조회가 있으므로 상한을 넉넉히 두고,
      // 대문자 식별자(테이블명)나 SQL 키워드를 지목했으면 길이와 무관하게 조회로 본다.
      && !docMarked
      // 짧은 명사구라도 대상을 안 집었으면 개념 질문 쪽이다("데이터 타입" vs "TAG01 평균").
      && (namesTarget(query, lower) || lower.trim().length <= 20)) {
      return skills['CodeExec'];
    }

    // 10. 잡담 — 인사·감사·확인 응답만 좁게 잡는다. 짧고 기술 어휘가 없는 발화.
    //     여기서 걸러내지 않으면 "안녕"에도 문서 검색이 돌아 헛수고가 된다.
    if (/^[\s]*(안녕|하이|헬로|반가|고마|감사|수고|잘\s*했|좋아|알겠|ok|okay|hi|hello|thanks|thank you|bye)/i.test(lower.trim())
      && lower.trim().length <= 20) {
      return defaultSkill;
    }

    // 11. 분류 실패 → DocLookup.
    //   표지("뭐야/어떻게/방법") 없는 문서 질문이 여기로 떨어진다. General은 toolGroups:[] + skipCore:true라
    //   도구도 안내도 없어, 모델이 사전지식으로 지어낸다.
    //   실수 비용이 비대칭이다: 잡담이 문서로 새면 헛조회 한 번, 문서 질문이 General로 가면 환각.
    //   실행·조회 의도가 문장에 드러나지 않은 질문은 설명 요구로 보는 것이 이 제품에서 맞다.
    return skills['DocLookup'];
  }

  return { register: register, get: get, classify: classify };
}

module.exports = { createRegistry, containsKeyword };
