// Example prompts grouped by category for the empty-state suggestions panel.

export interface PromptItem {
  id: string;
  label: string;
  prompt: string;
}

export interface PromptCategory {
  id: string;
  title: string;
  icon: string;
  items: PromptItem[];
}

export const EXAMPLE_PROMPT_CATEGORIES: PromptCategory[] = [
  {
    id: "tql",
    title: "TQL",
    icon: "code",
    items: [
      {
        id: "tql-basic",
        label: "TQL 기본 개념 이해",
        prompt: "TQL이 정확히 무엇인가요? 기존 SQL과 어떤 점이 다른가요?",
      },
      {
        id: "tql-ui",
        label: "TQL을 이용한 UI 구현",
        prompt: "TQL 스크립트만으로 UI를 직접 만들 수 있나요? 실습 예제가 있으면 좋겠습니다.",
      },
      {
        id: "tql-data-handling",
        label: "TQL로 데이터 핸들링 및 뷰잉",
        prompt: "TQL로 데이터를 쉽게 조회하고 가공하려면 어떻게 해야 하나요?",
      },
      {
        id: "tql-kalman",
        label: "TQL 칼만 필터 & 다이렉트 제어",
        prompt: "TQL에서 칼만 필터를 구현하고 MQTT와 연계해 실시간 제어를 실현할 수 있나요?",
      },
      {
        id: "tql-vector",
        label: "TQL 벡터 생산 및 활용",
        prompt: "TQL로 벡터를 생성한 후 AI나 검색에 어떻게 활용할 수 있나요?",
      },
    ],
  },
  {
    id: "viz",
    title: "시각화 & 대시보드",
    icon: "insert_chart",
    items: [
      {
        id: "viz-charts",
        label: "다양한 차트 설정 방법 실습",
        prompt: "Machbase Neo에서 다양한 차트 타입을 어떻게 설정하고 활용할 수 있나요?",
      },
      {
        id: "viz-dashboard",
        label: "대시보드 생성 방법",
        prompt: "Machbase로 대시보드를 만들려면 어떻게 하나요? 다른 SQL과 문법 차이도 궁금합니다.",
      },
      {
        id: "viz-map",
        label: "지도 시각화 (PostSQL 연동)",
        prompt: "PostgreSQL과 연결해서 지도 위에 센서·태블릿 데이터를 표시하려면 어떻게 하나요?",
      },
    ],
  },
  {
    id: "protocol",
    title: "연결 & 프로토콜",
    icon: "hub",
    items: [
      {
        id: "protocol-mqtt",
        label: "MQTT 개념 및 활용",
        prompt: "MQTT가 정확히 무엇인지, Machbase와 어떻게 연동하는지 쉽게 설명해 주실 수 있나요?",
      },
      {
        id: "protocol-mqtt-camera",
        label: "MQTT + 카메라 연동 및 AI 업로드",
        prompt: "카메라 데이터를 MQTT로 수집해서 AI에 업로드하는 파이프라인은 어떻게 구성하나요?",
      },
      {
        id: "protocol-db-by-protocol",
        label: "DB 연결 프로토콜별 설명",
        prompt: "MQTT, HTTP, OPC-UA 등 프로토콜별로 DB 연결 방법이 어떻게 다른가요?",
      },
      {
        id: "protocol-device-code",
        label: "장비-DB 프로토콜 연결 코드 예시",
        prompt: "실제 산업 장비와 Machbase를 연결하는 코드 예제를 볼 수 있을까요?",
      },
      {
        id: "protocol-opcua",
        label: "OPC-UA 샘플 및 관련 정보",
        prompt: "OPC-UA 프로토콜로 Machbase와 연동하는 샘플 코드나 사례가 있나요?",
      },
      {
        id: "protocol-rest-api",
        label: "데이터 API 형태 추출",
        prompt: "Machbase에 저장된 데이터를 REST API 형태로 외부에 제공하려면 어떻게 하나요?",
      },
      {
        id: "protocol-broker-http",
        label: "자체 MQTT Broker 및 HTTP API 수집 실습",
        prompt: "내장 MQTT Broker와 HTTP API로 데이터를 수집하는 실습을 해볼 수 있나요?",
      },
    ],
  },
  {
    id: "compare",
    title: "DB 비교 & 마이그레이션",
    icon: "compare_arrows",
    items: [
      {
        id: "compare-sql-migration",
        label: "SQL → Machbase 전환 방법",
        prompt: "기존 관계형 DB에서 Machbase로 마이그레이션할 때 어떤 점을 주의해야 하나요?",
      },
      {
        id: "compare-other-dbms",
        label: "타 DBMS와의 차이점 및 웹 연결",
        prompt: "웹 프로젝트에 Machbase를 연결할 때 다른 DBMS와 어떤 차이가 있나요?",
      },
      {
        id: "compare-rdbms-tsdb-perf",
        label: "RDBMS·오픈소스 TSDB 성능 비교",
        prompt: "Machbase Neo는 타 시계열 DB나 RDBMS와 비교했을 때 성능이 어느 정도인가요?",
      },
      {
        id: "compare-streaming-match",
        label: "Streaming(Match) 사례 비교",
        prompt: "타 TSDB나 ANSI-SQL과 비교해서 Machbase의 스트리밍 처리는 어떤 장점이 있나요?",
      },
    ],
  },
  {
    id: "ai",
    title: "AI & 이상치",
    icon: "auto_awesome",
    items: [
      {
        id: "ai-design",
        label: "AI를 이용한 설계·활용 방법",
        prompt: "Machbase 환경에서 AI 모델을 설계하거나 활용할 수 있는 구체적인 방법이 있나요?",
      },
      {
        id: "ai-diffusion",
        label: "Diffusion 모델과 시계열 DB 연계",
        prompt: "디퓨전 모델을 시계열 데이터베이스에 적용하는 것이 가능한가요?",
      },
      {
        id: "ai-anomaly",
        label: "이상치 탐지 및 제거",
        prompt: "센서 데이터에서 이상치를 검색하고 제거하는 방법을 더 자세히 알 수 있을까요?",
      },
      {
        id: "ai-bulk-python",
        label: "대용량 데이터 메모리 효율적 추출",
        prompt: "수억 건의 데이터를 Python에서 메모리 부하 없이 가져오려면 어떻게 해야 하나요?",
      },
    ],
  },
  {
    id: "log",
    title: "로그 & 실시간",
    icon: "description",
    items: [
      {
        id: "log-table",
        label: "로그 테이블 활용 방법",
        prompt: "로그 테이블을 더 유용하게 활용할 수 있는 방법에는 어떤 것들이 있나요?",
      },
      {
        id: "log-realtime",
        label: "실시간 데이터 활용 심화",
        prompt: "실시간 스트리밍 데이터를 Machbase에서 수집하고 처리하려면 어떻게 해야 하나요?",
      },
    ],
  },
  {
    id: "infra",
    title: "인프라 & 배포",
    icon: "dns",
    items: [
      {
        id: "infra-docker",
        label: "Docker를 이용한 DB 구성",
        prompt: "Docker 환경에서 Machbase를 설치하고 운영하는 방법을 자세히 알 수 있을까요?",
      },
      {
        id: "infra-cluster",
        label: "분산 노드·클러스터링 및 클라우드 전략",
        prompt: "Back-up/Mount 기능을 활용해 클러스터나 클라우드 환경을 효율적으로 구성하려면 어떻게 하나요?",
      },
    ],
  },
];
