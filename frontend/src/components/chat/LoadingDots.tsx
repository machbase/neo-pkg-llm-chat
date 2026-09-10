import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

interface Props {
    /** Tool currently running, when the wait is a tool call rather than generation. */
    toolName?: string;
    /** When that tool started, for the live clock. */
    startedAt?: number;
}

/** Ticks while a tool runs; one decimal is slow enough to read. */
const formatLive = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export const LoadingDots = ({ toolName, startedAt }: Props) => {
    const isTiming = !!toolName && typeof startedAt === 'number';
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!isTiming) return;
        const id = setInterval(() => setNow(Date.now()), 100);
        return () => clearInterval(id);
    }, [isTiming, startedAt]);

    return (
        <div className="chat-loading">
            <Icon name="progress_activity" className="chat-spin chat-loading-spinner" />
            <div className="chat-loading-text">
                <span className="chat-loading-label">Thinking...</span>
                {isTiming && (
                    <span className="chat-loading-tool">
                        {toolName}
                        <span className="chat-loading-sep">·</span>
                        {formatLive(Math.max(0, now - (startedAt as number)))}
                    </span>
                )}
            </div>
        </div>
    );
};
