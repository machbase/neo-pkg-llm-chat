// obsolete.json 생성 — 릴리스 태그·HEAD에 있던 파일 중 지금 패키지에 없는 경로를 remove에 누적
// · 사용: node scripts/gen-obsolete.mjs [--repo <git 저장소>] [--dry]
// · 저장소 기본값 = 패키지 폴더(git 최상위일 때만), 태그는 x.y.z 형식만
// · 지금 패키지에 있는 경로를 가리키는 항목은 제외 — 다시 생긴 파일을 업데이트가 지우는 것 방지
// · 존재 판정은 대소문자 무시 — 대소문자만 바뀐 파일을 Windows 설치본에서 지우는 것 방지
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(pkgRoot, 'scripts', 'obsolete.json');
const { isProtected } = createRequire(import.meta.url)('./cleanup.js');

// 저장소 전용 — 설치본과 무관
const EXCLUDE = [/^\.github\//];
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const args = process.argv.slice(2);
const repo = resolve(args.includes('--repo') ? args[args.indexOf('--repo') + 1] : pkgRoot);
const dry = args.includes('--dry');

const git = (a) => execFileSync('git', ['-C', repo, '-c', 'core.quotepath=false', ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });

// 상위 저장소에 속한 사본이면 이력이 다름 → --repo 필요
let prefix = null;
try { prefix = git(['rev-parse', '--show-prefix']).trim(); } catch (e) { /* git 저장소 아님 */ }
if (prefix !== '') {
  console.error('git 저장소 최상위가 아님: ' + repo + '\n  → --repo <neo-pkg-llm-chat 클론 경로> 지정');
  process.exit(1);
}

// 현재 패키지의 파일·폴더(소문자)
const present = new Set();
(function walk(rel) {
  for (const e of readdirSync(join(pkgRoot, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = rel ? rel + '/' + e.name : e.name;
    present.add(p.toLowerCase());
    if (e.isDirectory()) walk(p);
  }
})('');
const exists = (p) => present.has(p.replace(/\/$/, '').toLowerCase());

// 지금 없는 경로 → 존재하지 않는 최상위 조상 폴더(있으면 폴더 단위) 또는 파일
function entryOf(p) {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (!exists(dir)) return dir + '/';
  }
  return p;
}

const refs = git(['tag']).split('\n').filter((t) => /^v?\d+\.\d+\.\d+$/.test(t))
  .sort((a, b) => a.replace(/^v/, '').localeCompare(b.replace(/^v/, ''), undefined, { numeric: true }))
  .concat('HEAD');
const seenIn = new Map(); // 항목 → 들어 있던 ref 목록
for (const ref of refs) {
  for (const p of git(['ls-tree', '-r', '--name-only', ref]).split('\n')) {
    if (!p || exists(p) || EXCLUDE.some((re) => re.test(p)) || isProtected(p)) continue;
    const e = entryOf(p);
    if (!seenIn.has(e)) seenIn.set(e, new Set());
    seenIn.get(e).add(ref);
  }
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const before = manifest.remove || [];
const merged = new Set([...before, ...seenIn.keys()]);
const dropped = [];
for (const e of merged) {
  if (exists(e)) { merged.delete(e); dropped.push(e + ' (지금 패키지에 있음)'); }
}
// 폴더 항목에 포함되는 하위 항목 제거
const dirs = [...merged].filter((e) => e.endsWith('/'));
for (const e of merged) {
  if (dirs.some((d) => d !== e && e.startsWith(d))) { merged.delete(e); dropped.push(e + ' (상위 폴더 항목에 포함)'); }
}
const remove = [...merged].sort();

const added = remove.filter((e) => !before.includes(e));
const range = (e) => { const r = [...(seenIn.get(e) || [])]; return r.length ? ' [' + r[0] + (r.length > 1 ? '~' + r[r.length - 1] : '') + ']' : ''; };
console.log('태그 ' + refs.length + '개(' + refs[0] + '~' + refs[refs.length - 1] + ') 기준, 항목 ' + before.length + ' → ' + remove.length);
if (added.length) console.log('추가 ' + added.length + ':\n' + added.map((e) => '  + ' + e + range(e)).join('\n'));
if (dropped.length) console.log('제외 ' + dropped.length + ':\n' + dropped.map((e) => '  - ' + e).join('\n'));

if (dry) process.exit(0);
manifest.remove = remove;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('저장: ' + manifestPath);
