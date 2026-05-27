import type { MachbaseConfig } from '../types/settings'

interface Props {
    config: MachbaseConfig
    onChange: (config: MachbaseConfig) => void
    errors?: string[]
}

export function MachbaseSection({ config, onChange, errors = [] }: Props) {
    const set = (field: keyof MachbaseConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
        onChange({ ...config, [field]: e.target.value })

    const hasError = (field: string) => errors.includes(`machbase.${field}`)

    return (
        <div className="card">
            <div className="card-title">
                <div>
                    <h3>Machbase Connection</h3>
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
                <label className="form-label">
                    <span>User ID</span>
                    {/* Fixed to the logged-in user (JWT identity) so the saved config filename
                        and the DB connection username always agree. Editing here would create
                        a config under a different name than the actual user. */}
                    <input type="text" value={config.user} readOnly disabled className="opacity-60 cursor-not-allowed" />
                </label>
                <label className="form-label">
                    <span>Password</span>
                    <input type="password" placeholder="••••••••" value={config.password} onChange={set('password')} className={hasError('password') ? 'input-error' : ''} />
                </label>
            </div>
        </div>
    )
}
