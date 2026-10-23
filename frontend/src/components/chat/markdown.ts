// 채팅 마크다운 렌더 파이프라인 — RenderMd(브라우저)·회귀 테스트(node) 공용
// · 입력은 모델 답변·도구 결과(DB 행·문서 본문) 원문 → 결과 HTML에 실행 가능한 것 잔존 금지
// · 1차 방어(원시 HTML 차단·스킴 제한), 2차는 호출부 DOMPurify
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import dos from 'highlight.js/lib/languages/dos';
import go from 'highlight.js/lib/languages/go';
import groovy from 'highlight.js/lib/languages/groovy';
import http from 'highlight.js/lib/languages/http';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import nginx from 'highlight.js/lib/languages/nginx';
import pgsql from 'highlight.js/lib/languages/pgsql';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// 코드블록 하이라이트 언어 — 답변·문서에 나오는 언어 + 흔한 언어만 등록
// · 별칭(sh·js·py·cs·html·yml·text 등)은 각 언어 정의에 포함
// · 언어 표시가 없거나 모르는 언어(tql·csv 등)의 자동 추측도 이 목록 안에서만 함
const LANGUAGES = {
    bash, c, cpp, csharp, css, diff, dockerfile, dos, go, groovy, http, ini, java, javascript, json, kotlin,
    markdown, nginx, pgsql, php, plaintext, powershell, python, r, ruby, rust, scala, shell, sql, swift,
    typescript, xml, yaml,
};
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);

// target 속성 유지 — DOMPurify 기본값은 target 제거
export const PURIFY_CONFIG = { ADD_ATTR: ['target'] };
const escapeHtml = (s: string) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 링크·이미지 허용 스킴 — javascript:·data: 등 실행·내용 은닉 스킴 제외
const SAFE_URL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

// Neo 대시보드 링크(/web/ui/board/...)는 지금 접속한 주소로 — 백엔드는 설정의 Machbase 호스트로 만들어 줌
// · 그 밖의 링크(외부 사이트·상대 경로)는 그대로
const BOARD_PATH = /^\/web\/ui\/board\//;
export function boardLinkToOrigin(href: string, origin?: string): string {
    const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
    if (!base) return href;
    let url: URL;
    try { url = new URL(href); } catch { return href; }
    if (!/^https?:$/.test(url.protocol) || !BOARD_PATH.test(url.pathname)) return href;
    return base + url.pathname + url.search + url.hash;
}

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
            // 원시 HTML은 글자로 표시 — 답변·도구 결과(DB 행·문서 본문) 원문이 그대로 들어옴
            html({ text }) {
                return escapeHtml(text);
            },
            // href·target만 출력, 여는 동작은 위임 핸들러 담당 — 인라인 onclick의 href 탈출 통로 방지
            link({ href, tokens }) {
                const label = this.parser.parseInline(tokens);
                if (!SAFE_URL.test(String(href).trim())) return label;
                return `<a href="${escapeHtml(boardLinkToOrigin(href))}" target="_blank" rel="noopener noreferrer">${label}</a>`;
            },
            image({ href, text }) {
                if (!SAFE_URL.test(String(href).trim())) return escapeHtml(text);
                return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}">`;
            },
        },
    }
);

// marked가 놓치는 CJK 경계·내부 공백 강조 표기(**·*·~~) 사전 보정 — 펜스 코드블록 안은 제외
export function normalizeMarkdown(content: string): string {
    let fence: string | null = null;
    const fixed = content.split('\n').map(line => {
        // 펜스 코드블록(``` / ~~~) 안은 원문 유지
        const fenceMark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fenceMark) {
            if (fence === null) fence = fenceMark[1];
            else if (fenceMark[1][0] === fence[0] && fenceMark[1].length >= fence.length && fenceMark[2].trim() === '') fence = null;
            return line;
        }
        if (fence !== null) return line;
        const codes: string[] = [];
        line = line.replace(/`[^`]+`/g, (m) => { codes.push(m); return '%%C' + (codes.length - 1) + '%%'; });
        // Bold — [^*]+? 로 내부 공백 허용(예: **TQL(Transforming Query Language)**은)
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
        // 홑물결 escape — GFM의 홑물결 쌍 취소선 처리 방지(범위 표기 "0~45°C, pH 0~14")
        // · URL·링크 대상의 ~는 유지(주소 깨짐 방지)
        line = line.replace(/(\]\([^)]*\)|https?:\/\/\S+)|(?<!~)~(?!~)/g, (_m, keep) => keep ?? '\\~');
        // 한글이 바로 붙은 bare URL 뒤 공백 삽입 — autolink가 한글까지 삼키는 것 방지(예: ".../machbase-neo/에서")
        line = line.replace(/(https?:\/\/[\w\-._~:\/?#\[\]@!$&'()*+,;=%]+)(?=[가-힣])/g, '$1 ');
        line = line.replace(/%%C(\d+)%%/g, (_, i) => codes[parseInt(i)]);
        return line;
    }).join('\n');
    return fixed;
}

// 마크다운 → HTML — 호출부에서 DOMPurify.sanitize(..., PURIFY_CONFIG) 필수
export function renderMarkdown(content: string): string {
    return marked.parse(normalizeMarkdown(content)) as string;
}
