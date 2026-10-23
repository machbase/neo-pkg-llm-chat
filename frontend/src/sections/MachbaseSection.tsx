import { useState } from 'react'
import type { MachbaseConfig } from '../types/settings'
import type { TokenCheck } from '../services/settingsApi'
import Icon from '../components/common/Icon'

interface Props {
    config: MachbaseConfig
    onChange: (config: MachbaseConfig) => void
    errors?: string[]
    token: string
    onTokenChange: (token: string) => void
    tokenCheck: TokenCheck | null
    checking: boolean
    onVerify: () => void
    savedUser: string | null
    onClearToken: () => void
}

// 검증 결과 문구 — 계정 이름은 Neo 표기(대문자)로 표시
export function tokenCheckMessage(check: TokenCheck): { ok: boolean; text: string } {
    switch (check.status) {
        case 'ok':
            return { ok: true, text: `✓ ${check.user.toUpperCase()}` }
        case 'invalid':
            return { ok: false, text: '✗ 유효하지 않은 토큰입니다' }
        case 'mismatch':
            return { ok: false, text: `✗ 콘솔 로그인 계정(${check.consoleUser.toUpperCase()})과 다른 계정(${check.user.toUpperCase()})의 토큰입니다` }
        case 'no_console':
            return { ok: false, text: '✗ Neo 콘솔 로그인 정보를 확인할 수 없습니다. 콘솔에 로그인한 뒤 다시 시도하세요' }
        case 'error':
            return { ok: false, text: `✗ 검증 실패: ${check.message}` }
    }
}

export function MachbaseSection({
    config, onChange, errors = [],
    token, onTokenChange, tokenCheck, checking, onVerify, savedUser, onClearToken,
}: Props) {
    const [showToken, setShowToken] = useState(false)

    const set = (field: 'host' | 'port') => (e: React.ChangeEvent<HTMLInputElement>) =>
        onChange({ ...config, [field]: e.target.value })

    const hasError = (field: string) => errors.includes(`machbase.${field}`)
    const result = tokenCheck ? tokenCheckMessage(tokenCheck) : null

    return (
        <div className="settings-section">
            <div className="settings-section-header">
                <div>
                    <h3>Machbase connection</h3>
                    <p className="text-sm text-on-surface-secondary mt-1">Database connection settings for Machbase Neo</p>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <label className="form-label">
                    <span>Host</span>
                    <input type="text" placeholder="127.0.0.1" value={config.host} onChange={set('host')} className={hasError('host') ? 'input-error' : ''} />
                </label>
                <label className="form-label">
                    <span>Port</span>
                    <input type="text" placeholder="5654" value={config.port} onChange={set('port')} className={hasError('port') ? 'input-error' : ''} />
                </label>
            </div>

            <div className="flex flex-col gap-8 mt-12">
                <label className="form-label">
                    <span>API Token</span>
                    <div className="flex items-center gap-8 w-full">
                        <div className="input-icon-wrap w-full">
                            <input
                                type={showToken ? 'text' : 'password'}
                                placeholder="nt_..."
                                value={token}
                                onChange={(e) => onTokenChange(e.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                                className={`w-full ${hasError('token') ? 'input-error' : ''}`}
                            />
                            <button
                                type="button"
                                className="input-icon-btn"
                                onClick={() => setShowToken((v) => !v)}
                                aria-label={showToken ? 'Hide token' : 'Show token'}
                            >
                                <Icon name={showToken ? 'visibility' : 'visibility_off'} className="icon-sm" />
                            </button>
                        </div>
                        <button
                            type="button"
                            className="btn btn-content btn-ghost"
                            onClick={onVerify}
                            disabled={checking || !token.trim()}
                        >
                            {checking ? <span className="spinner" /> : <Icon name="verified_user" className="icon-sm" />}
                            검증
                        </button>
                    </div>
                </label>
                {result && (
                    <p className="text-sm" style={{ color: result.ok ? 'var(--color-success)' : 'var(--color-error)' }}>{result.text}</p>
                )}
                <p className="text-sm text-on-surface-secondary">
                    Neo 콘솔에서 발급한 API 토큰을 입력하세요. 토큰은 이 브라우저에만 저장되며 서버 설정 파일에는 저장되지 않습니다.
                </p>
                {savedUser && (
                    <div className="flex items-center gap-8">
                        <span className="text-sm text-on-surface-secondary">현재 {savedUser.toUpperCase()} 토큰으로 접속 중</span>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={onClearToken}>
                            토큰 지우기
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}
