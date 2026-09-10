import { useEffect, useRef, useState } from 'react';

interface Props {
    /** Line to type out. Changing it restarts the cycle on the new text. */
    text: string;
    /** Asked for the next line once this one has finished typing and erasing. */
    onCycle: () => void;
    /** Click anywhere on the line — skips ahead instead of waiting out the cycle. */
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

    // `onCycle` fires from inside a timer; keeping it in a ref means the timer
    // effect does not restart every render just because the callback is new.
    const cycleRef = useRef(onCycle);
    cycleRef.current = onCycle;

    // New line — start over from nothing.
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

    // One text flow, not two. The untyped tail stays in the layout at zero
    // opacity, so the line breaks exactly where the finished line will break and
    // the mark beside it never shifts. Splitting it across a hidden sizer and an
    // absolutely positioned overlay let the two disagree about where to wrap.
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
