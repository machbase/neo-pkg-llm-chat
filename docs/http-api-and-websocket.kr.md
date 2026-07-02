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
| GET | `/api/info` | 서버 정보. `{ ok, data: { port } }` 반환 |
| GET | `/api/debug` | 진단: configs 디렉토리, 설정 파일, 활성 워커 수 |

### 메인(서버) 설정

| Method | Path | 설명 |
| :---: | :--- | :--- |
| GET | `/api/config` | 메인/서버 설정 조회 |
| PUT | `/api/config` | 메인/서버 설정 변경 (예: 서버 포트) |

### 사용자 설정

설정은 사용자별로 저장됩니다(`configs/{user}.json`). 설정 이름은 Machbase 사용자명입니다.

| Method | Path | 설명 |
| :---: | :--- | :--- |
| GET | `/api/configs` | 저장된 설정 이름 목록. `?name={name}`이면 해당 설정 반환 |
| POST | `/api/configs` | 설정 저장(`machbase.user`에서 이름 추론) |
| PUT | `/api/configs?name={name}` | 설정 변경 |
| DELETE | `/api/configs?name={name}` | 설정 삭제 |
| GET | `/api/configs/{name}` | 특정 설정 조회 |
| PUT | `/api/configs/{name}` | 특정 설정 변경 |
| DELETE | `/api/configs/{name}` | 특정 설정 삭제 |

### 사용자별 UI 환경설정

| Method | Path | 설명 |
| :---: | :--- | :--- |
| GET | `/api/prefs?user={user}` | 사용자 UI 환경설정(즐겨찾기) 조회 |
| POST | `/api/prefs?user={user}` | 사용자 UI 환경설정(즐겨찾기) 저장 |
| PUT | `/api/prefs?user={user}` | 사용자 UI 환경설정(즐겨찾기) 저장 |

### WebSocket 경로

| Method | Path | 설명 |
| :---: | :--- | :--- |
| GET | `/{user_id}/ws` | 브라우저 채팅 WebSocket (현행 게이트웨이 구조) |
| GET | `/ws` | 레거시 인프로세스 채팅 WebSocket |
| GET | `/internal/ws` | 내부 게이트웨이 ↔ 워커 채널 (클라이언트용 아님) |

### 릴레이 라우트

연결된 Machbase Neo 서버로 직접 프록시하는 라우트입니다(UI가 TQL을 실행하고 차트 / 대시보드를 렌더링할 때 사용).

| Method | Path | 설명 |
| :---: | :--- | :--- |
| POST | `/db/tql` | TQL 실행 요청을 Machbase Neo로 릴레이 |
| GET / POST | `/web/*path` | Machbase Neo 웹 API로 릴레이 |

### 예제: 헬스 체크

```bash
curl http://localhost:8884/health
```

```json
{"ok": true}
```

### 예제: 저장된 설정 목록

```bash
curl http://localhost:8884/api/configs
```

```json
{"success": true, "reason": "success", "data": {"configs": ["sys"]}}
```

## WebSocket 프로토콜

채팅 UI는 WebSocket으로 서비스와 통신합니다. 접속 URL은 `ws://{host}:{port}/{user_id}/ws` 형식입니다. 게이트웨이는 각 세션을 워커 프로세스로 라우팅하고, 워커의 스트리밍 메시지를 브라우저로 중계합니다.

### 클라이언트 → 서버 메시지

**get_models** — 사용 가능한 LLM 프로바이더와 모델 요청:

```json
{"type": "get_models", "user_id": "sys"}
```

**chat** — 채팅 메시지 전송(`provider`와 `model` 필수):

```json
{
  "type": "chat",
  "user_id": "sys",
  "session_id": "sess-1234567890",
  "provider": "claude",
  "model": "claude-sonnet-4-6",
  "query": "GOLD 테이블 분석해줘"
}
```

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

**error** — 오류 발생(예: `config_required` 같은 `code` 포함 가능):

```json
{"type": "error", "session_id": "sess-1234567890", "msg": "Agent error: ..."}
```

> 참고: 별도의 `tool_call` / `tool_result` 메시지는 없습니다. 도구 활동은 `stream_block_delta` 진행 이벤트 안에서 마크다운 텍스트로 스트리밍됩니다.

## 문서 이동

- [이전: 기술 참고](./technical-reference.kr.md)
- [목차로 돌아가기](./index.kr.md)
- [다음: 문제 해결](./troubleshooting.kr.md)
