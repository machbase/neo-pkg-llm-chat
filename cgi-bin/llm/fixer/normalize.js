// Parameter alias normalization - maps common LLM mistakes to correct param names

var aliasMap = {
  save_tql_file: { path: 'filename', file_path: 'filename', name: 'filename', file_name: 'filename', tql_path: 'filename', script: 'tql_content', content: 'tql_content', code: 'tql_content' },
  execute_tql_script: { script: 'tql_content', content: 'tql_content', code: 'tql_content' },
  validate_chart_tql: { script: 'tql_script', tql_content: 'tql_script', content: 'tql_script' },
  execute_sql_query: { sql: 'sql_query', query: 'sql_query' },
  list_table_tags: { table: 'table_name', name: 'table_name', table_id: 'table_name' },
  get_full_document_content: { file_path: 'file_identifier', doc_name: 'file_identifier', path: 'file_identifier', document_path: 'file_identifier', doc_path: 'file_identifier' },
  get_document_sections: { file_path: 'file_identifier', doc_name: 'file_identifier', path: 'file_identifier', document_path: 'file_identifier', doc_path: 'file_identifier' },
  extract_code_blocks: { file_path: 'file_identifier', doc_name: 'file_identifier', path: 'file_identifier', document_path: 'file_identifier', doc_path: 'file_identifier' },
  create_folder: { name: 'folder_name', path: 'folder_name' },
  delete_file: { path: 'filename', file_path: 'filename', name: 'filename', file_name: 'filename' },
  create_dashboard: { name: 'filename', file_path: 'filename', dashboard_name: 'filename' },
  create_dashboard_with_charts: { name: 'filename', file_path: 'filename', dashboard_name: 'filename' },
  add_chart_to_dashboard: { name: 'filename', file_path: 'filename', dashboard_name: 'filename', title: 'chart_title', chart_name: 'chart_title' },
  remove_chart_from_dashboard: { name: 'filename', file_path: 'filename', dashboard_name: 'filename', title: 'panel_title', chart_title: 'panel_title', chart_name: 'panel_title' },
  update_chart_in_dashboard: { name: 'filename', file_path: 'filename', dashboard_name: 'filename', title: 'panel_title', chart_title: 'panel_title' },
  preview_dashboard: { name: 'filename', file_path: 'filename', dashboard_name: 'filename' },
  delete_dashboard: { name: 'filename', file_path: 'filename', dashboard_name: 'filename' },
};

var knownParams = ['format', 'timeformat', 'timezone', 'timeout_seconds', 'limit', 'auto_start', 'schedule', 'section_filter', 'language'];

function normalizeArgs(toolName, args) {
  var mapping = aliasMap[toolName];
  if (!mapping) return;

  var keys = Object.keys(args);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (mapping[key]) {
      var canonical = mapping[key];
      if (args[canonical] === undefined || args[canonical] === '') {
        args[canonical] = args[key];
        delete args[key];
        console.println('  [fix] ' + toolName + ': ' + key + ' → ' + canonical);
      }
    }
  }
}

module.exports = { normalizeArgs };
