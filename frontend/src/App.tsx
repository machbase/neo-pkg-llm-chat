import { useCallback, useEffect, useState } from "react";
import { useApp } from "./context/AppContext";
import { getConfigList, getConfig, createConfig, updateConfig, checkToken } from "./services/settingsApi";
import type { TokenCheck } from "./services/settingsApi";
import { defaultConfig } from "./types/settings";
import { getCurrentUser, getApiToken, setApiToken, clearApiToken } from "./utils/auth";
import { MachbaseSection, tokenCheckMessage } from "./sections/MachbaseSection";
import { ApiKeysSection } from "./sections/ApiKeysSection";
import { ModelsSection } from "./sections/ModelsSection";
import { Chat } from "./components/chat/Chat";
import Icon from "./components/common/Icon";
import ThemeToggle from "./components/common/ThemeToggle";
import Toast from "./components/common/Toast";
import type { AppConfig, ModelProvider } from "./types/settings";

type AppTab = "settings" | "chat" | null;

// 사용 가능 = API 키와 이름 있는 모델을 함께 가진 프로바이더가 하나 이상
// · Ollama 는 base_url 비어도 됨(서버가 `${machbase.host}:11434` 로 폴백) — 모델 이름만 필요
// · 갓 시드된 sys.json 은 모델이 비어 있어 첫 실행 시 설정 화면으로 이동
function isConfigUsable(c: AppConfig): boolean {
    if (c.claude.api_key.trim() && c.claude.models.some((m) => m.name.trim())) return true;
    if (c.chatgpt.api_key.trim() && c.chatgpt.models.some((m) => m.name.trim())) return true;
    if (c.gemini.api_key.trim() && c.gemini.models.some((m) => m.name.trim())) return true;
    if (c.ollama.models.some((m) => m.name.trim())) return true;
    return false;
}

