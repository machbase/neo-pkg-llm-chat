import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Message, PkgProvider, PkgSelectedModel } from '../../types/chat';
import { ChatMessageList } from './ChatMessageList';
import Icon from '../common/Icon';
import neoLogo from '../../assets/image/neowFavicon';

interface SuggestionChip {
    icon: string;
    label: string;
    prompt?: string;
    children?: SuggestionChip[];
}

const SUGGESTION_CHIPS: SuggestionChip[] = [
    { icon: 'table_chart', label: '어떤 테이블이 있어?', prompt: '테이블 리스트 조회 해줘' },
    { icon: 'sell', label: '태그 목록 보여줘', prompt: 'Example 테이블의 태그 리스트 조회해줘' },
    { icon: 'menu_book', label: 'Rollup이 뭐야?', prompt: 'Rollup 이 뭐야?' },
    { icon: 'info', label: '서버 상태 확인 해줘', prompt: '서버 상태 알려줘' },
    {
        icon: 'dashboard', label: '분석 대시보드 만들어줘', children: [
            { icon: 'monitoring', label: '분석 대시보드', prompt: 'Example 테이블 데이터의 분석 대시보드 만들어줘' },
            { icon: 'analytics', label: '심층 분석 대시보드', prompt: 'Example 테이블 데이터의 심층 분석 대시보드 만들어줘' },
        ],
    },
    {
        icon: 'query_stats', label: '분석 리포트 작성해줘', children: [
            { icon: 'summarize', label: '분석 리포트', prompt: 'Example 테이블 데이터 분석 리포트 작성해줘' },
            { icon: 'account_balance', label: '금융 분석 리포트', prompt: 'Example 테이블 데이터 금융 분석 리포트 작성해줘' },
            { icon: 'vibration', label: '진동 분석 리포트', prompt: 'Example 테이블 데이터 진동 분석 리포트 작성해줘' },
            { icon: 'directions_car', label: '운행 분석 리포트', prompt: 'Example 테이블 데이터 운행 분석 리포트 작성해줘' },
        ],
    },
];

interface ChatViewProps {
    messages: Message[];
    providerList: PkgProvider[];
    modelsMessage: string;
    inputValue: string;
    isConnected: boolean;
    isDisconnected: boolean;
    reconnect: () => void;
    selectedModel: PkgSelectedModel;
    isComposingRef: React.MutableRefObject<boolean>;
    isProcessingAnswer: boolean;
    getListModels: () => void;
    setInputValue: (value: string) => void;
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
    setSelectedModel: (model: PkgSelectedModel) => void;
    handleSendMessage: () => void;
    handleInterruptMessage: () => void;
    handleClearSession: () => void;
    onOpenSettings?: () => void;
}

