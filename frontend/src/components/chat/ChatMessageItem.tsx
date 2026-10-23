import { useEffect, useRef, useState } from "react";
import type { Message, UserMessageAlign } from "../../types/chat";
import { RenderMd } from "./RenderMd";
import { ErrorBanner } from "./ErrorBanner";
import Icon from "../common/Icon";

/** 24-hour wall clock, e.g. "14:22". */
const formatClock = (ts: number) =>
    new Date(ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

interface ChatMessageItemProps {
    message: Message;
    userMessageAlign?: UserMessageAlign;
    /** 수정한 사용자 메시지 저장 시 호출 — (메시지 id, trim된 새 내용) */
    onEdit?: (messageId: string, newContent: string) => void;
    /** 연필 아이콘 표시 여부 */
    canEdit?: boolean;
}

export const ChatMessageItem = ({ message, userMessageAlign = "left", onEdit, canEdit = false }: ChatMessageItemProps) => {
    if (message.type === "error") {
        return (
            <div className="chat-msg chat-msg--error">
                <ErrorBanner message={message.content} />
            </div>
        );
    }

    const isUser = message.role === "user";
    const isAssistant = message.role === "assistant";
    // 하단 메타 — 모델 표시가 있는 완료 답변에만
    const showMeta = isAssistant && !!message.model && !message.isProcess;

    // 항목별 편집 상태 — 본 입력창의 IME 조합 ref와 공유 금지(Enter·줄바꿈 판정 오염)
    const [isEditing, setIsEditing] = useState(false);
    const [draft, setDraft] = useState(message.content);
    const isComposingRef = useRef(false);
    // compositionend 후 한 프레임 Enter 무시 — 일부 브라우저·한글 IME가 조합 확정 Enter를 compositionend 뒤에 발생
    const justComposedRef = useRef(false);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const bubbleRef = useRef<HTMLDivElement | null>(null);

    // 연필 아이콘 — 완료된 사용자 메시지 + 편집 허용 시만
    const showEditAffordance = isUser && !message.isProcess && canEdit && !!onEdit;

    useEffect(() => {
        if (!isEditing) return;
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        // 커서를 내용 끝으로
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
    }, [isEditing]);

    // 편집 중 편집 권한 회수(새 스트림 시작·WS 끊김) 시 편집 모드 종료
    useEffect(() => {
        if (isEditing && !canEdit) {
            setIsEditing(false);
        }
    }, [canEdit, isEditing]);

    // 말풍선 밖 클릭 시 편집 취소(초안 폐기) — mousedown 사용, 포커스 이동 전 처리
    useEffect(() => {
        if (!isEditing) return;
        const handlePointerDown = (e: MouseEvent) => {
            const node = bubbleRef.current;
            if (!node) return;
            if (node.contains(e.target as Node)) return;
            setDraft(message.content);
            setIsEditing(false);
        };
        document.addEventListener("mousedown", handlePointerDown);
        return () => document.removeEventListener("mousedown", handlePointerDown);
    }, [isEditing, message.content]);

    const beginEdit = () => {
        setDraft(message.content);
        setIsEditing(true);
    };

    const cancelEdit = () => {
        setDraft(message.content);
        setIsEditing(false);
    };

    const trimmedDraft = draft.trim();
    const isSaveDisabled = trimmedDraft === "" || trimmedDraft === message.content;

    const commitEdit = () => {
        if (isSaveDisabled) return;
        onEdit?.(message.id, trimmedDraft);
        setIsEditing(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Escape") {
            e.preventDefault();
            cancelEdit();
            return;
        }
        if (e.key === "Enter" && !e.shiftKey && !isComposingRef.current && !justComposedRef.current) {
            e.preventDefault();
            commitEdit();
        }
        // Shift+Enter는 기본 동작(줄바꿈)
    };

    const bubbleClass = [
        "chat-msg-bubble",
        isUser ? "chat-msg-bubble--user" : "chat-msg-bubble--assistant",
        showEditAffordance ? "chat-msg-bubble--editable" : "",
        isEditing ? "chat-msg-bubble--editing" : "",
    ]
        .filter(Boolean)
        .join(" ");

    return (
        <div className={`chat-msg ${isUser ? "chat-msg--user" : "chat-msg--assistant"} ${isUser ? `chat-msg--${userMessageAlign}` : ""}`}>
            <div ref={bubbleRef} className={bubbleClass}>
                {isEditing ? (
                    <div className="chat-msg-edit">
                        <div className="chat-msg-edit-header">
                            <span className="chat-msg-edit-badge">
                                <Icon name="edit" className="icon-sm" />
                                메시지 수정 중
                            </span>
                        </div>
                        <textarea
                            ref={textareaRef}
                            className="chat-msg-edit-textarea"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onCompositionStart={() => {
                                isComposingRef.current = true;
                                justComposedRef.current = true;
                            }}
                            onCompositionEnd={() => {
                                isComposingRef.current = false;
                                // 다음 프레임까지 가드 유지 — 조합 확정 뒤 오는 Enter로 저장되는 것 방지
                                justComposedRef.current = true;
                                if (typeof requestAnimationFrame === "function") {
                                    requestAnimationFrame(() => {
                                        justComposedRef.current = false;
                                    });
                                } else {
                                    setTimeout(() => {
                                        justComposedRef.current = false;
                                    }, 0);
                                }
                            }}
                            onKeyDown={handleKeyDown}
                            rows={Math.min(8, Math.max(2, draft.split("\n").length))}
                        />
                        <div className="chat-msg-edit-actions">
                            <button type="button" className="chat-msg-edit-btn--cancel" onClick={cancelEdit}>
                                취소
                            </button>
                            <button type="button" className="chat-msg-edit-btn--save" onClick={commitEdit} disabled={isSaveDisabled}>
                                저장하고 다시 묻기
                                <Icon name="arrow_forward" className="icon-sm" />
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        {message.isProcess || isUser ? (
                            <div className="chat-msg-text">{message.content}</div>
                        ) : (
                            <RenderMd content={message.content} isInterrupt={message.isInterrupt} />
                        )}
                        {showEditAffordance && (
                            <button type="button" className="chat-msg-edit-btn" onClick={beginEdit} aria-label="Edit message" title="Edit message">
                                <Icon name="edit" className="icon-sm" />
                            </button>
                        )}
                        {showMeta && (
                            <div className="chat-msg-meta">
                                {message.model}
                                <span className="chat-msg-meta-sep">·</span>
                                {formatClock(message.timestamp)}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};
