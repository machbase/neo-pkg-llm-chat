module.exports = function () {
  return {
    name: 'BasicAnalysis',
    description: '기본 분석 (table-based 차트 대시보드)',
    workflows: ['BasicWorkflow'],
    toolGroups: ['dashboard_tools'], // 대시보드에는 예측 금지 — 예측은 "<테이블> 예측해줘" 전용
    skipCore: false,
    hint: '기본 분석 요청입니다. 기본 분석(table-based 차트) 절차를 따르세요. ' +
      'TQL 파일/템플릿/create_folder를 절대 사용하지 마세요. ' +
      '★ describe_table 한 번으로 테이블 구조·태그·통계·시간 범위를 모두 확인한 뒤, 그 프로파일을 보고 데이터 특성에 맞는 차트 타입을 선택하세요.{time}' +
      ' ★ 마지막에 반드시 preview_dashboard를 호출하고, 반환된 URL을 최종 답변에 포함하세요!',
    timeHint: 'describe',
    allowTools: [
      'list_tables', 'list_table_tags', 'describe_table', 'execute_sql_query',
      'create_dashboard_with_charts', 'preview_dashboard',
      'list_available_documents', 'get_full_document_content',
    ],
  };
};
