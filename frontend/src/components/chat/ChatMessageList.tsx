import { useState } from 'react';
import type { Message, UserMessageAlign } from '../../types/chat';
import { ChatMessageItem } from './ChatMessageItem';
import { LoadingDots } from './LoadingDots';
import { RenderMd } from './RenderMd';
import Icon from '../common/Icon';
import neoLogo from '../../assets/image/neowFavicon';

interface ChatMessageListProps {
    messages: Message[];
    isProcessingAnswer?: boolean;
    userMessageAlign?: UserMessageAlign;
    scrollRef?: React.RefObject<HTMLDivElement | null>;
}

interface ToolGroup {
    callMessage: Message;
    resultMessage?: Message;
}

type DisplayItem = { kind: 'message'; message: Message }
    | { kind: 'tool'; group: ToolGroup };

const isToolCall = (msg: Message) =>
    msg.role === 'assistant' && msg.type === 'block' && msg.content.includes('🛠️');

const isToolResult = (msg: Message) =>
    msg.role === 'assistant' && msg.type === 'block' && !msg.content.includes('🛠️') && msg.content.trimStart().startsWith('```');

/** Extract tool name from "🛠️ Calling tool: **tool_name**" */
const extractToolName = (content: string): string => {
    const match = content.match(/\*\*([^*]+)\*\*/);
    return match ? match[1] : 'tool';
};

const ToolCallGroup = ({ group }: { group: ToolGroup }) => {
    const [open, setOpen] = useState(false);
    const toolName = extractToolName(group.callMessage.content);

    return (
        <div className="chat-msg chat-msg--assistant">
            <div className="chat-msg-avatar chat-msg-avatar--assistant">
                <img src={neoLogo} alt="Neo" className="chat-msg-avatar-img" />
            </div>
            <div className="chat-msg-bubble chat-msg-bubble--assistant chat-tool-bubble">
                <button
                    className="chat-tool-toggle"
                    onClick={() => setOpen(!open)}
                >
                    <span className="chat-tool-name">🛠️ {toolName}</span>
                    <Icon name={open ? 'expand_less' : 'expand_more'} className="icon-sm" />
                </button>
                {open && (
                    <div className="chat-tool-detail">
                        <RenderMd content={group.callMessage.content} isInterrupt={false} />
                        {group.resultMessage && (
                            <RenderMd content={group.resultMessage.content} isInterrupt={false} />
                        )}
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
            const toolGrp: ToolGroup = { callMessage: msg };
            if (i + 1 < messages.length && isToolResult(messages[i + 1])) {
                toolGrp.resultMessage = messages[i + 1];
                i += 2;
            } else {
                i += 1;
            }
            items.push({ kind: 'tool', group: toolGrp });
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
}: ChatMessageListProps) => {
    const items = buildDisplayItems(messages);

    return (
        <div ref={scrollRef} className="chat-messages">
            {items.map((item) => {
                if (item.kind === 'tool') {
                    return (
                        <div className="chat-message-item-wrap" key={item.group.callMessage.id}>
                            <ToolCallGroup group={item.group} />
                        </div>
                    );
                }
                return (
                    <div className="chat-message-item-wrap" key={item.message.id}>
                        <ChatMessageItem message={item.message} userMessageAlign={userMessageAlign} />
                    </div>
                );
            })}
            {isProcessingAnswer && (
                <div className="chat-loading-wrap">
                    <LoadingDots />
                </div>
            )}
            <div className="chat-messages-anchor" />
        </div>
    );
};
