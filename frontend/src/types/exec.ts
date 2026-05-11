export type ExecStatus = 'idle' | 'loading' | 'success' | 'error';

export type ExecErrorKind =
  | 'AUTH_FAILED'
  | 'MACHBASE_UNAVAILABLE'
  | 'TIMEOUT'
  | 'INVALID_SQL'
  | 'NETWORK'
  | 'aborted'
  | 'unknown';

export interface TqlChartPayload {
  /** echarts 응답 — 마운트 div id로 사용 */
  chartID?: string;
  /** geomap 응답 — 마운트 div id로 사용 */
  geomapID?: string;
  jsAssets: string[];
  jsCodeAssets: string[];
  /** geomap의 leaflet.css 등 외부 stylesheet (echarts에는 보통 없음) */
  cssAssets?: string[];
  style?: { width: string; height: string; grayscale?: number };
  theme?: string;
}

export interface TablePayload {
  columns: Array<{ name: string; type?: string }>;
  rows: unknown[][];
  rowsAffected?: number;
  truncated?: boolean;
}

export interface TextPayload { text: string; }
export interface HtmlPayload { html: string; }
export interface ErrorPayload { kind: ExecErrorKind; message: string; }

export type ExecResult =
  | { kind: 'chart'; payload: TqlChartPayload }
  | { kind: 'table'; payload: TablePayload }
  | { kind: 'text'; payload: TextPayload }
  | { kind: 'html'; payload: HtmlPayload }
  | { kind: 'error'; payload: ErrorPayload };

export interface TqlExecResponse { kind: ExecResult['kind']; payload: ExecResult['payload']; chartType?: string; }
