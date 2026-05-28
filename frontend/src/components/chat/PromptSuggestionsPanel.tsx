import { useCallback, useState } from 'react';

import { EXAMPLE_PROMPT_CATEGORIES } from '../../constants/examplePrompts';
import Icon from '../common/Icon';

interface PromptSuggestionsPanelProps {
    onPick: (prompt: string) => void;
    visible: boolean;
}

export function PromptSuggestionsPanel({ onPick, visible }: PromptSuggestionsPanelProps) {
    const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

    const toggleCategory = useCallback((categoryId: string) => {
        setCollapsedCategories((prev) => {
            const next = new Set(prev);
            if (next.has(categoryId)) {
                next.delete(categoryId);
            } else {
                next.add(categoryId);
            }
            return next;
        });
    }, []);

    if (!visible) {
        return null;
    }

    return (
        <div className="chat-prompt-panel">
            {EXAMPLE_PROMPT_CATEGORIES.map((category) => {
                const collapsed = collapsedCategories.has(category.id);
                return (
                    <section className="chat-prompt-category" key={category.id}>
                        <button
                            className="chat-prompt-category-header"
                            onClick={() => toggleCategory(category.id)}
                            type="button"
                            aria-expanded={!collapsed}
                        >
                            <Icon name={category.icon} className="chat-prompt-category-icon" />
                            <span className="chat-prompt-category-title">{category.title}</span>
                            <span className="chat-prompt-category-count">{category.items.length}</span>
                            <Icon
                                name={collapsed ? 'chevron_right' : 'expand_more'}
                                className="chat-prompt-category-toggle"
                            />
                        </button>
                        {!collapsed && (
                            <ul className="chat-prompt-list">
                                {category.items.map((item) => (
                                    <li key={item.id}>
                                        <button
                                            type="button"
                                            className="chat-prompt-item"
                                            onClick={() => onPick(item.prompt)}
                                        >
                                            <span className="chat-prompt-item-label">{item.label}</span>
                                            <span className="chat-prompt-item-desc">{item.prompt}</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                );
            })}
        </div>
    );
}
