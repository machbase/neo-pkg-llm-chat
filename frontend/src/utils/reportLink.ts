import { authHeaders } from './auth';

// 리포트 링크(/db/tql/<경로>.html) → 파일 경로(퍼센트 인코딩 유지). 리포트 링크가 아니면 null
// · 호스트는 보지 않음 — 링크 호스트는 백엔드 설정 기준이라 화면 origin과 다를 수 있음
export function reportPathOf(href: string, base: string = window.location.href): string | null {
    let url: URL;
    try { url = new URL(href, base); } catch { return null; }
    const m = /^\/db\/tql\/(.+\.html?)$/i.exec(url.pathname);
    return m ? m[1] : null;
}

// 리포트를 API 토큰으로 받아 새 창에 표시 — 토큰 인증 ON에서 링크 직접 열기는 401
// · 팝업 차단 회피용으로 클릭 즉시 빈 창부터 열고, 받은 뒤 Blob URL로 이동
export function openReport(path: string): void {
    let opened: Window | null;
    try { opened = (window.top || window).open('', '_blank'); } catch { opened = window.open('', '_blank'); }
    if (!opened) return;
    const win = opened;
    win.opener = null;
    win.document.title = '리포트';
    win.document.body.textContent = '리포트를 불러오는 중…';

    fetch('/db/files/' + path, { headers: authHeaders() })
        .then(async (res) => {
            if (res.status === 401) throw new Error('API 토큰이 유효하지 않습니다. 설정에서 토큰을 확인한 뒤 다시 열어 주세요.');
            if (!res.ok) throw new Error(`리포트를 불러오지 못했습니다 (HTTP ${res.status})`);
            const blob = new Blob([await res.arrayBuffer()], { type: 'text/html;charset=utf-8' });
            // URL 해제 안 함 — 리포트 창 새로고침 대비
            win.location.replace(URL.createObjectURL(blob));
        })
        .catch((e: unknown) => {
            win.document.body.textContent = e instanceof Error ? e.message : String(e);
        });
}
