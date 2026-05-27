// TQL Analysis Template Expander
// Parses tql-analysis-templates.md and expands TEMPLATE:ID references

var fs = require('fs');
var path = require('path');

var _templates = null; // { '1-1': 'SQL(...)...', '2-1': '...' }

function loadTemplates() {
  if (_templates) return _templates;
  _templates = {};

  var mdPath = path.join(process.cwd(), 'neo', 'tql', 'tql-analysis-templates.md');
  var content;
  try { content = fs.readFileSync(mdPath, 'utf8'); } catch (e) {
    console.println('[TQL-Templates] Failed to load: ' + e.message);
    return _templates;
  }

  var lines = content.split('\n');
  var currentId = null;
  var inCodeBlock = false;
  var codeLines = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Detect template header: ### 1-1. ...
    var headerMatch = line.match(/^###\s+(\d+-\d+)\.\s+/);
    if (headerMatch) {
      // Save previous template
      if (currentId && codeLines.length > 0) {
        _templates[currentId] = codeLines.join('\n').trim();
      }
      currentId = headerMatch[1];
      codeLines = [];
      inCodeBlock = false;
      continue;
    }

    // Detect code block start/end
    if (line.trim().indexOf('```tql') === 0) {
      inCodeBlock = true;
      continue;
    }
    if (inCodeBlock && line.trim().indexOf('```') === 0) {
      inCodeBlock = false;
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
    }
  }
  // Save last template
  if (currentId && codeLines.length > 0) {
    _templates[currentId] = codeLines.join('\n').trim();
  }

  console.println('[TQL-Templates] Loaded ' + Object.keys(_templates).length + ' templates');
  return _templates;
}

// Expand a template by ID with parameter substitution
// params: { id, table, tag, tag1, tag2, unit, timeStart, timeEnd }
function expandTemplate(id, params) {
  var templates = loadTemplates();
  var tql = templates[id];
  if (!tql) return null;

  // Substitute placeholders (fixer uses uppercase keys: TABLE, TAG, UNIT, TIME_START, TIME_END)
  var table = params.TABLE || params.table || '';
  var tag = params.TAG || params.tag || '';
  var tag1 = params.TAG1 || params.tag1 || '';
  var tag2 = params.TAG2 || params.tag2 || '';
  var unit = params.UNIT || params.unit || '';
  var timeStart = params.TIME_START || params.timeStart || '';
  var timeEnd = params.TIME_END || params.timeEnd || '';

  if (table) tql = tql.replace(/\{TABLE\}/g, table);
  if (tag) tql = tql.replace(/\{TAG\}/g, tag);
  if (tag1) tql = tql.replace(/\{TAG1\}/g, tag1);
  if (tag2) tql = tql.replace(/\{TAG2\}/g, tag2);
  if (unit) {
    unit = unit.replace(/^['"]|['"]$/g, ''); // strip existing quotes
    tql = tql.replace(/\{UNIT\}/g, "'" + unit + "'");
  }
  if (timeStart) tql = tql.replace(/\{TIME_START\}/g, timeStart);
  if (timeEnd) tql = tql.replace(/\{TIME_END\}/g, timeEnd);

  return tql;
}

module.exports = { loadTemplates, expandTemplate };