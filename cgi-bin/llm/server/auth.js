// neo API 토큰(nt_) 검증 · 계정 이름 판정. 게이트웨이(WS)와 config API 공용
// · 판정은 neo 의 POST /db/token/validate 에 위임
// · 계정 이름은 소문자로 통일 — configs/·prefs/·산출물 폴더 이름과 일치

var http2 = require('@jsh/http');

// 'Bearer <token>' 헤더에서 토큰만 추출. 형식이 아니면 빈 문자열
function bearerOf(headerValue) {
  var m = /^Bearer\s+(\S+)/i.exec(String(headerValue || '').trim());
  return m ? m[1] : '';
}

function createAuth(neoBase) {
  var client = http2.NewClient();

  // 유효하면 소문자 계정 이름, 아니면 null(무효·만료·미제시·neo 응답 없음)
  function verifyToken(token) {
    if (!token) return null;
    try {
      var req = http2.NewRequest('POST', neoBase + '/db/token/validate');
      req.header.set('Authorization', 'Bearer ' + token);
      var resp = client.do(req);
      if (!resp.ok) return null;
      var body = JSON.parse(resp.string());
      var user = body && body.valid === true && body.user;
      return (typeof user === 'string' && user) ? user.toLowerCase() : null;
    } catch (e) {
      return null;
    }
  }

  return { verifyToken: verifyToken, bearerOf: bearerOf };
}

module.exports = { createAuth, bearerOf };
