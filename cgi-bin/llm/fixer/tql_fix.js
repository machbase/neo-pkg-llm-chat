// 문자열 인자의 리터럴 "\n"(백슬래시+n) → 실제 줄바꿈 — 모델이 이스케이프를 한 번 더 붙여 보내는 경우

function fixEscapedNewlines(args) {
  var keys = Object.keys(args);
  for (var i = 0; i < keys.length; i++) {
    var v = args[keys[i]];
    if (typeof v === 'string' && v.indexOf('\\n') >= 0) {
      args[keys[i]] = v.replace(/\\n/g, '\n');
    }
  }
}

module.exports = { fixEscapedNewlines };
