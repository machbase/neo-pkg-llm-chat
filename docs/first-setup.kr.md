---
title: 첫 설정
weight: 20
---

# 첫 설정

처음 열었을 때 아직 설정이 없으면 Settings 화면이 먼저 표시됩니다.  
설정을 이미 저장한 사용자라면 바로 Chat 화면으로 들어갈 수 있습니다.

## Machbase Connection

먼저 Machbase Neo 연결 정보를 입력합니다.

입력 항목:

- `Host`
- `Port`
- `User ID`
- `Password`

이 정보는 LLM이 질의 실행이나 대시보드 생성에 사용할 Machbase 연결입니다.

![Machbase Connection 설정 화면](./images/llm-settings-connection.png)

## API Keys & Endpoints

다음으로 사용할 LLM Provider 정보를 입력합니다.

지원되는 항목:

- `Claude`
- `ChatGPT`
- `Gemini`
- `Ollama`

입력 방식:

- Claude, ChatGPT, Gemini: API Key 입력
- Ollama: `base_url` 입력

모든 Provider를 다 채울 필요는 없습니다.  
실제로 사용할 Provider만 입력하면 됩니다.

프로바이더별 모델 목록 확인 위치:

- Claude
  - Anthropic Models 문서에서 `Claude API ID`를 확인합니다.
- ChatGPT
  - OpenAI Models 문서에서 `Model ID`를 확인합니다.
- Gemini
  - Gemini Models 문서에서 모델 코드를 확인합니다.
- Ollama
  - 로컬에 `ollama pull`로 내려받은 모델 이름을 그대로 사용합니다.

## Models 등록

LLM Chat은 Provider별로 사용할 Model을 별도로 등록합니다.

각 행에서 입력하는 값:

- `Provider`
- `Display Name`
- `Model ID`

예를 들어 화면에 보여줄 이름은 `GPT-4.1`, 실제 호출용 ID는 공급자 문서의 model id를 넣는 방식입니다.

설정 팁:

- Display Name은 사용자가 구분하기 쉬운 이름으로 넣습니다.
- Model ID는 Provider 문서에 나오는 정확한 값을 사용합니다.
- Ollama는 로컬에 `pull`한 모델 이름을 그대로 쓰면 됩니다.

![Models 설정 화면](./images/llm-settings-models.png)

## 저장 전 확인 사항

다음 조건이 만족되어야 저장할 수 있습니다.

- Machbase 연결 항목이 비어 있지 않음
- 추가한 Model 행은 Display Name과 Model ID가 모두 채워짐
- 적어도 하나 이상의 Provider가 실제로 사용 가능함

실패하면 화면에 어떤 입력이 부족한지 또는 저장이 되지 않는 이유가 표시됩니다.

## Save 후 동작

설정을 저장하면 Chat 화면으로 이동합니다.

이후에도 오른쪽 아래의 Settings 버튼으로 다시 설정 화면을 열어 수정할 수 있습니다.

## 문서 이동

- [목차로 돌아가기](./index.kr.md)
- [다음: Chat 사용 방법](./chat-usage.kr.md)
