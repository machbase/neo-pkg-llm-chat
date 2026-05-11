import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import { ChatExecResult } from './ChatExecResult';

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
            link({ href, text }) {
                const escaped = href.replace(/"/g, '&quot;');
                return `<a href="${escaped}" onclick="event.preventDefault();(window.top||window).open('${escaped}','_blank')" rel="noopener noreferrer">${text}</a>`;
            },
        },
    }
);

interface RenderMdProps {
    content: string;
    isInterrupt: boolean;
    isProcess?: boolean;
    disableExec?: boolean;
}

type ExecLang = 'tql' | 'sql' | 'sh';

const LANG_NORMALIZE_MAP: Record<string, ExecLang> = {
    tql: 'tql',
    'machbase-tql': 'tql',
    machbase: 'tql',
    neo: 'tql',
    sql: 'sql',
    mysql: 'sql',
    pgsql: 'sql',
    psql: 'sql',
    // sh/shell/bash/zsh — 백엔드 응답 형식 정형화 전까지 비활성화. 일반 코드블록으로만 표시.
};

const normalizeLang = (raw: string | undefined): ExecLang | null => {
    if (!raw) return null;
    return LANG_NORMALIZE_MAP[raw.toLowerCase()] ?? null;
};

// lang prefix가 명시 안 됐거나 매칭 실패 시 코드 내용으로 TQL/SQL 추론
const TQL_KEYWORDS = /\b(FAKE|CHART(_LINE|_BAR|_SCATTER|_PIE)?|MAPVALUE|MAPKEY|MAPDATA|PUSHKEY|PUSHVALUE|TAKE|DROP|FILTER|GROUP|JSON|CSV|TENGO|SCRIPT|BYTES|STRING|TIMEWINDOW|oscillator|range)\s*\(/;
const SQL_KEYWORDS = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|EXEC)\b/i;
const detectLangFromCode = (code: string): ExecLang | null => {
    if (TQL_KEYWORDS.test(code)) return 'tql';
    if (SQL_KEYWORDS.test(code)) return 'sql';
    return null;
};

interface ActiveRoot {
    root: Root;
    container: HTMLDivElement;
}

