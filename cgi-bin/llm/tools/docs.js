var process = require('process'); // jsh에선 process가 전역이 아님 → 명시적 require (findNeoDir의 process.cwd()용)
var { argStr } = require('./registry');
var fs = require('fs');
var path = require('path');

function register(registry, mc) {
  registry.register({
    name: 'list_available_documents',
    description: 'List all available documentation files in Machbase Neo.',
    parameters: { type: 'object', properties: {} },
    fn: function (args, cb) {
      try {
        var neoDir = findNeoDir();
        if (!neoDir) return cb(null, 'Error: neo documentation directory not found');
        // Use pre-built catalog.md if available (scanDocs can cause Go panic in JSH)
        var catalogPath = path.join(neoDir, 'catalog.md');
        if (fs.existsSync(catalogPath)) {
          return cb(null, fs.readFileSync(catalogPath, 'utf8'));
        }
        cb(null, scanDocs(neoDir));
      } catch (e) { cb(null, 'Error: documentation catalog unavailable'); } // e.message는 서버 절대경로 누출
    },
  });

  registry.register({
    name: 'search_documents',
    description: 'Search documentation catalog. keyword accepts one or more terms (Korean or English, space-separated). Returns ranked document paths, plus matching section titles you can pass directly as section= to get_full_document_content. Use this BEFORE get_full_document_content.',
    parameters: {
      type: 'object',
      properties: { keyword: { type: 'string', description: 'Search term(s), e.g. "PIVOT", "rollup 삭제", "retention policy"' } },
      required: ['keyword'],
    },
    fn: function (args, cb) {
      var keyword = argStr(args, 'keyword', '').trim();
      if (!keyword) return cb(null, 'Error: keyword is required');
      try {
        var neoDir = findNeoDir();
        if (!neoDir) return cb(null, 'Error: neo documentation directory not found');
        var catalogPath = path.join(neoDir, 'catalog.md');
        if (!fs.existsSync(catalogPath)) return cb(null, 'Error: catalog.md not found');
        var rows = parseCatalogRows(fs.readFileSync(catalogPath, 'utf8'));
        var phrase = keyword.toLowerCase();
        var tokens = tokenize(keyword);
        var scored = [];
        for (var i = 0; i < rows.length; i++) {
          var sc = scoreRow(rows[i], phrase, tokens);
          if (sc > 0) scored.push({ r: rows[i], sc: sc });
        }
        scored.sort(function (a, b) { return b.sc - a.sc; });
        if (scored.length === 0) {
          // 카탈로그 전체 덤프 금지(카탈로그는 시스템 프롬프트에 이미 있음 → 순수 중복 + 컨텍스트 밀어냄).
          // 대신 바이그램 근사 후보 top-8만 반환해 재시도를 유도.
          var near = nearestRows(rows, phrase);
          var msg = 'No match for: ' + keyword + '\n키워드를 바꿔 다시 검색하세요(영어 용어 권장).';
          if (near.length) {
            msg += ' 비슷한 문서 후보:\n';
            for (var n = 0; n < near.length; n++) msg += '- ' + near[n].path + ' (' + near[n].title + ')\n';
          }
          return cb(null, msg.trim());
        }
        var top = [];
        for (var j = 0; j < scored.length && j < 12; j++) top.push(scored[j].r);
        var out = 'Found ' + scored.length + ' document(s)' + (scored.length > top.length ? ' (top ' + top.length + ')' : '') + ':\n';
        for (var k = 0; k < top.length; k++) {
          out += '- ' + top[k].path + ' (' + top[k].title + ') [' + top[k].keywords + ']\n';
        }
        out += sectionHints(neoDir, top, tokens);
        // 접전(top-1과 CLOSE_MARGIN 이내) 문서가 2개 이상이면 winner-take-all 폴백: 각 접전 문서의 관련 섹션을 인라인.
        // 검색은 문서 1개만 읽는 구조라 1위가 틀리면 폴백이 없음 → 정답이 2·3위에 있어도 못 봄(예: DBMS machadmin vs machbase-neo restore).
        var CLOSE_MARGIN = 4, CLOSE_MAX = 3;
        var b0 = baseScoreRow(scored[0].r, tokens); // 1위의 base 점수(보너스 제외) 기준
        var close = [];
        for (var c = 0; c < scored.length && close.length < CLOSE_MAX; c++) if (baseScoreRow(scored[c].r, tokens) >= b0 - CLOSE_MARGIN) close.push(scored[c].r);
        if (close.length >= 2) {
          out += '\n⚠ 상위 ' + close.length + '개 문서 점수 접전 — 정답이 1위가 아닌 문서에 있을 수 있어, 각 문서의 관련 섹션을 아래 첨부합니다(질문에 맞는 것을 고르세요):\n';
          for (var cc = 0; cc < close.length; cc++) {
            var ex = topSectionExcerpt(neoDir, close[cc].path, tokens, 1200);
            if (ex) out += '\n───── ' + close[cc].path + ' ─────\n' + ex + '\n';
          }
        }
        cb(null, out.trim());
      } catch (e) { cb(null, 'Error: documentation catalog unavailable'); } // e.message는 서버 절대경로 누출
    },
  });

  registry.register({
    name: 'get_full_document_content',
    description: 'Get documentation content. Pass file_identifier (catalog path). Optionally pass section=<keyword in English> (e.g. "ADD COLUMN", "RETENTION", "2049") — returns that section in full; if it only appears in body text (or the doc has no headers, e.g. the error-code table), returns a match-centered excerpt instead. Without section, a large doc returns its section list so you can pick one.',
    parameters: {
      type: 'object',
      properties: {
        file_identifier: { type: 'string', description: 'Document path from catalog (copy verbatim)' },
        section: { type: 'string', description: 'Optional. A section header keyword OR an in-document search term (error code, function name). Use the question\'s specific operation phrase in English (e.g. "ADD COLUMN"). If omitted, large docs return a section list.' },
      },
      required: ['file_identifier'],
    },
    fn: function (args, cb) {
      var filePath = cleanFilePath(argStr(args, 'file_identifier', ''));
      if (!filePath) return cb(null, 'Error: file_identifier is required');
      var kw = argStr(args, 'section', '').trim().toLowerCase();
      try {
        var neoDir = findNeoDir();
        if (!neoDir) return cb(null, 'Error: neo documentation directory not found');
        filePath = resolveDocPath(neoDir, filePath);
        var content = fs.readFileSync(path.join(neoDir, filePath), 'utf8');
        var sections = parseSections(content);

        // 구조 없는 문서(헤더 0~1개): 섹션 타겟팅 무력(에러코드 48KB 표 등) → section=을 본문 검색어로 사용.
        if (sections.length <= 1) {
          if (kw) {
            var ex = excerptAround(content, kw);
            if (ex) return cb(null, '"' + kw + '" 매치 발췌:\n\n' + ex);
            return cb(null, '"' + kw + '"가 이 문서에 없습니다. 다른 키워드(에러코드 숫자, 영어 용어)로 section=을 바꿔 다시 호출하세요.\n\n문서 앞부분:\n' + content.substring(0, 2000));
          }
          if (content.length > TOTAL_CAP) {
            return cb(null, '이 문서는 큽니다(' + content.length + '자, 섹션 구분 없음). section=<찾는 키워드(에러코드/용어, 영어)>를 넣어 다시 호출하면 해당 부분을 발췌합니다.\n\n문서 앞부분:\n' + content.substring(0, 3000));
          }
          return cb(null, content);
        }

        // Section requested → 제목 랭킹(h1-3 + h4~h6 통합 풀) → 본문 매치 중심 발췌 → 섹션 인덱스.
        // 통합 이유: h1-3를 먼저 단락하면 약한 substring 매치(예: 'arrange()'가 'range()' 포함)가
        // h4의 정확 일치('#### range()')를 가려 엉뚱한 섹션이 반환됨 — 랭크가 좋은 쪽이 이겨야 함.
        if (kw) {
          var pool = [];
          for (var i = 0; i < sections.length; i++) {
            var sc = matchScore(sections[i].title, kw);
            if (sc < 99) {
              var wd = withDescendants(sections, i); // 하위 섹션 동봉(개념 섹션이 인트로 몇 줄뿐인 문제 해소)
              pool.push({ title: sections[i].title, content: wd.content, used: sections[i].title, kids: wd.childTitles, sc: sc, tlen: sections[i].title.length });
            }
          }
          var subs = parseSubsections(sections);
          for (var h = 0; h < subs.length; h++) {
            var hsc = matchScore(subs[h].title, kw);
            if (hsc < 99) pool.push({ title: subs[h].parent + ' › ' + subs[h].title, content: subs[h].content, used: subs[h].parent, sc: hsc, tlen: subs[h].title.length });
          }
          if (pool.length) {
            pool.sort(function (a, b) { return a.sc - b.sc || a.tlen - b.tlen; });
            var top = [];
            for (var j = 0; j < pool.length && j < 4; j++) top.push(pool[j]);
            var used = [];
            for (var u = 0; u < top.length; u++) {
              if (used.indexOf(top[u].used) < 0) used.push(top[u].used);
              var _kids = top[u].kids || [];
              for (var w = 0; w < _kids.length; w++) if (used.indexOf(_kids[w]) < 0) used.push(_kids[w]);
            }
            // No file path in the result — weak models echo it back as a doc link (forbidden).
            // command-line.md(CLI 레퍼런스, 24KB)는 약한 모델이 섹션을 과잉탐색·반복조회하다 강제답변 garbage/빈내용으로
            // degenerate하기 쉽다. otherSectionsFooter(다른 섹션 나열)가 그 유혹을 키우므로, 이 문서에선 "여기서 답하고
            // 그만 읽어라" 넛지로 대체. serve 섹션 하나에 서버 시작 명령 + 모든 실행 플래그(--host/--data 등)가 다 있음.
            var _clFooter = /command-line/.test(String(filePath))
              ? '\n\n(command-line.md는 CLI 레퍼런스입니다. 위 섹션이 질문의 명령어·플래그를 담고 있으면 더 읽지 말고 여기서 바로 답하세요. 서버 시작 명령과 모든 실행 플래그(--host·--data·--config·--pid 등)는 machbase-neo serve 섹션에 모여 있습니다. 같은/다른 섹션을 추가로 조회하지 마세요.)'
              : otherSectionsFooter(sections, used);
            return cb(null, emitSections(top, null, top.length > 1 ? 8000 : TOTAL_CAP) + _clFooter);
          }
          // 본문 스캔: 매치 위치 중심 발췌(앞부분 캡 방식은 섹션 뒤쪽 매치가 통째로 잘린다).
          for (var k = 0; k < sections.length; k++) {
            if (sections[k].content.toLowerCase().indexOf(kw) >= 0) {
              var body = excerptAround(sections[k].content, kw) || capSection(sections[k].content);
              return cb(null, 'No header matched "' + kw + '"; excerpt around the match:\n\n## ' + sections[k].title + '\n' + body + otherSectionsFooter(sections, [sections[k].title]));
            }
          }
          return cb(null, sectionIndex(filePath, sections, 'Section "' + kw + '" not found.'));
        }

        // No section → small doc returns whole; large doc returns the section index (no body hidden).
        var full = '';
        for (var m = 0; m < sections.length; m++) full += '## ' + sections[m].title + '\n' + sections[m].content + '\n\n';
        // 전체 문서라도 주요 섹션 목록을 명시적으로 덧붙임 — 약한 모델이 "정의 한 줄"로 끝내지 않고
        // 문서의 여러 주제를 답변에 반영하도록 체크리스트 역할(개념질문 답변 폭 확보).
        if (full.length <= TOTAL_CAP) return cb(null, full.trim() + mainTopicsFooter(sections));
        return cb(null, sectionIndex(filePath, sections, '이 문서는 큽니다(' + content.length + '자).'));
      } catch (e) { cb(null, 'Error: File not found: ' + filePath); }
    },
  });

  registry.register({
    name: 'get_document_sections',
    description: 'Get document content organized by sections (headers).',
    parameters: {
      type: 'object',
      properties: {
        file_identifier: { type: 'string' },
        section_filter: { type: 'string', description: 'Optional keyword to filter sections' },
      },
      required: ['file_identifier'],
    },
    fn: function (args, cb) {
      var filePath = cleanFilePath(argStr(args, 'file_identifier', ''));
      var filter = argStr(args, 'section_filter', '').toLowerCase();
      if (!filePath) return cb(null, 'Error: file_identifier is required');
      try {
        var neoDir = findNeoDir();
        if (!neoDir) return cb(null, 'Error: neo documentation directory not found');
        filePath = resolveDocPath(neoDir, filePath);
        var content = fs.readFileSync(path.join(neoDir, filePath), 'utf8');
        var sections = parseSections(content);
        if (filter) sections = sections.filter(function (s) { return s.title.toLowerCase().indexOf(filter) >= 0; });
        var out = '', shown = 0;
        for (var i = 0; i < sections.length; i++) {
          var chunk = '## ' + sections[i].title + '\n' + sections[i].content.substring(0, 2000) + '\n\n';
          // 총량 캡 — 캡 없던 시절 configuration-property.md가 39KB를 반환해 컨텍스트를 밀어냈음
          if (out.length + chunk.length > TOTAL_CAP && shown > 0) {
            out += '... (' + (sections.length - shown) + '개 섹션 생략; section_filter로 좁혀 다시 호출하세요)\n';
            break;
          }
          out += chunk; shown++;
        }
        cb(null, out.trim() || 'No sections found.');
      } catch (e) { cb(null, 'Error: File not found: ' + filePath); } // e.message는 서버 절대경로 누출
    },
  });

  registry.register({
    name: 'extract_code_blocks',
    description: 'Extract code blocks from a documentation file.',
    parameters: {
      type: 'object',
      properties: {
        file_identifier: { type: 'string' },
        language: { type: 'string', description: 'Optional language filter (e.g., "sql", "tql")' },
      },
      required: ['file_identifier'],
    },
    fn: function (args, cb) {
      var filePath = cleanFilePath(argStr(args, 'file_identifier', ''));
      var lang = argStr(args, 'language', '').toLowerCase();
      if (!filePath) return cb(null, 'Error: file_identifier is required');
      try {
        var neoDir = findNeoDir();
        if (!neoDir) return cb(null, 'Error: neo documentation directory not found');
        filePath = resolveDocPath(neoDir, filePath);
        var content = fs.readFileSync(path.join(neoDir, filePath), 'utf8');
        var blocks = extractBlocks(content, lang);
        var note = '';
        // 언어 필터 미스 → 전체 블록 폴백. 문서 태깅이 제각각이라(TQL 예제가 ```js로 태깅된 tql-guide 등)
        // 필터 전멸이 "예제 없음" 거짓 결론으로 이어진다. 빈 결과보다 전체가 낫다.
        if (blocks.length === 0 && lang) {
          blocks = extractBlocks(content, '');
          if (blocks.length) note = '("' + lang + '" 태그 블록이 없어 이 문서의 전체 코드블록을 반환합니다)\n\n';
        }
        if (blocks.length === 0) return cb(null, 'No code blocks found.');
        var out = note;
        for (var i = 0; i < blocks.length; i++) {
          var piece = '```' + blocks[i].lang + '\n' + blocks[i].code + '\n```\n\n';
          if (out.length + piece.length > TOTAL_CAP && out) {
            out += '... (' + (blocks.length - i) + '개 코드블록 생략; language 필터로 좁히세요)\n';
            break;
          }
          out += piece;
        }
        cb(null, out.trim());
      } catch (e) { cb(null, 'Error: File not found: ' + filePath); } // e.message는 서버 절대경로 누출
    },
  });
}

