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
    // base 는 이미 .../ws 로 끝나는 service proxy 경유 URL.
    // user 는 URL segment 가 아니라 첫 채팅 메시지의 user_id 필드로 전달된다
    // (백엔드 onBrowserConnection 의 fallback 로직이 이를 인증 user 로 처리).
    // — JSH ws 모듈의 path-template 매칭이 끝 segment 정적일 때만 동작하기 때문에
    //   /ws/{user} 같은 URL 패턴을 못 받음. /ws 정적 경로로 통일.
    return getWsBase();
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
    // Monotonic token for sendChatWhenReady's polling loop. Each new call
    // increments the token and captures it locally; if the captured token
    // no longer matches the ref by the time a poll tick fires, that older
    // invocation aborts (last-write-wins) so rapid successive edit-saves
    // collapse to a single network send.
    const pendingSendTokenRef = useRef(0);

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

    // Send chat payload once WS reaches OPEN.
    // `await connect()` only resolves after WebSocket object creation, not after
    // the OPEN transition, so sendExt called immediately afterward may silently
    // drop the payload (sendExt no-ops when readyState !== OPEN). This helper
    // polls readyState (every 50ms, up to 5s) and sends exactly once.
    const sendChatWhenReady = useCallback(async (query: string) => {
        if (!sSelectedModel.provider || !sSelectedModel.model) return;

        // Last-write-wins: bump the shared token and capture this call's
        // generation. Any earlier in-flight invocation will see its captured
        // token no longer match and abort silently (no send, no error msg).
        pendingSendTokenRef.current += 1;
        const myToken = pendingSendTokenRef.current;
        const isStillCurrent = () => pendingSendTokenRef.current === myToken;

        const payload: ExtWsOutgoing = {
            type: "chat",
            user_id: getCurrentUser() ?? "",
            session_id: sessionIdRef.current,
            provider: sSelectedModel.provider,
            model: sSelectedModel.model,
            query,
        };

        // Fast path: already OPEN.
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            if (!isStillCurrent()) return;
            socketRef.current.send(JSON.stringify(payload));
            return;
        }

        // Ensure a connect attempt is in flight.
        if (!socketRef.current) {
            await connect();
            if (!isStillCurrent()) return;
        }

        // Poll for OPEN up to 5s.
        const TIMEOUT_MS = 5000;
        const POLL_MS = 50;
        const start = Date.now();
        while (Date.now() - start < TIMEOUT_MS) {
            // A newer sendChatWhenReady call has superseded this one — bail
            // without sending or surfacing an error. The newer call owns the
            // send semantics from here on.
            if (!isStillCurrent()) return;
            if (socketRef.current?.readyState === WebSocket.OPEN) {
                socketRef.current.send(JSON.stringify(payload));
                return;
            }
            // If the socket was closed/errored entirely, abort.
            if (socketRef.current && socketRef.current.readyState === WebSocket.CLOSED) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }

        // Failed to reach OPEN within timeout — surface an error message,
        // but only if this invocation is still the latest one. Otherwise a
        // superseded call would spam the user with stale errors.
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

    // Edit a previous user message:
    //  1. trim & validate (non-empty, role==='user')
    //  2. if a stream is in flight, close WS (preserving sessionIdRef) — same
    //     pattern as handleInterruptMessage but keeping the session id.
    //  3. truncate messages array at the edited index, replacing content.
    //  4. re-issue the chat request via sendChatWhenReady (handles WS OPEN race).
    const handleEditUserMessage = useCallback((messageId: string, newContent: string) => {
        const trimmed = newContent.trim();
        if (!trimmed) return;

        const index = messages.findIndex((m) => m.id === messageId);
        if (index < 0) return;
        if (messages[index].role !== "user") return;

        // Interrupt any in-flight stream — but PRESERVE sessionIdRef so the
        // server-side session continuity is kept for the re-issued question.
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

        // Truncate at edited index, replacing the edited message's content.
        setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === messageId);
            if (idx < 0) return prev;
            if (prev[idx].role !== "user") return prev;
            const truncated = prev.slice(0, idx + 1);
            truncated[idx] = { ...truncated[idx], content: trimmed };
            return truncated;
        });

        // Re-issue request. sendChatWhenReady handles the WS-not-yet-OPEN race
        // (post-close reconnect path) and silently no-ops if no model selected.
        void sendChatWhenReady(trimmed);
    }, [messages, sendChatWhenReady]);

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
        handleEditUserMessage,
        getListModels,
    };
};
