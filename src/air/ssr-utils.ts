// Shared SSR/HTML utilities — used by vdom.ts (renderToString) and ssr-stream.ts (renderToStream).

export const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;").replace(/`/g, "&#96;")
    .replace(/\n/g, "&#xa;").replace(/\r/g, "&#xd;"); // AIO-277: escape newlines
}

export function resolveClassName(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter(Boolean).join(" ");
  if (typeof v === "object" && v !== null) {
    return Object.entries(v as Record<string, unknown>)
      .filter(([_, val]) => val)
      .map(([key]) => key)
      .join(" ");
  }
  return "";
}

export function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

// CSS properties that accept unitless numeric values — all others get "px" auto-appended
const UNITLESS_CSS = new Set([
  "animationIterationCount",
  "borderImageOutset",
  "borderImageSlice",
  "borderImageWidth",
  "boxFlex",
  "boxFlexGroup",
  "boxOrdinalGroup",
  "columnCount",
  "columns",
  "flex",
  "flexGrow",
  "flexPositive",
  "flexShrink",
  "flexNegative",
  "flexOrder",
  "gridArea",
  "gridRow",
  "gridRowEnd",
  "gridRowSpan",
  "gridRowStart",
  "gridColumn",
  "gridColumnEnd",
  "gridColumnSpan",
  "gridColumnStart",
  "fontWeight",
  "lineClamp",
  "lineHeight",
  "opacity",
  "order",
  "orphans",
  "tabSize",
  "widows",
  "zIndex",
  "zoom",
  "fillOpacity",
  "floodOpacity",
  "stopOpacity",
  "strokeDasharray",
  "strokeDashoffset",
  "strokeMiterlimit",
  "strokeOpacity",
  "strokeWidth",
  "scale",
]);

/** Resolve a numeric CSS value — auto-append "px" for properties that need units */
export function styleValue(prop: string, value: unknown): string {
  if (typeof value === "number" && value !== 0 && !UNITLESS_CSS.has(prop)) {
    return value + "px";
  }
  return String(value ?? "");
}
