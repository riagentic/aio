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

// JSX prop names whose DOM ATTRIBUTE name is spelled differently.
//
// Mostly SVG: it is mixed-case, so presentation/text attrs are kebab-case
// (`stop-color`) while structural attrs like `viewBox`/`preserveAspectRatio`
// stay camelCase — a blanket camel→kebab is WRONG. This curated map converts
// only the ones that need it; anything else passes through verbatim.
//
// `htmlFor` is here for the same reason and was the HTML half nobody had
// filled in: it is not a `_DOM_PROPS` entry, so it fell through to
// `setAttribute("htmlFor")` on the client and was emitted verbatim by SSR —
// `htmlfor=` and `htmlFor=`, two spellings of an attribute NO browser reads,
// so every `<label htmlFor>`/control association was silently dead. aio's own
// a11y warning recommends the shape, and `docs/ui/air-lifecycle.md` ships it.
const _ATTR_NAME: Readonly<Record<string, string>> = {
  htmlFor: "for",
  // `<form nativeSubmit>` opts out of the SPA submit interception
  // (vdom-events.ts reads `data-native-submit` off the element). The prop was
  // promised in that comment and never mapped, so it landed as a
  // `nativesubmit` attribute nothing reads — the form was still intercepted,
  // silently. The `data-native-submit` spelling keeps working unchanged.
  nativeSubmit: "data-native-submit",
  stopColor: "stop-color",
  stopOpacity: "stop-opacity",
  strokeWidth: "stroke-width",
  strokeLinecap: "stroke-linecap",
  strokeLinejoin: "stroke-linejoin",
  strokeDasharray: "stroke-dasharray",
  strokeDashoffset: "stroke-dashoffset",
  strokeOpacity: "stroke-opacity",
  strokeMiterlimit: "stroke-miterlimit",
  fillOpacity: "fill-opacity",
  fillRule: "fill-rule",
  clipRule: "clip-rule",
  clipPath: "clip-path",
  floodColor: "flood-color",
  floodOpacity: "flood-opacity",
  fontFamily: "font-family",
  fontSize: "font-size",
  fontWeight: "font-weight",
  fontStyle: "font-style",
  textAnchor: "text-anchor",
  textDecoration: "text-decoration",
  dominantBaseline: "dominant-baseline",
  alignmentBaseline: "alignment-baseline",
  baselineShift: "baseline-shift",
  letterSpacing: "letter-spacing",
  wordSpacing: "word-spacing",
  markerStart: "marker-start",
  markerMid: "marker-mid",
  markerEnd: "marker-end",
  pointerEvents: "pointer-events",
  shapeRendering: "shape-rendering",
  colorInterpolation: "color-interpolation",
  colorInterpolationFilters: "color-interpolation-filters",
  vectorEffect: "vector-effect",
  writingMode: "writing-mode",
  paintOrder: "paint-order",
};

/** Map a JSX prop name to its DOM attribute name — converts the known
 *  camelCase SVG attrs (stopColor → stop-color) so gradients/strokes render
 *  and `htmlFor` → `for`, and leaves everything else (viewBox, data-*, aria-*)
 *  untouched. Shared by the client patcher and both SSR emitters so all render
 *  paths agree: ONE table, no per-path variant. */
export function attrNameOf(k: string): string {
  return _ATTR_NAME[k] ?? k;
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
