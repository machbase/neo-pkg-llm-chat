import type { FavoriteItem } from "../hooks/useFavorites";
import { getApiBase } from "./baseUrl";

// Per-user UI preferences (favorites), stored server-side at prefs/{user}.json.
// Mutating calls use POST + Content-Type 'text/plain' so the browser treats them
// as "simple" requests (no CORS preflight) — the LLM server has no options()
// handler and reads the raw body string + JSON.parses it (same as settingsApi).

interface PrefsResponse {
    success: boolean;
    reason?: string;
    data?: { favorites?: FavoriteItem[] };
}

export async function fetchFavorites(user: string): Promise<FavoriteItem[]> {
    const API_BASE = await getApiBase();
    const res = await fetch(`${API_BASE}/prefs?user=${encodeURIComponent(user)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as PrefsResponse;
    if (!body.success) throw new Error(body.reason ?? "load failed");
    return Array.isArray(body.data?.favorites) ? body.data!.favorites! : [];
}

export async function saveFavorites(user: string, favorites: FavoriteItem[]): Promise<void> {
    const API_BASE = await getApiBase();
    const res = await fetch(`${API_BASE}/prefs?user=${encodeURIComponent(user)}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ favorites }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as PrefsResponse;
    if (!body.success) throw new Error(body.reason ?? "save failed");
}
