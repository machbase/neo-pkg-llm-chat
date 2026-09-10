// 채팅 마크다운 렌더 파이프라인. RenderMd(브라우저)와 회귀 테스트(node)가 같은 설정을 쓰도록 여기 모은다.
//
// 신뢰 경계: content에는 모델 답변과 도구 결과(DB 행·문서 본문)가 그대로 들어온다. 렌더 결과는
// dangerouslySetInnerHTML로 들어가므로, 여기서 나온 HTML에는 실행 가능한 것이 남아 있으면 안 된다.
// 이 파일이 1차 방어(원시 HTML 차단·스킴 제한)이고, 호출부가 DOMPurify로 2차 방어를 건다.
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';

// DOMPurify 기본값은 target을 지운다 — 링크를 새 창으로 여는 표시를 남긴다.
export const PURIFY_CONFIG = { ADD_ATTR: ['target'] };
const escapeHtml = (s: string) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 링크·이미지에 허용하는 스킴. javascript:·data: 처럼 실행되거나 내용을 숨기는 것은 뺀다.
const SAFE_URL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

const marked = new Marked(
    markedHighlight({
        langPrefix: 'hljs language-',
        highlight(code: string, lang: string) {
            if (lang && hljs.getLanguage(lang)) {
                return hljs.highlight(code, { language: lang }).value;
            }
            return hljs.highlightAuto(code).value;
        },
    }),
    {
        renderer: {
            // 답변·도구 결과(DB 행·문서 본문)가 그대로 들어오므로 원시 HTML은 렌더하지 않고 글자로 보여준다.
            html({ text }) {
                return escapeHtml(text);
            },
            // 링크 여는 동작은 위임 핸들러가 맡는다 — 인라인 onclick은 href가 JS 문자열로 박혀 탈출 통로가 된다.
            link({ href, tokens }) {
                const label = this.parser.parseInline(tokens);
                if (!SAFE_URL.test(String(href).trim())) return label;
                return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
            },
            image({ href, text }) {
                if (!SAFE_URL.test(String(href).trim())) return escapeHtml(text);
                return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}">`;
            },
        },
    }
);

// marked가 CJK 경계·공백이 섞인 강조 표기를 놓치는 것을 미리 보정한다(펜스 코드블록 안은 손대지 않는다).
export function normalizeMarkdown(content: string): string {
    // Fix: marked fails to parse **bold**/*italic*/~~strike~~ with inner spaces or CJK word boundaries
    let fence: string | null = null;
    const fixed = content.split('\n').map(line => {
        // 펜스 코드블록(``` / ~~~) 안은 원문 그대로 — 아래 보정이 코드 본문을 건드리면 안 된다
        const fenceMark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fenceMark) {
            if (fence === null) fence = fenceMark[1];
            else if (fenceMark[1][0] === fence[0] && fenceMark[1].length >= fence.length && fenceMark[2].trim() === '') fence = null;
            return line;
        }
        if (fence !== null) return line;
        const codes: string[] = [];
        line = line.replace(/`[^`]+`/g, (m) => { codes.push(m); return '%%C' + (codes.length - 1) + '%%'; });
        // Bold
        //  \S+? 였을 때는 굵게 안에 공백이 있으면(**TQL(Transforming Query Language)**은) 매칭에 실패해
        //  공백이 안 붙고, marked가 CJK 경계에서 굵게를 포기해 별표가 그대로 보였다. [^*]+? 로 공백을 허용한다.
        line = line.replace(/\*\*\s*([^*]+?)\s*\*\*/g, '**$1**');
        line = line.replace(/(\*\*[^*]+?\*\*)(?=[가-힣a-zA-Z0-9])/g, '$1 ');
        // Bold+Italic (***)
        line = line.replace(/\*\*\*\s*([^*]+?)\s*\*\*\*/g, '***$1***');
        line = line.replace(/(\*\*\*[^*]+?\*\*\*)(?=[가-힣a-zA-Z0-9])/g, '$1 ');
        // Italic (single *)
        line = line.replace(/(?<!\*)\*\s+([^*]+?)\s*\*(?!\*)/g, '*$1*');
        line = line.replace(/(?<!\*)\*([^*]+?)\s+\*(?!\*)/g, '*$1*');
        line = line.replace(/((?<!\*)\*[^*]+?\*(?!\*))(?=[가-힣a-zA-Z0-9])/g, '$1 ');
        // Strikethrough
        line = line.replace(/~~\s*([^~]+?)\s*~~/g, '~~$1~~');
        line = line.replace(/(~~\S+?~~)(?=[가-힣a-zA-Z0-9])/g, '$1 ');
        // Fix: GFM은 홑물결 한 쌍도 취소선으로 본다 — 범위 표기 "0~45°C, pH 0~14"가
        // "0<del>45°C, pH 0</del>14"로 먹힌다. ~~ 쌍이 아닌 홑물결은 escape해 글자 그대로 남긴다.
        // URL과 링크 대상의 ~는 그대로 둔다(escape하면 주소가 깨진다).
        line = line.replace(/(\]\([^)]*\)|https?:\/\/\S+)|(?<!~)~(?!~)/g, (_m, keep) => keep ?? '\\~');
        // Fix: bare URL directly followed by Korean → marked's autolink swallows the Korean
        // (e.g. ".../machbase-neo/에서"). Insert a space so the link ends at the URL. Proper [text](url)
        // links are unaffected (URL there is followed by ')', not Korean); inline code is masked above.
        line = line.replace(/(https?:\/\/[\w\-._~:\/?#\[\]@!$&'()*+,;=%]+)(?=[가-힣])/g, '$1 ');
        line = line.replace(/%%C(\d+)%%/g, (_, i) => codes[parseInt(i)]);
        return line;
    }).join('\n');
    return fixed;
}

// 마크다운 → HTML. 결과는 반드시 호출부에서 DOMPurify.sanitize(..., PURIFY_CONFIG)를 거쳐야 한다.
export function renderMarkdown(content: string): string {
    return marked.parse(normalizeMarkdown(content)) as string;
}
