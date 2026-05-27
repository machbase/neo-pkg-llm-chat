module.exports = function () {
  return {
    name: 'DocLookup',
    description: '문서 검색/조회',
    workflows: ['QueryClassification'],
    toolGroups: ['doc_tools'],
    skipCore: true,
    guards: [],
    hint: '문서 조회 요청입니다. search_documents(keyword)로 문서를 찾고, get_full_document_content로 읽은 후 답변하세요. 자체 지식으로 답변 금지!',
    allowTools: [
      'search_documents', 'list_available_documents', 'get_full_document_content',
      'get_document_sections', 'extract_code_blocks',
    ],
  };
};
