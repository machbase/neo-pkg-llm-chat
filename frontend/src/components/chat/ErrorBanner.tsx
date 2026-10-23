import Icon from '../common/Icon';

interface ErrorBannerProps {
    message: string;
}

export const ErrorBanner = ({ message }: ErrorBannerProps) => {
    if (!message || message.length === 0) return null;

    return (
        <div className="chat-error-banner">
            <Icon name="error" className="chat-error-banner-icon" />
            <div className="chat-error-banner-body">
                <div className="chat-error-banner-message">{message}</div>
            </div>
        </div>
    );
};