export default function App() {
    const { selectedConfig, setSelectedConfig, notify } = useApp();
    const [activeTab, setActiveTab] = useState<AppTab | null>(null);
    const [config, setConfig] = useState<AppConfig>(defaultConfig());
    const [saving, setSaving] = useState(false);
    const [validationErrors, setValidationErrors] = useState<string[]>([]);
    const [chatResetKey, setChatResetKey] = useState(0);
    const [tokenInput, setTokenInput] = useState<string>(() => getApiToken());
    const [tokenCheck, setTokenCheck] = useState<TokenCheck | null>(null);
    const [checking, setChecking] = useState(false);
    // 저장된(검증·계정 일치 확인된) 토큰의 계정 — 없으면 채팅 불가
    const [savedUser, setSavedUser] = useState<string | null>(null);

    const loadConfigList = useCallback(async () => {
        try {
            const all = await getConfigList();
            const user = getCurrentUser();
            return !user ? all : all.filter((name) => name === user);
        } catch {
            notify("Failed to load config list.", "error");
            return [];
        }
    }, [notify]);

    const loadConfig = useCallback(
        async (name: string) => {
            try {
                const data = await getConfig(name);
                setConfig(data);
                setSelectedConfig(name);
            } catch {
                notify(`Failed to load config "${name}".`, "error");
            }
        },
        [notify, setSelectedConfig]
    );

    const blankConfig = useCallback((): AppConfig => {
        const d = defaultConfig();
        return { ...d, machbase: { host: "127.0.0.1", port: "5654" } };
    }, []);

    // 검증된 토큰 저장 + (불러온 설정이 없을 때만) 그 계정의 기존 설정을 불러옴 — 불러왔으면 true
    // · 새 브라우저에서 토큰만 넣고 저장할 때 서버의 기존 설정(LLM 키)을 빈 값으로 덮어쓰는 것 방지
    // · 이미 불러온 설정은 편집 중일 수 있어 다시 불러오지 않음
    const adoptToken = useCallback(
        async (token: string, user: string): Promise<boolean> => {
            setApiToken(token);
            setSavedUser(user);
            if (selectedConfig !== null) return false;
            const list = await loadConfigList();
            if (!list.includes(user)) return false;
            const data = await getConfig(user);
            setConfig(data);
            setSelectedConfig(user);
            return true;
        },
        [loadConfigList, setSelectedConfig, selectedConfig]
    );

    useEffect(() => {
        (async () => {
            const stored = getApiToken();
            if (stored) {
                const check = await checkToken(stored);
                setTokenCheck(check);
                if (check.status === "ok") {
                    // loadConfig 대신 직접 조회 — setConfig 는 비동기라 바로 아래 라우팅 판단에 못 씀
                    setSavedUser(check.user);
                    const list = await loadConfigList();
                    if (list.includes(check.user)) {
                        const data = await getConfig(check.user);
                        setConfig(data);
                        setSelectedConfig(check.user);
                        setActiveTab(isConfigUsable(data) ? "chat" : "settings");
                        return;
                    }
                } else {
                    notify(`저장된 API 토큰을 사용할 수 없습니다. ${tokenCheckMessage(check).text}`, "error");
                }
            }
            setConfig(blankConfig());
            setActiveTab("settings");
        })();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const handleTokenChange = useCallback((value: string) => {
        setTokenInput(value);
        setTokenCheck(null);
        setValidationErrors((prev) => prev.filter((e) => e !== "machbase.token"));
    }, []);

    const handleVerifyToken = useCallback(async () => {
        const token = tokenInput.trim();
        if (!token) return;
        setChecking(true);
        const check = await checkToken(token);
        setTokenCheck(check);
        if (check.status === "ok") {
            const loaded = await adoptToken(token, check.user);
            if (loaded) notify(`${check.user.toUpperCase()} 계정의 기존 설정을 불러왔습니다.`, "success");
        }
        setChecking(false);
    }, [tokenInput, adoptToken, notify]);

    const handleClearToken = useCallback(() => {
        clearApiToken();
        setSavedUser(null);
        setTokenInput("");
        setTokenCheck(null);
        setSelectedConfig(null);
        setConfig(blankConfig());
        setChatResetKey((k) => k + 1);
        setActiveTab("settings");
        notify("API 토큰을 지웠습니다.", "success");
    }, [blankConfig, notify, setSelectedConfig]);

    const handleSave = useCallback(async () => {
        const errors: string[] = [];
        if (!config.machbase.host.trim()) errors.push("machbase.host");
        if (!config.machbase.port.trim()) errors.push("machbase.port");
        if (!tokenInput.trim()) errors.push("machbase.token");
        // 추가된 모델 항목은 이름·model_id 필수
        const providers: Array<{ key: string; models: { name: string; model_id: string }[] }> = [
            { key: "claude", models: config.claude.models },
            { key: "chatgpt", models: config.chatgpt.models },
            { key: "gemini", models: config.gemini.models },
            { key: "ollama", models: config.ollama.models },
        ];
        for (const p of providers) {
            p.models.forEach((m, i) => {
                if (!m.name.trim()) errors.push(`model.${p.key}.${i}.name`);
                if (!m.model_id.trim()) errors.push(`model.${p.key}.${i}.model_id`);
            });
        }
        // API 키+모델 갖춘 제공자 하나 이상 필수(Ollama는 모델만)
        if (!isConfigUsable(config)) errors.push("no_provider");

        if (errors.length > 0) {
            setValidationErrors(errors);
            const hasConnection = errors.some((e) => e.startsWith("machbase."));
            const hasModel = errors.some((e) => e.startsWith("model."));
            const hasNoProvider = errors.includes("no_provider");
            const msgs: string[] = [];
            if (hasConnection) msgs.push("Machbase connection fields");
            if (hasModel) msgs.push("model display names");
            if (hasNoProvider) msgs.push("at least one provider with API key and model");
            notify(`Please fill in: ${msgs.join(", ")}.`, "error");
            return;
        }
        setValidationErrors([]);
        setSaving(true);
        try {
            // 저장 직전 토큰 재검증 — 무효·콘솔 계정 불일치면 차단
            const token = tokenInput.trim();
            const check = await checkToken(token);
            setTokenCheck(check);
            if (check.status !== "ok") {
                setValidationErrors(["machbase.token"]);
                notify(tokenCheckMessage(check).text, "error");
                setSaving(false);
                return;
            }
            // 파일명 = 토큰 계정(서버도 같은 이름만 허용)
            const owner = check.user;
            const loaded = await adoptToken(token, owner);
            if (loaded) {
                notify(`${owner.toUpperCase()} 계정의 기존 설정을 불러왔습니다. 확인 후 다시 저장하세요.`, "info");
                setSaving(false);
                return;
            }
            const payload: AppConfig = { ...config, machbase: { host: config.machbase.host, port: config.machbase.port } };
            const isNew = selectedConfig === null;
            let savedName: string;
            if (isNew) {
                savedName = await createConfig(owner, payload);
                notify(`Config "${savedName}" created.`, "success");
            } else {
                savedName = await updateConfig(owner, payload);
                notify(`Config "${savedName}" saved.`, "success");
            }
            await loadConfigList();
            setSelectedConfig(savedName);
            setChatResetKey((k) => k + 1);
            setActiveTab("chat");
        } catch (e) {
            notify(`Save failed: ${e instanceof Error ? e.message : "unknown error"}`, "error");
        }
        setSaving(false);
    }, [config, selectedConfig, notify, loadConfigList, setSelectedConfig, tokenInput, adoptToken]);

    const handleOpenSettings = useCallback(async () => {
        if (savedUser) {
            const list = await loadConfigList();
            if (list.includes(savedUser)) await loadConfig(savedUser);
        }
        setActiveTab("settings");
    }, [loadConfigList, loadConfig, savedUser]);

    const handleMachbaseChange = useCallback((machbase: AppConfig["machbase"]) => {
        setConfig((prev) => ({ ...prev, machbase }));
        setValidationErrors([]);
    }, []);

    const handleApiKeyChange = useCallback((provider: "claude" | "chatgpt" | "gemini", key: string) => {
        setConfig((prev) => ({
            ...prev,
            [provider]: { ...prev[provider], api_key: key },
        }));
    }, []);

    const handleOllamaUrlChange = useCallback((url: string) => {
        setConfig((prev) => ({ ...prev, ollama: { ...prev.ollama, base_url: url } }));
    }, []);

    const handleModelsChange = useCallback((provider: ModelProvider, models: AppConfig["claude"]["models"]) => {
        setConfig((prev) => ({
            ...prev,
            [provider]: { ...prev[provider], models },
        }));
        setValidationErrors([]);
    }, []);

    const chatBlocked = savedUser === null || selectedConfig === null || !isConfigUsable(config);

    return (
        <>
            <div className="page bg-surface" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                {/* 문구 필수: Neo는 로드 후 1.2초간 글자·이미지 없는 화면을 "빈 앱"으로 판정해 오류 화면으로 덮음 */}
                {activeTab === null && (
                    <div className="flex-1 flex items-center justify-center" style={{ gap: "var(--spacing-8)", color: "var(--color-on-surface-muted)", fontSize: "var(--font-size-sm)" }}>
                        <span className="spinner" />
                        <span>Loading...</span>
                    </div>
                )}
                {activeTab !== null && (
                    <>
                        <div className="flex-1 flex flex-col overflow-hidden" style={{ display: activeTab === "settings" ? undefined : "none" }}>
                            <div className="page-header">
                                <div className="page-header-inner">
                                    <div className="page-header-lead">
                                        {/* 채팅으로 돌아가기 — 제목 왼쪽 아이콘 버튼
                                            · 활성 조건: 저장된 토큰 + 저장된 사용 가능 설정(폼 입력만은 제외, 백엔드의 설정 파일 검사와 일치) */}
                                        <button
                                            className="btn btn-icon btn-ghost page-header-back"
                                            onClick={() => setActiveTab("chat")}
                                            disabled={chatBlocked}
                                            aria-label="채팅으로 돌아가기"
                                            title={chatBlocked ? "API 토큰과 사용 가능한 설정(제공자·API 키·모델)을 저장한 뒤 채팅할 수 있습니다." : "채팅으로 돌아가기"}
                                        >
                                            <Icon name="arrow_back" className="icon-sm" />
                                        </button>
                                    <div>
                                        {/* 제목에 계정 이름 미표시 — 관리자 id 화면 노출 방지 */}
                                        <h1 className="page-title">{selectedConfig === null ? "New Configuration" : "Configuration"}</h1>
                                        <p className="page-desc">Manage LLM providers, API keys, models, and connection settings.</p>
                                    </div>
                                    </div>
                                    <div className="flex items-center gap-8">
                                        <ThemeToggle className="btn btn-icon btn-ghost" />
                                        <button className="btn btn-content btn-primary" onClick={handleSave} disabled={saving}>
                                            {saving ? <span className="spinner" /> : <Icon name="save" className="icon-sm" />}
                                            Save
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div className="page-body">
                                <div className="page-body-inner">
                                    <div className="flex flex-col gap-32">
                                        <MachbaseSection
                                            config={config.machbase}
                                            onChange={handleMachbaseChange}
                                            errors={validationErrors}
                                            token={tokenInput}
                                            onTokenChange={handleTokenChange}
                                            tokenCheck={tokenCheck}
                                            checking={checking}
                                            onVerify={handleVerifyToken}
                                            savedUser={savedUser}
                                            onClearToken={handleClearToken}
                                        />
                                        <ApiKeysSection
                                            claude={config.claude}
                                            chatgpt={config.chatgpt}
                                            gemini={config.gemini}
                                            ollama={config.ollama}
                                            onKeyChange={handleApiKeyChange}
                                            onOllamaUrlChange={handleOllamaUrlChange}
                                        />
                                        <ModelsSection
                                            claude={config.claude}
                                            chatgpt={config.chatgpt}
                                            gemini={config.gemini}
                                            ollama={config.ollama}
                                            onChange={handleModelsChange}
                                            errors={validationErrors}
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div className="flex-1 overflow-hidden" style={{ display: activeTab === "chat" ? undefined : "none" }}>
                            <Chat key={chatResetKey} onOpenSettings={handleOpenSettings} accountName={savedUser} />
                        </div>
                    </>
                )}
            </div>

            <Toast />
        </>
    );
}
