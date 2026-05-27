var fs = require('fs');
var path = require('path');

var TEMPLATE_FILES = [
  'general-report-templates.md',
  'finance-report-templates.md',
  'vibration-report-templates.md',
  'driving-report-templates.md',
];

function loadReportTemplates() {
  var templates = {};
  var baseDir = path.join(__dirname, '..', 'neo', 'report');
  for (var i = 0; i < TEMPLATE_FILES.length; i++) {
    var filePath = path.join(baseDir, TEMPLATE_FILES[i]);
    try {
      var data = fs.readFileSync(filePath, 'utf8');
      var content = data.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
      var re = /(?:^|\n)###\s*(R-\d+)\.[^\n]*\n[\s\S]*?```html\n([\s\S]*?)\n```/g;
      var match;
      while ((match = re.exec(content)) !== null) {
        templates[match[1]] = match[2].trim();
        console.println('[ReportTemplates] Parsed ' + match[1] + ' from ' + TEMPLATE_FILES[i]);
      }
    } catch (e) {
      console.println('[ReportTemplates] Skip ' + TEMPLATE_FILES[i] + ': ' + e.message);
    }
  }
  var ids = Object.keys(templates);
  console.println('[ReportTemplates] Total loaded: ' + ids.length + ' [' + ids.join(', ') + '] baseDir=' + baseDir);
  return templates;
}

var _cache = null;

function expandReportTemplate(templateID, params) {
  if (!_cache) _cache = loadReportTemplates();
  var tmpl = _cache;
  var code = tmpl[templateID];
  if (!code) {
    code = tmpl['R-0'];
    if (code) {
      console.println('[ReportTemplates] Template \'' + templateID + '\' not found, falling back to R-0');
    }
  }
  if (!code) {
    var baseDir = path.join(__dirname, '..', 'neo', 'report');
    throw new Error('report template \'' + templateID + '\' not found. available: ' + JSON.stringify(Object.keys(tmpl)) + ' [baseDir=' + baseDir + ']');
  }
  var keys = Object.keys(params);
  for (var i = 0; i < keys.length; i++) {
    var re = new RegExp('\\{' + keys[i] + '\\}', 'g');
    code = code.replace(re, params[keys[i]]);
  }
  return code;
}

module.exports = { loadReportTemplates, expandReportTemplate };