function cleanFilePath(raw) {
  var p = String(raw || '').replace(/\\/g, '/').replace(/^neo\//, '');
  // Reject path traversal and absolute paths so '../configs/sys.json', '../config/config.js'
  // (machbase password + API keys) can never be read through the doc tools.
  if (p.indexOf('..') >= 0) return '';
  if (p.charAt(0) === '/') return '';
  if (/^[A-Za-z]:/.test(p)) return ''; // Windows drive-letter absolute path
  return p;
}

// If the exact path is wrong (e.g. the LLM guessed 'sql/sql-reference/sql-reference-ddl.md'
// instead of 'dbms/sql-reference/sql-reference-ddl.md'), fall back to matching the file BASENAME
// against catalog.md and return the correct catalog path. Stays within neoDir (catalog paths are
// trusted relative paths), so no traversal risk.
function resolveDocPath(neoDir, filePath) {
  try { if (fs.statSync(path.join(neoDir, filePath)).isFile()) return filePath; } catch (e) {}
  var base = String(filePath).replace(/\\/g, '/').split('/').pop();
  if (!base) return filePath;
  try {
    var catalog = fs.readFileSync(path.join(neoDir, 'catalog.md'), 'utf8').split('\n');
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].indexOf('|') < 0) continue;
      var p = (catalog[i].split('|')[1] || '').trim();
      if (p && p.split('/').pop() === base) return p;
    }
  } catch (e) {}
  return filePath; // no match — return original (caller will report not found)
}



