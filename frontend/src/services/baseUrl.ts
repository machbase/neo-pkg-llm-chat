interface InfoResponse {
    ok: boolean;
    data?: { port: string };
    reason?: string;
}

let cachedPort: Promise<string> | null = null;

const pkgBasePath = (): string => {
    const pathname = window.location.pathname;
    const trimmed = pathname.replace(/\/[^/]*$/, "/");

    console.log(trimmed === "" ? "/" : trimmed);

    return trimmed === "" ? "/" : trimmed;
};

// CGI 엔드포인트 (machbase-neo, 현재 페이지 포트) — info.js 전용
const CGI_PREFIX = "/public/neo-pkg-llm-chat/cgi-bin/api";
// LLM 바이너리 REST API — http://host:{llmPort}/api/...
const API_PREFIX = "/api";

export const getLlmPort = (): Promise<string> => {
    if (cachedPort) return cachedPort;
    const url = `${CGI_PREFIX}/info`;
    cachedPort = fetch(url)
        .then((res) => {
            if (!res.ok) throw new Error(`info.js HTTP ${res.status}`);
            return res.json() as Promise<InfoResponse>;
        })
        .then((body) => {
            if (!body.ok || !body.data?.port) {
                throw new Error(body.reason || "info.js returned no port");
            }
            return body.data.port;
        })
        .catch((err) => {
            cachedPort = null;
            throw err;
        });
    return cachedPort;
};

export const getApiBase = async (): Promise<string> => {
    const port = await getLlmPort();
    return `${window.location.protocol}//${window.location.hostname}:${port}${API_PREFIX}`;
};

export const getWsBase = async (): Promise<string> => {
    const port = await getLlmPort();
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.hostname}:${port}`;
};

/**
 * LLM 중계 서버 origin 반환 (예: "http://localhost:8884").
 * iframe `<base href>`에 사용. getLlmPort()의 cachedPort를 재사용 — 별도 fetch X.
 */
export async function getApiBaseOrigin(): Promise<string> {
    const port = await getLlmPort();
    const proto = window.location.protocol; // "http:" or "https:"
    const host = window.location.hostname;
    return `${proto}//${host}:${port}`;
}
