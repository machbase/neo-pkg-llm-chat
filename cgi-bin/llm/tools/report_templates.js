var fs = require('fs');
var path = require('path');

// 30초 TTL 재스캔 — 새로 넣은 custom/*.md를 워커 재시작 없이 반영
var CACHE_TTL = 30 * 1000;

var _cache = null;   // id -> html 문자열
var _meta = {};      // id -> { id, title, file, custom, compute, guide }
var _cacheTs = 0;

// neo/report/(빌트인)·neo/report/custom/(커스텀) 아래 *.md 수집
function scanTemplateFiles(baseDir) {
  var out = [];
  function addDir(dir, custom) {
    var names;
    try { names = fs.readdirSync(dir); } catch (e) { return; } // custom/ 없을 수 있음
    for (var i = 0; i < names.length; i++) {
      if (/\.md$/i.test(names[i])) out.push({ path: path.join(dir, names[i]), file: names[i], custom: custom });
    }
  }
  addDir(baseDir, false);
  addDir(path.join(baseDir, 'custom'), true);
  return out;
}

// 간이 YAML frontmatter 파서 — 선두 ---\n ... \n--- 블록
// · `key: value` 스칼라·`key: |` 블록 스칼라(들여쓴 다음 줄들) 지원
// · 템플릿별 `compute:`(실행할 계산)·`guide:`(분석 방향 문구)용
function parseFrontmatter(content) {
  var m = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!m) return {};
  var lines = m[1].split('\n');
  var fm = {};
  var i = 0;
  while (i < lines.length) {
    var kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) { i++; continue; }
    var key = kv[1], val = kv[2];
    if (val === '|' || val === '>') {
      var buf = [];
      i++;
      while (i < lines.length && (lines[i] === '' || /^\s/.test(lines[i]))) {
        buf.push(lines[i].replace(/^  /, ''));
        i++;
      }
      fm[key] = buf.join('\n').replace(/^\n+|\n+$/g, '');
    } else {
      fm[key] = val.replace(/\s+#.*$/, '').trim(); // YAML 인라인 주석 ' # ...' 제거
      i++;
    }
  }
  return fm;
}

function loadReportTemplates() {
  var templates = {};
  var meta = {};
  var baseDir = path.resolve(__dirname, '..', 'neo', 'report'); // jsh fs.readdirSync는 절대 경로 필요
  var files = scanTemplateFiles(baseDir);
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    try {
      var data = fs.readFileSync(f.path, 'utf8');
      var content = data.replace(/\r\n/g, '\n').replace(/^﻿/, '');
      var fm = parseFrontmatter(content);
      // group1=id(R-N-topic / C-N-topic), group2=제목, group3=html 본문
      var re = /(?:^|\n)###\s*([RC]-\d+[\w-]*)\s*\.\s*([^\n]*)\n[\s\S]*?```html\n([\s\S]*?)\n```/g;
      var match;
      while ((match = re.exec(content)) !== null) {
        var id = match[1];
        templates[id] = match[3].trim();
        meta[id] = { id: id, title: (match[2] || '').trim(), file: f.file, custom: f.custom, compute: fm.compute || '', guide: fm.guide || '' };
        console.println('[ReportTemplates] Parsed ' + id + (f.custom ? ' (custom)' : '') + (fm.compute ? ' compute=' + fm.compute : '') + ' from ' + f.file);
      }
    } catch (e) {
      console.println('[ReportTemplates] Skip ' + f.file + ': ' + e.message);
    }
  }
  _meta = meta;
  var ids = Object.keys(templates);
  console.println('[ReportTemplates] Total loaded: ' + ids.length + ' [' + ids.join(', ') + '] baseDir=' + baseDir);
  return templates;
}

// 지연 로드 + 짧은 TTL 재스캔
function ensureCache() {
  var now = Date.now();
  if (!_cache || (now - _cacheTs) > CACHE_TTL) {
    _cache = loadReportTemplates();
    _cacheTs = now;
  }
  return _cache;
}

// [{ id, title, file, custom, compute, guide }] — 빌트인 먼저, 커스텀 다음. LLM 노출·라우팅용
// ⚠️ neo/report 안 템플릿은 전부 save_html_report로 채울 수 있어야 함 — 목록이 그대로 LLM 노출·라우팅 대상
//    · 도구 전용 템플릿(예: 예측)은 다른 폴더(neo/forecast/)에 둠
function listReportTemplates() {
  ensureCache();
  var out = [];
  var keys = Object.keys(_meta);
  for (var i = 0; i < keys.length; i++) out.push(_meta[keys[i]]);
  return out;
}

