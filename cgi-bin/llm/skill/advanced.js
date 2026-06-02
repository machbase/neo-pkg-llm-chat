module.exports = function () {
  return {
    name: 'AdvancedAnalysis',
    description: '고급 분석 (TQL 템플릿 기반 심층 분석)',
    workflows: ['AdvancedWorkflow'],
    toolGroups: ['tql_tools', 'dashboard_tools'],
    skipCore: false,
    hint: '고급 분석(TQL 템플릿) 절차를 따르세요.',
    allowTools: [
      'list_tables', 'describe_table', 'list_table_tags', 'execute_sql_query',
      'create_folder', 'save_tql_file', 'execute_tql_script',
      'create_dashboard_with_charts', 'preview_dashboard',
      'list_available_documents', 'get_full_document_content',
    ],
  };
};
