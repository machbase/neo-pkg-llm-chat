import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { getCurrentUser } from "../utils/auth";
import { getWsBase } from "../services/baseUrl";
import type { Message, PkgProvider, PkgSelectedModel } from "../types/chat";

interface ExtMsgIncoming {
    type: string;
    session?: string;
    providers?: PkgProvider[];
    msg?: string;
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
    | { type: "get_models"; user_id: string }
    | { type: "chat"; user_id: string; session_id: string; provider: string; model: string; query: string }
    | { type: "stop"; user_id: string; session_id: string }
    | { type: "clear"; user_id: string; session_id: string };

const getExtWsUrl = async (): Promise<string> => {
    const base = await getWsBase();
    const userId = getCurrentUser() ?? "sys";
    return `${base}/${userId}/ws`;
};

const generateSessionId = (): string => `sess-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

const DEFAULT_DELTA_SET = (target: "msg" | "block"): Message => {
    const ts = Date.now();
    return {
        id: `${target}-${ts}-${Math.random()}`,
        content: "",
        timestamp: ts,
        role: "assistant",
        type: target,
        isProcess: true,
        isInterrupt: false,
    };
};

export const usePkgChat = (pInitialMessages?: Message[]) => {
    const socketRef = useRef<WebSocket | null>(null);
    const sessionIdRef = useRef<string>(generateSessionId());
    const [wsReady, setWsReady] = useState(false);
    const wasConnectedRef = useRef(false);

    const [messages, setMessages] = useState<Message[]>(pInitialMessages ?? []);
    const [sInputValue, setInputValue] = useState("");
    const [sProcessingAnswer, setProcessingAnswer] = useState(false);
    const [sSelectedModel, setSelectedModel] = useState<PkgSelectedModel>({ provider: "", model: "", name: "" });
    const [sProviderList, setProviderList] = useState<PkgProvider[]>([]);
    const [sModelsMessage, setModelsMessage] = useState("");
    const callbackRef = useRef<any>(undefined);

    const isComposingRef = useRef(false);
    const processingAnswerRef = useRef(false);

    const getProcessingAnswer = useMemo(() => sProcessingAnswer, [sProcessingAnswer]);

    // Handle models response
    const handleModelsResponse = useCallback((raw: ExtMsgIncoming) => {
        if (raw.providers) {
            setProviderList(raw.providers);
            setModelsMessage("");
        } else if (raw.msg) {
            setProviderList([]);
            setModelsMessage(raw.msg);
        }
    }, []);

    // Handle stop response
    const handleStopResponse = useCallback((raw: ExtMsgIncoming) => {
        setProcessingAnswer(false);
        processingAnswerRef.current = false;
        if (raw.msg) {
            setMessages((prev) => [
                ...prev,
                { id: `msg-${Date.now()}-stop`, content: raw.msg!, timestamp: Date.now(), role: "assistant", type: "msg", isProcess: false, isInterrupt: false },
            ]);
        }
    }, []);

    // Handle error response
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

    // Handle msg response (streaming)
    const handleMsgResponse = useCallback((raw: ExtMsgIncoming) => {
        const msg = raw.message;
        if (!msg) return;

        switch (msg.type) {
            case "answer_start":
                setProcessingAnswer(true);
                processingAnswerRef.current = true;
                break;

            case "answer_stop":
                if (callbackRef?.current) {
                    callbackRef.current();
                    callbackRef.current = undefined;
                }
                setProcessingAnswer(false);
                processingAnswerRef.current = false;
                // Finalize any messages still marked as processing
                setMessages((prev) => {
                    const hasProcessing = prev.some((m) => m.isProcess);
                    if (!hasProcessing) return prev;
                    return prev.map((m) => m.isProcess ? { ...m, isProcess: false } : m);
                });
                break;

            case "stream_msg_start":
            case "stream_block_start":
                // Do nothing — message is created lazily on first delta
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
                    // No existing processing message — create one with first delta
                    return [...prev, { ...DEFAULT_DELTA_SET(targetType), content: text }];
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

    // Keep handlers in refs so connect() doesn't depend on them
    const handlersRef = useRef({ handleModelsResponse, handleMsgResponse, handleStopResponse, handleErrorResponse });
    useEffect(() => {
        handlersRef.current = { handleModelsResponse, handleMsgResponse, handleStopResponse, handleErrorResponse };
    }, [handleModelsResponse, handleMsgResponse, handleStopResponse, handleErrorResponse]);

    // WebSocket connect
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
            const url = await getExtWsUrl();
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
                        case "stop":
                            h.handleStopResponse(raw);
                            break;
                        case "error":
                            h.handleErrorResponse(raw);
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

    // Send to WS
    const sendExt = useCallback((payload: ExtWsOutgoing) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify(payload));
        }
    }, []);

    // Request model list
    const getListModels = useCallback(() => {
        sendExt({ type: "get_models", user_id: getCurrentUser() ?? "" });
    }, [sendExt]);

    // Send chat message
    const handleSendMessage = () => {
        const text = sInputValue.trim();
        if (!text || !sSelectedModel.provider || !sSelectedModel.model) return;

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
            user_id: getCurrentUser() ?? "",
            session_id: sessionIdRef.current,
            provider: sSelectedModel.provider,
            model: sSelectedModel.model,
            query: text,
        });

        setInputValue("");
    };

    const handleInterruptMessage = () => {
        setMessages((prev) => prev.map((m) => ({ ...m, isInterrupt: true })));
        // Close WS to trigger server-side cancellation, then reconnect
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
        // Reconnect after a short delay
        setTimeout(() => { connect(); }, 500);
    };

    const handleClearSession = () => {
        // Close WS to trigger server-side cancellation (same as interrupt),
        // then reset session and reconnect
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
        setProcessingAnswer(false);
        processingAnswerRef.current = false;
        setTimeout(() => { connect(); }, 500);
    };

    const isConnected = wsReady && socketRef.current?.readyState === WebSocket.OPEN;
    const isDisconnected = !isConnected && wasConnectedRef.current;

    return {
        messages,
        setMessages,
        inputValue: sInputValue,
        setInputValue,
        isProcessingAnswer: getProcessingAnswer,
        selectedModel: sSelectedModel,
        setSelectedModel,
        providerList: sProviderList,
        modelsMessage: sModelsMessage,
        isComposingRef,
        isConnected,
        isDisconnected,
        reconnect: connect,
        handleSendMessage,
        handleInterruptMessage,
        handleClearSession,
        getListModels,
    };
};