// 템플릿 id 하나의 메타데이터(compute/guide/title/custom), 없으면 null
function getTemplateMeta(id) {
  ensureCache();
  return _meta[id] || null;
}

function expandReportTemplate(templateID, params) {
  var tmpl = ensureCache();
  var code = tmpl[templateID];
  if (!code) {
    code = tmpl['R-0-general'];
    if (code) {
      console.println('[ReportTemplates] Template \'' + templateID + '\' not found, falling back to R-0-general');
    }
  }
  if (!code) {
    var baseDir = path.resolve(__dirname, '..', 'neo', 'report');
    throw new Error('report template \'' + templateID + '\' not found. available: ' + JSON.stringify(Object.keys(tmpl)) + ' [baseDir=' + baseDir + ']');
  }
  var keys = Object.keys(params);
  for (var i = 0; i < keys.length; i++) {
    var re = new RegExp('\\{' + keys[i] + '\\}', 'g');
    code = code.replace(re, params[keys[i]]);
  }
  return code;
}

// 리포트 라우팅용 generic stopword — 대부분 요청에 등장하는 일반어는 커스텀 매칭에서 제외(오탐 방지).
// 'sample'/'샘플'도 포함 → 중립 슬러그 데모(C-1-sample)는 자동 라우팅 안 됨(설계 의도: 이름으로 직접 골라야만 쓰임).
var ROUTING_STOPWORDS = {
  '리포트': 1, 'report': 1, '보고서': 1, '분석': 1, 'analysis': 1, '데이터': 1, 'data': 1,
  '커스텀': 1, 'custom': 1, '템플릿': 1, 'template': 1, '기본': 1, 'general': 1,
  '표': 1, 'table': 1, '테이블': 1, '차트': 1, 'chart': 1, '작성': 1, '생성': 1, '만들': 1,
  '샘플': 1, 'sample': 1, '예시': 1, 'example': 1, '요약': 1, 'summary': 1,
  // 빌트인 제목 전부에 등장("~ 데이터 종합 분석 리포트") → 남겨두면 '종합' 포함 질문이 전 템플릿 multi-hit돼 주제 매칭 무효화
  '종합': 1
};
function routingTokens(s) {
  return String(s).toLowerCase().split(/[^a-z0-9가-힣]+/).filter(function (t) {
    return t.length >= 2 && !ROUTING_STOPWORDS[t];
  });
}

// 쿼리에 매칭되는 템플릿 id (slug + 제목 토큰, generic stopword 제외). 정확히 1개면 그 id, 아니면 ''.
// 약한 모델(ollama)이 template_id를 못 고를 때, 도구-레벨에서 결정론적으로 주입하기 위함.
function matchByQuery(query, customOnly) {
  if (!query) return '';
  var q = String(query).toLowerCase();
  ensureCache();
  var hits = [];
  var keys = Object.keys(_meta);
  for (var i = 0; i < keys.length; i++) {
    var m = _meta[keys[i]];
    if (!m) continue;
    if (m.internal) continue; // 도구 전용 템플릿은 질의 라우팅 대상 아님 — "예측 리포트"가 save_html_report로 새는 것 방지
    if (customOnly ? !m.custom : m.custom) continue;
    var slug = (/^[A-Za-z]-\d+-(.+)$/.exec(m.id) || [])[1] || '';
    var kws = routingTokens(slug).concat(routingTokens(m.title || ''));
    for (var k = 0; k < kws.length; k++) {
      if (q.indexOf(kws[k]) >= 0) { hits.push(m.id); break; }
    }
  }
  return hits.length === 1 ? hits[0] : '';
}

// 커스텀 전용 — 고유 주제 커스텀(C-2-energy 등)만 매칭. 중립 'sample'은 stopword라 미매칭(데모는 이름선택 전용 유지).
function matchCustomByQuery(query) { return matchByQuery(query, true); }

// 빌트인 전용 — 질문의 주제어("진동 리포트" 등)가 빌트인 제목/슬러그 토큰과 매칭되면 그 id.
// 테이블/태그명이 도메인과 무관해도(BEARING 태그 C1/C2 등) 사용자의 말 자체로 템플릿을 결정론적으로 잡는 경로.
function matchBuiltinByQuery(query) { return matchByQuery(query, false); }

module.exports = { loadReportTemplates: loadReportTemplates, expandReportTemplate: expandReportTemplate, listReportTemplates: listReportTemplates, getTemplateMeta: getTemplateMeta, matchCustomByQuery: matchCustomByQuery, matchBuiltinByQuery: matchBuiltinByQuery };
