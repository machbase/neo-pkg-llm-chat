module.exports = function () {
  return {
    name: 'CodeExec',
    description: 'SQL/TQL 코드 실행, 데이터 조회, TQL 파일 저장',
    workflows: [],
    toolGroups: [],
    skipCore: false,
    guards: [],
    hint: '사용자가 제공한 코드를 실행하거나, 요청한 데이터를 SQL/TQL로 조회하세요. 코드가 주어지면 즉시 실행하세요.',
    allowTools: [
      'list_tables', 'list_table_tags', 'execute_sql_query',
      'execute_tql_script', 'save_tql_file', 'describe_table',
    ],
  };
};