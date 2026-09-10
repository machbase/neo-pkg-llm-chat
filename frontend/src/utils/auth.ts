/**
 * Parse the JWT stored in localStorage('accessToken') and extract the username.
 * Returns null if token is missing, malformed, or has no recognisable username field.
 */
export function getCurrentUser(): string | null {
  const token = localStorage.getItem('accessToken');
  if (!token) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // base64url → base64 → decode
    const payload = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const decoded = JSON.parse(atob(payload));

    // check common JWT username fields
    return decoded.sub ?? decoded.username ?? decoded.preferred_username ?? decoded.name ?? null;
  } catch {
    return null;
  }
}

/** Raw Neo session token, or an empty string when not logged in. */
export function getAuthToken(): string {
  return localStorage.getItem('accessToken') ?? '';
}

/**
 * Authorization header carrying the Neo session token. The LLM backend verifies it
 * and derives the user from it, so config calls must send it — without it they are 401.
 */
export function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('accessToken');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Returns true when the current user is the super-admin account */
export function isSysUser(): boolean {
  return getCurrentUser() === 'sys';
}
