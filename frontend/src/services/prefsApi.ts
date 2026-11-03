import type { FavoriteItem } from "../hooks/useFavorites";
import { getApiBase } from "./baseUrl";
import { authHeaders } from "../utils/auth";

// 사용자별 UI 설정(즐겨찾기) — 서버 prefs/{user}.json 저장
// · 사용자는 서버가 요청 토큰으로 판별 → 이름 미전송
// · 변경 요청은 POST + 'text/plain' — CORS preflight 회피(서버에 options() 핸들러 없음, 본문 문자열 JSON.parse)

interface PrefsResponse {
    success: boolean;
    reason?: string;
    data?: { favorites?: FavoriteItem[] };
}

export async function fetchFavorites(): Promise<FavoriteItem[]> {
    const API_BASE = await getApiBase();
    const res = await fetch(`${API_BASE}/prefs`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as PrefsResponse;
    if (!body.success) throw new Error(body.reason ?? "load failed");
    return Array.isArray(body.data?.favorites) ? body.data!.favorites! : [];
}

export async function saveFavorites(favorites: FavoriteItem[]): Promise<void> {
    const API_BASE = await getApiBase();
    const res = await fetch(`${API_BASE}/prefs`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", ...authHeaders() },
        body: JSON.stringify({ favorites }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as PrefsResponse;
    if (!body.success) throw new Error(body.reason ?? "save failed");
}
