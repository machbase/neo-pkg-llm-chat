import type { TqlChartPayload, TablePayload, ExecResult, ExecErrorKind } from "../types/exec";
import { getApiBaseOrigin } from "./baseUrl";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * LLM 중계 서버의 root-level path 빌드 — `${apiBaseOrigin}/db/...`.
 * (LLM relay가 /db/tql, /db/query를 instance prefix 없이 forward하도록 backend 처리됨)
 */
async function buildUrl(suffix: string): Promise<string> {
  const apiBase = await getApiBaseOrigin();
  return `${apiBase}${suffix}`;
}

/**
 * fetch 응답을 ExecResult로 정규화. Authorization 헤더 안 보냄 (LLM 중계 서버가 inject).
 * AbortController 시그널 throw / TypeError → kind 분류는 useTqlExec에서.
 */
export async function executeTql(
  code: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ExecResult> {
  const url = await buildUrl("/db/tql");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: code,
    signal: opts.signal,
  });
  if (!res.ok) return classifyHttpError(res, await safeText(res));

  // x-chart-type 헤더는 cross-origin 응답에서 Access-Control-Expose-Headers 미설정 시
  // 읽을 수 없으므로 body shape이 ground truth. chart → table → text 순으로 판별.
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";

  // application/xhtml+xml, text/html → iframe DOM 렌더 (HTML() sink)
  if (contentType.includes("xhtml+xml") || contentType.includes("text/html")) {
    return { kind: "html", payload: { html: text } };
  }

  try {
    const data = JSON.parse(text);
    if (isChartShape(data)) {
      return { kind: "chart", payload: data as TqlChartPayload };
    }
    if (isTableShape(data)) {
      return { kind: "table", payload: applyTruncate(data as TablePayload, text) };
    }
  } catch { /* not JSON → text */ }

  return { kind: "text", payload: { text } };
}

/**
 * SQL 코드를 TQL boilerplate로 감싸 /db/tql로 전송.
 * 모든 실행 요청은 단일 TQL endpoint로 통일.
 *   SQL(`<query>`)
 *   CSV()
 */
export async function executeSql(
  query: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return executeTql(wrapSqlAsTql(query), opts);
}

/**
 * Shell 코드를 TQL boilerplate로 감싸 /db/tql로 전송.
 *   FAKE(once(1))
 *   SHELL(`<cmd>`)
 *   JSON(rowsFlatten(true))
 */
export async function executeSh(
  cmd: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return executeTql(wrapShAsTql(cmd), opts);
}

/**
 * TQL backtick string에 안전하게 임베드하기 위해 코드 내 backtick은 single quote로 치환.
 */
function escapeBacktick(code: string): string {
  return code.replace(/`/g, "'");
}

function wrapSqlAsTql(query: string): string {
  return `SQL(\`${escapeBacktick(query.trim())}\`)\nCSV()`;
}

function wrapShAsTql(cmd: string): string {
  return `FAKE(once(1))\nSHELL(\`${escapeBacktick(cmd.trim())}\`)\nJSON(rowsFlatten(true))`;
}

function classifyHttpError(res: Response, body: string): ExecResult {
  const status = res.status;
  let kind: ExecErrorKind;
  if (status === 401 || status === 403) kind = "AUTH_FAILED";
  else if (status === 502 || status === 503 || status === 504) kind = "MACHBASE_UNAVAILABLE";
  else if (status >= 400 && status < 600) kind = "INVALID_SQL";
  else kind = "unknown";
  const message = body || `HTTP ${status} ${res.statusText}`;
  return { kind: "error", payload: { kind, message } };
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

function isChartShape(d: unknown): boolean {
  if (!d || typeof d !== "object") return false;
  const o = d as Record<string, unknown>;
  const hasMountId = typeof o.chartID === "string" || typeof o.geomapID === "string";
  return hasMountId && Array.isArray(o.jsAssets);
}

function isTableShape(d: unknown): boolean {
  if (!d || typeof d !== "object") return false;
  const o = d as Record<string, unknown>;
  return Array.isArray(o.columns) && Array.isArray(o.rows);
}

function applyTruncate(t: TablePayload, raw: string): TablePayload {
  const TEN_K = 10_000;
  const FIVE_MB = 5 * 1024 * 1024;
  const tooManyRows = t.rows.length > TEN_K;
  const tooLarge = raw.length > FIVE_MB;
  if (tooManyRows || tooLarge) {
    return { ...t, truncated: true, rows: t.rows.slice(0, TEN_K) };
  }
  return t;
}

export const TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
