import Icon from "./Icon";
import { toggleTheme, useTheme } from "../../utils/theme";

interface Props {
    /** Host decides the shape — the settings header uses .btn, chat uses the round icon button. */
    className?: string;
    iconClassName?: string;
}

/** Light/dark switch. The icon shows the mode the click switches TO. */
export default function ThemeToggle({ className = "", iconClassName = "icon-sm" }: Props) {
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
            <Icon name={toLight ? "light_mode" : "dark_mode"} className={iconClassName} />
        </button>
    );
}
