import type { Message, UserMessageAlign } from '../../types/chat';
import { RenderMd } from './RenderMd';
import { ErrorBanner } from './ErrorBanner';
import neoLogo from '../../assets/image/neowFavicon';

interface ChatMessageItemProps {
    message: Message;
    userMessageAlign?: UserMessageAlign;
}

export const ChatMessageItem = ({ message, userMessageAlign = 'left' }: ChatMessageItemProps) => {
    if (message.type === 'error') {
        return (
            <div className="chat-msg chat-msg--error">
                <ErrorBanner message={message.content} />
            </div>
        );
    }

    const isUser = message.role === 'user';
    const isAssistant = message.role === 'assistant';
    const showAvatar = isAssistant && message.type !== 'msg';

    return (
        <div className={`chat-msg ${isUser ? 'chat-msg--user' : 'chat-msg--assistant'} ${isUser ? `chat-msg--${userMessageAlign}` : ''}`}>
            {isAssistant && (
                <div className="chat-msg-avatar chat-msg-avatar--assistant">
                    {showAvatar ? (
                        <img src={neoLogo} alt="Neo" className="chat-msg-avatar-img" />
                    ) : (
                        <span className={`chat-msg-dot ${message.isProcess ? 'chat-msg-dot--active' : ''}`} />
                    )}
                </div>
            )}
            <div className={`chat-msg-bubble ${isUser ? 'chat-msg-bubble--user' : 'chat-msg-bubble--assistant'}`}>
                {message.isProcess || isUser ? (
                    <div className="chat-msg-text">{message.content}</div>
                ) : (
                    <RenderMd content={message.content} isInterrupt={message.isInterrupt} isProcess={message.isProcess} />
                )}
            </div>
        </div>
    );
};
