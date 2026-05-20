import { useEffect, useRef, useState } from 'react';
import { useTqlExec } from '../../hooks/useTqlExec';
import { ErrorBanner } from './ErrorBanner';
import { ResultTableView } from './result/ResultTableView';
import { ResultChartView } from './result/ResultChartView';
import { ResultHtmlView } from './result/ResultHtmlView';

interface ChatExecResultProps {
    code: string;
    lang: 'tql' | 'sql' | 'sh';
}

type ResultView = 'result' | 'code';

/** text payload가 JSON parseable이면 pretty print, 아니면 그대로. */
const formatTextPayload = (text: string): string => {
    const trimmed = text.trim();
    if (!trimmed) return text;
    const first = trimmed[0];
    // JSON object/array로 시작할 때만 parse 시도 (불필요한 try/catch 최소화)
    if (first !== '{' && first !== '[') return text;
    try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
        return text;
    }
};

/**
 * RenderMd가 TQL/SQL 코드 블록 발견 시 자동 마운트하는 결과 컴포넌트.
 *  - 마운트 시 자동 fetch 안 함 — Result 토글 첫 클릭 시 실행 (사용자 명시 액션 트리거).
 *  - 기본 view는 'code' (Code view는 status 무관 항상 코드 표시 + 카피 버튼).
 *  - 토글 라벨은 항상 'Result' / 'Code' (동적 변환 없음).
 *  - abort 미지원: 30s timeout 자체로 충분.
 */
export const ChatExecResult = ({ code, lang }: ChatExecResultProps) => {
    const { status, result, error, runRef, cancelRef } = useTqlExec({ code, lang });
    const [view, setView] = useState<ResultView>('code');
    const [copied, setCopied] = useState(false);
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        };
    }, []);

    // Result 토글 클릭 — 매번 새 fetch 실행 (사용자가 명시적으로 재실행 의도).
    const handleShowResult = () => {
        runRef.current?.();
        setView('result');
    };

    // Code 토글 클릭 — 실행 중이면 abort (사용자가 결과 안 보겠다는 의도).
    const handleShowCode = () => {
        if (status === 'loading') cancelRef.current?.();
        setView('code');
    };

    const handleAbort = () => {
        cancelRef.current?.();
        setView('code');
    };

    const handleCopyCode = async () => {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(code);
            } else {
                // fallback for non-secure contexts
                const textarea = document.createElement('textarea');
                textarea.value = code;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
            }
            setCopied(true);
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
            copyTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
        } catch {
            // ignore
        }
    };

    // Result/Code 토글은 항상 노출 — Result 클릭이 첫 실행 트리거

    const codeBlock = (
        <div className="chat-exec-result__code-block">
            <button
                type="button"
                className={`chat-exec-result__copy ${copied ? 'is-copied' : ''}`}
                onClick={handleCopyCode}
                title={copied ? '복사됨' : '코드 복사'}
                aria-label="코드 복사"
            >
                {copied ? '✓' : 'Copy'}
            </button>
            <pre className="chat-exec-result__code-fallback">{code}</pre>
        </div>
    );

    return (
        <div className="chat-exec-result">
            <div className="chat-exec-result__header">
                <div className="chat-exec-result__toggle-group" role="tablist">
                    <button
                        type="button"
                        className={`chat-code-view-toggle ${view === 'code' ? 'is-active' : ''}`}
                        onClick={handleShowCode}
                        role="tab"
                        aria-selected={view === 'code'}
                    >
                        Code
                    </button>
                    <button
                        type="button"
                        className={`chat-code-view-toggle ${view === 'result' ? 'is-active' : ''}`}
                        onClick={handleShowResult}
                        role="tab"
                        aria-selected={view === 'result'}
                    >
                        Run
                    </button>
                </div>
            </div>

            <div className="chat-exec-result__body">
                {/* Code view — status 무관 항상 코드 표시 (idle/loading/success/error 모두) */}
                {view === 'code' && codeBlock}

                {view === 'result' && (
                    <>
                        {(status === 'idle' || status === 'loading') && (
                            <div className="chat-exec-result__loading">
                                <span className="chat-exec-result__spinner" />
                                <span>실행 중…</span>
                                {status === 'loading' && (
                                    <button
                                        type="button"
                                        className="chat-exec-result__abort"
                                        onClick={handleAbort}
                                        aria-label="실행 중단"
                                    >
                                        Abort
                                    </button>
                                )}
                            </div>
                        )}
                        {status === 'success' && result && (
                            <>
                                {result.kind === 'chart' && <ResultChartView data={result.payload} />}
                                {result.kind === 'table' && <ResultTableView data={result.payload} />}
                                {result.kind === 'html' && <ResultHtmlView data={result.payload} />}
                                {result.kind === 'text' && (
                                    <pre className="chat-exec-result__text">{formatTextPayload(result.payload.text)}</pre>
                                )}
                            </>
                        )}
                        {status === 'error' && error && (
                            <ErrorBanner message={`[${error.kind}] ${error.message}`} />
                        )}
                    </>
                )}
            </div>
        </div>
    );
};
