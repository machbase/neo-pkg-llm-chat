module.exports = function () {
  return {
    name: 'CodeExec',
    description: 'SQL/TQL 코드 실행, 데이터 조회, TQL 파일 저장',
    workflows: [],
    toolGroups: ['tql_spec_tools', 'forecast_tools'],
    skipCore: false,
    guards: [],
    hint: '**기본은 데이터 조회입니다. "조회/확인/보여줘/몇 건/최근/데이터 가져와" 류 요청이면 describe_table(필요 시) 후 execute_sql_query로 SELECT 결과를 표로 보여주세요. 절대 TQL/차트/대시보드를 만들지 마세요.** ' +
      '사용자가 제공한 코드가 주어지면 즉시 실행하세요. ' +
      '사용자가 명시적으로 "TQL 만들어/차트/그래프/시각화"를 요청한 경우에만, raw TQL을 직접 쓰지 말고 describe_table 후 compile_tql_from_spec으로 검증된 TQL을 생성하세요(저장이 필요하면 filename 지정). ' +
      '"이후 데이터/미래 값을 예측"해달라는 요청이면 forecast_table을 쓰세요(인라인 차트는 filename 없이, 대시보드용 .tql은 filename 지정).',
    allowTools: [
      'list_tables', 'list_table_tags', 'execute_sql_query',
      'execute_tql_script', 'save_tql_file', 'describe_table', 'compile_tql_from_spec', 'forecast_table',
    ],
  };
};