function findNeoDir() {
  var cwd = process.cwd();
  var candidates = [path.join(cwd, 'neo'), path.join(cwd, '..', 'neo'), 'neo'];
  for (var i = 0; i < candidates.length; i++) {
    try { if (fs.statSync(candidates[i]).isDirectory()) return candidates[i]; } catch (e) { /* continue */ }
  }
  return null;
}

function scanDocs(baseDir, relParts) {
  var out = '';
  if (!relParts) relParts = [];
  try {
    var dirArgs = [baseDir].concat(relParts);
    var dirPath = path.join.apply(path, dirArgs);
    var entries = fs.readdirSync(dirPath);
    for (var i = 0; i < entries.length; i++) {
      var childParts = relParts.concat([entries[i]]);
      var fullArgs = [baseDir].concat(childParts);
      var full = path.join.apply(path, fullArgs);
      try {
        if (fs.statSync(full).isDirectory()) out += scanDocs(baseDir, childParts);
        else if (entries[i].endsWith('.md')) out += childParts.join('/') + '\n';
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* skip */ }
  return out;
}

// --- search_documents helpers ---

// catalog.md 표를 {path,title,keywords} 행 배열로 파싱
function parseCatalogRows(text) {
  var lines = text.split('\n');
  var rows = [];
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('|') < 0 || lines[i].indexOf('---') >= 0) continue;
    var cols = lines[i].split('|');
    if (cols.length < 4) continue;
    var p = cols[1].trim();
    if (!p || p.indexOf('.md') < 0) continue;
    rows.push({ path: p, title: cols[2].trim(), keywords: cols[3].trim() });
  }
  return rows;
}

