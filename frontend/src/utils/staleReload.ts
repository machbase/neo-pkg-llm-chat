/**
 * 업데이트 뒤 캐시된 옛 화면이면 프레임 새로 고침
 * · Neo 콘솔 앱 iframe은 Ctrl+Shift+R로도 다시 받지 않음 — 프레임 새로 고침만 서버에 재확인
 * · 서버 package.json(캐시 없이) 버전 ≠ 빌드 버전이면 새로 고침, 같은 서버 버전엔 탭당 한 번(반복 방지)
 */
const KEY_PREFIX = "neo-pkg-llm-chat:reload:";

export function reloadIfStale(): void {
    if (import.meta.env.DEV) return;
    fetch("package.json", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((pkg: { version?: string } | null) => {
            const version = pkg?.version;
            if (!version || version === __PKG_VERSION__) return;
            const key = KEY_PREFIX + version;
            if (sessionStorage.getItem(key)) return;
            sessionStorage.setItem(key, "1");
            location.reload();
        })
        .catch(() => {});
}
