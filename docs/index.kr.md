---
title: LLM Chat 기술 문서
weight: 10
---

# LLM Chat 기술 문서

<p align="center" style="margin-top:1.25rem"><strong>한국어</strong> | <a href="./index.en.md">English</a> | <a href="./index.ja.md">日本語</a></p>

Machbase Neo LLM Chat 패키지는 Machbase Neo 시계열 데이터베이스와 자연어로 상호작용할 수 있는 LLM 채팅 인터페이스입니다.
대화를 통해 데이터 조회, 대시보드 생성, 분석 리포트 작성, 메뉴얼 문서 탐색이 가능합니다.

패키지는 내부적으로 에이전틱 루프를 실행하여 사용자 질문을 LLM에 전달하고, 도구 호출을 Machbase Neo에서 실행한 뒤, 결과를 다시 LLM에 피드백하는 과정을 최종 응답이 생성될 때까지 반복합니다.

## 설치

Machbase Neo 좌측 사이드 패널에는 사용 가능한 패키지 목록이 표시됩니다.  
여기서 LLM Chat 패키지를 선택하고 `Install` 버튼을 누르면 설치할 수 있습니다.

설치에는 약간의 시간이 걸릴 수 있으므로, 완료될 때까지 잠시 기다립니다.

![패키지 설치 화면](./images/package-install.png)

### 요구 사항

- Machbase Neo 8.7.3 이상
- LLM Chat을 사용할 계정의 Machbase Neo API 토큰 (Neo 웹 콘솔에서 발급, [첫 설정](./first-setup.kr.md) 참고)

### 제거

좌측 패널에서 `neo-pkg-llm-chat`을 선택하고 **Uninstall**을 누르면 패키지와 관련 서비스가 제거됩니다.

## LLM 프로바이더

4가지 LLM 프로바이더를 지원합니다. 프로바이더 호출 자체는 단발(non-streaming) 요청·응답으로 처리되며, 도구 실행 단계별 진행 상황은 WebSocket을 통해 브라우저로 스트리밍되어 표시됩니다.

| 프로바이더 | API | 로컬 |
| :--- | :--- | :---: |
| Claude | Anthropic API | 아니오 |
| ChatGPT | OpenAI API | 아니오 |
| Gemini | Google Gemini API | 아니오 |
| Ollama | Ollama REST API | 예 |

프로바이더와 연결 설정은 웹 기반 Settings 화면에서 구성합니다. API Key, 모델 목록, Machbase Neo 연결 정보는 계정별로 서버에 저장되고, Machbase Neo API 토큰은 서버에 저장되지 않고 브라우저에만 저장됩니다.

## 에이전틱 루프

에이전틱 루프는 이 패키지의 핵심 실행 엔진입니다. 질문 유형을 판정해 실행 흐름을 고른 뒤, LLM이 그 흐름의 도구를 실행하고 결과를 보며 다음 단계를 정하는 과정을 답이 나올 때까지 반복합니다(도구 호출은 실행 전에 자동 보정·검사를 거침).

### 질문 유형 감지

질문은 아래 순서로 판정해 실행 흐름을 고릅니다. 흐름마다 모델이 쓸 수 있는 도구가 정해져 있습니다([기술 참고](./technical-reference.kr.md)의 공통 규칙 참고).

| 질문 | 흐름 |
| :--- | :--- |
| 코드(`SQL(`, `CHART(` 등)를 붙여 넣음 | 데이터 조회 |
| "리포트", "보고서", "report"가 들어감 | 리포트 — HTML 분석 리포트 생성 |
| "타이머", "timer", "cron", "스케줄러"가 들어감 | 문서 검색 — 매뉴얼로 안내(타이머 등록은 지원하지 않음) |
| 서버 버전·상태를 짧게 물음 | 시스템 정보 |
| "예측", "forecast" (리포트·대시보드 언급 없음) | 데이터 조회 — 예측 리포트 생성 |
| 실행 요청, 테이블·태그를 지목한 조회, "온도 몇 도야" 같은 측정값 질문 | 데이터 조회 |
| "뭐야", "어떻게", "예제", "사용법" 같은 개념·사용법 질문 | 문서 검색 |
| "심층", "고급", "FFT", "RMS", "스펙트럼", "이상 탐지" 등 | 고급 분석 — 분석 의도(IR)로 컴파일한 심층 차트 |
| 차트·대시보드·분석·추세 요청 | 기본 분석 — 테이블 기반 차트 |
| "평균", "최근", "몇 건", "목록" 같은 조회 표현 | 데이터 조회 |
| 인사 | 일반 대화 |
| 그 외 | 문서 검색 |

## 이 문서에서 다루는 내용

- 패키지 설치
- 초기 설정과 모델 등록
- Chat 화면 사용과 질문 패턴
- 내장 도구와 자동화 기능
- HTTP API와 WebSocket 프로토콜
- 연결 문제와 자주 보는 오류 점검

## 기본 작업 순서

1. Neo에서 LLM Chat 패키지를 설치합니다.
2. Neo 웹 콘솔에서 사용할 계정의 API 토큰을 발급합니다.
3. 처음 열면 Settings 화면에서 Host, Port, API 토큰을 입력하고 **검증**을 누릅니다.
4. 사용할 Provider의 API Key 또는 Endpoint를 입력합니다.
5. 사용할 Model을 한 개 이상 등록합니다.
6. Save 후 Chat 화면으로 이동합니다.
7. Chat 화면에서 모델을 선택하고 질문을 보냅니다.

## 화면 구성

- Settings 화면
  - Machbase Connection
  - API Keys & Endpoints
  - Models
- Chat 화면
  - 대화 영역
  - 모델 선택 버튼
  - 연결 상태 표시
  - 메시지 입력창

![LLM Chat 메인 화면](./images/llm-chat-main.png)

## 문서 목록

- [첫 설정](./first-setup.kr.md)
- [Chat 사용 방법](./chat-usage.kr.md)
- [기술 참고](./technical-reference.kr.md)
- [HTTP API와 WebSocket](./http-api-and-websocket.kr.md)
- [문제 해결](./troubleshooting.kr.md)

## 문서 이동

- [다음: 첫 설정](./first-setup.kr.md)
