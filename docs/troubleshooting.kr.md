---
title: 문제 해결
weight: 60
---

# 문제 해결

## 저장이 되지 않음

다음 항목을 확인합니다.

- Machbase `Host`, `Port`, `User ID`, `Password`
- 추가한 Model의 `Display Name`, `Model ID`
- 실제로 사용할 수 있는 Provider가 하나 이상 등록되었는지

입력이 빠지면 저장 시 오류 안내가 표시됩니다.

## 모델 목록이 비어 있음

- Settings에서 Model을 실제로 추가했는지 확인합니다.
- 해당 Provider의 API Key 또는 Ollama URL이 맞는지 확인합니다.
- Chat 화면에서 모델 목록을 다시 열어 새로고침합니다.

## Chat 화면이 Disconnected 상태임

- 서버 연결이 일시적으로 끊긴 경우일 수 있습니다.
- `Reconnect` 버튼으로 다시 연결합니다.
- 계속 실패하면 패키지 서비스 상태와 브라우저 네트워크 상태를 함께 확인합니다.

## 질문은 보냈는데 응답이 늦음

가능한 원인:

- 선택한 모델 자체가 느린 경우
- 외부 Provider 응답이 느린 경우
- Machbase 질의나 대시보드 생성 작업이 오래 걸리는 경우

이때는 잠시 기다리거나 필요하면 **Stop**으로 중단 후 질문을 더 단순하게 바꿔 다시 시도합니다.

## 원하는 답이 나오지 않음

- 테이블 이름을 정확히 넣어 질문합니다.
- 기간, 태그, 컬럼 이름을 함께 적으면 결과가 더 안정적입니다.
- “대시보드”, “리포트”, “태그 목록”처럼 목적을 분명하게 적는 편이 좋습니다.

## 운영 권장 사항

- 처음에는 Provider 1개, Model 1개만 등록해 동작을 확인합니다.
- Machbase 연결 정보가 바뀌면 Settings에서 즉시 수정합니다.
- 여러 모델을 쓸 경우 Display Name을 구분하기 쉽게 정리합니다.

## 문서 이동

- [이전: HTTP API와 WebSocket](./http-api-and-websocket.kr.md)
- [목차로 돌아가기](./index.kr.md)
