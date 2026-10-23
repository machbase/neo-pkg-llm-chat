import Icon from "./Icon";
import { toggleTheme, useTheme } from "../../utils/theme";

interface Props {
    /** 버튼 모양 클래스 — 호출부 지정 */
    className?: string;
}

/** 라이트·다크 전환 버튼 — 아이콘은 클릭 시 바뀔 모드 표시 */
export default function ThemeToggle({ className = "" }: Props) {
    const theme = useTheme();
    const toLight = theme === "dark";
    return (
        <button
            type="button"
            className={className}
            onClick={toggleTheme}
            title={toLight ? "Light mode" : "Dark mode"}
            aria-label={toLight ? "Switch to light mode" : "Switch to dark mode"}
        >
            <Icon name={toLight ? "light_mode" : "dark_mode"} className="icon-sm" />
        </button>
    );
}
