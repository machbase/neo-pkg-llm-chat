import type { TqlChartPayload } from "../types/exec";
import type { Theme } from "./theme";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const escapeUrl = (s: string): string => encodeURI(s);

const THEME_ASSET_RE = /\/themes\/[^/]+\.js(\?.*)?$/;
const ECHARTS_MAIN_RE = /\/echarts(\.min)?\.js(\?.*)?$/;

/**
 * jsAssets에 echarts "dark" 테마 파일 로드 보정
 * · 테마 파일(/themes/<name>.js) 있으면 dark.js로 치환
 * · 없으면 echarts 메인 asset 경로에서 /themes/dark.js 유도해 추가
 * · 둘 다 실패 시 원본 그대로(라이트로 fallback 가능)
 */
function ensureDarkThemeAsset(assets: string[]): string[] {
  let replaced = false;
  const next = assets.map((src) => {
    if (THEME_ASSET_RE.test(src)) {
      replaced = true;
      return src.replace(/\/themes\/[^/]+\.js/, "/themes/dark.js");
    }
    return src;
  });
  if (replaced) return next;
  const main = assets.find((src) => ECHARTS_MAIN_RE.test(src));
  if (main) {
    next.push(main.replace(/\/echarts(\.min)?\.js.*$/, "/themes/dark.js"));
  }
  return next;
}

/**
 * TQL 차트 응답 → iframe srcdoc용 HTML 문자열 조립
 * · apiBase: <base href>에 넣을 접속 주소(getChartAssetBase)
 * · jsAssets/jsCodeAssets/cssAssets는 Neo의 /web/... 상대 주소 그대로 — <base href>로 접속 주소에서 로드
 * · theme: 앱 테마 — 차트 명암을 채팅 배경에 맞춤
 */
export function buildChartIframeHtml(payload: TqlChartPayload, apiBase: string, theme: Theme = "dark"): string {
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
  // echarts 차트 테마를 앱 테마에 맞춤(geomap(leaflet)은 echarts 미사용 → 제외)
  // · 테마는 jsAssets 테마 파일이 registerTheme로 등록, jsCodeAssets가 echarts.init(dom, "<name>")로 사용
  // · dark: dark 테마 파일 로드 + init 인자 "dark" 치환 — 미등록 테마 참조로 라이트 fallback 방지
  // · light: 기본 테마가 라이트 → init 인자 null로 서버 지정 테마 무시
  const isLight = theme === "light";
  const jsAssets = isGeomap || isLight ? payload.jsAssets : ensureDarkThemeAsset(payload.jsAssets);
  const jsAssetTags = jsAssets
    .map((src) => `<script src="${escapeUrl(src)}"></script>`)
    .join("\n  ");
  // echarts.init 패치
  // · 테마를 앱 테마로 강제
  // · setOption의 backgroundColor를 transparent로 덮어써 앱(iframe) 배경 노출
  const themeArg = isLight ? "null" : '"dark"';
  const themePatchTag = isGeomap
    ? ""
    : `<script>(function(){if(window.echarts&&typeof echarts.init==="function"){var _init=echarts.init;echarts.init=function(dom,_theme,opts){var c=_init.call(echarts,dom,${themeArg},opts);var _set=c.setOption;c.setOption=function(o){if(o&&typeof o==="object"){o.backgroundColor="transparent";}return _set.apply(this,arguments);};return c;};}})();</script>`;
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
<style>.chart_container{display:flex;justify-content:center;align-items:center;height:100%}.chart_item{margin:auto}html,body{margin:0;background:transparent}</style>
${geomapExtraStyle}
</head>
<body style="width:100vw;height:100vh;margin:0">
${mountDiv}
${themePatchTag}
${jsCodeTags}
</body>
</html>`;
}
