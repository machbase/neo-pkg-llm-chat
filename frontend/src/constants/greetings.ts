// 웰컴 화면 인사말 — 시간대 세트 + 공통 세트에서 무작위 선택
// · 빈 상태 화면 → 이어지는 대화를 암시하는 문구("이어서…") 제외

type Slot = "dawn" | "morning" | "afternoon" | "evening";

const NEUTRAL_GREETINGS = [
    "어떤 데이터가 궁금하세요?",
    "데이터를 조회해 볼까요? 근데 SQL을 곁들인",
    "Machbase 에 오신 것을 환영합니다.",
    "모든 쿼리는 저를 통합니다.",
    "시계열 DB의 차이가 느껴지십니까 휴먼?",
    "어서 와. 시계열 디비는 처음이지?",
    "뭔가 고민하고 계신 눈치인데요?",
    "추억은 사진첩에, 시계열은 Machbase에"
];

const TIME_GREETINGS: Record<Slot, string[]> = {
    dawn: [
        "늦은 시간까지 고생 많으세요.",
        "새벽에도 데이터는 다양한 변화를 보여줍니다.",
        "지금 깨어 있는 건 저희 둘뿐이네요.",
    ],
    morning: [
        "좋은 아침이에요.",
        "간밤에 쌓인 데이터부터 볼까요?",
        "커피 한 잔 하셨나요? 데이터는 벌써 일하고 있네요.",
    ],
    afternoon: [
        "나른한 오후네요. 졸고 있진 않으신가요?",
        "점심은 드셨어요?",
        "오후엔 뭘 볼까요?",
    ],
    evening: [
        "좋은 저녁이에요.",
        "퇴근 전에 하나만 볼까요?",
        "오늘 수집한 데이터, 정리해볼까요?",
    ],
};

/** 6–11 아침 · 12–17 오후 · 18–22 저녁 · 나머지 새벽. */
function slotFor(hour: number): Slot {
    if (hour >= 6 && hour < 12) return "morning";
    if (hour >= 12 && hour < 18) return "afternoon";
    if (hour >= 18 && hour < 23) return "evening";
    return "dawn";
}

/** exclude: 화면의 현재 문구 제외(다시 뽑으면 항상 바뀜) — 후보가 비면 무시 */
export function pickGreeting(now: Date = new Date(), exclude?: string): string {
    const pool = [...TIME_GREETINGS[slotFor(now.getHours())], ...NEUTRAL_GREETINGS];
    const rest = exclude ? pool.filter((line) => line !== exclude) : pool;
    const from = rest.length > 0 ? rest : pool;
    return from[Math.floor(Math.random() * from.length)];
}
