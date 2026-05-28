import { useEffect, useRef, useState } from "react";
import type { Message, UserMessageAlign } from "../../types/chat";
import { RenderMd } from "./RenderMd";
import { ErrorBanner } from "./ErrorBanner";
import Icon from "../common/Icon";
import neoLogo from "../../assets/image/neowFavicon";

interface ChatMessageItemProps {
    message: Message;
    userMessageAlign?: UserMessageAlign;
    /**
     * Invoked when the user saves an edited user-message.
     * Receives the message id and the new (trimmed) content.
     * Phase 1 wired the data path; Phase 2 surfaces the pencil + editor UI.
     */
    onEdit?: (messageId: string, newContent: string) => void;
    /**
     * Controls whether the pencil icon is rendered at all. The parent gates this
     * on `!isProcessingAnswer && isConnected`. Phase 3 may strengthen DOM
     * removal; for now we conditionally render.
     */
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
    const showAvatar = isAssistant && message.type !== "msg";

    // Local edit state — strictly per-item. Never reuse usePkgChat's shared
    // isComposingRef here: that ref tracks the main input's IME composition,
    // and sharing it would corrupt either side's Enter-vs-newline behavior.
    const [isEditing, setIsEditing] = useState(false);
    const [draft, setDraft] = useState(message.content);
    const isComposingRef = useRef(false);
    // One-frame guard after compositionend: some browsers (older WebKit,
    // certain Korean IMEs) emit the Enter keydown that finalized the composition
    // *after* compositionend fires, so isComposingRef has already flipped to
    // false. We hold this guard true until the next frame to absorb that Enter.
    const justComposedRef = useRef(false);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const bubbleRef = useRef<HTMLDivElement | null>(null);

    // Show the pencil only on user, non-process messages, and only when the
    // parent has granted edit capability.
    const showEditAffordance = isUser && !message.isProcess && canEdit && !!onEdit;

    useEffect(() => {
        if (!isEditing) return;
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        // Place cursor at end of the existing content.
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
    }, [isEditing]);

    // If the parent revokes edit capability mid-edit (e.g. a new stream starts
    // and isProcessingAnswer flips to true, or the WS disconnects), bail out of
    // edit mode so the user isn't left typing into a dead affordance.
    useEffect(() => {
        if (isEditing && !canEdit) {
            setIsEditing(false);
        }
    }, [canEdit, isEditing]);

    // Click outside the editing bubble dismisses edit mode (discards draft).
    // Use mousedown so the dismiss fires before focus shifts to the click
    // target — matches how popovers/menus typically behave.
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
        // Shift+Enter falls through to default textarea behavior (newline).
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
            {isAssistant && (
                <div className="chat-msg-avatar chat-msg-avatar--assistant">
                    {showAvatar ? (
                        <img src={neoLogo} alt="Neo" className="chat-msg-avatar-img" />
                    ) : (
                        <span className={`chat-msg-dot ${message.isProcess ? "chat-msg-dot--active" : ""}`} />
                    )}
                </div>
            )}
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
                                // Hold the guard until the next frame so a
                                // trailing Enter keydown (fired after
                                // compositionend in some IMEs/browsers) is
                                // absorbed instead of committing the edit.
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
                            <RenderMd content={message.content} isInterrupt={message.isInterrupt} isProcess={message.isProcess} />
                        )}
                        {showEditAffordance && (
                            <button type="button" className="chat-msg-edit-btn" onClick={beginEdit} aria-label="Edit message" title="Edit message">
                                <Icon name="edit" className="icon-sm" />
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};
