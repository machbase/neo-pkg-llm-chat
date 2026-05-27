import type { TqlChartPayload } from "../types/exec";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const escapeUrl = (s: string): string => encodeURI(s);

/**
 * TQL 차트 응답 + apiBase로 iframe srcdoc용 HTML 문자열 조립.
 * apiBase는 호출자가 미리 await getApiBaseOrigin()으로 받아서 전달 (sync function).
 * jsAssets/jsCodeAssets URL은 응답값 그대로 사용 — backend가 root-level forward 처리.
 */
export function buildChartIframeHtml(payload: TqlChartPayload, apiBase: string): string {
  const isGeomap = typeof payload.geomapID === "string";
  // chartID(echarts) 또는 geomapID(geomap) — 둘 중 응답에 들어온 것을 마운트 div id로 사용
  const mountID = payload.chartID ?? payload.geomapID ?? "";
  const safeChartID = escapeHtml(mountID);
  const width = escapeHtml(payload.style?.width ?? "600px");
  const height = escapeHtml(payload.style?.height ?? "360px");
  const safeApiBase = escapeHtml(apiBase);
  const cssAssetTags = (payload.cssAssets ?? [])
    .map((href) => `<link rel="stylesheet" href="${escapeUrl(href)}">`)
    .join("\n  ");
  const jsAssetTags = payload.jsAssets
    .map((src) => `<script src="${escapeUrl(src)}"></script>`)
    .join("\n  ");
  const jsCodeTags = payload.jsCodeAssets
    .map((src) => `<script src="${escapeUrl(src)}"></script>`)
    .join("\n  ");
  // geomap은 leaflet 컨테이너 — 정사각 box 채우는 width/height + grayscale 옵션
  const grayscale = typeof payload.style?.grayscale === "number" ? payload.style.grayscale : 0;
  const geomapExtraStyle = isGeomap
    ? `<style>.map_container{width:${width};height:${height};}.leaflet-tile-pane{-webkit-filter:grayscale(${grayscale}%);filter:grayscale(${grayscale}%);}</style>`
    : "";
  const mountDiv = isGeomap
    ? `<div class="map_container" id="${safeChartID}"></div>`
    : `<div class="chart_container"><div class="chart_item" id="${safeChartID}" style="width:${width};height:${height};"></div></div>`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<base href="${safeApiBase}/">
${cssAssetTags}
${jsAssetTags}
<style>.chart_container{display:flex;justify-content:center;align-items:center;height:100%}.chart_item{margin:auto}body{margin:0}</style>
${geomapExtraStyle}
</head>
<body style="width:100vw;height:100vh;margin:0">
${mountDiv}
${jsCodeTags}
</body>
</html>`;
}
