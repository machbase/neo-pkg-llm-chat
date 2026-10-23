// 채팅 마크다운 렌더 회귀 테스트 — 브라우저 불필요
// · 공격 차단: 모델 답변·DB 행·문서 본문이 innerHTML 전에 실행 가능한 것을 남기지 않는지
// · 정상 마크다운 보존: 과잉 차단·CJK 강조 보정 어긋남 검사
// · 대시보드 링크 주소 변환
// 사용: npm run test:render  (frontend/)
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { renderMarkdown, PURIFY_CONFIG, boardLinkToOrigin } from '../src/components/chat/markdown.ts';

// 앱과 같은 파이프라인 — DOMPurify용 window만 JSDOM으로 제공
const DOMPurify = createDOMPurify(new JSDOM('').window);
if (!DOMPurify.isSupported) { console.error('FAIL: DOMPurify가 이 환경을 지원하지 않아 검사가 무의미합니다.'); process.exit(1); }
// 두 층 따로 검사 — 최종만 보면 DOMPurify에 가려 1차 방어 손상을 놓침
const renderA = (md) => renderMarkdown(md);                                    // 1차: markdown.ts 렌더러만
const render = (md) => DOMPurify.sanitize(renderMarkdown(md), PURIFY_CONFIG);  // 최종: 앱과 동일

