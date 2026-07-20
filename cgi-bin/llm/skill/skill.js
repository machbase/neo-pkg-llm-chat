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
  var FORECAST_ANY = ['예측', 'forecast', 'predict', 'prediction', '예상', '전망', '향후', '이후 데이터', '미래 값', 'extrapolat'];

  function classify(query) {
    var lower = query.toLowerCase();

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

    // 4. System status/version
    if (containsKeyword(lower, [
      '버전', '상태', '시스템 정보', '서버 정보', '패키지',
      'version', 'status', 'system info', 'server info',
    ])) {
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
      'how to', 'what is', 'what are', 'explain', 'usage', 'example', 'syntax', 'help me understand',
      '문서', '매뉴얼', 'manual', 'doc', 'documentation', 'reference',
    ]);
    if (!hasDocKw && containsKeyword(lower, [
      '실행', '돌려',
      'run', 'execute',
    ])) {
      return skills['CodeExec'];
    }

    // 6. DocLookup — '뭐임/뭔데/뭐냐/뭐지' 같은 구어 개념질문("tql 이 뭐임")도 잡는다.
    //    이 토큰들이 없으면 개념질문이 General로 새서 DocLookup 가드가 전부 무력화된다.
    if (containsKeyword(lower, [
      '뭐야', '뭐임', '뭔데', '뭐냐', '뭐지', '뭔가요', '란?', '이란', '사용법', '문법', '예제', '알려줘', '설명해', '어떻게',
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
    if (containsKeyword(lower, [
      '분석', '대시보드', '차트', '시각화', '추세', '트렌드', '패턴', '비교', '그래프',
      'dashboard', 'chart', 'visualize', 'visualization', 'trend', 'pattern', 'compare', 'comparison',
      'plot', 'graph', 'analyze', 'analysis',
    ])) {
      return skills['BasicAnalysis'];
    }

    // 8.5 모호한 "보여줘/show me/display" — 위에서 차트 단어가 안 걸렸으면 단순 데이터 조회(SQL 표)로.
    //  ("데이터 보여줘"=표 조회 / "차트 보여줘"=위 규칙 8에서 이미 BasicAnalysis 처리됨)
    if (containsKeyword(lower, ['보여줘', '보여 줘', 'show me', 'display'])) {
      return skills['CodeExec'];
    }

    // 9. CodeExec — 범용 조회 키워드 fallback
    if (containsKeyword(lower, [
      '조회', '확인', '최근', '최신', '태그', '몇건', '몇 건', '저장', '구조', '컬럼', '스키마',
      'schema', 'structure', 'columns', 'describe',
      'query', 'fetch', 'retrieve', 'select', 'count', 'how many',
      'latest', 'recent', 'list', 'get data', 'check', 'save',
      '데이터', 'data',
    ])) {
      return skills['CodeExec'];
    }

    return defaultSkill;
  }

  return { register: register, get: get, classify: classify };
}

module.exports = { createRegistry, containsKeyword };
