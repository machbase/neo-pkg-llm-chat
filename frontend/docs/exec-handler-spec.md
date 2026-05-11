# TQL/SQL Execution Handler Spec

> Frontend에서 LLM 중계 서버를 통해 Machbase Neo의 표준 endpoint로 TQL/SQL 실행을 위한 인터페이스 명세

## 1. 개요

이 문서는 AI Agent 대화에서 TQL/SQL 코드 블록을 사용자가 직접 실행할 수 있도록 frontend가 LLM 중계 서버를 통해 호출하는 endpoint와 응답 처리 정책을 정의한다.

**핵심 원칙**:
- frontend는 Authorization 헤더를 보내지 않는다 — LLM 중계 서버가 user_id 매핑된 자격증명을 inject해서 Neo로 forward
- 본 task에서 백엔드 코드는 작성하지 않는다 — frontend가 의존하는 인터페이스 계약만 명세
- TQL 차트 응답은 iframe srcdoc HTML로 변환하여 표출 (echarts 의존성을 frontend가 직접 안 가짐)

## 2. 백엔드 사전 합의 필수 (🚨)

Phase 2 wiring 시작 전 backend 담당자와 다음을 사전 확인:

- LLM 중계 서버 (`:8884`)가 `/db/tql`, `/db/query` route를 노출하고 Neo로 forward
- forward 시 user_id 매핑된 AppConfig.machbase 자격증명을 Authorization 헤더로 inject
- iframe 안의 정적 자산 (`/web/echarts/*`, `/web/api/tql-assets/*`)도 같은 forward 경로 통과 (필요 시 자격증명 inject 또는 익명 통과)

## 3. TQL 호출 명세

### 3.1 Request

- Method: `POST`
- URL: `/db/tql` (LLM 중계 서버 origin 기준 relative)
- Header: `Content-Type: text/plain`
- Header: **Authorization 안 보냄** (중계 서버가 inject)
- Body: TQL 텍스트 그대로

### 3.2 Response

- Header: `x-chart-type` (있으면 차트 응답)
- Body:
  - 차트 응답 (JSON):
    ```json
    {
      "chartID": "$undefined_c8b7c60a_d18a_48f1_96fc_61fa86c6efa1",
      "jsAssets": ["/web/echarts/echarts.min.js", "/web/echarts/themes/dark.js"],
      "jsCodeAssets": ["/web/api/tql-assets/$undefined_c8b7c60a_d18a_48f1_96fc_61fa86c6efa1.js"],
      "style": { "width": "981px", "height": "353px" },
      "theme": "dark"
    }
    ```
  - 표 응답 (JSON):
    ```json
    {
      "columns": [{"name": "TIME", "type": "datetime"}, {"name": "cnt", "type": "long"}],
      "rows": [[...], [...]]
    }
    ```
  - 텍스트 응답: 그냥 string

## 4. SQL 호출 명세

### 4.1 Request

- Method: `GET`
- URL: `/db/query?q={encodeURIComponent(sql)}`
- Header: **Authorization 안 보냄**

### 4.2 Response

- Body (JSON):
  ```json
  {
    "columns": [{"name": "...", "type": "..."}],
    "rows": [[...]],
    "rowsAffected": 0
  }
  ```

## 5. TQL 차트 → iframe srcdoc HTML 변환

### 5.1 변환 규칙

frontend는 차트 응답을 받으면 다음 형식의 HTML을 조립하여 `<iframe srcdoc>`으로 렌더한다:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <base href="{apiBase}/">
  {jsAssets.map(src => `<script src="${src}"></script>`).join('\n  ')}
  <style>
    .chart_container { display: flex; justify-content: center; align-items: center; height: 100%; }
    .chart_item { margin: auto; }
  </style>
</head>
<body style="width:100vw;height:100vh;margin:0">
  <div class="chart_container">
    <div class="chart_item" id="{chartID}" style="width:{style.width};height:{style.height};"></div>
  </div>
  {jsCodeAssets.map(src => `<script src="${src}"></script>`).join('\n  ')}
</body>
</html>
```

### 5.2 핵심 디테일

- **`<base href="{apiBase}/">` 필수** — srcdoc iframe origin이 `about:srcdoc`이라 leading-slash 절대 경로(`/web/...`)가 깨짐. base 태그로 LLM 중계 서버 origin 기준 해석.
- **apiBase 결정**: `getApiBaseOrigin()` async helper (baseUrl.ts) — `getLlmPort()` 결과의 origin 형태 (`http://host:port`)
- **HTML escape 필수**: chartID/style/URL 모두 attribute에 들어가므로 `&`, `<`, `>`, `"`, `'` escape (XSS 방지)

### 5.3 iframe sandbox 정책

- `sandbox="allow-scripts"` — script 실행만 허용
- `allow-same-origin` 제외 — parent DOM 접근 차단, opaque origin
- **자체완결 chart만 지원** — iframe 안 echarts-init 스크립트가 fetch() 추가 호출하면 sandbox 환경 + opaque origin이라 CORS fail. fetch 필요한 chart는 본 task 범위 외.

## 6. dev 환경 vite proxy

`frontend/vite.config.ts`:

```ts
proxy: {
  '/public/neo-pkg-llm-chat': 'http://localhost:5654',  // 기존
  '/db/tql': 'http://localhost:8884',                    // 신규
  '/db/query': 'http://localhost:8884',                  // 신규
}
```

dev에서 frontend `localhost:7779` → vite proxy → LLM 중계 서버 `:8884` → Neo `:5654` forward.

## 7. 프로덕션 same-origin 정책

frontend가 LLM 중계 서버와 same-origin에서 served됨을 가정 (build:root가 ../index.html 복사하는 패턴이 LLM 중계 서버 apps dir 기준). same-origin이라 CORS preflight 불필요.

## 8. 에러 분류 (frontend 측)

| Kind | 조건 | 사용자 메시지 |
|------|------|---------------|
| `AUTH_FAILED` | 401, 403 | "인증 실패 — 자격증명 확인" |
| `MACHBASE_UNAVAILABLE` | 502, 503 | "Machbase Neo 연결 실패" |
| `TIMEOUT` | AbortController + timedOut flag | "실행 시간 초과 (30s)" |
| `INVALID_SQL` | 400, 500 + Neo error message | (Neo 메시지 그대로 표시) |
| `NETWORK` | TypeError (fetch reject) | "네트워크 연결 또는 CORS 설정을 확인해 주세요" |
| `aborted` | AbortError + !timedOut | (사용자 cancel — UI 표시 안 함) |
| `unknown` | 그 외 | "알 수 없는 오류: {error}" |

## 9. 동시성/취소

- AbortController로 frontend 측 cancel
- 동일 코드 재실행 시 이전 abort + result 초기화
- 30s timeout — `setTimeout`으로 controller.abort() 호출 직전 `timedOut=true` flag 설정

## 10. 결과 사이즈 제한

frontend 측에서 응답 크기 검증:
- 1만 행 또는 5MB 초과 시 `truncated=true` 플래그 부착 (서버는 안 내려줌)
- 표 렌더 시 'show first 1000' 패턴

## 11. Phase 2 wiring 사전 검증 (dev curl)

backend 합의 후 다음 명령으로 사전 확인:

```bash
curl -X POST http://localhost:7779/db/tql \
  -H "Content-Type: text/plain" \
  --data-raw "SQL('SELECT 1')"
# 200 응답 (Authorization 없이도, 중계 서버가 자격증명 inject)
```
