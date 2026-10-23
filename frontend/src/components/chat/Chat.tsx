import { usePkgChat } from '../../hooks/usePkgChat';
import { ChatView } from './ChatView';

interface ChatProps {
    onOpenSettings?: () => void;
    accountName?: string | null;
}

export const Chat = ({ onOpenSettings, accountName }: ChatProps) => {
    const chatLogic = usePkgChat();
    return <ChatView {...chatLogic} onOpenSettings={onOpenSettings} accountName={accountName} />;
};
