import { useCallback, useEffect, useRef, useState } from "react";

import { getCurrentUser } from "../utils/auth";
import { fetchFavorites, saveFavorites } from "../services/prefsApi";

// 사용자별 "자주 쓰는 질문" 즐겨찾기
// · 로그인 → /api/prefs 경유 서버 prefs/{user}.json 저장(기기 간 공유·사용자별 격리)
// · 비로그인 → localStorage 대체(개발·로그인 전)
// · 첫 로드 때 브라우저 저장소에만 있던 즐겨찾기를 서버로 1회 이전

export interface FavoriteItem {
  id: string;
  prompt: string;
}

const STORAGE_KEY = "neo-llm-favorites"; // 로컬 대체 저장 키

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

  // 사용자 확인 + 초기 로드(1회)
  useEffect(() => {
    const user = getCurrentUser();
    userRef.current = user;
    let cancelled = false;

    (async () => {
      if (user) {
        try {
          const server = sanitize(await fetchFavorites());
          if (cancelled) return;
          if (server.length === 0) {
            // 브라우저 저장소에만 있던 즐겨찾기를 서버로 이전
            const local = readLocal();
            if (local.length > 0) {
              setBoth(local);
              loadedRef.current = true;
              try {
                await saveFavorites(local);
                localStorage.removeItem(STORAGE_KEY);
              } catch (e) {
                console.warn("[favorites] migration save failed:", e);
              }
              return;
            }
          }
          setBoth(server);
        } catch (e) {
          // 서버 불통 — 로컬로 대체해 UI 유지, loadedRef는 표시 후 전환
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
        /* 저장소 가득 참·사용 불가 — 무시 */
      }
      return;
    }
    dirtyRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      dirtyRef.current = false;
      saveFavorites(favoritesRef.current).catch((e) => console.warn("[favorites] save failed:", e));
    }, SAVE_DEBOUNCE_MS);
  }, []);

  // 언마운트 시 대기 중인 디바운스 저장 즉시 실행
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const user = userRef.current;
      if (dirtyRef.current && user) {
        dirtyRef.current = false;
        saveFavorites(favoritesRef.current).catch(() => {});
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
    if (prev.some((f) => f.prompt === text)) return; // 완전 일치 중복 제외
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
