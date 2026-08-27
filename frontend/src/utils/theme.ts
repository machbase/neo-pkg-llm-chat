import { useSyncExternalStore } from "react";

/**
 * Light/dark theme, held in a module-level store rather than React context.
 *
 * RenderMd mounts ChatExecResult through its own createRoot(), and context does
 * not cross root boundaries — a module store is readable from every root.
 *
 * The class lives on <html> so the portaled popovers (model dropdown, prompt /
 * favorites panels, toast) are covered as well.
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

export function getTheme(): Theme {
    return current;
}

export function setTheme(theme: Theme): void {
    if (theme === current) return;
    current = theme;
    apply(theme);
    try {
        localStorage.setItem(STORAGE_KEY, theme);
    } catch {
        // Private mode / storage disabled — the theme still applies for this session.
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
 * Reconcile <html> with the stored value. The HTML entry files run the same
 * check inline to avoid a dark flash before the bundle loads; this covers the
 * case where that script is absent or storage changed since.
 */
export function initTheme(): void {
    apply(current);
}
