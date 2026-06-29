import React, { useCallback, useEffect, useRef, useState } from 'react';

import type { FavoriteItem } from '../../hooks/useFavorites';
import Icon from '../common/Icon';

interface FavoritesPanelProps {
    favorites: FavoriteItem[];
    onPick: (prompt: string) => void;
    onAdd: (prompt: string) => void;
    onRemove: (id: string) => void;
    onReorder: (fromIndex: number, toIndex: number) => void;
}

const FLASH_MS = 1200;

export function FavoritesPanel({ favorites, onPick, onAdd, onRemove, onReorder }: FavoritesPanelProps) {
    const [draft, setDraft] = useState('');
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [overIndex, setOverIndex] = useState<number | null>(null);
    const [flashId, setFlashId] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const itemRefs = useRef<Map<string, HTMLLIElement>>(new Map());
    const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => {
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    }, []);

    // Briefly highlight + scroll an existing item into view (when a duplicate is
    // re-added). The null→rAF→id flip restarts the animation on repeat attempts.
    const flashExisting = useCallback((id: string) => {
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        setFlashId(null);
        requestAnimationFrame(() => {
            setFlashId(id);
            itemRefs.current.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        flashTimerRef.current = setTimeout(() => setFlashId(null), FLASH_MS);
    }, []);

    const commitDraft = useCallback(() => {
        const text = draft.trim();
        if (!text) return;
        const existing = favorites.find((f) => f.prompt === text);
        if (existing) {
            // Already there — don't add; show the user where it is, keep the draft.
            flashExisting(existing.id);
            return;
        }
        onAdd(text);
        setDraft('');
        requestAnimationFrame(() => inputRef.current?.focus());
    }, [draft, favorites, onAdd, flashExisting]);

    const handleDraftKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commitDraft();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft('');
            inputRef.current?.blur();
        }
    };

    const handleDrop = () => {
        if (dragIndex !== null && overIndex !== null) {
            onReorder(dragIndex, overIndex);
        }
        setDragIndex(null);
        setOverIndex(null);
    };

    return (
        <div className="chat-fav-panel">
            <div className="chat-fav-header">
                <span className="chat-fav-title">즐겨찾기</span>
                <span className="chat-fav-meta">
                    {favorites.length > 0 ? `${favorites.length}개 · 드래그로 정렬` : '아직 없음'}
                </span>
            </div>

            {favorites.length > 0 && (
                <ul
                    className="chat-fav-list"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleDrop}
                >
                    {favorites.map((item, index) => {
                        const isDragging = dragIndex === index;
                        const isOver = overIndex === index && dragIndex !== null && dragIndex !== index;
                        const isFlash = flashId === item.id;
                        return (
                            <li
                                key={item.id}
                                ref={(el) => {
                                    if (el) itemRefs.current.set(item.id, el);
                                    else itemRefs.current.delete(item.id);
                                }}
                                className={`chat-fav-item ${isDragging ? 'chat-fav-item--dragging' : ''} ${isOver ? 'chat-fav-item--over' : ''} ${isFlash ? 'chat-fav-item--flash' : ''}`}
                                draggable
                                onDragStart={(e) => {
                                    setDragIndex(index);
                                    e.dataTransfer.effectAllowed = 'move';
                                }}
                                onDragEnter={() => setOverIndex(index)}
                                onDragEnd={() => {
                                    setDragIndex(null);
                                    setOverIndex(null);
                                }}
                            >
                                <span className="chat-fav-grip" aria-hidden="true">
                                    <Icon name="drag_indicator" className="icon-sm" />
                                </span>
                                <button
                                    type="button"
                                    className="chat-fav-item-text"
                                    onClick={() => onPick(item.prompt)}
                                    title={item.prompt}
                                >
                                    {item.prompt}
                                </button>
                                <button
                                    type="button"
                                    className="chat-fav-item-remove"
                                    onClick={() => onRemove(item.id)}
                                    title="즐겨찾기 해제"
                                    aria-label="즐겨찾기 해제"
                                >
                                    <Icon name="close" className="icon-xs" />
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}

            <div className="chat-fav-add">
                <input
                    ref={inputRef}
                    className="chat-fav-add-input"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleDraftKey}
                    placeholder="자주 쓰는 질문 입력..."
                />
                <button
                    type="button"
                    className="chat-fav-add-btn"
                    onClick={commitDraft}
                    disabled={!draft.trim()}
                    title="즐겨찾기 추가 (Enter)"
                    aria-label="즐겨찾기 추가"
                >
                    <Icon name="save" className="icon-sm" />
                </button>
            </div>
        </div>
    );
}
