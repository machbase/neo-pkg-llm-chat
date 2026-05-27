function captureKnownTags(result, fctx) {
  if (!result) return;
  // Format: "[TABLE] tag1, tag2, tag3" or just lines of tags
  var tags = [];
  var bracketIdx = result.indexOf(']');
  if (bracketIdx >= 0) {
    var tagStr = result.substring(bracketIdx + 1).trim();
    tags = tagStr.split(',').map(function (t) { return t.trim(); }).filter(function (t) { return t.length > 0; });
  } else {
    tags = result.split('\n').map(function (t) { return t.trim(); }).filter(function (t) { return t.length > 0 && t !== 'NAME'; });
  }
  if (tags.length > 0) {
    fctx.knownTags = tags;
  }
}

function validateTagInArgs(toolName, args, knownTags) {
  if (!knownTags || knownTags.length === 0) return '';
  if (toolName !== 'save_tql_file' && toolName !== 'execute_tql_script' && toolName !== 'validate_chart_tql') return '';

  var tql = args.tql_content || args.tql_script || '';
  if (!tql) return '';

  // Detect unsubstituted placeholders
  var placeholderRE = /\{(TAG\d?|TABLE|UNIT)\}/g;
  var found = tql.match(placeholderRE);
  if (found && found.length > 0) {
    return 'Error: 플레이스홀더 ' + JSON.stringify(found) + '가 치환되지 않았습니다. ' +
      'tql_content에 raw TQL을 직접 쓰지 마세요! ' +
      '반드시 TEMPLATE:ID TABLE:테이블 TAG:태그 UNIT:단위 형식을 사용하세요.';
  }

  // Check NAME='...' references against known tags
  var nameRE = /NAME\s*=\s*'([^']+)'/g;
  var tagSet = {};
  for (var i = 0; i < knownTags.length; i++) {
    tagSet[knownTags[i]] = true;
  }

  var invalidTags = [];
  var match;
  while ((match = nameRE.exec(tql)) !== null) {
    if (!tagSet[match[1]]) {
      invalidTags.push(match[1]);
    }
  }

  // Check NAME IN (...) references
  var inRE = /NAME\s+IN\s*\(([^)]+)\)/g;
  while ((match = inRE.exec(tql)) !== null) {
    var tagListRE = /'([^']+)'/g;
    var tagMatch;
    while ((tagMatch = tagListRE.exec(match[1])) !== null) {
      if (!tagSet[tagMatch[1]]) {
        invalidTags.push(tagMatch[1]);
      }
    }
  }

  if (invalidTags.length === 0) return '';
  return 'Error: 존재하지 않는 태그명이 사용되었습니다: ' + JSON.stringify(invalidTags) +
    '\n사용 가능한 태그 목록: ' + JSON.stringify(knownTags);
}

module.exports = { captureKnownTags, validateTagInArgs };
