import type { FavoriteItem } from "../hooks/useFavorites";
import { getApiBase } from "./baseUrl";
import { authHeaders } from "../utils/auth";

// Per-user UI preferences (favorites), stored server-side at prefs/{user}.json.
// The server derives the user from the request token, so no name is sent.
// Mutating calls use POST + Content-Type 'text/plain' so the browser treats them
// as "simple" requests (no CORS preflight) — the LLM server has no options()
// handler and reads the raw body string + JSON.parses it (same as settingsApi).

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
