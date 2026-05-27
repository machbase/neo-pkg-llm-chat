// LLM 백엔드 REST API — 프록시 경로 뒤에 붙는 /api/* prefix
const API_PREFIX = "/api";

// ── 서비스 프록시 공개 경로 (단일 지점) ──
// neo 본체가 이 경로의 요청을 127.0.0.1:<llmPort> 로 포워딩한다(포트 직접 호출/CORS 제거).
// 백엔드 launcher 의 stripPrefix 가 SVC_BASE 까지만 제거하므로, 프론트가 보내는
// /web/services/<svc>/api/configs · /web/services/<svc>/db/tql 가 백엔드에 그대로
// (/api/configs, /db/tql) 도달한다. 같은 origin 이므로 상대 경로로 둔다.
// svc 세그먼트는 launcher 의 PROXY_SVC(=JSH 서비스명 neo-pkg-llm)와
// 일치해야 한다 — neo 의 서비스 종료 시 프록시 자동 정리가 서비스명 기준으로 매칭되기 때문.
const SVC_BASE = "/web/services/neo-pkg-llm";

export const getApiBase = async (): Promise<string> => {
    // /api/* REST(/configs 등) → 프록시 prefix '/api/' 로 매칭.
    return `${SVC_BASE}${API_PREFIX}`;
};

export const getWsBase = async (): Promise<string> => {
    // WS 도 서비스 프록시 경유. URL 끝에 user segment 를 붙이지 않는다 — JSH ws 모듈의
    // path-template 매칭이 끝 segment 정적(예: /:user/ws)일 때만 동작해서 /ws/:user
    // 패턴은 매칭 실패(404). 백엔드는 path: '/ws' 정적 라우트로 받고, 사용자 식별은
    // 첫 메시지 body 의 user_id 필드로 처리(onBrowserConnection 의 fallback).
    // 공개 경로: {ws|wss}://<host>/web/services/<svc>/ws
    //   → stripPrefix(SVC_BASE) 후 백엔드 /ws
    //   → server.js 의 path: '/ws' 정적 라우트로 도달.
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}${SVC_BASE}/ws`;
};

/**
 * /db/tql 등 root-level REST 경로 빌드용 base. 프록시 base(SVC_BASE)를 반환 →
 * 호출부가 `${base}/db/tql` 로 조합하면 /web/services/<svc>/db/tql 가 되어
 * 프록시 prefix '/db/' 로 매칭(stripPrefix 후 백엔드는 /db/tql 수신).
 */
export async function getApiBaseOrigin(): Promise<string> {
    return SVC_BASE;
}

/**
 * 차트 iframe `<base href>` 전용 origin. sandbox srcdoc 의 opaque origin 에서
 * 절대경로(/web/...)가 현재 페이지(neo 본체) origin 으로 해석되도록 base 를 고정한다.
 */
export function getChartAssetBase(): string {
    return window.location.origin;
}

/**
 * 차트 에셋 프록시 prefix. TQL 차트 응답의 jsAssets/jsCodeAssets 는
 * `/web/echarts/echarts.min.js` · `/web/api/tql-assets/<id>.js` 처럼 `/web/...`
 * 루트 절대경로로 오는데, 이를 그대로 두면 현재 페이지 origin 의 /web/*(neo 본체)로
 * 가서 백엔드 차트 에셋에 닿지 못한다. launcher 가 '/web/' prefix 도 프록시에
 * 등록하므로, 에셋 경로 앞에 이 prefix 를 붙여 /web/services/<svc>/web/... 로 만들면
 * stripPrefix(SVC_BASE) 후 백엔드가 /web/... 를 그대로 받는다(포트 직접 호출 제거).
 */
export const CHART_ASSET_PREFIX = SVC_BASE;
