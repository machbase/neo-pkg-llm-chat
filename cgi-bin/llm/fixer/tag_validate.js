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

module.exports = { captureKnownTags };
