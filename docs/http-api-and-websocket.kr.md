---
title: HTTP API와 WebSocket
weight: 50
---

# HTTP API와 WebSocket

이 문서는 LLM Chat 패키지 서비스가 제공하는 HTTP API 엔드포인트와 WebSocket 프로토콜을 정리합니다.

패키지는 게이트웨이 / 워커 구조를 사용합니다. 브라우저가 게이트웨이로 WebSocket을 열면, 게이트웨이가 세션별 워커 프로세스를 띄워 에이전틱 루프를 실행합니다. **채팅은 전적으로 WebSocket으로 처리되며 HTTP가 아닙니다** — HTTP 엔드포인트는 설정, 사용자 환경설정, 헬스/진단 용도로만 쓰입니다.

## HTTP API 엔드포인트

모든 설정 응답은 `{ success, reason, data }` JSON 형태를 사용합니다. CORS preflight를 피하기 위해, `PUT` / `DELETE`는 쿼리 파라미터 `_method=PUT` 또는 `_method=DELETE`와 `text/plain` 본문을 가진 `POST`로도 보낼 수 있습니다.

### 헬스 & 진단

| Method | Path | 설명 |
| :---: | :--- | :--- |
| GET | `/health` | 헬스 체크. `{ "ok": true }` 반환 |
| GET | `/api/debug` | 진단: configs 디렉토리와 파일 목록, 활성 워커 수. API 토큰 필요 |

서비스 포트는 `configs/sys.json`의 `server.port`로 정합니다(기본 `8884`). 런처가 시작할 때 이 값을 읽습니다.

### 사용자 설정

설정은 사용자별로 저장됩니다(`configs/{user}.json`). 설정 이름은 Machbase 사용자명입니다.

이 아래 토큰 검증·설정·환경설정 API는 **모든 요청에 `Authorization: Bearer {API 토큰}` 헤더가 필요합니다**(Neo 웹 콘솔에서 발급한 `nt_`로 시작하는 토큰). 서버는 Machbase Neo의 `POST /db/token/validate`로 토큰을 검증해 계정을 확정하며, 본인 것이 아닌 이름을 요청하면 거부합니다. 계정 이름은 소문자로 다룹니다(예: `SYS` → `sys`).

| 상황 | 응답 |
| :--- | :--- |
| 토큰 없음 / 무효 / 삭제·만료 | `401` `{"success": false, "reason": "authentication required"}` |
| 다른 사용자의 설정 요청 | `403` `{"success": false, "reason": "forbidden"}` |

### 토큰 검증

| Method | Path | 설명 |
| :---: | :--- | :--- |
| GET | `/api/token/validate` | 헤더의 API 토큰을 검증해 계정 이름 반환. 성공 `200` `{"success": true, "data": {"user": "sys"}}`, 실패 `401` `{"success": false, "reason": "invalid token"}` |

Settings 화면의 **검증** 버튼이 이 API를 호출합니다. 콘솔 로그인 계정과의 일치 여부는 브라우저에서 따로 확인합니다.

| Method | Path | 설명 |
| :---: | :--- | :--- |
| GET | `/api/configs` | 설정 이름 목록(**본인 것만**). `?name={name}`이면 해당 설정 반환 |
| POST | `/api/configs` | 설정 저장. 파일 이름과 본문의 `machbase.user`를 **토큰의 사용자로 고정**합니다(본문에 다른 계정을 적어도 무시). 본문의 `machbase.token`·`machbase.password`는 **저장하지 않고 제거**합니다 |
| PUT | `/api/configs?name={name}` | 설정 변경 |
| DELETE | `/api/configs?name={name}` | 설정 삭제 |
| GET | `/api/configs/{name}` | 특정 설정 조회 |
| PUT | `/api/configs/{name}` | 특정 설정 변경 |
| DELETE | `/api/configs/{name}` | 특정 설정 삭제 |

### 사용자별 UI 환경설정

| Method | Path | 설명 |
| :---: | :--- | :--- |
| GET | `/api/prefs` | 사용자 UI 환경설정(즐겨찾기) 조회 |
| POST | `/api/prefs` | 사용자 UI 환경설정(즐겨찾기) 저장 |
| PUT | `/api/prefs` | 사용자 UI 환경설정(즐겨찾기) 저장 |

대상 사용자는 토큰에서 정합니다 — 이름을 파라미터로 받지 않습니다.

### WebSocket 경로

| Method | Path | 설명 |
| :---: | :--- | :--- |
| GET | `/ws` | 브라우저 채팅 WebSocket. 사용자는 **메시지마다 `auth_token`을 검증해** 확정합니다 |
| GET | `/internal/ws` | 내부 게이트웨이 ↔ 워커 채널 (클라이언트용 아님) |

### 릴레이 라우트

연결된 Machbase Neo 서버로 직접 프록시하는 라우트입니다(UI가 TQL을 실행하고 차트 / 대시보드를 렌더링할 때 사용).

| Method | Path | 설명 |
| :---: | :--- | :--- |
| POST | `/db/tql` | TQL 실행 릴레이. Neo의 `/db/tql`로 전달합니다. **`Authorization: Bearer {API 토큰}` 헤더 필수**이며 호출자의 토큰을 그대로 넘깁니다(토큰 없으면 `401`). 전달 전에 `FROM`·`JOIN` 뒤의 접두 없는 테이블 이름을 토큰 계정이 볼 수 있는 테이블 기준으로 `DB.소유자.테이블`로 채웁니다. 같은 이름이 여러 계정에 있으면 실행하지 않고 `400`과 후보 목록을 돌려줍니다 |

