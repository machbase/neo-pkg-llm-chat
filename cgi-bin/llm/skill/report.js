module.exports = function () {
  return {
    name: 'Report',
    description: 'HTML 분석 리포트 생성',
    workflows: ['HTMLReportWorkflow'],
    toolGroups: ['report_tools'],
    skipCore: false,
    guards: ['report_omission'],
    hint: 'save_html_report(template_id, table)를 바로 호출하세요. 컬럼/태그를 직접 조회하지 마세요 — 도구가 내부에서 자동 처리합니다. time_start·time_end는 사용자가 기간을 명시할 때만 전달(예: "최근 1시간"); 기간 언급이 없으면 넣지 마세요(전체 데이터, 임의 기간 추측 금지).',
    // execute_sql_query/list_* 제외: 모델이 리포트 전에 직접 조회(잘못된 컬럼명 추측 등)하다 헛스텝 나는 것 차단.
    // save_html_report가 시간범위·컬럼·태그·통계를 전부 내부 처리하므로 사전 조회 불필요.
    //
    // ※ forecast_table은 넣지 않는다. "예측 리포트 만들어줘"는 여기로 분류되며(skill.js 2단계)
    //   그 결과는 **일반 분석 리포트**다. 예측 리포트는 **"예측해줘"(순수 예측 요청)** 경로에서만 만든다.
    //   이 목록은 guard/report_omission.js의 REPORT_TOOLS와 짝을 이룬다 — 한쪽만 늘리면 가드가
    //   완성된 리포트를 미완성으로 보고 재촉한다.
    allowTools: [
      'save_html_report',
    ],
  };
};