export const ChatView = ({
    messages,
    providerList,
    modelsMessage,
    inputValue,
    isConnected,
    isDisconnected,
    reconnect,
    selectedModel,
    isComposingRef,
    isProcessingAnswer,
    getListModels,
    setInputValue,
    setMessages: _setMessages,
    setSelectedModel,
    handleSendMessage,
    handleInterruptMessage,
    handleClearSession,
    onOpenSettings,
}: ChatViewProps) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const wasEmptyRef = useRef(messages.length === 0);
    const isModelSelected = !!(selectedModel.name && selectedModel.name.trim());
    const showSlideDown = wasEmptyRef.current && messages.length > 0;

    const SCROLL_THRESHOLD = 100;
    const [showScrollTop, setShowScrollTop] = useState(false);
    const [showScrollBottom, setShowScrollBottom] = useState(false);
    const [isModelLoading, setIsModelLoading] = useState(false);
    const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
    const [isReconnecting, setIsReconnecting] = useState(false);
    const [chipChildren, setChipChildren] = useState<SuggestionChip[] | null>(null);
    const modelBtnRef = useRef<HTMLButtonElement>(null);
    const [dropdownPos, setDropdownPos] = useState<{ left: number; bottom: number } | null>(null);

    useEffect(() => {
        wasEmptyRef.current = messages.length === 0;
        if (messages.length === 0) setChipChildren(null);
    }, [messages.length]);

    useEffect(() => {
        adjustTextareaHeight();
    }, [inputValue]);

    useEffect(() => {
        if (providerList.length > 0 || modelsMessage) setIsModelLoading(false);
    }, [providerList, modelsMessage]);

    useEffect(() => {
        if (isConnected) {
            setIsReconnecting(false);
        }
    }, [isConnected]);

    useEffect(() => {
        if (!isReconnecting) return;
        const timer = setTimeout(() => setIsReconnecting(false), 5000);
        return () => clearTimeout(timer);
    }, [isReconnecting]);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;

        const handleScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = el;
            setShowScrollTop(scrollTop > SCROLL_THRESHOLD);
            setShowScrollBottom(scrollTop + clientHeight < scrollHeight - SCROLL_THRESHOLD);
        };

        el.addEventListener('scroll', handleScroll);
        handleScroll();
        return () => el.removeEventListener('scroll', handleScroll);
    }, [messages.length > 0]);

    useEffect(() => {
        if (!isModelMenuOpen) return;
        const handleClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!target.closest('.chat-model-menu') && !target.closest('.chat-model-dropdown')) {
                setIsModelMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [isModelMenuOpen]);

    const adjustTextareaHeight = () => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.style.height = 'auto';
        if (!inputValue.trim()) {
            textarea.style.overflowY = 'hidden';
            return;
        }
        const scrollHeight = textarea.scrollHeight;
        if (scrollHeight > 200) {
            textarea.style.height = '200px';
            textarea.style.overflowY = 'auto';
        } else {
            textarea.style.height = `${scrollHeight}px`;
            textarea.style.overflowY = 'hidden';
        }
    };

    const handleSendAndScroll = () => {
        handleSendMessage();
        requestAnimationFrame(() => {
            const el = scrollRef.current;
            if (!el) return;
            const items = el.querySelectorAll('.chat-message-item-wrap');
            const lastItem = items[items.length - 1];
            if (lastItem) {
                lastItem.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }
        });
    };

    const handleKeyDownEnter = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
            e.preventDefault();
            if (isModelSelected) handleSendAndScroll();
        }
    };

    const handleKeyDownEsc = (e: React.KeyboardEvent<HTMLElement>) => {
        if (e.key === 'Escape' && !e.shiftKey && isProcessingAnswer) {
            e.preventDefault();
            handleInterruptMessage();
        }
    };

    const handleScrollToTop = useCallback(() => {
        scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }, []);

    const handleScrollToBottom = useCallback(() => {
        const el = scrollRef.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }, []);

    const handleClearMessages = () => handleClearSession();

    const handleModelMenuOpen = () => {
        if (modelBtnRef.current) {
            const rect = modelBtnRef.current.getBoundingClientRect();
            setDropdownPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
        }
        setIsModelMenuOpen(true);
        setIsModelLoading(true);
        getListModels();
    };

    const handleModelSelect = (provider: string, model: { name: string; model_id?: string }) => {
        setSelectedModel({
            provider,
            model: model.model_id ?? model.name,
            name: model.name,
        });
        setIsModelMenuOpen(false);
    };

    return (
        <div className="chat-page" onKeyDown={handleKeyDownEsc}>
            {/* Body */}
            <div className="chat-body">
                {messages.length === 0 && (
                    <>
                    <div className="chat-spacer chat-spacer--active" />
                    <div className="chat-welcome">
                        <div className="chat-welcome-icon-wrap">
                            <img src={neoLogo} alt="Neo" className="chat-welcome-logo" />
                        </div>
                        <h2 className="chat-welcome-title">How can I help you?</h2>
                        {!isModelSelected && (
                            <p className="chat-welcome-hint">Select a model below to start chatting.</p>
                        )}
                    </div>
                    </>
                )}

                {messages.length > 0 && (
                    <div className="chat-main">
                        <ChatMessageList
                            messages={messages}
                            isProcessingAnswer={isProcessingAnswer}
                            userMessageAlign="right"
                            scrollRef={scrollRef}
                        />
                    </div>
                )}

                {/* Clear button (top-right) */}
                {messages.length > 0 && (
                    <div className="chat-floating-top">
                        <button className="chat-scroll-btn" onClick={handleClearMessages} title="Clear session">
                            <Icon name="delete_sweep" className="icon-sm" />
                        </button>
                    </div>
                )}

                {/* Scroll buttons (bottom-right) */}
                {messages.length > 0 && (showScrollTop || showScrollBottom) && (
                    <div className="chat-floating-bottom">
                        {showScrollTop && (
                            <button className="chat-scroll-btn" onClick={handleScrollToTop} title="Scroll to top">
                                <Icon name="keyboard_arrow_up" className="icon-sm" />
                            </button>
                        )}
                        {showScrollBottom && (
                            <button className="chat-scroll-btn" onClick={handleScrollToBottom} title="Scroll to bottom">
                                <Icon name="keyboard_arrow_down" className="icon-sm" />
                            </button>
                        )}
                    </div>
                )}

                {/* Input */}
                <div className={`chat-input-wrap ${showSlideDown ? 'chat-input-wrap--slide-down' : ''}`}>
                    <div className={`chat-input-container ${isDisconnected ? 'chat-input-container--disconnected' : ''}`}>
                        <div className="chat-input-row">
                            <textarea
                                ref={textareaRef}
                                value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}
                                onKeyDown={handleKeyDownEnter}
                                onCompositionStart={() => (isComposingRef.current = true)}
                                onCompositionEnd={() => (isComposingRef.current = false)}
                                placeholder={
                                    !isConnected
                                        ? 'Not connected to server.'
                                        : isModelSelected
                                          ? `Message ${selectedModel.name}...`
                                          : 'Select a model first...'
                                }
                                disabled={!isConnected}
                                className="chat-input"
                                rows={1}
                            />
                        </div>
                        <div className="chat-toolbar">
                            <div className="chat-toolbar-left">
                                {/* Model selector */}
                                <div className="chat-model-menu">
                                    <button
                                        ref={modelBtnRef}
                                        className={`chat-model-btn ${isModelSelected ? 'chat-model-btn--active' : isConnected ? 'chat-model-btn--pulse' : ''}`}
                                        onClick={handleModelMenuOpen}
                                    >
                                        <span className="chat-model-label">
                                            {isModelSelected ? `${selectedModel.provider} / ${selectedModel.name}` : 'Select model'}
                                        </span>
                                        <Icon name="unfold_more" className="icon-xs" />
                                    </button>
                                    {isModelMenuOpen && dropdownPos && createPortal(
                                        <div
                                            className="chat-model-dropdown"
                                            style={{ left: dropdownPos.left, bottom: dropdownPos.bottom }}
                                        >
                                            <div className="chat-model-dropdown-header">Models</div>
                                            {isModelLoading ? (
                                                <div className="chat-model-dropdown-status">
                                                    <Icon name="progress_activity" className="icon-sm chat-spin" />
                                                    <span>Loading models...</span>
                                                </div>
                                            ) : modelsMessage ? (
                                                <div className="chat-model-dropdown-status">{modelsMessage}</div>
                                            ) : (
                                                providerList.map((provider) => (
                                                    <div key={provider.provider} className="chat-model-dropdown-group">
                                                        <div className="chat-model-dropdown-label">
                                                            {provider.provider}
                                                        </div>
                                                        {provider.models.map((model) => {
                                                            const isSelected =
                                                                selectedModel.provider === provider.provider &&
                                                                selectedModel.model === (model.model_id ?? model.name);
                                                            return (
                                                                <button
                                                                    key={`${provider.provider}-${model.name}`}
                                                                    className={`chat-model-dropdown-item ${isSelected ? 'chat-model-dropdown-item--selected' : ''}`}
                                                                    onClick={() => handleModelSelect(provider.provider, model)}
                                                                >
                                                                    <span>{model.name}</span>
                                                                    {isSelected && <Icon name="check" className="icon-sm" />}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                ))
                                            )}
                                        </div>,
                                        document.body
                                    )}
                                </div>

                                {/* Connection status */}
                                <div className={`chat-conn-badge ${isConnected ? 'chat-conn-badge--on' : 'chat-conn-badge--off'}`}>
                                    <span className="chat-conn-dot" />
                                    <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
                                </div>
                                {!isConnected && (
                                    <button
                                        className="chat-toolbar-action"
                                        onClick={() => { setIsReconnecting(true); reconnect(); }}
                                        disabled={isReconnecting}
                                        title="Reconnect"
                                    >
                                        <Icon name="sync" className={`icon-sm ${isReconnecting ? 'chat-spin' : ''}`} />
                                    </button>
                                )}

                            </div>
                            <div className="chat-toolbar-right">
                                {isProcessingAnswer ? (
                                    <button className="chat-send-btn chat-send-btn--stop" onClick={handleInterruptMessage} title="Stop generating">
                                        <Icon name="stop" className="icon-sm" />
                                    </button>
                                ) : (
                                    <button
                                        className="chat-send-btn"
                                        onClick={handleSendAndScroll}
                                        disabled={!isConnected || !inputValue.trim() || !isModelSelected}
                                        title="Send message"
                                    >
                                        <Icon name="arrow_upward" className="icon-sm" />
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                    {onOpenSettings && (
                        <button className="chat-settings-btn" onClick={onOpenSettings} title="Settings">
                            <Icon name="settings" className="icon-sm" />
                        </button>
                    )}
                </div>

                {/* Suggestion chips */}
                {messages.length === 0 && isModelSelected && (
                    <div className={`chat-suggestions ${chipChildren !== null ? 'chat-suggestions--sub' : ''}`}>
                        {chipChildren !== null && (
                            <button
                                className="chat-suggestion-chip chat-suggestion-chip--back"
                                onClick={() => setChipChildren(null)}
                            >
                                <Icon name="arrow_back" className="icon-sm" />
                            </button>
                        )}
                        {(chipChildren ?? SUGGESTION_CHIPS).map((chip) => (
                            <button
                                key={chip.label}
                                className="chat-suggestion-chip"
                                onClick={() => {
                                    if (chip.children) {
                                        setChipChildren(chip.children);
                                    } else if (chip.prompt) {
                                        setInputValue(chip.prompt);
                                    }
                                }}
                            >
                                <Icon name={chip.icon} className="icon-sm" />
                                <span>{chip.label}</span>
                                {chip.children && <Icon name="chevron_right" className="icon-xs" />}
                            </button>
                        ))}
                        {chipChildren !== null && (
                            <div className="chat-suggestion-chip chat-suggestion-chip--spacer" />
                        )}
                    </div>
                )}

                {messages.length === 0 && <div className="chat-spacer chat-spacer--active" />}
            </div>
        </div>
    );
};
