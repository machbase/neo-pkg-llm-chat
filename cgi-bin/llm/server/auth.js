// neo 가 발급한 JWT 를 검증하고 로그인 이름을 얻는다. 게이트웨이(WS)와 config API 가 공유한다.
//
// 서명 검증은 neo 에 위임한다(GET /web/api/check). 토큰 payload 는 누구나 만들어낼 수 있어
// 파싱만으로는 위조를 걸러내지 못하므로, 검증에 성공한 토큰에 대해서만 payload 에서 이름을
// 꺼낸다. 검증과 파싱의 순서가 이 모듈의 전부다.

var http2 = require('@jsh/http');

var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// jsh 런타임에 atob/Buffer 가 없어 base64url 을 직접 푼다.
function base64UrlDecode(str) {
  var b64 = String(str || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  // 남은 글자가 없을 때 charAt() 은 빈 문자열을 주고 indexOf('') 는 0 이라, 길이를 직접 보고
  // 부족한 자리를 -1 로 둔다. 그러지 않으면 마지막 그룹에 없는 바이트가 덧붙는다.
  function at(i) { return i < b64.length ? B64_CHARS.indexOf(b64.charAt(i)) : -1; }
  var out = '', i = 0;
  while (i < b64.length) {
    var e1 = at(i++), e2 = at(i++), e3 = at(i++), e4 = at(i++);
    if (e1 < 0 || e2 < 0) break;
    out += String.fromCharCode((e1 << 2) | (e2 >> 4));
    if (e3 >= 0) out += String.fromCharCode(((e2 & 15) << 4) | (e3 >> 2));
    if (e3 >= 0 && e4 >= 0) out += String.fromCharCode(((e3 & 3) << 6) | e4);
  }
  return out;
}

// 'Bearer <token>' 헤더에서 토큰만 꺼낸다. 형식이 아니면 빈 문자열.
function bearerOf(headerValue) {
  var m = /^Bearer\s+(\S+)/i.exec(String(headerValue || '').trim());
  return m ? m[1] : '';
}

function createAuth(neoBase) {
  var client = http2.NewClient();

  // 유효한 토큰이면 로그인 이름, 아니면 null. 만료·서명 위조·미제시 모두 null 이다.
  function verifyToken(token) {
    if (!token) return null;
    try {
      var req = http2.NewRequest('GET', neoBase + '/web/api/check');
      req.header.set('Authorization', 'Bearer ' + token);
      if (!client.do(req).ok) return null;
    } catch (e) {
      return null;
    }
    var parts = String(token).split('.');
    if (parts.length !== 3) return null;
    try {
      var payload = JSON.parse(base64UrlDecode(parts[1]));
      var sub = payload && payload.sub;
      return (typeof sub === 'string' && sub) ? sub : null;
    } catch (e) {
      return null;
    }
  }

  return { verifyToken: verifyToken, bearerOf: bearerOf };
}

module.exports = { createAuth, bearerOf, base64UrlDecode };
