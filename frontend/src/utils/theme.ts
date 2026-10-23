import { useSyncExternalStore } from "react";

/**
 * 라이트·다크 테마 — 모듈 레벨 store
 * · 별도 createRoot로 마운트된 트리에서도 읽기용 — context는 root 경계 미통과
 * · 클래스는 <html>에 — 포털 팝오버(모델 드롭다운·프롬프트/즐겨찾기 패널·토스트)까지 적용
 */

export type Theme = "light" | "dark";

const STORAGE_KEY = "llmChatTheme";
const LIGHT_CLASS = "theme-light";

function read(): Theme {
    try {
        return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
    } catch {
        return "dark";
    }
}

function apply(theme: Theme): void {
    document.documentElement.classList.toggle(LIGHT_CLASS, theme === "light");
}

let current: Theme = read();
const listeners = new Set<() => void>();

function getTheme(): Theme {
    return current;
}

function setTheme(theme: Theme): void {
    if (theme === current) return;
    current = theme;
    apply(theme);
    try {
        localStorage.setItem(STORAGE_KEY, theme);
    } catch {
        // 저장 불가 환경 — 이번 세션엔 테마 적용 유지
    }
    for (const listener of listeners) listener();
}

export function toggleTheme(): void {
    setTheme(current === "light" ? "dark" : "light");
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useTheme(): Theme {
    return useSyncExternalStore(subscribe, getTheme, getTheme);
}

/**
 * <html> 클래스를 저장값에 맞춤 — HTML 진입 파일의 인라인 검사가 없거나 그 뒤 저장값이 바뀐 경우 대비
 */
export function initTheme(): void {
    apply(current);
}
