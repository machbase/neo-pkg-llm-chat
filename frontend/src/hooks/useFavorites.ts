import { useCallback, useEffect, useRef, useState } from "react";

import { getCurrentUser } from "../utils/auth";
import { fetchFavorites, saveFavorites } from "../services/prefsApi";

// Per-user "자주 쓰는 질문" favorites.
//  - Logged-in user → stored server-side at prefs/{user}.json (cross-device,
//    isolated per user) via /api/prefs.
//  - No logged-in user → localStorage fallback (dev / pre-login).
// Favorites saved by the earlier localStorage-only version are migrated up to
// the server once, on first load.

export interface FavoriteItem {
  id: string;
  prompt: string;
}

const STORAGE_KEY = "neo-llm-favorites"; // legacy/local fallback key

let idSeq = 0;
const genId = (): string => `fav-${Date.now()}-${(idSeq += 1)}`;

function sanitize(list: unknown): FavoriteItem[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((it): it is { id?: unknown; prompt?: unknown } => !!it && typeof (it as { prompt?: unknown }).prompt === "string")
    .map((it) => ({ id: typeof it.id === "string" && it.id ? it.id : genId(), prompt: String(it.prompt) }))
    .filter((it) => it.prompt.trim());
}

function readLocal(): FavoriteItem[] {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));
  } catch {
    return [];
  }
}

const SAVE_DEBOUNCE_MS = 400;

export function useFavorites() {
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const favoritesRef = useRef<FavoriteItem[]>([]);
  const userRef = useRef<string | null>(null);
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);

  const setBoth = useCallback((list: FavoriteItem[]) => {
    favoritesRef.current = list;
    setFavorites(list);
  }, []);

  // Resolve user + initial load (once).
  useEffect(() => {
    const user = getCurrentUser();
    userRef.current = user;
    let cancelled = false;

    (async () => {
      if (user) {
        try {
          const server = sanitize(await fetchFavorites(user));
          if (cancelled) return;
          if (server.length === 0) {
            // Migrate favorites from the previous localStorage-only version.
            const local = readLocal();
            if (local.length > 0) {
              setBoth(local);
              loadedRef.current = true;
              try {
                await saveFavorites(user, local);
                localStorage.removeItem(STORAGE_KEY);
              } catch (e) {
                console.warn("[favorites] migration save failed:", e);
              }
              return;
            }
          }
          setBoth(server);
        } catch (e) {
          // Server unreachable — fall back to local so the UI still works,
          // but don't flip loadedRef until we've shown something.
          console.warn("[favorites] load failed, using local:", e);
          if (!cancelled) setBoth(readLocal());
        }
      } else {
        setBoth(readLocal());
      }
      if (!cancelled) loadedRef.current = true;
    })();

    return () => {
      cancelled = true;
    };
  }, [setBoth]);

  const persist = useCallback((list: FavoriteItem[]) => {
    const user = userRef.current;
    if (!user) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      } catch {
        /* storage full / unavailable — non-fatal */
      }
      return;
    }
    dirtyRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      dirtyRef.current = false;
      saveFavorites(user, favoritesRef.current).catch((e) => console.warn("[favorites] save failed:", e));
    }, SAVE_DEBOUNCE_MS);
  }, []);

  // Flush a pending debounced save on unmount.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const user = userRef.current;
      if (dirtyRef.current && user) {
        dirtyRef.current = false;
        saveFavorites(user, favoritesRef.current).catch(() => {});
      }
    };
  }, []);

  const apply = useCallback((next: FavoriteItem[]) => {
    setBoth(next);
    if (loadedRef.current) persist(next);
  }, [persist, setBoth]);

  const addFavorite = useCallback((prompt: string) => {
    const text = prompt.trim();
    if (!text) return;
    const prev = favoritesRef.current;
    if (prev.some((f) => f.prompt === text)) return; // de-dup exact matches
    apply([...prev, { id: genId(), prompt: text }]);
  }, [apply]);

  const removeFavorite = useCallback((id: string) => {
    apply(favoritesRef.current.filter((f) => f.id !== id));
  }, [apply]);

  const reorderFavorites = useCallback((fromIndex: number, toIndex: number) => {
    const prev = favoritesRef.current;
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= prev.length) return;
    if (toIndex < 0 || toIndex >= prev.length) return;
    const next = [...prev];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    apply(next);
  }, [apply]);

  return { favorites, addFavorite, removeFavorite, reorderFavorites };
}
