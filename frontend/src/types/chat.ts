export interface Message {
    id: string;
    content: string;
    timestamp: number;
    role: 'user' | 'assistant';
    type: 'block' | 'msg' | 'question' | 'error';
    isProcess: boolean;
    isInterrupt: boolean;
    /** 답변 생성 모델 표시 이름(예: "claude / haiku") — 스트리밍 답변에만 기록, 있을 때만 하단 표시 */
    model?: string;
}

interface PkgModel {
    name: string;
    model_id?: string;
}

export interface PkgProvider {
    provider: string;
    models: PkgModel[];
}

export interface PkgSelectedModel {
    provider: string;
    model: string;
    name: string;
}

export type UserMessageAlign = 'left' | 'right';
