interface ServerConfig {
    port: string;
}

// API 토큰은 config 에 없음 — 브라우저(utils/auth)에만 보관
export interface MachbaseConfig {
    host: string;
    port: string;
}

export interface ModelEntry {
    name: string;
    model_id: string;
}

export interface ProviderConfig {
    api_key: string;
    models: ModelEntry[];
}

export interface OllamaConfig {
    base_url: string;
    models: ModelEntry[];
}

export interface AppConfig {
    server: ServerConfig;
    machbase: MachbaseConfig;
    claude: ProviderConfig;
    chatgpt: ProviderConfig;
    gemini: ProviderConfig;
    ollama: OllamaConfig;
}

export type ApiProvider = "claude" | "chatgpt" | "gemini";
export type ModelProvider = "claude" | "chatgpt" | "gemini" | "ollama";

export interface ApiResponse<T> {
    success: boolean;
    reason: string;
    elapse: string;
    data: T | null;
}

export function defaultConfig(): AppConfig {
    return {
        server: { port: "8884" },
        machbase: { host: "", port: "" },
        claude: { api_key: "", models: [] },
        chatgpt: { api_key: "", models: [] },
        gemini: { api_key: "", models: [] },
        ollama: { base_url: "", models: [] },
    };
}
