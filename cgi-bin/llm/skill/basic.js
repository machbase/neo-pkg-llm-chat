module.exports = function () {
  return {
    name: 'BasicAnalysis',
    description: '기본 분석 (table-based 차트 대시보드)',
    workflows: ['BasicWorkflow'],
    toolGroups: ['dashboard_tools', 'forecast_tools'],
    skipCore: false,
    hint: '기본 분석(table-based 차트) 절차를 따르세요. 예측 차트가 필요하면 forecast_table(filename 지정)로 .tql을 만들어 대시보드 charts의 tql_path로 넣으세요.',
    allowTools: [
      'list_tables', 'list_table_tags', 'describe_table', 'execute_sql_query',
      'create_dashboard_with_charts', 'preview_dashboard', 'forecast_table',
      'list_available_documents', 'get_full_document_content',
    ],
  };
};
