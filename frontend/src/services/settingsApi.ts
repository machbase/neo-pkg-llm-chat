import type { AppConfig, ApiResponse } from "../types/settings";
import { defaultConfig } from "../types/settings";
import { getApiBase } from "./baseUrl";
import { authHeaders, getConsoleUser } from "../utils/auth";

// ── API token check ──
// 성공 시 소문자 계정 이름, 무효(401)면 null. 네트워크·서버 오류는 throw
async function validateToken(token: string): Promise<string | null> {
    const API_BASE = await getApiBase();
    const res = await fetch(`${API_BASE}/token/validate`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as ApiResponse<{ user: string }>;
    return body.success && body.data?.user ? body.data.user : null;
}

export type TokenCheck =
    | { status: "ok"; user: string }
    | { status: "invalid" }
    | { status: "mismatch"; user: string; consoleUser: string }
    | { status: "no_console" }
    | { status: "error"; message: string };

// 토큰 검증 + 콘솔 로그인 계정 일치 확인 — 불일치·콘솔 계정 미확인은 차단
export async function checkToken(token: string): Promise<TokenCheck> {
    const consoleUser = getConsoleUser();
    if (!consoleUser) return { status: "no_console" };
    try {
        const user = await validateToken(token.trim());
        if (!user) return { status: "invalid" };
        if (user !== consoleUser) return { status: "mismatch", user, consoleUser };
        return { status: "ok", user };
    } catch (e) {
        return { status: "error", message: e instanceof Error ? e.message : String(e) };
    }
}

// ── Config list ──
export async function getConfigList(): Promise<string[]> {
    const API_BASE = await getApiBase();
    const res = await fetch(`${API_BASE}/configs`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as ApiResponse<{ configs: Array<string | { name: string; running: boolean }> }>;
    if (!body.success) throw new Error(body.reason);
    const raw = body.data?.configs ?? [];
    return raw.map((item) => (typeof item === "string" ? item : item.name));
}

// ── Config detail ──
export async function getConfig(name: string): Promise<AppConfig> {
    const API_BASE = await getApiBase();
    const res = await fetch(`${API_BASE}/configs/${encodeURIComponent(name)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as ApiResponse<{ config: AppConfig; running: boolean }>;
    if (!body.success) throw new Error(body.reason);
    const defaults = defaultConfig();
    const data = body.data?.config ?? ({} as Partial<AppConfig>);
    return {
        server: { ...defaults.server, ...data.server },
        machbase: {
            host: data.machbase?.host ?? defaults.machbase.host,
            port: data.machbase?.port ?? defaults.machbase.port,
        },
        claude: { ...defaults.claude, ...data.claude },
        chatgpt: { ...defaults.chatgpt, ...data.chatgpt },
        gemini: { ...defaults.gemini, ...data.gemini },
        ollama: { ...defaults.ollama, ...data.ollama },
    };
}

// 변경 요청은 전부 POST + text/plain — CORS preflight 회피
// · LLM 서버(@jsh/http)에 preflight 응답(options) 없음, 본문은 문자열로 받아 JSON.parse
// · PUT/DELETE 는 ?_method=PUT|DELETE 로 전달

// ── Config create ──
// /api/configs/{name} 경로로 저장(서버에서 PUT 처리) — 이름은 토큰 계정만 허용(아니면 403)
export async function createConfig(name: string, config: AppConfig): Promise<string> {
    const API_BASE = await getApiBase();
    const res = await fetch(`${API_BASE}/configs/${encodeURIComponent(name)}?_method=PUT`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", ...authHeaders() },
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
        headers: { "Content-Type": "text/plain", ...authHeaders() },
        body: JSON.stringify(config),
    });
    const body = (await res.json()) as ApiResponse<{ name: string }>;
    if (!body.success) throw new Error(body.reason);
    return body.data?.name ?? "";
}
