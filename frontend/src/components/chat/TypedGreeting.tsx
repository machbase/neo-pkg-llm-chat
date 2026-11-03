import { useEffect, useRef, useState } from 'react';

interface Props {
    /** 타이핑할 문구 — 바뀌면 새 문구로 사이클 재시작 */
    text: string;
    /** 타이핑·지우기 완료 후 다음 문구 요청 */
    onCycle: () => void;
    /** 문구 클릭 — 사이클 대기 없이 바로 넘김 */
    onClick: () => void;
}

const TYPE_MS = 70;
const DELETE_MS = 30;
const HOLD_MS = 2600;

type Phase = 'typing' | 'holding' | 'deleting';

const prefersReducedMotion = () =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const TypedGreeting = ({ text, onCycle, onClick }: Props) => {
    const still = prefersReducedMotion();
    const chars = [...text];
    const [count, setCount] = useState(still ? chars.length : 0);
    const [phase, setPhase] = useState<Phase>(still ? 'holding' : 'typing');

    // onCycle은 ref로 보관 — 콜백이 바뀔 때마다 타이머 effect 재시작 방지
    const cycleRef = useRef(onCycle);
    cycleRef.current = onCycle;

    // 새 문구 — 처음부터 다시 타이핑
    useEffect(() => {
        if (still) {
            setCount([...text].length);
            setPhase('holding');
            return;
        }
        setCount(0);
        setPhase('typing');
    }, [text, still]);

    useEffect(() => {
        if (still) return;
        const delay = phase === 'typing' ? TYPE_MS : phase === 'deleting' ? DELETE_MS : HOLD_MS;
        const id = setTimeout(() => {
            if (phase === 'holding') {
                setPhase('deleting');
                return;
            }
            if (phase === 'typing') {
                if (count >= [...text].length) setPhase('holding');
                else setCount(count + 1);
                return;
            }
            if (count <= 0) cycleRef.current();
            else setCount(count - 1);
        }, delay);
        return () => clearTimeout(id);
    }, [phase, count, text, still]);

    // 미입력 꼬리도 투명하게 레이아웃 유지 — 완성 문구와 같은 줄바꿈, 옆 마크 위치 고정
    const shown = chars.slice(0, count).join('');
    const rest = chars.slice(count).join('');

    return (
        <button
            type="button"
            className="chat-welcome-title-btn"
            onClick={onClick}
            aria-label={text}
            title="다른 인사말 보기"
        >
            <span aria-hidden="true">{shown}</span>
            {!still && <span className="chat-welcome-caret" aria-hidden="true" />}
            <span className="chat-welcome-rest" aria-hidden="true">{rest}</span>
        </button>
    );
};
