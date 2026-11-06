import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../components/common/Icon'

// 토큰 발급 방법 — 단계 글 + 그림(1 → 2 → 3), 그림을 누르면 크게 보기
// · 그림 = 매뉴얼 그림(docs/static/images, 설치본에 포함) — 못 불러오면 글만
const IMG_DIR = 'docs/static/images/'
const STEPS = [
    { file: 'neo-token-create.png', text: 'Neo 콘솔 왼쪽 메뉴의 방패 아이콘(SECURITY) → TOKENS 옆 + → 이름 입력 → Issue token' },
    { file: 'neo-token-copy.png', text: '발급된 토큰(nt_…)을 복사합니다 · 토큰은 이때 한 번만 보입니다' },
    { file: 'llm-token-input.png', text: '위 API Token 칸에 붙여 넣고 검증을 누릅니다 · 콘솔에 로그인한 계정의 토큰이어야 합니다' },
]

interface Props {
    // 사용자가 접거나 펼치기 전의 상태 — 토큰 없으면 펼침
    defaultOpen: boolean
}

export function TokenHowTo({ defaultOpen }: Props) {
    const [open, setOpen] = useState<boolean | null>(null)
    const [failed, setFailed] = useState<Record<number, boolean>>({})
    const [view, setView] = useState(-1)
    const isOpen = open ?? defaultOpen
    const shown = STEPS.map((_, i) => i).filter((i) => !failed[i])
    const pos = shown.indexOf(view)

    // 크게 보기 넘기기 — 그림 있는 단계만
    const move = (d: number) => {
        const at = pos + d
        if (at >= 0 && at < shown.length) setView(shown[at])
    }

    useEffect(() => {
        if (view < 0) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); setView(-1) }
            else if (e.key === 'ArrowRight') move(1)
            else if (e.key === 'ArrowLeft') move(-1)
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
    }, [view, failed])

    return (
        <div className="token-howto">
            <button type="button" className="token-howto-toggle" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen}>
                <Icon name="help" className="icon-sm" />
                토큰 발급 방법
                <Icon name={isOpen ? 'keyboard_arrow_up' : 'keyboard_arrow_down'} className="icon-sm" />
            </button>
            {isOpen && (
                <div className="token-howto-steps">
                    {STEPS.map((st, i) => (
                        <div key={st.file} className="token-howto-step">
                            <div className="token-howto-text">
                                <span className="token-howto-num">{i + 1}</span>
                                <span>{st.text}</span>
                            </div>
                            {!failed[i] && (
                                <button type="button" className="token-howto-thumb" onClick={() => setView(i)} title="누르면 크게 보입니다">
                                    <img src={IMG_DIR + st.file} alt={st.text} onError={() => setFailed((f) => ({ ...f, [i]: true }))} />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}
            {pos >= 0 && createPortal(
                <div className="token-howto-viewer" onClick={() => setView(-1)}>
                    <img src={IMG_DIR + STEPS[view].file} alt={STEPS[view].text} onClick={(e) => e.stopPropagation()} />
                    <div className="token-howto-viewer-bar" onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => move(-1)} disabled={pos <= 0} aria-label="이전">
                            <Icon name="chevron_left" className="icon-sm" />
                        </button>
                        <span className="token-howto-num">{view + 1}</span>
                        <span>{STEPS[view].text}</span>
                        <span className="token-howto-count">{pos + 1}/{shown.length}</span>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => move(1)} disabled={pos >= shown.length - 1} aria-label="다음">
                            <Icon name="chevron_right" className="icon-sm" />
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setView(-1)} aria-label="닫기">
                            <Icon name="close" className="icon-sm" />
                        </button>
                    </div>
                </div>,
                document.body,
            )}
        </div>
    )
}
