import type { ApiProvider, ProviderConfig, OllamaConfig } from '../types/settings'

type AnyProvider = ApiProvider | 'ollama'

interface Props {
    claude: ProviderConfig
    chatgpt: ProviderConfig
    gemini: ProviderConfig
    ollama: OllamaConfig
    onKeyChange: (provider: ApiProvider, key: string) => void
    onOllamaUrlChange: (url: string) => void
}

const PROVIDER_META: Record<AnyProvider, { label: string; placeholder: string }> = {
    claude: { label: 'Claude', placeholder: 'sk-ant-api03-...' },
    chatgpt: { label: 'ChatGPT', placeholder: 'sk-proj-...' },
    gemini: { label: 'Gemini', placeholder: 'AIzaSy...' },
    ollama: { label: 'Ollama', placeholder: 'http://localhost:11434' },
}

const ALL_PROVIDERS: AnyProvider[] = ['claude', 'chatgpt', 'gemini', 'ollama']

export function ApiKeysSection({ claude, chatgpt, gemini, ollama, onKeyChange, onOllamaUrlChange }: Props) {
    const getValue = (p: AnyProvider): string => {
        if (p === 'ollama') return ollama.base_url
        return { claude, chatgpt, gemini }[p].api_key
    }

    const handleChange = (p: AnyProvider, value: string) => {
        if (p === 'ollama') {
            onOllamaUrlChange(value)
        } else {
            onKeyChange(p, value)
        }
    }

    return (
        <div className="settings-section">
            <div className="settings-section-header">
                <div>
                    <h3>API keys &amp; endpoints</h3>
                    <p className="text-sm text-on-surface-secondary mt-1">LLM provider authentication keys and endpoints</p>
                </div>
            </div>

            <div className="flex flex-col gap-3">
                {ALL_PROVIDERS.map((p) => (
                    <div key={p} className="flex items-center gap-3">
                        <span className={`badge badge-${p} shrink-0`}>{PROVIDER_META[p].label}</span>
                        <input
                            type={p === 'ollama' ? 'text' : 'password'}
                            className="flex-1 min-w-0"
                            placeholder={PROVIDER_META[p].placeholder}
                            value={getValue(p)}
                            onChange={(e) => handleChange(p, e.target.value)}
                        />
                    </div>
                ))}
            </div>
        </div>
    )
}
