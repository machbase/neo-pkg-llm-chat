import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

interface Props {
    /** 실행 중인 도구 이름 — 답변 생성 대기 땐 없음 */
    toolName?: string;
    /** 도구 시작 시각 — 실시간 경과 표시용 */
    startedAt?: number;
}

/** 도구 실행 중 경과 시간 — 소수 한 자리(읽을 수 있는 갱신 속도) */
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
