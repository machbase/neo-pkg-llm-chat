module.exports = function () {
  return {
    name: 'Report',
    description: 'HTML 분석 리포트 생성',
    workflows: ['HTMLReportWorkflow'],
    toolGroups: ['report_tools'],
    skipCore: false,
    guards: ['report_omission'],
    hint: 'save_html_report를 바로 호출하세요.',
    allowTools: [
      'list_tables', 'list_table_tags', 'execute_sql_query',
      'save_html_report',
    ],
  };
};
