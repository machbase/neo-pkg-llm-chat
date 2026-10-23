module.exports = function () {
  return {
    name: 'AdvancedAnalysis',
    description: '고급 분석 (IR 컴파일 기반 심층 분석)',
    workflows: ['AdvancedWorkflow'],
    toolGroups: ['tql_spec_tools', 'dashboard_tools'], // 대시보드에는 예측 금지 — 예측은 "<테이블> 예측해줘" 전용
    skipCore: false,
    hint: '고급 분석 요청입니다. describe_table 한 번으로 구조·태그·통계·시간범위·ROLLUP 여부를 확인한 뒤, compile_tql_from_spec(spec, filename)으로 차트 TQL을 만들어 저장하세요 (실행검증은 도구가 합니다. 실패하면 spec만 고쳐 재호출, TQL 직접 작성 금지). ' +
      '예측 차트(forecast)는 만들지 마세요 — 실측 데이터 차트만.{time}' +
      ' ★ 마지막에 반드시 preview_dashboard를 호출하고, 반환된 URL을 최종 답변에 포함하세요!',
    timeHint: 'describe',
    allowTools: [
      'list_tables', 'describe_table', 'list_table_tags', 'execute_sql_query',
      'create_folder', 'compile_tql_from_spec',
      'create_dashboard_with_charts', 'preview_dashboard',
      'list_available_documents', 'get_full_document_content',
    ],
  };
};
