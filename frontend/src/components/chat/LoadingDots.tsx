import neoLogo from '../../assets/image/neowFavicon';

export const LoadingDots = () => (
    <div className="chat-loading">
        <div className="chat-msg-avatar chat-msg-avatar--assistant">
            <img src={neoLogo} alt="Neo" className="chat-msg-avatar-img" />
        </div>
        <div className="chat-loading-dots">
            <span className="chat-loading-dot" />
            <span className="chat-loading-dot" />
            <span className="chat-loading-dot" />
        </div>
    </div>
);
