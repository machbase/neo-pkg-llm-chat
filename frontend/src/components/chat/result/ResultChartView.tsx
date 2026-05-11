import { useEffect, useMemo, useState } from "react";
import { getApiBaseOrigin } from "../../../services/baseUrl";
import { buildChartIframeHtml } from "../../../utils/buildChartIframeHtml";
import type { TqlChartPayload } from "../../../types/exec";

/**
 * TQL 차트 응답 → iframe srcdoc 격리 렌더.
 * apiBase는 async getApiBaseOrigin()으로 부트스트랩 (sync 호출 X — undefined race 회피).
 */
export const ResultChartView = ({ data }: { data: TqlChartPayload }) => {
    const [apiBase, setApiBase] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        getApiBaseOrigin().then((base) => {
            if (!cancelled) setApiBase(base);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const html = useMemo(() => {
        if (!apiBase) return null;
        return buildChartIframeHtml(data, apiBase);
    }, [data, apiBase]);

    if (!html) {
        return <div className="chat-chart-loading">차트 로딩 중…</div>;
    }

    const width = data.style?.width ?? "600px";
    const height = data.style?.height ?? "360px";

    return (
        <div className="chat-chart-wrapper">
            <iframe
                className="chat-chart-iframe"
                srcDoc={html}
                sandbox="allow-scripts"
                style={{ width, height, border: "none" }}
                title="TQL chart"
            />
        </div>
    );
};
