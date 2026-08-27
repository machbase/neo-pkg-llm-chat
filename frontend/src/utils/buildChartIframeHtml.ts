import type { TqlChartPayload } from "../types/exec";
import { CHART_ASSET_PREFIX } from "../services/baseUrl";
import type { Theme } from "./theme";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const escapeUrl = (s: string): string => encodeURI(s);

// 루트 절대경로(/web/...) 에셋을 서비스 프록시 경로로 재작성한다. base href 만으로는
// 절대경로에 prefix 를 못 붙이므로 URL 자체를 /web/services/<svc>/web/... 로 바꾼다.
// http(s):// 절대 URL 이나 이미 prefix 가 붙은 경로는 그대로 둔다.
const toProxyAsset = (url: string): string =>
  url.startsWith("/") && !url.startsWith(`${CHART_ASSET_PREFIX}/`)
    ? `${CHART_ASSET_PREFIX}${url}`
    : url;

const THEME_ASSET_RE = /\/themes\/[^/]+\.js(\?.*)?$/;
const ECHARTS_MAIN_RE = /\/echarts(\.min)?\.js(\?.*)?$/;

/**
 * jsAssets에 echarts "dark" 테마 파일이 반드시 로드되도록 보정.
 * - 기존 테마 파일(/themes/<name>.js)이 있으면 dark.js로 치환
 * - 없으면 echarts 메인 asset 경로에서 /themes/dark.js를 유도해 추가
 * 둘 다 실패하면 원본을 그대로 반환(테마 패치만으로는 라이트 fallback될 수 있음).
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
 * TQL 차트 응답 + apiBase로 iframe srcdoc용 HTML 문자열 조립.
 * apiBase는 호출자가 미리 await getApiBaseOrigin()으로 받아서 전달 (sync function).
 * jsAssets/jsCodeAssets URL은 응답값 그대로 사용 — backend가 root-level forward 처리.
 * theme은 앱 테마 — 차트가 채팅 배경과 같은 명암을 갖도록 맞춘다.
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
    .map((href) => `<link rel="stylesheet" href="${escapeUrl(toProxyAsset(href))}">`)
    .join("\n  ");
  // echarts 차트 테마를 앱 테마에 맞춘다. geomap(leaflet)은 echarts를 쓰지 않으므로 제외.
  // 테마는 (a) jsAssets의 테마 파일이 echarts.registerTheme로 등록하고
  //         (b) jsCodeAssets가 echarts.init(dom, "<name>")로 사용한다.
  // dark: asset URL만 바꾸면 init이 미등록 테마를 참조해 라이트로 떨어지므로,
  //       dark 테마 파일을 로드(a)하고 init 인자를 "dark"로 치환(b)한다.
  // light: echarts 기본 테마가 곧 라이트라 등록할 파일이 없다 — init 인자를 null로
  //        떨궈 서버가 지정한 테마(다크일 수 있음)를 무시한다.
  const isLight = theme === "light";
  const jsAssets = isGeomap || isLight ? payload.jsAssets : ensureDarkThemeAsset(payload.jsAssets);
  const jsAssetTags = jsAssets
    .map((src) => `<script src="${escapeUrl(toProxyAsset(src))}"></script>`)
    .join("\n  ");
  // echarts.init을 패치해 (1) 테마를 앱 테마로 강제하고
  // (2) 인스턴스 setOption에서 backgroundColor를 transparent로 덮어써
  //     테마 자체 배경(dark의 #100c2a, light의 흰색) 대신 앱(iframe) 배경이 비치게 한다.
  const themeArg = isLight ? "null" : '"dark"';
  const themePatchTag = isGeomap
    ? ""
    : `<script>(function(){if(window.echarts&&typeof echarts.init==="function"){var _init=echarts.init;echarts.init=function(dom,_theme,opts){var c=_init.call(echarts,dom,${themeArg},opts);var _set=c.setOption;c.setOption=function(o){if(o&&typeof o==="object"){o.backgroundColor="transparent";}return _set.apply(this,arguments);};return c;};}})();</script>`;
  const jsCodeTags = payload.jsCodeAssets
    .map((src) => `<script src="${escapeUrl(toProxyAsset(src))}"></script>`)
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
