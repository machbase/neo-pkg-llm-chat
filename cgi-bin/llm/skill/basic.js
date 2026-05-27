module.exports = function () {
  return {
    name: 'BasicAnalysis',
    description: '기본 분석 (table-based 차트 대시보드)',
    workflows: ['BasicWorkflow'],
    toolGroups: ['dashboard_tools'],
    skipCore: false,
    guards: [],
    hint: '기본 분석(table-based 차트) 절차를 따르세요.',
    allowTools: [
      'list_tables', 'list_table_tags', 'execute_sql_query',
      'create_dashboard_with_charts', 'preview_dashboard',
      'list_available_documents', 'get_full_document_content',
    ],
  };
};
