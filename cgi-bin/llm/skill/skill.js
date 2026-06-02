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

  function classify(query) {
    var lower = query.toLowerCase();

    // 1. CodeExec — 실제 코드 포함 → 무조건 CodeExec
    if (containsKeyword(query, ['SQL(', 'CHART(', 'CSV(', 'SCRIPT(', 'FAKE('])) {
      return skills['CodeExec'];
    }

    // 2. Report
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

    // 5. CodeExec — 실행 의도 확실한 키워드 (DocLookup 키워드 없을 때만)
    var hasDocKw = containsKeyword(lower, [
      '뭐야', '뭔가요', '란?', '이란', '사용법', '문법', '예제', '알려줘', '설명해', '어떻게', '방법',
      'how to', 'what is', 'what are', 'explain', 'usage', 'example', 'syntax', 'help me understand',
      '문서', '매뉴얼', 'manual', 'doc', 'documentation', 'reference',
    ]);
    if (!hasDocKw && containsKeyword(lower, [
      '실행', '돌려',
      'run', 'execute',
    ])) {
      return skills['CodeExec'];
    }

    // 6. DocLookup
    if (containsKeyword(lower, [
      '뭐야', '뭔가요', '란?', '이란', '사용법', '문법', '예제', '알려줘', '설명해', '어떻게',
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

    // 8. BasicAnalysis
    if (containsKeyword(lower, [
      '분석', '대시보드', '차트', '시각화', '추세', '트렌드', '패턴', '비교', '보여줘', '보여 줘', '그래프',
      'dashboard', 'chart', 'visualize', 'visualization', 'trend', 'pattern', 'compare', 'comparison',
      'show me', 'plot', 'graph', 'analyze', 'analysis', 'display',
    ])) {
      return skills['BasicAnalysis'];
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
