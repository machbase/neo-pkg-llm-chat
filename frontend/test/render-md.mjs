// 채팅 마크다운 렌더 회귀 테스트 — 브라우저 없이 즉시 끝난다.
//
// 무엇을 재나: 두 가지를 한 파이프라인에서 함께 본다.
//   1) 채팅에 흘러드는 텍스트(모델 답변·DB 행·문서 본문)가 innerHTML에 닿기 전에
//      실행 가능한 것을 남기지 않는지
//   2) 정상 마크다운이 살아남는지 — 과잉 차단도, CJK 강조 보정이 어긋나는 것도 실패다
// 왜 필요한가: 두 성질 모두 marked의 동작에 기대고 있어, marked를 올리면 조용히 어긋날 수 있다.
//   그때 사용자가 아니라 이 테스트가 먼저 깨져야 한다.
//
// 사용: npm run test:render  (frontend/)
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { renderMarkdown, PURIFY_CONFIG } from '../src/components/chat/markdown.ts';

// 앱과 같은 파이프라인. 다른 점은 DOMPurify에 줄 window뿐이다(브라우저에는 이미 있다).
const DOMPurify = createDOMPurify(new JSDOM('').window);
if (!DOMPurify.isSupported) { console.error('FAIL: DOMPurify가 이 환경을 지원하지 않아 검사가 무의미합니다.'); process.exit(1); }
// 두 층을 따로 잰다. 최종만 재면 DOMPurify가 다 막아주는 바람에 1차 방어가 썩어도 모른다.
const renderA = (md) => renderMarkdown(md);                                    // 1차: markdown.ts 렌더러만
const render = (md) => DOMPurify.sanitize(renderMarkdown(md), PURIFY_CONFIG);  // 최종: 앱과 동일

// 렌더 결과에 실행 가능한 것이 남았는가 — 문자열이 아니라 파싱된 DOM에서 본다.
//   (이스케이프된 "&lt;img onerror=…&gt;"는 글자일 뿐이라 문자열 검사로는 오탐이 난다)
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
            // 제어문자·공백을 걷어낸 뒤 판정 — 브라우저도 그렇게 읽는다
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

// 정상 마크다운은 살아남아야 한다 — 과잉 차단도 실패다.
// CJK 항목들은 marked가 한글 경계·공백 낀 강조를 놓치는 것을 normalizeMarkdown이 보정하는 부분이라,
// marked를 올렸을 때 보정이 어긋나면 여기서 먼저 드러난다.
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

const total = ATTACKS.length + KEEPS.length;
console.log('\n===== ' + (total - fail) + '/' + total + ' 통과 =====');
process.exit(fail ? 1 : 0);
