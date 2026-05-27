module.exports = function () {
  return {
    name: 'Timer',
    description: '타이머/스케줄러 생성·관리',
    workflows: ['TimerWorkflow'],
    toolGroups: ['timer_tools'],
    skipCore: false,
    guards: [],
    hint: '',
    allowTools: [
      'list_timers', 'add_timer', 'start_timer', 'stop_timer', 'delete_timer',
      'execute_sql_query', 'save_tql_file', 'create_folder', 'delete_file',
      'list_available_documents', 'get_full_document_content',
    ],
  };
};
