import { useMemo } from "react";
import { getChartAssetBase } from "../../../services/baseUrl";
import { buildChartIframeHtml } from "../../../utils/buildChartIframeHtml";
import type { TqlChartPayload } from "../../../types/exec";

/**
 * TQL 차트 응답 → iframe srcdoc 격리 렌더.
 * 에셋은 서비스 프록시 경로로 재작성되므로 base href 는 현재 페이지 origin 만 있으면 된다.
 */
export const ResultChartView = ({ data }: { data: TqlChartPayload }) => {
    const html = useMemo(
        () => buildChartIframeHtml(data, getChartAssetBase()),
        [data],
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
