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
      } catch (e) { cb(null, 'Error: ' + e.message); }
    },
  });

  registry.register({
    name: 'search_documents',
    description: 'Search documentation catalog by keyword. Returns matching document paths. Use this BEFORE get_full_document_content to find the right document.',
    parameters: {
      type: 'object',
      properties: { keyword: { type: 'string', description: 'Search keyword (e.g., "PIVOT", "ROLLUP", "TQL", "chart")' } },
      required: ['keyword'],
    },
    fn: function (args, cb) {
      var keyword = argStr(args, 'keyword', '').toLowerCase();
      if (!keyword) return cb(null, 'Error: keyword is required');
      try {
        var neoDir = findNeoDir();
        if (!neoDir) return cb(null, 'Error: neo documentation directory not found');
        var catalogPath = path.join(neoDir, 'catalog.md');
        if (!fs.existsSync(catalogPath)) return cb(null, 'Error: catalog.md not found');
        var lines = fs.readFileSync(catalogPath, 'utf8').split('\n');
        var results = [];
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].indexOf('|') < 0 || lines[i].indexOf('---') >= 0) continue;
          if (lines[i].toLowerCase().indexOf(keyword) >= 0) {
            var cols = lines[i].split('|');
            if (cols.length >= 4) {
              results.push({ path: cols[1].trim(), title: cols[2].trim(), keywords: cols[3].trim() });
            }
          }
        }
        if (results.length === 0) {
          // Fallback: return full catalog so LLM can find it manually
          var catalog = fs.readFileSync(catalogPath, 'utf8');
          return cb(null, 'No exact match for: ' + keyword + '\n\n아래 카탈로그에서 직접 찾아보세요:\n' + catalog);
        }
        var out = 'Found ' + results.length + ' document(s):\n';
        for (var j = 0; j < results.length; j++) {
          out += '- ' + results[j].path + ' (' + results[j].title + ') [' + results[j].keywords + ']\n';
        }
        cb(null, out.trim());
      } catch (e) { cb(null, 'Error: ' + e.message); }
    },
  });

  registry.register({
    name: 'get_full_document_content',
    description: 'Get documentation content. Pass file_identifier (catalog path). Optionally pass section=<header keyword> (e.g. "ADD COLUMN", "RETENTION", "TO_CHAR") to return ONLY that section at full length — recommended for large reference docs (DDL/functions) so deep sections are not cut off. Without section, a large doc returns its section list so you can pick one.',
    parameters: {
      type: 'object',
      properties: {
        file_identifier: { type: 'string', description: 'Document path from catalog (copy verbatim)' },
        section: { type: 'string', description: 'Optional. A section header keyword to return only that section in full. Use the question\'s specific operation phrase (e.g. "ADD COLUMN"). If omitted, large docs return a section list.' },
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

        // No markdown headers at all → legacy raw behavior.
        if (sections.length === 0) {
          if (content.length > TOTAL_CAP) content = content.substring(0, TOTAL_CAP) + '\n\n... (truncated, total ' + content.length + ' chars)';
          return cb(null, content);
        }

        // Section requested → title match (ranked), then body scan, then section index.
        if (kw) {
          var scored = [];
          for (var i = 0; i < sections.length; i++) {
            var sc = matchScore(sections[i].title, kw);
            if (sc < 99) scored.push({ s: sections[i], sc: sc });
          }
          if (scored.length) {
            scored.sort(function (a, b) { return a.sc - b.sc || a.s.title.length - b.s.title.length; });
            var top = [];
            for (var j = 0; j < scored.length && j < 4; j++) top.push(scored[j].s);
            var used = []; for (var u = 0; u < top.length; u++) used.push(top[u].title);
            // No file path in the result — weak models echo it back as a doc link (forbidden).
            return cb(null, emitSections(top, null, top.length > 1 ? 8000 : TOTAL_CAP) + otherSectionsFooter(sections, used));
          }
          for (var k = 0; k < sections.length; k++) {
            if (sections[k].content.toLowerCase().indexOf(kw) >= 0) {
              return cb(null, emitSections([sections[k]], 'No header matched "' + kw + '"; closest section by content:', TOTAL_CAP) + otherSectionsFooter(sections, [sections[k].title]));
            }
          }
          return cb(null, sectionIndex(filePath, sections, 'Section "' + kw + '" not found.'));
        }

        // No section → small doc returns whole; large doc returns the section index (no body hidden).
        var full = '';
        for (var m = 0; m < sections.length; m++) full += '## ' + sections[m].title + '\n' + sections[m].content + '\n\n';
        if (full.length <= TOTAL_CAP) return cb(null, full.trim());
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
        var out = '';
        for (var i = 0; i < sections.length; i++) out += '## ' + sections[i].title + '\n' + sections[i].content.substring(0, 2000) + '\n\n';
        cb(null, out.trim() || 'No sections found.');
      } catch (e) { cb(null, 'Error: ' + e.message); }
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
        if (blocks.length === 0) return cb(null, 'No code blocks found.');
        var out = '';
        for (var i = 0; i < blocks.length; i++) out += '```' + blocks[i].lang + '\n' + blocks[i].code + '\n```\n\n';
        cb(null, out.trim());
      } catch (e) { cb(null, 'Error: ' + e.message); }
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

function parseSections(content) {
  var lines = content.split('\n');
  var sections = [];
  var current = null;
  var inFence = false; // track ``` code blocks so '## ...' inside a SQL example isn't a fake section
  for (var i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) inFence = !inFence;
    if (!inFence && lines[i].match(/^#{1,3}\s/)) {
      if (current) sections.push(current);
      current = { title: lines[i].replace(/^#+\s*/, ''), content: '' };
    } else if (current) { current.content += lines[i] + '\n'; }
  }
  if (current) sections.push(current);
  return sections;
}

// --- section-targeted retrieval helpers (used by get_full_document_content) ---
var SECTION_CAP = 8000;  // per-section cap (covers the largest measured section ~6.4KB)
var TOTAL_CAP = 16000;   // overall ceiling for any single tool result

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
    '\n(관련되면 section= 로 추가 조회 가능)';
}

// When a doc is too large to return whole, list its section titles so the model can target one.
function sectionIndex(filePath, sections, prefix) {
  // Do NOT print the file path here — weak models echo it as a doc link. The model already holds
  // the file_identifier from its own call; tell it to reuse it and only change section=.
  var out = (prefix ? prefix + ' ' : '') +
    '같은 문서를 section= 인자만 바꿔(영어 키워드) 다시 호출하세요. 사용 가능한 섹션:\n';
  for (var i = 0; i < sections.length; i++) out += '- ' + sections[i].title + '\n';
  return out.trim();
}

function extractBlocks(content, langFilter) {
  var blocks = [];
  var re = /```(\w*)\n([\s\S]*?)```/g;
  var match;
  while ((match = re.exec(content)) !== null) {
    var lang = match[1] || '';
    if (langFilter && lang.toLowerCase() !== langFilter) continue;
    blocks.push({ lang: lang, code: match[2].trim() });
  }
  return blocks;
}

module.exports = { register };
