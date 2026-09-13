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

/** The two elements whose text content is RAW: the parser reads to the
 *  closing tag and decodes no entities at all. */
export const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

/** The text to emit inside a raw-text element.
 *
 *  SSR escaped it like any other child, so a server-rendered
 *  `<style>{".a > .b { color: red }"}</style>` shipped `.a &gt; .b` — a
 *  selector that matches nothing — and a `<script>` comparing `a < b` shipped
 *  `a &lt; b`, which does not parse. The client's `createDom` writes these as
 *  text and gets them right, so the same app behaved one way in the browser
 *  and another on the server: a dev/prod divergence in the direction the
 *  project forbids.
 *
 *  The one thing raw text cannot contain is its own closing tag, because
 *  nothing can escape it — `</style` inside a `<style>` ENDS the element and
 *  the rest of the stylesheet becomes page content. That is a real defect in
 *  the caller's data, so dev THROWS and names it; production falls back to
 *  escaping, which produces the wrong text but a page that still parses,
 *  rather than markup that breaks out of the element. */
export function rawTextContent(
  tag: string,
  text: string,
  dev: boolean,
): string {
  if (new RegExp(`</\s*${tag}`, "i").test(text)) {
    const msg = `[aio] <${tag}> content contains a literal "</${tag}", which ` +
      `ends the element — raw text has no escape for it. Split the string ` +
      `(e.g. "<\/${tag}") or move it out of the ${tag} tag.`;
    if (dev) throw new Error(msg);
    console.error(msg + " Falling back to escaping it.");
    return escapeHtml(text);
  }
  return text;
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;").replace(/`/g, "&#96;")
    .replace(/\n/g, "&#xa;").replace(/\r/g, "&#xd;"); // AIO-277: escape newlines
}

// ── <select value> ────────────────────────────────────────────────────────
//
// `<select>` has NO `value` content attribute — which side of the DOM chose
// the option is expressed by `selected` on the option — so `_propAttr`
// correctly emits nothing for it. Nothing then put `selected` anywhere, and
// the server always shipped the FIRST option: a server-rendered language,
// currency or status picker showed the wrong choice until hydration, and a
// form submitted before hydration (or with JS off) posted it. The
// `<textarea value>` case one line above it in `_NO_ATTR_ON` had already been
// solved; this is the other half of the same idea.
//
// A stack, because SSR is a synchronous depth-first walk and `<optgroup>`
// nests: the innermost open `<select>` is the one an `<option>` belongs to.
const _selectValues: unknown[] = [];

/** Open a `<select>` scope if this element is one. Returns whether it did,
 *  which the caller passes back to {@linkcode ssrCloseSelect}. */
export function ssrOpenSelect(tag: string, value: unknown): boolean {
  if (tag !== "select") return false;
  _selectValues.push(value);
  return true;
}

/** Close the scope {@linkcode ssrOpenSelect} opened. */
export function ssrCloseSelect(opened: boolean): void {
  if (opened) _selectValues.pop();
}

/** @internal Test seam — a render that threw could otherwise leave a scope
 *  open and mark options in the NEXT render. */
export function _resetSsrSelect(): void {
  _selectValues.length = 0;
}

/** The props to render this element with: an `<option>` inside a `<select>`
 *  whose value it matches gains `selected`.
 *
 *  An explicit `selected` prop always wins — the author said so — and an
 *  option with no `value` of its own is identified by its text, exactly as
 *  the DOM does it. `own` is the option's own value with any SIGNAL already
 *  resolved: this module cannot import the resolver (`signal-binding` imports
 *  this one), and `String(aSignal)` would stringify the function and match
 *  nothing. */
export function ssrOptionProps(
  tag: string,
  props: Record<string, unknown>,
  children: readonly unknown[],
  own: unknown,
): Record<string, unknown> {
  if (tag !== "option" || _selectValues.length === 0) return props;
  if (props.selected !== undefined) return props;
  const want = _selectValues[_selectValues.length - 1];
  if (want === undefined || want === null) return props;
  const text = own !== undefined ? String(own) : children
    .filter((c) => typeof c === "string" || typeof c === "number")
    .map(String)
    .join("");
  const hit = Array.isArray(want)
    ? want.some((w) => String(w) === text)
    : String(want) === text;
  return hit ? { ...props, selected: true } : props;
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

/** A style object KEY → the CSS property name `setProperty` and SSR write.
 *
 *  Two spellings were mangled by the blanket camel→kebab:
 *
 *  - A custom property (`--rowGap`) is CASE-SENSITIVE and is not camelCase
 *    for anything — it is the name. Kebabing it to `--row-gap` declared a
 *    different variable, so `var(--rowGap)` in the stylesheet read nothing.
 *  - `ms` is the one vendor prefix written lower-case in JS (`msTransform`,
 *    as the CSSOM spells it), so it gained no leading dash and shipped
 *    `ms-transform`, a property no browser has. `WebkitX`/`MozX` already came
 *    out right because their capital produces the dash. */
export function camelToKebab(s: string): string {
  if (s.startsWith("--")) return s;
  const k = s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  return k.startsWith("ms-") ? "-" + k : k;
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
  "aspectRatio",
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

/** The unprefixed name a vendor-prefixed key is unitless under, so
 *  `WebkitLineClamp: 2` is `2` like `lineClamp: 2` is, not `2px` (an invalid
 *  declaration the browser drops — the clamp silently did nothing). */
function _unitless(prop: string): boolean {
  if (UNITLESS_CSS.has(prop)) return true;
  const m = /^(?:Webkit|Moz|ms|O)([A-Z])(.*)$/.exec(prop);
  return !!m && UNITLESS_CSS.has(m[1]!.toLowerCase() + m[2]);
}

/** Resolve one style declaration's value — auto-append "px" for properties
 *  that need units.
 *
 *  `""` means "no declaration": the client's `setProperty(name, "")` REMOVES
 *  the property and the SSR writer omits the pair, so both renderers agree.
 *  A BOOLEAN lands there too, as null does. `{ display: hidden && "none" }`
 *  is the ordinary conditional-style shape, and `false` used to stringify to
 *  `"false"` — an invalid value `setProperty` ignores, so the OLD `display:
 *  none` stayed on the element forever once `hidden` turned false, while SSR
 *  shipped `display:false`. `true` is never a CSS value either (React ignores
 *  both), so it is not one here. A custom property (`--gap: 4`) takes the
 *  number verbatim: it has no unit of its own to assume. */
export function styleValue(prop: string, value: unknown): string {
  if (value == null || typeof value === "boolean") return "";
  if (
    typeof value === "number" && value !== 0 && !prop.startsWith("--") &&
    !_unitless(prop)
  ) {
    return value + "px";
  }
  return String(value);
}
