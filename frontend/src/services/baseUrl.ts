// LLM 백엔드 REST API — 프록시 경로 뒤에 붙는 /api/* prefix
const API_PREFIX = "/api";

// ── 서비스 프록시 공개 경로 (단일 지점) ──
// · neo가 127.0.0.1:<llmPort>로 포워딩, SVC_BASE까지만 제거 → 백엔드엔 /api/configs·/db/tql 그대로 도달
// · 같은 origin이라 상대 경로
// · svc = JSH 서비스명(neo-pkg-llm) 필수 — neo의 프록시 자동 정리가 서비스명 기준 매칭
const SVC_BASE = "/web/services/neo-pkg-llm";

export const getApiBase = async (): Promise<string> => {
    // /api/* REST(/configs 등) — 프록시 prefix '/api/'로 매칭
    return `${SVC_BASE}${API_PREFIX}`;
};

export const getWsBase = async (): Promise<string> => {
    // WS 도 서비스 프록시 경유 — URL 에 사용자 segment 없음
    // · JSH ws path-template 은 끝 segment 가 정적일 때만 매칭 → /ws/:user 형태는 404
    // · 사용자 판정은 메시지마다 싣는 auth_token(API 토큰)으로만
    // · stripPrefix(SVC_BASE) 후 백엔드 '/ws' 라우트로 도달
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}${SVC_BASE}/ws`;
};

/**
 * /db/tql 등 root-level REST 경로용 base(SVC_BASE) — `${base}/db/tql`이 프록시 prefix '/db/'로 매칭
 */
export async function getApiBaseOrigin(): Promise<string> {
    return SVC_BASE;
}

/**
 * 차트 iframe `<base href>` 전용 origin — sandbox srcdoc(opaque origin)에서 /web/... 절대경로를 현재 페이지 origin으로 해석
 */
export function getChartAssetBase(): string {
    return window.location.origin;
}
