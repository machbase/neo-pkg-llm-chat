export interface Message {
    id: string;
    content: string;
    timestamp: number;
    role: 'user' | 'assistant';
    type: 'block' | 'msg' | 'answer' | 'question' | 'error';
    isProcess: boolean;
    isInterrupt: boolean;
    /**
     * Display label of the model that produced this message, e.g. "claude / haiku".
     * Only stamped on streamed answers, so its presence is what gates the footer:
     * stop notices and errors carry none and stay bare.
     */
    model?: string;
}

export interface PkgModel {
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