// 검색 불용어 — 질문 보일러플레이트(모든 질문에 붙어 랭킹을 오염). 조사가 붙은 변형도 startsWith로 흡수.
// ('방법/데이터 임포트 방법' 같은 제너릭 문서가 '방법' 하나로 상위 오염되던 문제 차단.) 내용어(입력/삭제/포트 등)는 유지.
var SEARCH_STOP = {
  '방법': 1, '알려줘': 1, '알려': 1, '해줘': 1, '하는': 1, '하기': 1, '하고': 1, '어떻게': 1, '방식': 1,
  '사용': 1, '사용법': 1, '관련': 1, '있는': 1, '싶어': 1, '싶은': 1, '주세요': 1, '무엇': 1, '무엇으로': 1,
  '어떤': 1, '이거': 1, '이것': 1, '그거': 1, '좀': 1, '해': 1, '되는': 1, '위한': 1, '대한': 1,
  'how': 1, 'to': 1, 'the': 1, 'using': 1, 'use': 1, 'want': 1, 'please': 1, 'show': 1, 'method': 1,
  'way': 1, 'what': 1, 'is': 1, 'are': 1, 'of': 1, 'for': 1, 'with': 1, 'and': 1, 'do': 1, 'does': 1,
};
// 조사만 정확히 매칭(사용→사용자 같은 내용어 오컷 방지 — 접미가 '자/량' 등이면 조사 아님)
var JOSA = /^(을|를|은|는|이|가|도|의|에|와|과|로|으로|만|에서|에게|까지|부터)$/;
function isStop(t) {
  if (SEARCH_STOP[t]) return true;
  // 한글 불용어 + 조사(방법을/방법은/알려줘를) → 컷. 조사가 아닌 접미(사용자·사용량)는 유지.
  for (var s in SEARCH_STOP) {
    if (!SEARCH_STOP.hasOwnProperty(s)) continue;
    if (s.length >= 2 && /[가-힣]/.test(s) && t.indexOf(s) === 0 && t.length > s.length) {
      if (JOSA.test(t.substring(s.length))) return true;
    }
  }
  return false;
}