릴레이는 호출자 토큰의 계정으로 실행되므로, 권한 밖 테이블은 Machbase가 거부합니다.

### 예제: 헬스 체크

```bash
curl http://localhost:8884/health
```

```json
{"ok": true}
```

### 예제: 토큰 검증

```bash
TOKEN=nt_a_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
curl -H "Authorization: Bearer $TOKEN" http://localhost:8884/api/token/validate
```

```json
{"success": true, "reason": "success", "data": {"user": "sys"}}
```

### 예제: 저장된 설정 목록

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8884/api/configs
```

```json
{"success": true, "reason": "success", "data": {"configs": ["sys"]}}
```

토큰 없이 호출하면 `401`이 돌아옵니다.

## WebSocket 프로토콜

채팅 UI는 WebSocket으로 서비스와 통신합니다. 접속 URL은 `ws://{host}:{port}/ws` 입니다. 게이트웨이는 각 세션을 워커 프로세스로 라우팅하고, 워커의 스트리밍 메시지를 브라우저로 중계합니다.

**모든 클라이언트 메시지에 `auth_token`(Machbase Neo API 토큰)을 실어야 합니다.** 게이트웨이는 메시지마다 토큰을 검증해 사용자를 확정하므로, 토큰을 바꾸거나 Neo에서 토큰을 삭제하면 다음 메시지부터 바로 반영됩니다. `user_id` 필드는 신원 판단에 쓰지 않습니다.

검증한 토큰은 게이트웨이가 워커로 보내는 `chat` 메시지에만 실어 전달하며, 워커 설정 파일(`workers/*.json`)이나 사용자 설정 파일에는 기록하지 않습니다.

검증에 실패하면 다음이 돌아옵니다.

```json
{"type": "error", "code": "auth_required", "msg": "API 토큰이 확인되지 않았습니다. 설정에서 토큰을 확인한 뒤 다시 시도하세요."}
```

다른 계정이 만든 세션 ID로 메시지를 보내면 `code: "auth_required"`, `msg: "다른 계정의 세션입니다."`로 거부합니다.

### 클라이언트 → 서버 메시지

**get_models** — 사용 가능한 LLM 프로바이더와 모델 요청:

```json
{"type": "get_models", "auth_token": "nt_a_xxxx..."}
```

**chat** — 채팅 메시지 전송(`provider`와 `model` 필수):

```json
{
  "type": "chat",
  "auth_token": "nt_a_xxxx...",
  "session_id": "sess-1234567890",
  "provider": "claude",
  "model": "claude-sonnet-4-6",
  "query": "GOLD 테이블 분석해줘",
  "tz": "Asia/Seoul"
}
```

`tz`는 선택 항목으로, 브라우저 시간대(IANA 이름)입니다. 조회 결과·차트·리포트의 시각과 모델에게 알려 주는 현재 시각의 기준이 되며, 없으면 서버 시간대를 씁니다.

**stop** — 현재 생성 중지:

```json
{"type": "stop", "session_id": "sess-1234567890"}
```

**clear** — 세션 초기화(워커 종료):

```json
{"type": "clear", "session_id": "sess-1234567890"}
```

### 서버 → 클라이언트 메시지

**models** — `get_models`에 대한 응답:

```json
{"type": "models", "providers": [ { "provider": "claude", "models": ["..."] } ]}
```

이 계정의 설정이 아직 저장되지 않았으면 `providers` 대신 다음이 옵니다.

```json
{"type": "models", "msg": "No providers configured. Please set API keys in Settings."}
```

**msg** — 스트리밍 봉투. 진행 상황 서술과 최종 답변 모두 `msg` 이벤트로 전달됩니다. 내부 `message.type`이 단계를 나타내고, 텍스트는 `body.ofStreamBlockDelta`로 옵니다:

```json
{
  "type": "msg",
  "message": {
    "ver": "1.0",
    "id": 1699999999999,
    "type": "stream_block_delta",
    "body": {
      "ofStreamBlockDelta": {
        "contentType": "text/markdown",
        "text": "GOLD 테이블을 조회하는 중..."
      }
    }
  }
}
```

내부 `message.type` 단계(순서):

- `answer_start` — 응답 시작
- `stream_block_start` / `stream_block_delta` / `stream_block_stop` — 진행 상황 서술(도구 단계가 여기서 마크다운 텍스트로 설명됨)
- `stream_msg_start` / `stream_msg_delta` / `stream_msg_stop` — 최종 답변 텍스트
- `answer_stop` — 응답 완료

**followups** — 답변이 끝난 뒤 이어서 물어볼 만한 질문 추천(만들지 못하면 오지 않음):

```json
{"type": "followups", "session_id": "sess-1234567890", "items": ["..."]}
```

**error** — 오류 발생(예: `config_required` 같은 `code` 포함 가능):

```json
{"type": "error", "session_id": "sess-1234567890", "msg": "Agent error: ..."}
```

> 참고: 별도의 `tool_call` / `tool_result` 메시지는 없습니다. 도구 활동은 `stream_block_delta` 진행 이벤트 안에서 마크다운 텍스트로 스트리밍됩니다.

## 문서 이동

- [이전: 기술 참고](./technical-reference.kr.md)
- [목차로 돌아가기](./index.kr.md)
- [다음: 문제 해결](./troubleshooting.kr.md)
