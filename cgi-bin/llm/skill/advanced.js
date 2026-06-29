module.exports = function () {
  return {
    name: 'AdvancedAnalysis',
    description: '고급 분석 (IR 컴파일 기반 심층 분석)',
    workflows: ['AdvancedWorkflow'],
    toolGroups: ['tql_spec_tools', 'forecast_tools', 'dashboard_tools'],
    skipCore: false,
    hint: '고급 분석: compile_tql_from_spec(IR)로 차트 TQL을 생성하는 절차를 따르세요. 예측 차트가 필요하면 forecast_table(filename 지정)로 .tql을 만들어 대시보드 charts의 tql_path로 넣으세요.',
    // save_tql_file(raw)는 의도적으로 제외 → 모델이 raw TQL로 못 새고 compile_tql_from_spec만 사용.
    // (compile_tql_from_spec는 내부적으로 save_tql_file에 위임하므로 저장은 정상 동작 — registry엔 등록돼 있음)
    allowTools: [
      'list_tables', 'describe_table', 'list_table_tags', 'execute_sql_query',
      'create_folder', 'compile_tql_from_spec', 'forecast_table',
      'create_dashboard_with_charts', 'preview_dashboard',
      'list_available_documents', 'get_full_document_content',
    ],
  };
};
