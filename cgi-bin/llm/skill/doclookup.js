module.exports = function () {
  return {
    name: 'DocLookup',
    description: '문서 검색/조회',
    workflows: ['QueryClassification'],
    toolGroups: ['doc_tools', 'tql_spec_tools'],
    skipCore: true,
    guards: [],
    hint: '문서 조회 요청입니다. search_documents(keyword)로 문서를 찾고, get_full_document_content로 읽은 후 답변하세요. 자체 지식으로 답변 금지! 단, 특정 테이블 구조/컬럼 요청 시 describe_table을 사용하세요. **특정 테이블 데이터로 실행 가능한 TQL을 알려달라는 요청이면, 문서에서 손으로 베끼지 말고 describe_table로 태그/기간 확인 후 compile_tql_from_spec(filename 없이)로 검증된 TQL을 만들어 답하세요.**',
    allowTools: [
      'search_documents', 'list_available_documents', 'get_full_document_content',
      'get_document_sections', 'extract_code_blocks',
      'list_tables', 'describe_table', 'list_table_tags', 'compile_tql_from_spec',
    ],
  };
};
