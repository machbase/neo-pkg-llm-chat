import { useState } from 'react';
import type { Message, UserMessageAlign } from '../../types/chat';
import { ChatMessageItem } from './ChatMessageItem';
import { LoadingDots } from './LoadingDots';
import { RenderMd } from './RenderMd';
import Icon from '../common/Icon';

interface ChatMessageListProps {
    messages: Message[];
    isProcessingAnswer?: boolean;
    userMessageAlign?: UserMessageAlign;
    scrollRef?: React.RefObject<HTMLDivElement | null>;
    /** Forwarded to ChatMessageItem for the inline edit affordance. */
    onEdit?: (messageId: string, newContent: string) => void;
    /** Forwarded to ChatMessageItem; gates whether the pencil icon is rendered. */
    canEdit?: boolean;
    /** Follow-up chips for the last answer; empty while none have arrived. */
    followups?: string[];
    onPickFollowup?: (prompt: string) => void;
}

interface ToolRun {
    callMessage: Message;
    resultMessage?: Message;
}

/** Consecutive runs of one tool, collapsed behind a single chip. */
interface ToolGroup {
    name: string;
    runs: ToolRun[];
}

type DisplayItem = { kind: 'message'; message: Message }
    | { kind: 'tool'; group: ToolGroup };

const isToolCall = (msg: Message) =>
    msg.role === 'assistant' && msg.type === 'block' && msg.content.includes('🛠️');

/** 표 결과(list_tables 등) — 코드펜스가 아니라 마크다운 표로 온다. */
const isMarkdownTable = (content: string) => /^\s*\|.*\|\s*\r?\n\s*\|[-\s|:]+\|/.test(content);

const isToolResult = (msg: Message) =>
    msg.role === 'assistant' && msg.type === 'block' && !msg.content.includes('🛠️') &&
    (msg.content.trimStart().startsWith('```') || isMarkdownTable(msg.content));

/** Extract tool name from "🛠️ Calling tool: **tool_name**" */
const extractToolName = (content: string): string => {
    const match = content.match(/\*\*([^*]+)\*\*/);
    return match ? match[1] : 'tool';
};

/**
 * Wall time between the call block and its result block arriving. That covers
 * the tool run plus its round trip, not the tool body alone — it is the only
 * timing the stream exposes.
 */
const formatDuration = (ms: number): string =>
    ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

/** Summed over the runs that actually returned; null when none did. */
const totalElapsed = (runs: ToolRun[]): number | null => {
    let total = 0;
    let measured = 0;
    for (const run of runs) {
        if (!run.resultMessage) continue;
        const ms = run.resultMessage.timestamp - run.callMessage.timestamp;
        if (ms < 0) continue;
        total += ms;
        measured += 1;
    }
    return measured > 0 ? total : null;
};

const ToolCallGroup = ({ group }: { group: ToolGroup }) => {
    // 표는 최종 답변에 들어가므로 도구 블록은 접어 둔다(같은 표가 두 번 보이지 않게).
    const [open, setOpen] = useState(false);
    const count = group.runs.length;
    const elapsed = totalElapsed(group.runs);

    return (
        <div className="chat-msg chat-msg--assistant">
            <div className="chat-msg-bubble chat-msg-bubble--assistant chat-tool-bubble">
                <button
                    className={`chat-tool-toggle ${open ? 'chat-tool-toggle--open' : ''}`}
                    onClick={() => setOpen(!open)}
                >
                    <span className="chat-tool-emoji">🛠️</span>
                    <span className="chat-tool-name">{group.name}</span>
                    {count > 1 && <span className="chat-tool-count">×{count}</span>}
                    {elapsed !== null && (
                        <>
                            <span className="chat-tool-sep">·</span>
                            <span className="chat-tool-dur">{formatDuration(elapsed)}</span>
                        </>
                    )}
                    <Icon name="chevron_right" className="icon-sm chat-tool-chevron" />
                </button>
                {open && (
                    <div className="chat-tool-detail">
                        {group.runs.map((run, idx) => (
                            <div key={run.callMessage.id} className="chat-tool-run">
                                {count > 1 && <div className="chat-tool-run-label">{idx + 1} / {count}</div>}
                                <RenderMd content={run.callMessage.content} isInterrupt={false} />
                                {run.resultMessage && (
                                    <RenderMd content={run.resultMessage.content} isInterrupt={false} />
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

function buildDisplayItems(messages: Message[]): DisplayItem[] {
    const items: DisplayItem[] = [];
    let i = 0;

    while (i < messages.length) {
        const msg = messages[i];

        // Tool call → pair with next result block
        if (isToolCall(msg)) {
            const run: ToolRun = { callMessage: msg };
            if (i + 1 < messages.length && isToolResult(messages[i + 1])) {
                run.resultMessage = messages[i + 1];
                i += 2;
            } else {
                i += 1;
            }
            const name = extractToolName(msg.content);
            // Only fold runs that are adjacent — merging across an intervening
            // tool would reorder what actually happened.
            const last = items[items.length - 1];
            if (last && last.kind === 'tool' && last.group.name === name) {
                last.group.runs.push(run);
            } else {
                items.push({ kind: 'tool', group: { name, runs: [run] } });
            }
            continue;
        }

        items.push({ kind: 'message', message: msg });
        i += 1;
    }

    return items;
}

export const ChatMessageList = ({
    messages,
    isProcessingAnswer = false,
    userMessageAlign = 'left',
    scrollRef,
    onEdit,
    canEdit,
    followups = [],
    onPickFollowup,
}: ChatMessageListProps) => {
    const items = buildDisplayItems(messages);
    // A tool whose result block has not arrived yet is the thing being waited on.
    // Only the tail can be pending — anything earlier already returned.
    const tail = items[items.length - 1];
    const tailRun = tail?.kind === 'tool' ? tail.group.runs[tail.group.runs.length - 1] : undefined;
    const pending = tailRun && !tailRun.resultMessage
        ? { name: (tail as { group: ToolGroup }).group.name, startedAt: tailRun.callMessage.timestamp }
        : undefined;

    return (
        <div ref={scrollRef} className="chat-messages">
            {items.map((item) => {
                if (item.kind === 'tool') {
                    return (
                        <div className="chat-message-item-wrap" key={item.group.runs[0].callMessage.id}>
                            <ToolCallGroup group={item.group} />
                        </div>
                    );
                }
                return (
                    <div className="chat-message-item-wrap" key={item.message.id}>
                        <ChatMessageItem
                            message={item.message}
                            userMessageAlign={userMessageAlign}
                            onEdit={onEdit}
                            canEdit={canEdit}
                        />
                    </div>
                );
            })}
            {isProcessingAnswer && (
                <div className="chat-loading-wrap">
                    <LoadingDots toolName={pending?.name} startedAt={pending?.startedAt} />
                </div>
            )}
            {!isProcessingAnswer && followups.length > 0 && onPickFollowup && (
                <div className="chat-message-item-wrap">
                    <div className="chat-followups">
                        {followups.map((text) => (
                            <button
                                key={text}
                                type="button"
                                className="chat-followup-chip"
                                onClick={() => onPickFollowup(text)}
                            >
                                {text}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            <div className="chat-messages-anchor" />
        </div>
    );
};
