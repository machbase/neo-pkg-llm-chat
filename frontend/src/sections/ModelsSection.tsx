import { useState } from "react";
import Icon from "../components/common/Icon";
import type { ModelEntry, ModelProvider, OllamaConfig, ProviderConfig } from "../types/settings";

interface Props {
    claude: ProviderConfig;
    chatgpt: ProviderConfig;
    gemini: ProviderConfig;
    ollama: OllamaConfig;
    onChange: (provider: ModelProvider, models: ModelEntry[]) => void;
    errors?: string[];
}

const PROVIDER_META: Record<ModelProvider, { label: string; modelsUrl: string; hint: string }> = {
    claude: {
        label: "Claude",
        modelsUrl: "https://platform.claude.com/docs/ko/about-claude/models/overview",
        hint: 'Models page -> Copy "Claude API ID" -> paste as model_id',
    },
    chatgpt: {
        label: "ChatGPT",
        modelsUrl: "https://developers.openai.com/api/docs/models/all",
        hint: 'Models page -> Copy "Model ID" -> paste as model_id',
    },
    gemini: {
        label: "Gemini",
        modelsUrl: "https://ai.google.dev/gemini-api/docs/models?hl=ko",
        hint: "Models page -> Copy model code -> paste as model_id",
    },
    ollama: {
        label: "Ollama",
        modelsUrl: "https://ollama.com/search",
        hint: "Search model -> ollama pull <name> -> paste name as model_id",
    },
};

const ALL_PROVIDERS: ModelProvider[] = ["claude", "chatgpt", "gemini", "ollama"];

type ModelRow = { provider: ModelProvider; index: number; entry: ModelEntry };

export function ModelsSection({ claude, chatgpt, gemini, ollama, onChange, errors = [] }: Props) {
    const [selected, setSelected] = useState<ModelProvider>("claude");

    const providerModels = (p: ModelProvider): ModelEntry[] => {
        if (p === "ollama") return ollama.models;
        return { claude, chatgpt, gemini }[p].models;
    };

    const rows: ModelRow[] = ALL_PROVIDERS.flatMap((p) => providerModels(p).map((entry, index) => ({ provider: p, index, entry })));

    const handleAdd = () => {
        const models = [...providerModels(selected), { name: "", model_id: "" }];
        onChange(selected, models);
    };

    const handleRemove = (p: ModelProvider, idx: number) => {
        const models = providerModels(p).filter((_, i) => i !== idx);
        onChange(p, models);
    };

    const handleChange = (p: ModelProvider, idx: number, field: keyof ModelEntry, value: string) => {
        const models = providerModels(p).map((m, i) => (i === idx ? { ...m, [field]: value } : m));
        onChange(p, models);
    };

    return (
        <div className="card">
            <div className="card-title">
                <div>
                    <h3>Models</h3>
                    <p className="text-sm text-on-surface-secondary mt-1">Configure available models per provider</p>
                </div>
                <div className="flex items-center gap-8">
                    <select value={selected} onChange={(e) => setSelected(e.target.value as ModelProvider)}>
                        {ALL_PROVIDERS.map((p) => (
                            <option key={p} value={p}>
                                {PROVIDER_META[p].label}
                            </option>
                        ))}
                    </select>
                    <button className="btn btn-content btn-primary" onClick={handleAdd}>
                        <Icon name="add" className="icon-sm" /> Add
                    </button>
                </div>
            </div>

            <div className="flex flex-col gap-3 text-xs text-on-surface-tertiary" style={{ marginBottom: 24 }}>
                {ALL_PROVIDERS.map((p) => (
                    <div key={p} className="flex items-center gap-3">
                        <span className={`badge badge-${p}`}>{PROVIDER_META[p].label}</span>
                        <a href={PROVIDER_META[p].modelsUrl} target="_blank" rel="noopener noreferrer" className="model-link">
                            <span>
                                <Icon name="link" className="icon-xs mr-2" />
                                Models
                            </span>
                        </a>
                        <span>{PROVIDER_META[p].hint}</span>
                    </div>
                ))}
            </div>

            <table className="data-table">
                <thead>
                    <tr>
                        <th style={{ width: 110 }}>Provider</th>
                        <th>Display Name</th>
                        <th>Model ID</th>
                        <th style={{ width: 48 }}></th>
                    </tr>
                </thead>
                <tbody>
                    {rows.length === 0 && (
                        <tr>
                            <td colSpan={4} className="text-center text-on-surface-disabled" style={{ padding: "24px 0" }}>
                                No models added. Add a model.
                            </td>
                        </tr>
                    )}
                    {rows.map(({ provider, index, entry }) => (
                        <tr key={`${provider}-${index}`}>
                            <td>
                                <span className={`badge badge-${provider}`}>{PROVIDER_META[provider].label}</span>
                            </td>
                            <td>
                                <input
                                    type="text"
                                    placeholder="Display name"
                                    value={entry.name}
                                    onChange={(e) => handleChange(provider, index, "name", e.target.value)}
                                    className={errors.includes(`model.${provider}.${index}.name`) ? "input-error" : ""}
                                />
                            </td>
                            <td>
                                <input
                                    type="text"
                                    placeholder="model-id"
                                    value={entry.model_id}
                                    onChange={(e) => handleChange(provider, index, "model_id", e.target.value)}
                                    className={errors.includes(`model.${provider}.${index}.model_id`) ? "input-error" : ""}
                                />
                            </td>
                            <td>
                                <button className="btn btn-danger btn-sm btn-icon" onClick={() => handleRemove(provider, index)} title="Remove">
                                    <Icon name="close" className="icon-sm" />
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
