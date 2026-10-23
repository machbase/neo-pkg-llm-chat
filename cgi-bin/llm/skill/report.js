module.exports = function () {
  return {
    name: 'Report',
    description: 'HTML 분석 리포트 생성',
    workflows: ['HTMLReportWorkflow'],
    toolGroups: ['report_tools'],
    skipCore: false,
    hint: 'HTML 분석 리포트 요청입니다. 사전 쿼리 없이 save_html_report(template_id, table)를 바로 호출하세요. 오직 save_html_report만 사용하세요. ' +
      '컬럼/태그를 직접 조회하지 마세요 — 도구가 내부에서 자동 처리합니다. 리포트 생성 후 URL을 최종 답변에 포함하세요!{time}',
    timeHint: 'tool',
    // execute_sql_query/list_* 제외 — save_html_report가 내부 처리 · 사전 조회 헛스텝(컬럼명 추측) 방지
    // · forecast_table 제외 — 예측 리포트는 순수 예측("예측해줘") 경로 전용
    // · guard/report_omission.js REPORT_TOOLS와 짝 — 한쪽만 늘리면 완성 리포트를 미완성으로 재촉
    allowTools: [
      'save_html_report',
    ],
  };
};
