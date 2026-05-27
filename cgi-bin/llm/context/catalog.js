function formatCatalog(catalogText) {
  if (!catalogText) return '';
  return '\n## 문서 카탈로그 (경로 | 제목 | 키워드)\n' +
    '아래 목록에서 키워드로 검색하여 경로를 찾으세요. list_available_documents 호출 불필요!\n\n' +
    catalogText;
}

module.exports = { formatCatalog };
