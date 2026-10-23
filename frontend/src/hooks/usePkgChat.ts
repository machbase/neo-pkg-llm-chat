import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { getApiToken } from "../utils/auth";
import { getWsBase } from "../services/baseUrl";
import type { Message, PkgProvider, PkgSelectedModel } from "../types/chat";

interface ExtMsgIncoming {
    type: string;
    providers?: PkgProvider[];
    msg?: string;
    /** 후속 질문 칩 — answer_stop 뒤에 도착, ollama·생성 실패 시 없음 */
    items?: string[];
    message?: {
        ver: string;
        id: number;
        type: string;
        body?: {
            ofStreamBlockDelta?: {
                contentType?: string;
                text?: string;
            };
        };
    };
}

type ExtWsOutgoing =
    | { type: "get_models" }
    | { type: "chat"; session_id: string; provider: string; model: string; query: string; tz?: string };

// 브라우저 시간대(IANA 이름) — 리포트 등 시각 표시 기준
const browserTimeZone = (): string | undefined => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
        return undefined;
    }
};

const generateSessionId = (): string => `sess-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

const DEFAULT_DELTA_SET = (target: "msg" | "block", model?: string): Message => {
    const ts = Date.now();
    return {
        id: `${target}-${ts}-${Math.random()}`,
        content: "",
        timestamp: ts,
        role: "assistant",
        type: target,
        isProcess: true,
        isInterrupt: false,
        // 답변 메시지만 대상 — 도구 블록은 접혀 있어 푸터 없음
        model: target === "msg" ? model : undefined,
    };
};

export const usePkgChat = () => {
    const socketRef = useRef<WebSocket | null>(null);
    const sessionIdRef = useRef<string>(generateSessionId());
    const [wsReady, setWsReady] = useState(false);
    const wasConnectedRef = useRef(false);

    const [messages, setMessages] = useState<Message[]>([]);
    const [sInputValue, setInputValue] = useState("");
    const [sProcessingAnswer, setProcessingAnswer] = useState(false);
    const [sSelectedModel, setSelectedModel] = useState<PkgSelectedModel>({ provider: "", model: "", name: "" });
    const [sProviderList, setProviderList] = useState<PkgProvider[]>([]);
    const [sFollowups, setFollowups] = useState<string[]>([]);
    const [sModelsMessage, setModelsMessage] = useState("");

    const isComposingRef = useRef(false);
    const processingAnswerRef = useRef(false);
    // 소켓 핸들러에서 읽음(옛 state 를 붙잡음) — 답변마다 모델 라벨을 찍어 세션 중 모델 변경에도 정확
    const modelLabelRef = useRef("");
    modelLabelRef.current = sSelectedModel.name
        ? `${sSelectedModel.provider} / ${sSelectedModel.name}`
        : "";
    // sendChatWhenReady 폴링용 단조 증가 번호 — 호출마다 증가·캡처
    // · 폴링 중 번호가 바뀌면 이전 호출은 중단(마지막 호출만 전송) — 연속 수정·저장을 전송 1회로 합침
    const pendingSendTokenRef = useRef(0);

    const getProcessingAnswer = useMemo(() => sProcessingAnswer, [sProcessingAnswer]);

    const handleModelsResponse = useCallback((raw: ExtMsgIncoming) => {
        if (raw.providers) {
            setProviderList(raw.providers);
            setModelsMessage("");
        } else if (raw.msg) {
            setProviderList([]);
            setModelsMessage(raw.msg);
        }
    }, []);

    // 후속 질문 칩 — 답변이 화면에 뜬 뒤 도착, 칩 추가만 함
    const handleFollowups = useCallback((raw: ExtMsgIncoming) => {
        setFollowups(Array.isArray(raw.items) ? raw.items : []);
    }, []);

    const handleErrorResponse = useCallback((raw: ExtMsgIncoming) => {
        setProcessingAnswer(false);
        processingAnswerRef.current = false;
        if (raw.msg) {
            setMessages((prev) => [
                ...prev,
                { id: `msg-${Date.now()}-error`, content: raw.msg!, timestamp: Date.now(), role: "assistant", type: "error", isProcess: false, isInterrupt: false },
            ]);
        }
    }, []);

    // 스트리밍 메시지 처리
    const handleMsgResponse = useCallback((raw: ExtMsgIncoming) => {
        const msg = raw.message;
        if (!msg) return;

        switch (msg.type) {
            case "answer_start":
                setProcessingAnswer(true);
                processingAnswerRef.current = true;
                break;

            case "answer_stop":
                setProcessingAnswer(false);
                processingAnswerRef.current = false;
                // 진행 중 표시가 남은 메시지 확정
                setMessages((prev) => {
                    const hasProcessing = prev.some((m) => m.isProcess);
                    if (!hasProcessing) return prev;
                    return prev.map((m) => m.isProcess ? { ...m, isProcess: false } : m);
                });
                break;

            case "stream_msg_start":
            case "stream_block_start":
                // 무시 — 메시지는 첫 delta에서 생성
                break;

            case "stream_block_delta":
            case "stream_msg_delta": {
                const targetType = msg.type === "stream_msg_delta" ? "msg" : "block";
                const text = msg.body?.ofStreamBlockDelta?.text ?? "";
                if (!text) break;
                setMessages((prev) => {
                    const updated = [...prev];
                    for (let i = updated.length - 1; i >= 0; i--) {
                        if (updated[i].type === targetType && updated[i].isProcess) {
                            updated[i] = { ...updated[i], content: updated[i].content + text };
                            return updated;
                        }
                    }
                    // 진행 중 메시지 없음 → 첫 delta로 생성
                    return [...prev, { ...DEFAULT_DELTA_SET(targetType, modelLabelRef.current), content: text }];
                });
                break;
            }

            case "stream_block_stop":
            case "stream_msg_stop": {
                const targetType = msg.type === "stream_msg_stop" ? "msg" : "block";
                setMessages((prev) => {
                    if (prev.length === 0) return prev;
                    const updated = [...prev];
                    for (let i = updated.length - 1; i >= 0; i--) {
                        if (updated[i].type === targetType && updated[i].isProcess) {
                            if (!updated[i].content.trim()) {
                                updated.splice(i, 1);
                            } else {
                                updated[i] = { ...updated[i], isProcess: false };
                            }
                            break;
                        }
                    }
                    return updated;
                });
                break;
            }
        }
    }, []);

    // 핸들러는 ref 보관 — connect()가 핸들러에 의존하지 않게 함
    const handlersRef = useRef({ handleModelsResponse, handleMsgResponse, handleErrorResponse, handleFollowups });
    useEffect(() => {
        handlersRef.current = { handleModelsResponse, handleMsgResponse, handleErrorResponse, handleFollowups };
    }, [handleModelsResponse, handleMsgResponse, handleErrorResponse, handleFollowups]);

    const connect = useCallback(async () => {
        const prev = socketRef.current;
        if (prev) {
            prev.onopen = null;
            prev.onmessage = null;
            prev.onclose = null;
            prev.onerror = null;
            prev.close();
            socketRef.current = null;
        }

        try {
            const url = await getWsBase();
            const ws = new WebSocket(url);
            socketRef.current = ws;

            ws.onopen = () => {
                if (socketRef.current !== ws) return;
                wasConnectedRef.current = true;
                setWsReady(true);
            };

            ws.onmessage = (event) => {
                if (socketRef.current !== ws) return;
                try {
                    const raw: ExtMsgIncoming = JSON.parse(event.data);
                    const h = handlersRef.current;
                    switch (raw.type) {
                        case "models":
                            h.handleModelsResponse(raw);
                            break;
                        case "msg":
                            h.handleMsgResponse(raw);
                            break;
                        case "error":
                            h.handleErrorResponse(raw);
                            break;
                        case "followups":
                            h.handleFollowups(raw);
                            break;
                    }
                } catch (e) {
                    console.error("[WS] Parse error:", e);
                }
            };

            ws.onclose = () => {
                if (socketRef.current !== ws) return;
                socketRef.current = null;
                setWsReady(false);
                setProcessingAnswer(false);
            };

            ws.onerror = (err) => {
                console.error("[WS] Error:", err);
            };
        } catch (e) {
            console.error("[WS] Connect error:", e);
        }
    }, []);

    useEffect(() => {
        connect();
        return () => {
            const ws = socketRef.current;
            if (ws) {
                ws.onopen = null;
                ws.onmessage = null;
                ws.onclose = null;
                ws.onerror = null;
                ws.close();
                socketRef.current = null;
            }
        };
    }, [connect]);

    // 백엔드는 이 API 토큰만으로 사용자 판정
    // · 보낼 때마다 저장소에서 읽음 — 토큰 교체·삭제 즉시 반영
    const wireMessage = (payload: ExtWsOutgoing) => JSON.stringify({ ...payload, auth_token: getApiToken() });

    const sendExt = useCallback((payload: ExtWsOutgoing) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(wireMessage(payload));
        }
    }, []);

    // WS 가 OPEN 된 뒤 채팅 전송(정확히 1회)
    // · await connect() 는 객체 생성까지만 기다림 — 바로 sendExt 하면 OPEN 전이라 조용히 버려짐
    // · readyState 를 50ms 간격·최대 5초 폴링
    const sendChatWhenReady = useCallback(async (query: string) => {
        if (!sSelectedModel.provider || !sSelectedModel.model) return;

        // 마지막 호출 우선 — 번호 증가·캡처, 진행 중이던 이전 호출은 조용히 중단(전송·오류 없음)
        pendingSendTokenRef.current += 1;
        const myToken = pendingSendTokenRef.current;
        const isStillCurrent = () => pendingSendTokenRef.current === myToken;

        const payload: ExtWsOutgoing = {
            type: "chat",
            session_id: sessionIdRef.current,
            provider: sSelectedModel.provider,
            model: sSelectedModel.model,
            query,
            tz: browserTimeZone(),
        };

        // 이미 OPEN이면 즉시 전송
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            if (!isStillCurrent()) return;
            socketRef.current.send(wireMessage(payload));
            return;
        }

        // 소켓 없으면 연결 시작
        if (!socketRef.current) {
            await connect();
            if (!isStillCurrent()) return;
        }

        const TIMEOUT_MS = 5000;
        const POLL_MS = 50;
        const start = Date.now();
        while (Date.now() - start < TIMEOUT_MS) {
            // 더 새 호출이 있음 — 전송·오류 표시 없이 중단(전송은 새 호출 담당)
            if (!isStillCurrent()) return;
            if (socketRef.current?.readyState === WebSocket.OPEN) {
                socketRef.current.send(wireMessage(payload));
                return;
            }
            // 소켓이 닫혔으면 중단
            if (socketRef.current && socketRef.current.readyState === WebSocket.CLOSED) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }

        // 시간 안에 OPEN 실패 — 최신 호출일 때만 오류 표시(밀려난 호출의 낡은 오류 방지)
        if (!isStillCurrent()) return;
        setMessages((prev) => [
            ...prev,
            {
                id: `msg-${Date.now()}-edit-error`,
                content: "Failed to reconnect to chat server while editing message.",
                timestamp: Date.now(),
                role: "assistant",
                type: "error",
                isProcess: false,
                isInterrupt: false,
            },
        ]);
    }, [connect, sSelectedModel.provider, sSelectedModel.model]);

    const getListModels = useCallback(() => {
        sendExt({ type: "get_models" });
    }, [sendExt]);

    const handleSendMessage = () => {
        const text = sInputValue.trim();
        if (!text || !sSelectedModel.provider || !sSelectedModel.model) return;
        setFollowups([]);

        const userMessage: Message = {
            id: `msg-${Date.now()}`,
            content: text,
            timestamp: Date.now(),
            role: "user",
            type: "question",
            isProcess: false,
            isInterrupt: false,
        };
        setMessages((prev) => [...prev, userMessage]);

        sendExt({
            type: "chat",
            session_id: sessionIdRef.current,
            provider: sSelectedModel.provider,
            model: sSelectedModel.model,
            query: text,
            tz: browserTimeZone(),
        });

        setInputValue("");
    };

    const handleInterruptMessage = () => {
        setMessages((prev) => prev.map((m) => ({ ...m, isInterrupt: true })));
        // WS 종료로 서버 측 취소 → 재연결
        const ws = socketRef.current;
        if (ws) {
            ws.onopen = null;
            ws.onmessage = null;
            ws.onclose = null;
            ws.onerror = null;
            ws.close();
            socketRef.current = null;
        }
        setWsReady(false);
        setProcessingAnswer(false);
        processingAnswerRef.current = false;
        setTimeout(() => { connect(); }, 500);
    };

    // 이전 사용자 메시지 수정
    // · 1) trim·검증(비어 있지 않음, role==='user')
    // · 2) 응답 중이면 WS 종료(sessionIdRef 유지 — handleInterruptMessage 와 같되 세션 유지)
    // · 3) 수정한 위치에서 메시지 배열 자르고 내용 교체
    // · 4) sendChatWhenReady 로 재요청(WS OPEN 경합 처리)
    const handleEditUserMessage = useCallback((messageId: string, newContent: string) => {
        const trimmed = newContent.trim();
        if (!trimmed) return;
        setFollowups([]);

        const index = messages.findIndex((m) => m.id === messageId);
        if (index < 0) return;
        if (messages[index].role !== "user") return;

        // 진행 중 응답 중단 — sessionIdRef 는 유지(재질문이 서버 세션을 이어감)
        if (processingAnswerRef.current) {
            const ws = socketRef.current;
            if (ws) {
                ws.onopen = null;
                ws.onmessage = null;
                ws.onclose = null;
                ws.onerror = null;
                ws.close();
                socketRef.current = null;
            }
            setWsReady(false);
            setProcessingAnswer(false);
            processingAnswerRef.current = false;
        }

        // 수정 위치까지 자르고 내용 교체
        setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === messageId);
            if (idx < 0) return prev;
            if (prev[idx].role !== "user") return prev;
            const truncated = prev.slice(0, idx + 1);
            truncated[idx] = { ...truncated[idx], content: trimmed };
            return truncated;
        });

        // 재요청 — WS 재연결 중 OPEN 경합은 sendChatWhenReady 가 처리, 모델 미선택이면 무시
        void sendChatWhenReady(trimmed);
    }, [messages, sendChatWhenReady]);

    const handleClearSession = () => {
        // WS 종료로 서버 측 취소(중단과 동일) → 세션 초기화 후 재연결
        const ws = socketRef.current;
        if (ws) {
            ws.onopen = null;
            ws.onmessage = null;
            ws.onclose = null;
            ws.onerror = null;
            ws.close();
            socketRef.current = null;
        }
        setWsReady(false);
        sessionIdRef.current = generateSessionId();
        setMessages([]);
        setFollowups([]);
        setProcessingAnswer(false);
        processingAnswerRef.current = false;
        setTimeout(() => { connect(); }, 500);
    };

    const isConnected = wsReady && socketRef.current?.readyState === WebSocket.OPEN;
    const isDisconnected = !isConnected && wasConnectedRef.current;

    return {
        messages,
        inputValue: sInputValue,
        setInputValue,
        isProcessingAnswer: getProcessingAnswer,
        selectedModel: sSelectedModel,
        setSelectedModel,
        providerList: sProviderList,
        followups: sFollowups,
        modelsMessage: sModelsMessage,
        isComposingRef,
        isConnected,
        isDisconnected,
        reconnect: connect,
        handleSendMessage,
        handleInterruptMessage,
        handleClearSession,
        handleEditUserMessage,
        getListModels,
    };
};
