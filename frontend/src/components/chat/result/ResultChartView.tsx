import { useMemo } from "react";
import { getChartAssetBase } from "../../../services/baseUrl";
import { buildChartIframeHtml } from "../../../utils/buildChartIframeHtml";
import { useTheme } from "../../../utils/theme";
import type { TqlChartPayload } from "../../../types/exec";

/**
 * TQL 차트 응답 → iframe srcdoc 격리 렌더
 * 에셋은 Neo의 /web/... 상대 주소 — base href(현재 페이지 origin)로 접속 주소에서 로드
 */
export const ResultChartView = ({ data }: { data: TqlChartPayload }) => {
    // 테마 변경 시 srcdoc 재생성 → iframe 새 테마로 재마운트
    const theme = useTheme();
    const html = useMemo(
        () => buildChartIframeHtml(data, getChartAssetBase(), theme),
        [data, theme],
    );

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