// 동사 어미 제거(라이트 스테밍) — 질문은 "수정하는/지정하여", 키워드는 "수정/지정"이라 안 맞던 문제.
// 하-기반 2글자+ 어미와 '해서'만(내용어가 이 어미로 끝나는 경우 거의 없어 안전). '해/한/는' 단독은 오컷 위험이라 제외.
var VERB_END = /(하는지|하는데|하는|하기|하고|하여|하며|하면|해서)$/;

// 검색어 토큰화: 공백/구분자 분리, 소문자. 1글자 라틴 제외(한글 1글자 유지), 어미 스테밍, 불용어 제외.
function tokenize(keyword) {
  var parts = String(keyword).toLowerCase().split(/[\s,;|/·]+/);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var t = parts[i].trim();
    if (!t) continue;
    var stem = t.replace(VERB_END, '');
    if (stem.length >= 2) t = stem; // 어미 떼고도 2글자↑면 스테밍 적용(과도축약 방지)
    if (!(t.length >= 2 || /[가-힣]/.test(t))) continue;
    if (isStop(t)) continue;
    out.push(t);
  }
  return out;
}

// base 점수: 토큰별 필드매칭 합만(보너스 제외) — "문서들이 얼마나 비슷한가"(접전 판정)용. 랭킹은 scoreRow(보너스 포함) 사용.
// all-hit/구문 보너스는 1위를 튀게 해 접전 판정을 왜곡하므로(검색어에 따라 격차가 4→6 출렁) 접전엔 base를 쓴다.
function baseScoreRow(row, tokens) {
  var title = row.title.toLowerCase(), kws = row.keywords.toLowerCase(), p = row.path.toLowerCase(), s = 0;
  for (var i = 0; i < tokens.length; i++) { var t = tokens[i]; if (title.indexOf(t) >= 0) s += 3; else if (kws.indexOf(t) >= 0) s += 2; else if (p.indexOf(t) >= 0) s += 2; }
  return s;
}

// 행 점수: 토큰별 최고 필드 점수(제목3/키워드2/경로2) 합 + 전 토큰 적중/구문 일치 보너스. 0 = 미적중.
function scoreRow(row, phrase, tokens) {
  var title = row.title.toLowerCase(), kws = row.keywords.toLowerCase(), p = row.path.toLowerCase();
  var score = 0, hits = 0;
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i], s = 0;
    if (title.indexOf(t) >= 0) s = 3;
    else if (kws.indexOf(t) >= 0) s = 2;
    else if (p.indexOf(t) >= 0) s = 2;
    if (s > 0) { score += s; hits++; }
  }
  if (hits === 0) return 0;
  if (hits === tokens.length && tokens.length > 1) score += 2;
  if (tokens.length > 1 && (title.indexOf(phrase) >= 0 || kws.indexOf(phrase) >= 0)) score += 3;
  return score;
}

// 검색어 바이그램이 행 텍스트에 얼마나 포함되는지(0~1) — 미스 시 근사 후보 랭킹용
function bigramContainment(needle, hay) {
  var n = 0, hit = 0, seen = {};
  for (var i = 0; i < needle.length - 1; i++) {
    var b = needle.substring(i, i + 2);
    if (seen[b]) continue;
    seen[b] = true; n++;
    if (hay.indexOf(b) >= 0) hit++;
  }
  return n ? hit / n : 0;
}