export const RenderMd = ({ content, isInterrupt, isProcess = false, disableExec = false }: RenderMdProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const activeRoots = useRef<Map<HTMLElement, ActiveRoot>>(new Map());

    const html = useMemo(() => {
        if (isInterrupt || !content) return '';
        // Fix: marked fails to parse **bold**/*italic*/~~strike~~ with inner spaces or CJK word boundaries
        const fixed = content.split('\n').map(line => {
            const codes: string[] = [];
            line = line.replace(/`[^`]+`/g, (m) => { codes.push(m); return '%%C' + (codes.length - 1) + '%%'; });
            // Bold
            line = line.replace(/\*\*\s*([^*]+?)\s*\*\*/g, '**$1**');
            line = line.replace(/(\*\*\S+?\*\*)(?=[가-힣a-zA-Z0-9])/g, '$1 ');
            // Bold+Italic (***)
            line = line.replace(/\*\*\*\s*([^*]+?)\s*\*\*\*/g, '***$1***');
            line = line.replace(/(\*\*\*\S+?\*\*\*)(?=[가-힣a-zA-Z0-9])/g, '$1 ');
            // Italic (single *)
            line = line.replace(/(?<!\*)\*\s+([^*]+?)\s*\*(?!\*)/g, '*$1*');
            line = line.replace(/(?<!\*)\*([^*]+?)\s+\*(?!\*)/g, '*$1*');
            line = line.replace(/((?<!\*)\*[^*]+?\*(?!\*))(?=[가-힣a-zA-Z0-9])/g, '$1 ');
            // Strikethrough
            line = line.replace(/~~\s*([^~]+?)\s*~~/g, '~~$1~~');
            line = line.replace(/(~~\S+?~~)(?=[가-힣a-zA-Z0-9])/g, '$1 ');
            line = line.replace(/%%C(\d+)%%/g, (_, i) => codes[parseInt(i)]);
            return line;
        }).join('\n');
        return marked.parse(fixed) as string;
    }, [content, isInterrupt]);

    const COPY_ICON = `<svg viewBox="0 0 24 24" fill="rgba(255,255,255,0.5)" height="100%" width="100%">
        <path d="M20 2H10c-1.103 0-2 .897-2 2v4H4c-1.103 0-2 .897-2 2v10c0 1.103.897 2 2 2h10c1.103 0 2-.897 2-2v-4h4c1.103 0 2-.897 2-2V4c0-1.103-.897-2-2-2zM4 20V10h10l.002 10H4zm16-6h-4v-4c0-1.103-.897-2-2-2h-4V4h10v10z"/>
    </svg>`;

    // wrapperEl 안에 ChatExecResult를 createRoot으로 마운트. 같은 wrapper에 이미 root가 있으면 skip.
    const handleRun = useCallback((wrapperEl: HTMLElement, code: string, lang: ExecLang) => {
        if (activeRoots.current.has(wrapperEl)) return;
        wrapperEl.classList.add('swapped');
        const container = document.createElement('div');
        container.className = 'chat-code-result-container';
        wrapperEl.appendChild(container);
        const root = createRoot(container);
        root.render(<ChatExecResult code={code} lang={lang} />);
        activeRoots.current.set(wrapperEl, { root, container });
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !html) return;

        // html 재생성 시:
        //  (a) wrapper element 자체가 새로 만들어지면 이전 wrapper는 !isConnected
        //  (b) wrapper는 같은 reference인데 innerHTML re-set으로 자식 container만 wiped — wrapper.contains(container) === false
        // 둘 다 cleanup 후 재마운트 필요.
        for (const [wrapper, entry] of activeRoots.current) {
            const isWrapperGone = !wrapper.isConnected;
            const isContainerDetached = !wrapper.contains(entry.container);
            if (isWrapperGone || isContainerDetached) {
                entry.root.unmount();
                activeRoots.current.delete(wrapper);
            }
        }

        container.querySelectorAll('pre code').forEach((codeElement) => {
            const preElement = codeElement.parentElement as HTMLPreElement;
            if (!preElement) return;

            let wrapper = preElement.parentElement;
            if (!wrapper || !wrapper.classList.contains('code-block-wrapper')) {
                wrapper = document.createElement('div');
                wrapper.className = 'code-block-wrapper';
                preElement.parentElement?.insertBefore(wrapper, preElement);
                wrapper.appendChild(preElement);
            }

            if (!wrapper.querySelector(':scope > .code-copy-button')) {
                const copyButton = document.createElement('button');
                copyButton.className = 'code-copy-button';
                copyButton.innerHTML = COPY_ICON;

                copyButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const cloned = codeElement.cloneNode(true) as HTMLElement;
                    cloned.querySelectorAll('span[style*="user-select:none"]').forEach((el) => el.remove());
                    const code = cloned.textContent || '';

                    const showSuccess = () => {
                        copyButton.classList.add('copied');
                        copyButton.innerHTML = `<svg viewBox="0 0 24 24" fill="#71e071" height="100%" width="100%"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
                        setTimeout(() => { copyButton.classList.remove('copied'); copyButton.innerHTML = COPY_ICON; }, 2000);
                    };

                    const showError = () => {
                        copyButton.innerHTML = `<svg viewBox="0 0 24 24" fill="#ff5353" height="100%" width="100%"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
                        setTimeout(() => { copyButton.innerHTML = COPY_ICON; }, 2000);
                    };

                    try {
                        if (navigator.clipboard && window.isSecureContext) {
                            navigator.clipboard.writeText(code).then(showSuccess, showError);
                        } else {
                            const textarea = document.createElement('textarea');
                            textarea.value = code;
                            textarea.style.position = 'fixed';
                            textarea.style.opacity = '0';
                            document.body.appendChild(textarea);
                            textarea.select();
                            document.execCommand('copy');
                            document.body.removeChild(textarea);
                            showSuccess();
                        }
                    } catch {
                        showError();
                    }
                });

                wrapper.appendChild(copyButton);
            }

            // ─── lang 추출 — `language-...` 클래스에서 (순서 무관) ───
            const classList = codeElement.className.split(/\s+/);
            const langClass = classList.find((c) => c.startsWith('language-'));
            const rawLang = langClass?.slice('language-'.length);
            let normalizedLang = normalizeLang(rawLang);
            const wrapperEl = wrapper as HTMLElement;

            // ─── 코드 추출 (lang 없을 때 휴리스틱 fallback에 사용) ───
            const cloned = codeElement.cloneNode(true) as HTMLElement;
            cloned.querySelectorAll('span[style*="user-select:none"]').forEach((el) => el.remove());
            const code = cloned.textContent || '';

            // lang 매칭 실패 시 코드 내용 휴리스틱으로 TQL/SQL 추론
            if (!normalizedLang) {
                normalizedLang = detectLangFromCode(code);
            }

            const shouldMountRun =
                (normalizedLang === 'tql' || normalizedLang === 'sql' || normalizedLang === 'sh') &&
                !disableExec &&
                isProcess === false;

            // 자동 mount — DOM 상태 기반 idempotent. wrapper의 container가 detached/없으면 cleanup + 재마운트.
            if (shouldMountRun && normalizedLang) {
                handleRun(wrapperEl, code, normalizedLang);
            }
        });
    }); // 의존성 array 없음 — 매 render마다 sync. dangerouslySetInnerHTML re-set으로 인한 자식 wipe도 즉시 감지.

    // dangerouslySetInnerHTML 객체 reference 안정화 — html string 동일이면 React가 innerHTML re-set skip.
    const dangerousHTML = useMemo(() => ({ __html: html }), [html]);

    // RenderMd unmount 시 모든 active root cleanup
    useEffect(() => {
        const map = activeRoots.current;
        return () => {
            for (const entry of map.values()) {
                entry.root.unmount();
            }
            map.clear();
        };
    }, []);

    return (
        <>
            <div
                ref={containerRef}
                className="chat-markdown markdown-body"
                style={{ display: 'flex', flexDirection: 'column', width: '100%' }}
                dangerouslySetInnerHTML={dangerousHTML}
            />
        </>
    );
};
