module.exports = function () {
  return {
    name: 'General',
    description: '일반 대화/인사/분류 불가 쿼리',
    workflows: ['QueryClassification'],
    toolGroups: [],
    skipCore: true,
    hint: '',
    // 삭제 계열(delete_file·delete_dashboard·remove_chart_from_dashboard) 제외 — 분류 안 된 질문(인사·잡담)에 삭제 도구를 열지 않음
    allowTools: [
      'list_tables', 'list_table_tags', 'describe_table', 'execute_sql_query',
      'compile_tql_from_spec', 'forecast_table', 'create_folder', 'list_files',
      'create_dashboard_with_charts', 'preview_dashboard', 'get_dashboard',
      'update_dashboard_time_range', 'add_chart_to_dashboard', 'update_chart_in_dashboard',
      'save_html_report', 'list_available_documents', 'search_documents',
      'get_full_document_content', 'get_document_sections', 'extract_code_blocks',
      'get_version', 'debug_mcp_status',
    ],
  };
};
