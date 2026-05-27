module.exports = function () {
  return {
    name: 'DataQuery',
    description: '시계열 데이터 조회/확인 (결과만 반환, 시각화 없음)',
    workflows: [],
    toolGroups: [],
    skipCore: false,
    guards: [],
    hint: '사용자가 요청한 데이터를 SQL로 조회하여 결과를 텍스트로 알려주세요. 대시보드나 차트를 만들지 마세요.',
    allowTools: [
      'list_tables', 'list_table_tags', 'execute_sql_query',
    ],
  };
};
