import type { AppConfig, ApiResponse } from "../types/settings";
import { defaultConfig } from "../types/settings";
import { getApiBase } from "./baseUrl";

// ── Config list ──
export async function getConfigList(): Promise<string[]> {
    const API_BASE = await getApiBase();
    const res = await fetch(`${API_BASE}/configs`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as ApiResponse<{ configs: Array<string | { name: string; running: boolean }> }>;
    if (!body.success) throw new Error(body.reason);
    const raw = body.data?.configs ?? [];
    return raw.map((item) => (typeof item === "string" ? item : item.name));
}

// ── Config detail ──
export async function getConfig(name: string): Promise<AppConfig> {
    const API_BASE = await getApiBase();
    const res = await fetch(`${API_BASE}/configs/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as ApiResponse<{ config: AppConfig; running: boolean }>;
    if (!body.success) throw new Error(body.reason);
    const defaults = defaultConfig();
    const data = body.data?.config ?? ({} as Partial<AppConfig>);
    return {
        server: { ...defaults.server, ...data.server },
        machbase: { ...defaults.machbase, ...data.machbase },
        claude: { ...defaults.claude, ...data.claude },
        chatgpt: { ...defaults.chatgpt, ...data.chatgpt },
        gemini: { ...defaults.gemini, ...data.gemini },
        ollama: { ...defaults.ollama, ...data.ollama },
    };
}

// All mutating calls use POST with Content-Type 'text/plain' so the browser treats
// them as "simple" requests (no CORS preflight). The LLM server's @jsh/http build
// has no `options()`/`all()` method to answer preflight, and the server reads the
// raw body string + JSON.parses it. PUT/DELETE are tunneled via ?_method=PUT|DELETE.

// ── Config create ──
// We always save under the path /api/configs/{name} (treated as PUT semantics on the
// server) so the filename is decided by the caller, not by the request body. This
// keeps the saved file aligned with the logged-in user instead of whatever the
// machbase.user form field happens to contain.
export async function createConfig(name: string, config: AppConfig): Promise<string> {
    const API_BASE = await getApiBase();
    const res = await fetch(`${API_BASE}/configs/${encodeURIComponent(name)}?_method=PUT`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(config),
    });
    const body = (await res.json()) as ApiResponse<{ name: string }>;
    if (!body.success) throw new Error(body.reason);
    return body.data?.name ?? name;
}

// ── Config update ──
export async function updateConfig(name: string, config: AppConfig): Promise<string> {
    const API_BASE = await getApiBase();
    const res = await fetch(`${API_BASE}/configs/${encodeURIComponent(name)}?_method=PUT`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(config),
    });
    const body = (await res.json()) as ApiResponse<{ name: string }>;
    if (!body.success) throw new Error(body.reason);
    return body.data?.name ?? "";
}

// ── Config delete ──
export async function deleteConfig(name: string): Promise<void> {
    const API_BASE = await getApiBase();
    const res = await fetch(`${API_BASE}/configs/${encodeURIComponent(name)}?_method=DELETE`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
    });
    const body = (await res.json()) as ApiResponse<{ name: string }>;
    if (!body.success) throw new Error(body.reason);
}
