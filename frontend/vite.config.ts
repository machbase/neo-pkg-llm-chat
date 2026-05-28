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

export default defineConfig({
    plugins: [react(), tailwindcss(), viteSingleFile()],
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