function nearestRows(rows, phrase) {
  var scored = [];
  for (var i = 0; i < rows.length; i++) {
    var hay = (rows[i].title + ' ' + rows[i].keywords + ' ' + rows[i].path).toLowerCase();
    var sim = bigramContainment(phrase, hay);
    if (sim > 0.3) scored.push({ r: rows[i], sim: sim });
  }
  scored.sort(function (a, b) { return b.sim - a.sim; });
  var out = [];
  for (var j = 0; j < scored.length && j < 8; j++) out.push(scored[j].r);
  return out;
}

// 상위 매치 문서(최대 2개)의 섹션/하위 제목 중 토큰과 맞는 것 → section= 재호출 힌트(왕복 절약)
function sectionHints(neoDir, topRows, tokens) {
  var out = '';
  for (var i = 0; i < topRows.length && i < 2; i++) {
    var titles = [];
    try {
      var content = fs.readFileSync(path.join(neoDir, topRows[i].path), 'utf8');
      var secs = parseSections(content);
      var all = secs.concat(parseSubsections(secs));
      for (var j = 0; j < all.length && titles.length < 5; j++) {
        var tl = all[j].title.toLowerCase();
        for (var t = 0; t < tokens.length; t++) {
          if (tl.indexOf(tokens[t]) >= 0) { titles.push(all[j].title); break; }
        }
      }
    } catch (e) { /* 파일 못 읽으면 힌트 생략 */ }
    if (titles.length) out += '- ' + topRows[i].path + ' → section= ' + titles.join(' | ') + '\n';
  }
  return out ? '\n섹션 힌트(get_full_document_content의 section=으로 바로 사용):\n' + out : '';
}

// 접전(점수 근접) 문서에서 토큰과 가장 많이 겹치는 섹션(+하위)을 캡 길이로 발췌 — winner-take-all 폴백용.
// 검색이 1개 문서만 읽는 구조라 1위가 틀리면 폴백이 없음 → 접전 문서의 정답 섹션을 결과에 직접 인라인해 모델이 보게 함.
function topSectionExcerpt(neoDir, docPath, tokens, cap) {
  try {
    var content = fs.readFileSync(path.join(neoDir, docPath), 'utf8');
    var sections = parseSections(content);
    if (sections.length <= 1) return content.substring(0, cap).trim();
    // 제목 매칭에 가중(×3) — 장황한 Introduction(본문에 토큰 많음)보다 명령/주제 섹션(제목이 토큰과 일치)을 우선.
    var bestIdx = -1, bestScore = -1;
    for (var i = 0; i < sections.length; i++) {
      var tl = sections[i].title.toLowerCase(), cl = sections[i].content.toLowerCase(), sc = 0;
      for (var t = 0; t < tokens.length; t++) { if (tl.indexOf(tokens[t]) >= 0) sc += 3; else if (cl.indexOf(tokens[t]) >= 0) sc += 1; }
      if (sc > bestScore) { bestScore = sc; bestIdx = i; }
    }
    // 토큰이 어떤 섹션과도 안 맞음(점수 0) — 흔히 한국어 질문 토큰 vs 영어 섹션 제목(셸≠shell). 엉뚱한 인트로 대신
    // 섹션 제목 목록을 인라인 → 모델이 영어 섹션명(machbase-neo shell 등)을 보고 맞는 섹션을 인지/선택하게.
    if (bestScore <= 0) {
      var titles = [];
      for (var s = 0; s < sections.length && titles.length < 15; s++) if (sections[s].title) titles.push(sections[s].title);
      return '(이 문서의 섹션 목록 — 질문에 맞는 것을 section= 으로 조회): ' + titles.join(' | ');
    }
    if (bestIdx < 0) return content.substring(0, cap).trim();
    var wd = withDescendants(sections, bestIdx);
    return ('## ' + sections[bestIdx].title + '\n' + wd.content).substring(0, cap).trim();
  } catch (e) { return ''; }
}

