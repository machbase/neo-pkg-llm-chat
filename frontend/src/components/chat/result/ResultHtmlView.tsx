import type { HtmlPayload } from "../../../types/exec";

/**
 * application/xhtml+xml 또는 text/html 응답 → iframe srcdoc 격리 렌더.
 * 응답 본문이 그 자체로 완전한 HTML 문서라고 가정하고 그대로 srcDoc에 주입.
 */
export const ResultHtmlView = ({ data }: { data: HtmlPayload }) => {
    return (
        <div className="chat-html-wrapper">
            <iframe
                className="chat-html-iframe"
                srcDoc={data.html}
                sandbox="allow-scripts"
                title="TQL HTML output"
            />
        </div>
    );
};
