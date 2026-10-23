import type { TqlChartPayload, TablePayload, ExecResult, ExecErrorKind } from "../types/exec";
import { getApiBaseOrigin } from "./baseUrl";
import { authHeaders } from "../utils/auth";

const DEFAULT_TIMEOUT_MS = 30_000;

/** LLM 중계 서버의 root-level 경로 빌드 — `${apiBaseOrigin}/db/...` */
async function buildUrl(suffix: string): Promise<string> {
  const apiBase = await getApiBaseOrigin();
  return `${apiBase}${suffix}`;
}

/**
 * TQL 실행 → ExecResult 정규화 — 인증 헤더는 중계 서버가 neo로 그대로 전달
 * abort·네트워크 오류(TypeError)는 throw — 호출부에서 분류
 */
export async function executeTql(
  code: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ExecResult> {
  const url = await buildUrl("/db/tql");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain", ...authHeaders() },
    body: code,
    signal: opts.signal,
  });
  if (!res.ok) return classifyHttpError(res, await safeText(res));

  // 응답 종류는 body 형태로 판별(chart → table → text) — x-chart-type 헤더는 cross-origin에서 읽기 불가할 수 있음
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
    const table = toTablePayload(data);
    if (table) {
      return { kind: "table", payload: applyTruncate(table, text) };
    }
    // SQL 오류는 HTTP 200 + {"success":false,"reason":...}로 옴
    if (data && typeof data === "object" && (data as Record<string, unknown>).success === false) {
      const reason = (data as Record<string, unknown>).reason;
      return { kind: "error", payload: { kind: "INVALID_SQL", message: String(reason ?? text) } };
    }
  } catch { /* not JSON → text */ }

  return { kind: "text", payload: { text } };
}

/**
 * SQL 코드를 TQL boilerplate로 감싸 /db/tql로 전송 — 결과는 표로 표시
 *   SQL(`<query>`)
 *   JSON(timeformat("Default"), tz("Local"))
 */
export async function executeSql(
  query: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return executeTql(wrapSqlAsTql(query), opts);
}

/**
 * Shell 코드를 TQL boilerplate로 감싸 /db/tql로 전송
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

/** 코드 내 backtick → single quote 치환 — TQL backtick 문자열 임베드용 */
function escapeBacktick(code: string): string {
  return code.replace(/`/g, "'");
}

function wrapSqlAsTql(query: string): string {
  return `SQL(\`${escapeBacktick(query.trim())}\`)\nJSON(timeformat("Default"), tz("Local"))`;
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
  // {"success":false,"reason":...} 형태면 reason만 표시
  let reason = "";
  try { reason = String(JSON.parse(body)?.reason ?? ""); } catch { /* 텍스트 본문 */ }
  const message = reason || body || `HTTP ${status} ${res.statusText}`;
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

// Neo JSON() 결과 {data:{columns:[이름], types:[타입], rows}} → 표. 아니면 null
function toTablePayload(d: unknown): TablePayload | null {
  if (!d || typeof d !== "object") return null;
  const inner = (d as Record<string, unknown>).data;
  if (!inner || typeof inner !== "object") return null;
  const o = inner as Record<string, unknown>;
  if (!Array.isArray(o.columns) || !Array.isArray(o.rows)) return null;
  const types = Array.isArray(o.types) ? o.types : [];
  return {
    columns: o.columns.map((name, i) => ({ name: String(name), type: types[i] === undefined ? undefined : String(types[i]) })),
    rows: o.rows as unknown[][],
  };
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