// 렌더 결과의 실행 가능한 것 잔존 여부 — 파싱된 DOM 기준(이스케이프된 "&lt;img onerror=…&gt;" 글자 오탐 방지)
const EXEC_SCHEME = /^(javascript|vbscript|data):/i;
const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'data'];
const BAD_TAGS = ['script', 'iframe', 'object', 'embed', 'form'];
function findDanger(html) {
    const doc = new JSDOM('<body>' + html + '</body>').window.document;
    for (const el of doc.querySelectorAll('*')) {
        const tag = el.tagName.toLowerCase();
        if (BAD_TAGS.includes(tag)) return tag + ' 요소';
        for (const at of el.attributes) {
            const name = at.name.toLowerCase();
            if (/^on/.test(name)) return at.name + ' 이벤트 핸들러 (' + tag + ')';
            if (name === 'srcdoc') return 'srcdoc 속성 (' + tag + ')';
            if (!URL_ATTRS.includes(name)) continue;
            // 제어문자·공백 제거 후 판정 — 브라우저 해석과 동일
            const v = at.value.replace(/[\u0000-\u0020]/g, '');
            if (EXEC_SCHEME.test(v) && !/^data:image\//i.test(v)) return at.name + '="' + at.value.slice(0, 40) + '" (' + tag + ')';
        }
    }
    return null;
}

const ATTACKS = [
    ['링크 텍스트 주입', '[<img src=x onerror=alert(1)>](https://ok.com)'],
    ['href 따옴표 탈출', "[a](https://x'-alert(1)-'y)"],
    ['javascript: 링크', '[a](javascript:alert(1))'],
    ['원시 HTML', 'hello <img src=x onerror=alert(2)> world'],
    ['원시 script', '<script>alert(3)</script>'],
    ['svg onload', '<svg onload=alert(4)>'],
    ['이미지 alt 탈출', '![" onerror=alert(5) x="](https://ok.com/a.png)'],
    ['이미지 javascript: 스킴', '![a](javascript:alert(6))'],
    ['펜스 lang 주입', '```js"><img src=x onerror=alert(7)>\nvar a=1;\n```'],
    ['링크 title 탈출', '[a](https://ok.com "\\" onmouseover=alert(8) x=\\"")'],
    ['자동링크 javascript:', '<javascript:alert(9)>'],
    ['data: URL 링크', '[a](data:text/html,<script>alert(10)</script>)'],
    ['대문자 스킴 우회', '[a](JaVaScRiPt:alert(11))'],
    ['개행 섞은 스킴', '[a](java\nscript:alert(12))'],
];

// 정상 마크다운 보존 — 과잉 차단도 실패
// · CJK 항목: normalizeMarkdown의 한글 경계·공백 낀 강조 보정 검사
const KEEPS = [
    ['링크', '[문서](https://docs.machbase.com/neo)', /<a [^>]*href="https:\/\/docs\.machbase\.com\/neo"/],
    ['굵게', '**굵게**', /<strong>굵게<\/strong>/],
    ['인라인 코드', '`SELECT 1`', /<code>SELECT 1<\/code>/],
    ['표', '| a | b |\n|---|---|\n| 1 | 2 |', /<table>[\s\S]*<td>1<\/td>/],
    ['코드블록 하이라이트', '```sql\nSELECT 1;\n```', /<pre><code class="hljs language-sql"/],
    ['이미지', '![차트](https://ok.com/a.png)', /<img [^>]*src="https:\/\/ok\.com\/a\.png"/],
    ['CJK 굵게', '**TQL(Transforming Query Language)**은 데이터를 변환합니다.', /<strong>TQL\(Transforming Query Language\)<\/strong>\s*은/],
    ['공백 낀 굵게', '** 굵게 ** 뒤에 한글', /<strong>굵게<\/strong>/],
    ['CJK 기울임', '*중요* 한 항목', /<em>중요<\/em>/],
    ['홑물결 범위표기', '온도 0~45°C, pH 0~14 입니다', /0~45°C/],
    ['취소선', '~~취소~~된 항목', /<del>취소<\/del>/],
    ['URL 뒤 한글', 'https://docs.machbase.com/neo/에서 확인', /href="https:\/\/docs\.machbase\.com\/neo\/"/],
    ['TQL 펜스', '```tql\nSQL(`select 1`)\nCSV()\n```', /<pre><code class="hljs language-tql"/],
    ['번호 목록', '1. 첫째\n2. 둘째', /<ol>[\s\S]*<li>첫째<\/li>/],
    ['코드 안 별표 보존', '`a ** b`', /<code>a \*\* b<\/code>/],
];

let fail = 0;
console.log('── 공격 차단 ──');
for (const [name, md] of ATTACKS) {
    let a, ab;
    try { a = findDanger(renderA(md)); } catch (e) { a = '1차 렌더러가 던짐: ' + e.message; }
    try { ab = findDanger(render(md)); } catch (e) { ab = '최종 렌더가 던짐: ' + e.message; }
    if (ab) { console.log('  ✗ ' + name + ' → [최종] ' + ab); fail++; }
    else if (a) { console.log('  ✗ ' + name + ' → [1차] ' + a + ' — DOMPurify가 가려주고 있다'); fail++; }
    else console.log('  ✓ ' + name);
}
console.log('── 정상 마크다운 보존 ──');
for (const [name, md, expect] of KEEPS) {
    let out;
    try { out = render(md); } catch (e) { console.log('  ✗ ' + name + ' → 렌더가 던짐: ' + e.message); fail++; continue; }
    if (expect.test(out)) console.log('  ✓ ' + name);
    else { console.log('  ✗ ' + name + ' 깨짐: ' + out.trim().slice(0, 120)); fail++; }
}

// 대시보드 링크 — 백엔드가 설정 호스트로 만든 링크를 접속 주소로, 그 밖의 링크는 그대로
const UI = 'http://192.168.0.10:5654';
const LINKS = [
    ['대시보드 링크 → 접속 주소', 'http://127.0.0.1:5654/web/ui/board/alpha/T/d_20261023?x=1#top', UI + '/web/ui/board/alpha/T/d_20261023?x=1#top'],
    ['접속 주소와 같은 링크 → 그대로', UI + '/web/ui/board/alpha/T/d', UI + '/web/ui/board/alpha/T/d'],
    ['리포트 링크 → 그대로', 'http://127.0.0.1:5654/db/tql/alpha/T/r.html', 'http://127.0.0.1:5654/db/tql/alpha/T/r.html'],
    ['다른 호스트의 대시보드 경로 → 접속 주소', 'https://neo.example.com/web/ui/board/x', UI + '/web/ui/board/x'],
    ['외부 사이트 → 그대로', 'https://example.com/docs/web', 'https://example.com/docs/web'],
    ['상대 경로 → 그대로', '/web/ui/board/alpha/T/d', '/web/ui/board/alpha/T/d'],
    ['mailto → 그대로', 'mailto:a@b.c', 'mailto:a@b.c'],
];
console.log('── 대시보드 링크 주소 ──');
for (const [name, href, expect] of LINKS) {
    const got = boardLinkToOrigin(href, UI);
    if (got === expect) console.log('  ✓ ' + name);
    else { console.log('  ✗ ' + name + ' → ' + got); fail++; }
}

const total = ATTACKS.length + KEEPS.length + LINKS.length;
console.log('\n===== ' + (total - fail) + '/' + total + ' 통과 =====');
process.exit(fail ? 1 : 0);
