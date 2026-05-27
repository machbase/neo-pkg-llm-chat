---
title: HTTP API와 WebSocket
weight: 50
---

# HTTP API와 WebSocket

이 문서는 `server` 모드로 실행되는 LLM Chat 패키지의 HTTP API 엔드포인트와 채팅 UI가 사용하는 WebSocket 프로토콜을 정리합니다.

## HTTP API 엔드포인트

### 마스터 레벨 엔드포인트

| 메서드 | 경로 | 설명 |
| :---: | :--- | :--- |
| GET | `/health` | 상태 확인 |
| GET | `/settings` | 설정 페이지 |
| GET | `/api/instances` | 실행 중인 인스턴스 목록 |
| POST | `/api/configs` | 설정 저장 및 인스턴스 시작 |
| GET | `/api/configs` | 모든 설정 목록 |
| GET | `/api/configs/{name}` | 특정 설정 조회 |
| PUT | `/api/configs/{name}` | 설정 변경 및 인스턴스 재시작 |
| DELETE | `/api/configs/{name}` | 설정 삭제 및 인스턴스 중지 |

### 인스턴스별 엔드포인트

| 메서드 | 경로 | 설명 |
| :---: | :--- | :--- |
| POST | `/{name}/api/chat` | 비스트리밍 채팅 |
| POST | `/{name}/api/chat/stream` | SSE 스트리밍 채팅 |
| GET | `/{name}/api/settings` | 인스턴스 설정 조회 |
| POST | `/{name}/api/restart-llm` | 인스턴스 LLM 클라이언트 재시작 |
| GET | `/{name}/ws` | WebSocket 엔드포인트 (채팅 UI) |
| GET | `/{name}/health` | 인스턴스 상태 확인 |

### 예제: curl로 스트리밍 채팅

```bash
curl -X POST http://localhost:8884/sys/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"query": "테이블 리스트 조회 해줘"}'
```

### 예제: 상태 확인

```bash
curl http://localhost:8884/health
```

```json
{"status": "ok"}
```

## WebSocket 프로토콜

채팅 UI는 WebSocket을 통해 패키지 서비스와 통신합니다. 연결 URL은 `ws://{host}:{port}/{user_id}/ws` 형식입니다.

### 클라이언트 → 서버 메시지

**get_models** — 사용 가능한 LLM 프로바이더 및 모델 요청:

```json
{"type": "get_models", "user_id": "sys"}
```

**chat** — 채팅 메시지 전송:

```json
{
  "type": "chat",
  "user_id": "sys",
  "session_id": "sess-1234567890",
  "provider": "claude",
  "model": "claude-sonnet-4-20250514",
  "query": "GOLD 테이블 분석해줘"
}
```

**stop** — 현재 생성 중단:

```json
{"type": "stop", "user_id": "sys", "session_id": "sess-1234567890"}
```

**clear** — 세션 기록 초기화:

```json
{"type": "clear", "user_id": "sys", "session_id": "sess-1234567890"}
```

### 서버 → 클라이언트 메시지

서버는 에이전틱 루프 실행 중 스트리밍 이벤트를 전송합니다.

**스트리밍 텍스트 청크:**

```json
{
  "type": "msg",
  "message": {
    "type": "ofStreamBlockDelta",
    "body": {
      "ofStreamBlockDelta": {
        "contentType": "text",
        "text": "분석 결과를 정리하겠습니다..."
      }
    }
  }
}
```

**도구 호출 알림:**

```json
{"type": "tool_call", "name": "execute_sql_query", "args": {"sql_query": "SELECT ..."}}
```

**도구 실행 결과:**

```json
{"type": "tool_result", "status": "success", "content": "NAME,COUNT(*)\\ntemperature,15230"}
```

## 문서 이동

- [이전: 기술 참고](./technical-reference.kr.md)
- [목차로 돌아가기](./index.kr.md)
- [다음: 문제 해결](./troubleshooting.kr.md)