function parseSections(content) {
  var lines = content.split('\n');
  var sections = [];
  var current = null;
  var inFence = false; // track ``` code blocks so '## ...' inside a SQL example isn't a fake section
  for (var i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) inFence = !inFence;
    if (!inFence && lines[i].match(/^#{1,3}\s/)) {
      if (current) sections.push(current);
      current = { title: lines[i].replace(/^#+\s*/, ''), content: '', level: lines[i].match(/^#+/)[0].length };
    } else if (current) { current.content += lines[i] + '\n'; }
  }
  if (current) sections.push(current);
  return sections;
}

// 제목 매칭된 섹션에 하위 섹션(더 깊은 레벨의 후속 h1-3)을 동봉 — "TQL Concepts"(h2)를 조회하면
// SRC/SINK/MAP Functions(h3) 내용이 함께 오도록. parseSections가 h1-3를 평탄화해 부모-자식이 끊긴 것을 복원.
// 반환: { content: 본문+자식들, childTitles: [자식 제목...] } (자식 제목은 footer 중복 방지용)
function withDescendants(sections, idx) {
  var out = sections[idx].content;
  var childTitles = [];
  var lvl = sections[idx].level || 3;
  for (var j = idx + 1; j < sections.length; j++) {
    if ((sections[j].level || 3) <= lvl) break;
    out += '\n### ' + sections[j].title + '\n' + sections[j].content;
    childTitles.push(sections[j].title);
  }
  return { content: out, childTitles: childTitles };
}

// h4~h6 하위 제목을 평탄화 — ddl.md의 #### 개별 옵션 등 깊은 항목을 section=으로 직접 주소화하기 위함
function parseSubsections(sections) {
  var subs = [];
  for (var i = 0; i < sections.length; i++) {
    var lines = sections[i].content.split('\n');
    var cur = null, inFence = false;
    for (var j = 0; j < lines.length; j++) {
      if (/^```/.test(lines[j])) inFence = !inFence;
      if (!inFence && /^#{4,6}\s/.test(lines[j])) {
        if (cur) subs.push(cur);
        cur = { title: lines[j].replace(/^#+\s*/, ''), parent: sections[i].title, content: '' };
      } else if (cur) { cur.content += lines[j] + '\n'; }
    }
    if (cur) subs.push(cur);
  }
  return subs;
}

// --- section-targeted retrieval helpers (used by get_full_document_content) ---
var SECTION_CAP = 8000;  // per-section cap (covers the largest measured section ~6.4KB)
var TOTAL_CAP = 16000;   // overall ceiling for any single tool result
var EXCERPT_WIN = 700;   // 매치 앞뒤 발췌 폭
var EXCERPT_MAX = 3;     // 발췌 최대 매치 수
var INDEX_CAP = 60;      // 섹션 목록 상한(목록 자체가 컨텍스트를 밀어내지 않게)

// 키워드 매치 위치 중심 발췌 — 앞부분 캡 방식은 깊은 매치(에러코드 표 뒤쪽 등)를 통째로 놓친다
function excerptAround(content, kw) {
  var low = content.toLowerCase();
  var positions = [];
  var from = 0;
  while (positions.length < EXCERPT_MAX) {
    var p = low.indexOf(kw, from);
    if (p < 0) break;
    positions.push(p);
    from = p + EXCERPT_WIN; // 인접 매치는 같은 윈도우에 이미 포함
  }
  if (!positions.length) return '';
  var ranges = [];
  for (var i = 0; i < positions.length; i++) {
    var s = Math.max(0, positions[i] - EXCERPT_WIN);
    var e = Math.min(content.length, positions[i] + kw.length + EXCERPT_WIN);
    var pe = positions[i] + kw.length; // 매치 끝 위치 — 스냅이 매치 자체를 잘라내지 않게 하한으로 사용
    if (ranges.length && s <= ranges[ranges.length - 1].e) {
      if (e > ranges[ranges.length - 1].e) ranges[ranges.length - 1].e = e;
      if (pe > ranges[ranges.length - 1].pe) ranges[ranges.length - 1].pe = pe;
    } else ranges.push({ s: s, e: e, pe: pe });
  }
  var out = '';
  for (var j = 0; j < ranges.length; j++) {
    var s2 = ranges[j].s, e2 = ranges[j].e;
    // 줄 경계로 스냅(표 문서에서 행 절단 완화). 단 매치 위치를 넘어 자르지 않음(초장문 라인 보호).
    if (s2 > 0) { var nl = content.indexOf('\n', s2); if (nl >= 0 && nl - s2 < 200 && nl + 1 <= ranges[j].pe - kw.length) s2 = nl + 1; }
    if (e2 < content.length) { var nl2 = content.lastIndexOf('\n', e2); if (nl2 > s2 && nl2 >= ranges[j].pe) e2 = nl2; }
    out += (s2 > 0 ? '…\n' : '') + content.substring(s2, e2) + (e2 < content.length ? '\n…' : '') + '\n\n';
    if (out.length > SECTION_CAP) break;
  }
  return out.trim();
}

function capSection(body) {
  if (body.length <= SECTION_CAP) return body;
  return body.substring(0, SECTION_CAP) + '\n... (이 섹션이 ' + SECTION_CAP + '자에서 잘림)';
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Rank a section title against the keyword: lower = better match; 99 = no match.
function matchScore(title, kw) {
  var t = title.toLowerCase();
  if (t === kw) return 0;                                        // exact title
  if (t.indexOf(kw) === 0) return 1;                            // title starts with kw
  if (new RegExp('\\b' + escapeRegex(kw) + '\\b').test(t)) return 2; // whole-word match
  if (t.indexOf(kw) >= 0) return 3;                            // substring
  return 99;
}

// Emit one or more sections (each capped), with a leading note, stopping at totalCap.
function emitSections(secs, note, totalCap) {
  var ceil = totalCap || TOTAL_CAP;
  var out = note ? note + '\n\n' : '';
  var total = out.length, shown = 0;
  for (var i = 0; i < secs.length; i++) {
    var chunk = '## ' + secs[i].title + '\n' + capSection(secs[i].content) + '\n\n';
    if (total + chunk.length > ceil && shown > 0) {
      out += '... (' + (secs.length - shown) + '개 섹션 생략; section= 키워드를 더 구체적으로 지정하세요)\n';
      break;
    }
    out += chunk; total += chunk.length; shown++;
  }
  return out.trim();
}

// Footer appended to a section-targeted response: lists the OTHER section titles so the answer
// keeps doc-scope awareness (can mention/fetch related ops) without dumping their bodies.
function otherSectionsFooter(sections, usedTitles) {
  var names = [];
  for (var i = 0; i < sections.length; i++) {
    if (usedTitles.indexOf(sections[i].title) < 0) names.push(sections[i].title);
  }
  if (!names.length) return '';
  var FOOT_CAP = 1500;
  var line = '', shown = 0;
  for (var k = 0; k < names.length; k++) {
    var add = (shown ? ', ' : '') + names[k];
    if (line.length + add.length > FOOT_CAP && shown > 0) break;
    line += add; shown++;
  }
  var more = names.length - shown;
  return '\n\n---\n이 문서의 다른 섹션: ' + line + (more > 0 ? ' …외 ' + more + '개' : '') +
    '\n⚠ 지금 섹션이 질문에 완전히 답하지 않으면(특히 지금 섹션이 질문과 반대·부정 관계면, 예: 질문은 "헤더 스킵"인데 섹션은 "without header") 위 다른 섹션을 section= 로 다시 조회한 뒤 답하세요. 한 섹션만 보고 넘겨짚지 마세요.';
}

// 전체 문서 반환에 덧붙이는 "주요 섹션" 목록 — 최상위(h2) 제목만(문서 H1·h3 하위는 제외).
// 모델이 여러 주제를 답변에 반영하도록 유도(개념질문 폭 확보). 답변엔 3개 정도 녹이라는 지시 포함.
function mainTopicsFooter(sections) {
  var names = [];
  for (var i = 0; i < sections.length; i++) {
    if ((sections[i].level || 2) === 2 && sections[i].title) names.push(sections[i].title);
  }
  if (names.length < 2) { // h2가 거의 없는 문서 → h1 제외 전체로 폴백
    names = [];
    for (var j = 0; j < sections.length; j++) if ((sections[j].level || 2) > 1 && sections[j].title) names.push(sections[j].title);
  }
  if (names.length < 2) return '';
  var FOOT_CAP = 800, line = '', shown = 0;
  for (var k = 0; k < names.length; k++) {
    var add = (shown ? ', ' : '') + names[k];
    if (line.length + add.length > FOOT_CAP && shown > 0) break;
    line += add; shown++;
  }
  var more = names.length - shown;
  return '\n\n---\n이 문서의 주요 섹션: ' + line + (more > 0 ? ' …외 ' + more + '개' : '') +
    '\n(질문과 밀접한 3개 정도의 내용을 답변에 자연스럽게 반영하세요. 섹션 제목·도구 이름은 답변에 노출하지 마세요.)';
}

// When a doc is too large to return whole, list its section titles so the model can target one.
function sectionIndex(filePath, sections, prefix) {
  // Do NOT print the file path here — weak models echo it as a doc link. The model already holds
  // the file_identifier from its own call; tell it to reuse it and only change section=.
  var out = (prefix ? prefix + ' ' : '') +
    '같은 문서를 section= 인자만 바꿔(영어 키워드) 다시 호출하세요. 사용 가능한 섹션:\n';
  var n = Math.min(sections.length, INDEX_CAP);
  for (var i = 0; i < n; i++) out += '- ' + sections[i].title + '\n';
  if (sections.length > n) out += '…외 ' + (sections.length - n) + '개\n';
  out += '(섹션 제목 외에 하위(####) 제목·본문 단어도 section=으로 검색됩니다)';
  return out.trim();
}

function extractBlocks(content, langFilter) {
  var blocks = [];
  var re = /```(\w*)\n([\s\S]*?)```/g;
  var match;
  while ((match = re.exec(content)) !== null) {
    var lang = match[1] || '';
    // 무태그 펜스는 필터를 통과시킨다 — 문서의 TQL 예제 다수가 무태그라
    // language="tql" 필터로 전멸시키면 "예제 없음" 거짓 결론을 유발한다.
    if (langFilter && lang && lang.toLowerCase() !== langFilter) continue;
    blocks.push({ lang: lang, code: match[2].trim() });
  }
  return blocks;
}

module.exports = { register };
