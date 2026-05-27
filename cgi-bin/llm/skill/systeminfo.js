module.exports = function () {
  return {
    name: 'SystemInfo',
    description: '서버 상태/버전/시스템 정보 조회',
    workflows: [],
    toolGroups: [],
    skipCore: false,
    guards: [],
    hint: '반드시 get_version()을 호출하여 서버 상태, 스토리지, 설치된 패키지 정보를 확인하세요. 추가 정보가 필요하면 execute_sql_query로 V$PROPERTY, V$STORAGE, V$SESSION 등을 조회하세요.',
    allowTools: [
      'get_version', 'debug_mcp_status',
      'execute_sql_query',
    ],
  };
};
