import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __dirname = dirname(fileURLToPath(import.meta.url));

const entries: Record<string, string> = {
    index: resolve(__dirname, "index.html"),
    main: resolve(__dirname, "main.html"),
};

const entry = process.env.VITE_ENTRY || "index";

// 패키지 버전 — 화면이 서버 package.json과 비교(utils/staleReload.ts), 버전 올린 뒤 재빌드 필요
const PKG = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));

// base './' — public 자산(폰트) 링크를 패키지 하위 경로 기준 상대경로로 출력
export default defineConfig({
    base: "./",
    plugins: [react(), tailwindcss(), viteSingleFile()],
    define: { __PKG_VERSION__: JSON.stringify(PKG.version) },
    build: {
        rollupOptions: {
            input: entries[entry],
        },
        emptyOutDir: entry === "index",
    },
    server: {
        host: true,
        port: 7779,
        proxy: {
            "/web/services/neo-pkg-llm": {
                target: `http://localhost:7777`,
                changeOrigin: true,
                secure: false,
                ws: true,
            },
        },
    },
});
