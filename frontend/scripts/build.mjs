// 엔트리별 vite build — npm `VAR=x cmd` 형태가 Windows(cmd)에서 안 돼 환경변수·산출물 복사 직접 처리
// · --root: dist 산출물(html·assets)을 패키지 루트로 복사
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');

// index 먼저 — vite.config.ts가 index 빌드에서만 emptyOutDir 함
const ENTRIES = ['index', 'main'];

for (const entry of ENTRIES) {
    const res = spawnSync(process.execPath, [viteBin, 'build'], {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, VITE_ENTRY: entry },
    });
    if (res.status !== 0) process.exit(res.status ?? 1);
}

if (process.argv.includes('--root')) {
    for (const entry of ENTRIES) {
        copyFileSync(resolve(root, 'dist', `${entry}.html`), resolve(root, '..', `${entry}.html`));
        console.log(`copied dist/${entry}.html -> ../${entry}.html`);
    }
    cpSync(resolve(root, 'dist', 'assets'), resolve(root, '..', 'assets'), { recursive: true });
    console.log('copied dist/assets -> ../assets');
}
