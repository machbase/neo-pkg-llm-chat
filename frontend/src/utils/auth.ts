/**
 * Neo 콘솔 로그인 계정(소문자) — localStorage('accessToken') JWT payload 의 sub 등 이름 필드만 읽음
 * · 서명 검증 없음, 인증에 안 씀 — 토큰 저장 칸 구분 · 계정 불일치 차단용
 */
export function getConsoleUser(): string | null {
  const jwt = localStorage.getItem('accessToken');
  if (!jwt) return null;

  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(payload));
    const name = decoded.sub ?? decoded.username ?? decoded.preferred_username ?? decoded.name ?? null;
    return typeof name === 'string' && name ? name.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** 현재 사용자 이름 — 토큰 계정과 콘솔 계정은 일치가 강제되므로 콘솔 계정과 같음 */
export function getCurrentUser(): string | null {
  return getConsoleUser();
}

// API 토큰 저장 칸 — 콘솔 계정별(공용 브라우저에서 앞사람 토큰 재사용 방지)
function tokenKey(): string | null {
  const user = getConsoleUser();
  return user ? `llm-chat.token.${user}` : null;
}

/** 현재 콘솔 계정의 Machbase API 토큰(nt_), 없으면 빈 문자열 */
export function getApiToken(): string {
  const key = tokenKey();
  if (!key) return '';
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}

export function setApiToken(token: string): void {
  const key = tokenKey();
  if (!key) return;
  try { localStorage.setItem(key, token); } catch { /* 저장 불가 환경 */ }
}

export function clearApiToken(): void {
  const key = tokenKey();
  if (!key) return;
  try { localStorage.removeItem(key); } catch { /* 저장 불가 환경 */ }
}

/**
 * LLM 백엔드·Neo /db/* 호출용 Authorization 헤더
 * · 백엔드는 이 토큰으로만 사용자 판정 — 없으면 401
 */
export function authHeaders(): Record<string, string> {
  const token = getApiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
