/**
 * @module
 * JSX automatic runtime for AIO renderer.
 *
 * Provides `jsx`/`jsxs`/`Fragment` so esbuild's `jsxImportSource: "aio"` works
 * without explicit `import { h } from "aio"` in every component file. Also
 * exports the `JSX` namespace so TypeScript resolves intrinsic element types
 * from this module (no global type augmentation — JSR forbids it).
 *
 * @example
 * ```jsonc
 * // deno.json
 * { "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "aio" } }
 * ```
 */

import { Fragment, h } from "./air/vdom.ts";
import type { VNode } from "./air/vdom.ts";

/** VDOM fragment — groups children without a wrapper element. */
export { Fragment };

/** Automatic JSX transform — called by esbuild for single-child elements.
 *
 *  ONE child. When that child is an array it is the result of an EXPRESSION
 *  (`<ul>{items.map(…)}</ul>`), so it is handed to `h()` as one nested array
 *  and not spread: the runtime marks what it flattens out of a nested array
 *  as "array children" (vdom-create.ts `_isFromArray`), which is the only
 *  case the missing-keys warning is about. Spreading it here — as this and
 *  `jsxs` both used to — made a `.map` list indistinguishable from siblings
 *  written out by hand, so the warning fired for both. */
export function jsx(
  tag: string | typeof Fragment | ((props: Record<string, unknown>) => unknown),
  props: Record<string, unknown> | null,
  key?: string | number,
): ReturnType<typeof h> {
  const { children, ...rest } = props ?? {};
  if (key !== undefined) rest.key = key;
  return children == null
    ? h(tag as string, rest)
    : h(tag as string, rest, children as VNode);
}

/** Automatic JSX transform — called by esbuild for multi-child elements.
 *
 *  The children array here is the JSX's OWN child list — literal siblings —
 *  so it is spread. An array sitting inside it (`<ul><li/>{items.map(…)}</ul>`)
 *  is still nested, and the runtime marks it as such. Same signature as `jsx`
 *  (it used to be an alias). */
export function jsxs(
  tag: string | typeof Fragment | ((props: Record<string, unknown>) => unknown),
  props: Record<string, unknown> | null,
  key?: string | number,
): ReturnType<typeof h> {
  const { children, ...rest } = props ?? {};
  if (key !== undefined) rest.key = key;
  const kids = children == null
    ? []
    : Array.isArray(children)
    ? children
    : [children];
  return h(tag as string, rest, ...kids);
}

// ── JSX types ────────────────────────────────────────────────────────
// AIO-62: Native DOM event types. When jsxImportSource is "aio",
// TypeScript uses these types instead of @types/react. Event handlers
// receive native DOM events — no SyntheticEvent, no `as any` casts.

type AioEventHandler<E extends Event = Event> = (event: E) => void;

/** AIO-7.3: event with `currentTarget` typed as the handling element —
 *  `e.currentTarget.value` works without casts (React expectation). */
export type AirEvent<T extends EventTarget, E extends Event = Event> = E & {
  currentTarget: T;
  target: EventTarget;
};

/** Event-name → DOM event type map backing AIR's typed `on*` props. */
type AioEventMap = {
  Click: MouseEvent;
  DblClick: MouseEvent;
  DoubleClick: MouseEvent; // AIO-7.2: React alias — maps to dblclick
  MouseDown: MouseEvent;
  MouseUp: MouseEvent;
  MouseMove: MouseEvent;
  MouseEnter: MouseEvent;
  MouseLeave: MouseEvent;
  MouseOver: MouseEvent;
  MouseOut: MouseEvent;
  ContextMenu: MouseEvent;
  KeyDown: KeyboardEvent;
  KeyUp: KeyboardEvent;
  KeyPress: KeyboardEvent;
  Focus: FocusEvent;
  Blur: FocusEvent;
  FocusIn: FocusEvent;
  FocusOut: FocusEvent;
  Change: Event;
  Input: InputEvent;
  Submit: SubmitEvent;
  Reset: Event;
  Invalid: Event;
  TouchStart: TouchEvent;
  TouchEnd: TouchEvent;
  TouchMove: TouchEvent;
  TouchCancel: TouchEvent;
  PointerDown: PointerEvent;
  PointerUp: PointerEvent;
  PointerMove: PointerEvent;
  PointerEnter: PointerEvent;
  PointerLeave: PointerEvent;
  PointerOver: PointerEvent;
  PointerOut: PointerEvent;
  PointerCancel: PointerEvent;
  Wheel: WheelEvent;
  Scroll: Event;
  Drag: DragEvent;
  DragStart: DragEvent;
  DragEnd: DragEvent;
  DragEnter: DragEvent;
  DragLeave: DragEvent;
  DragOver: DragEvent;
  Drop: DragEvent;
  Copy: ClipboardEvent;
  Cut: ClipboardEvent;
  Paste: ClipboardEvent;
  AnimationStart: AnimationEvent;
  AnimationEnd: AnimationEvent;
  AnimationIteration: AnimationEvent;
  TransitionEnd: TransitionEvent;
  Load: Event;
  Error: Event;
};

/** All `on<Event>` handler props, element-typed via AirEvent<T>. */
type AioMappedEventHandlers<T extends EventTarget = HTMLElement> = {
  [K in keyof AioEventMap as `on${K}`]?: (
    e: AirEvent<T, AioEventMap[K]>,
  ) => void;
};

/** Base JSX attributes for intrinsic elements (global attrs + typed events). */
type AioHTMLAttributes<T extends EventTarget = HTMLElement> =
  & AioMappedEventHandlers<T>
  & {
    id?: string;
    className?: string | string[] | Record<string, boolean>;
    class?: string;
    style?:
      | string
      | Partial<CSSStyleDeclaration>
      | Record<string, string | number>;
    title?: string;
    tabIndex?: number;
    hidden?: boolean;
    role?: string;
    slot?: string;
    dir?: string;
    lang?: string;
    draggable?: boolean;
    spellcheck?: boolean;
    contentEditable?: boolean | "true" | "false" | "plaintext-only";
    /** Which on-screen keyboard to raise — `<input type="number"
     *  inputMode="decimal">` is the standard way to get a numeric keypad.
     *  Global (valid on any element, including `contentEditable` ones), which
     *  is why it lives here rather than on the input attributes. The renderer
     *  already wrote these through to the DOM; only the TYPE was missing, so
     *  the documented spelling failed to compile on the target it matters most
     *  for — Android is first-class here (a field report). */
    inputMode?:
      | "none"
      | "text"
      | "decimal"
      | "numeric"
      | "tel"
      | "search"
      | "email"
      | "url";
    /** The action label on the virtual keyboard's Enter key. */
    enterKeyHint?:
      | "enter"
      | "done"
      | "go"
      | "next"
      | "previous"
      | "search"
      | "send";
    /** Auto-capitalization for virtual keyboards. */
    autoCapitalize?:
      | "off"
      | "none"
      | "on"
      | "sentences"
      | "words"
      | "characters";
    [key: `data-${string}`]: string | number | boolean | undefined;
    [key: `aria-${string}`]: string | number | boolean | undefined;
    ref?: ((el: HTMLElement | null) => void) | { current: HTMLElement | null };
    key?: string | number;
    /** Semantic test handle — names this element in the UI surface
     *  (`testUI`, `am ui`). Dev/test concept; stripped from the DOM. */
    t?: string;
    children?: unknown;
    dangerouslySetInnerHTML?: { __html: string };
  };

/** `<input>` JSX attributes. */
type AioInputAttributes = AioHTMLAttributes<HTMLInputElement> & {
  type?: string;
  value?: string | number;
  defaultValue?: string | number;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  placeholder?: string;
  name?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  pattern?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  multiple?: boolean;
  accept?: string;
  maxLength?: number;
  minLength?: number;
  size?: number;
};

/** `<textarea>` JSX attributes. */
type AioTextAreaAttributes = AioHTMLAttributes<HTMLTextAreaElement> & {
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  placeholder?: string;
  name?: string;
  rows?: number;
  cols?: number;
  maxLength?: number;
  minLength?: number;
  wrap?: string;
  autoFocus?: boolean;
};

/** `<select>` JSX attributes. */
type AioSelectAttributes = AioHTMLAttributes<HTMLSelectElement> & {
  value?: string | number;
  defaultValue?: string | number;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  multiple?: boolean;
  size?: number;
  autoFocus?: boolean;
};

/** `<a>` JSX attributes. */
type AioAnchorAttributes = AioHTMLAttributes<HTMLAnchorElement> & {
  href?: string;
  target?: string;
  rel?: string;
  download?: string | boolean;
  hreflang?: string;
  type?: string;
  referrerPolicy?: string;
};

/** `<img>` JSX attributes. */
type AioImgAttributes = AioHTMLAttributes<HTMLImageElement> & {
  src?: string;
  alt?: string;
  width?: string | number;
  height?: string | number;
  loading?: "lazy" | "eager";
  decoding?: "async" | "auto" | "sync";
  crossOrigin?: string;
  srcSet?: string;
  sizes?: string;
  referrerPolicy?: string;
  fetchPriority?: "high" | "low" | "auto";
  useMap?: string;
  isMap?: boolean;
};

/** `<iframe>` JSX attributes. */
type AioIframeAttributes = AioHTMLAttributes<HTMLIFrameElement> & {
  src?: string;
  srcDoc?: string;
  width?: string | number;
  height?: string | number;
  name?: string;
  title?: string;
  allow?: string;
  allowFullScreen?: boolean;
  loading?: "lazy" | "eager";
  referrerPolicy?: string;
  sandbox?: string;
};

/** `<form>` JSX attributes. */
type AioFormAttributes = AioHTMLAttributes<HTMLFormElement> & {
  action?: string;
  method?: string;
  encType?: string;
  target?: string;
  noValidate?: boolean;
  autoComplete?: string;
  name?: string;
};

/** `<button>` JSX attributes. */
type AioButtonAttributes = AioHTMLAttributes<HTMLButtonElement> & {
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  name?: string;
  value?: string;
  autoFocus?: boolean;
  form?: string;
};

/** `<label>` JSX attributes. */
type AioLabelAttributes = AioHTMLAttributes & {
  htmlFor?: string;
  for?: string;
};

/** `<option>` JSX attributes. */
type AioOptionAttributes = AioHTMLAttributes & {
  value?: string | number;
  selected?: boolean;
  disabled?: boolean;
  label?: string;
};

/** SVG element JSX attributes. */
type AioSVGAttributes = AioHTMLAttributes & {
  viewBox?: string;
  xmlns?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: string | number;
  d?: string;
  cx?: string | number;
  cy?: string | number;
  r?: string | number;
  x?: string | number;
  y?: string | number;
  width?: string | number;
  height?: string | number;
  transform?: string;
  opacity?: string | number;
  clipPath?: string;
  [key: string]: unknown;
};

/** `<fieldset>` — `disabled` locks every control in the group at once, which is
 *  THE standard way to lock a form section. It was missing, and the workarounds
 *  (don't render the group, or disable each control by hand) are worse markup for
 *  the same intent. */
type AioFieldSetAttributes = AioHTMLAttributes<HTMLFieldSetElement> & {
  disabled?: boolean;
  form?: string;
  name?: string;
};

/** `<optgroup>` — same `disabled` story, one level up from `<option>`. */
type AioOptGroupAttributes = AioHTMLAttributes<HTMLOptGroupElement> & {
  disabled?: boolean;
  label?: string;
};

/** `<details>` / `<dialog>` — `open` IS the state of these elements. */
type AioDetailsAttributes = AioHTMLAttributes<HTMLDetailsElement> & {
  open?: boolean;
  name?: string;
};
/** `<dialog>` attributes, including the `open` boolean AIR treats as state. */
type AioDialogAttributes = AioHTMLAttributes<HTMLDialogElement> & {
  open?: boolean;
};

/** `<progress>` / `<meter>` — a UI that reports progress needs these typed. */
type AioProgressAttributes = AioHTMLAttributes<HTMLProgressElement> & {
  value?: number | string;
  max?: number | string;
};
/** `<meter>` attributes — value plus the min/max/low/high/optimum bounds. */
type AioMeterAttributes = AioHTMLAttributes<HTMLMeterElement> & {
  value?: number | string;
  min?: number | string;
  max?: number | string;
  low?: number | string;
  high?: number | string;
  optimum?: number | string;
};

/** Table cells — `colSpan`/`rowSpan`/`headers`/`scope` are structural. */
type AioTableCellAttributes = AioHTMLAttributes<HTMLTableCellElement> & {
  colSpan?: number;
  rowSpan?: number;
  headers?: string;
  scope?: "row" | "col" | "rowgroup" | "colgroup";
  abbr?: string;
};

/** Media elements — the attributes that decide playback behaviour. */
type AioMediaAttributes<T extends EventTarget = HTMLMediaElement> =
  & AioHTMLAttributes<T>
  & {
    src?: string;
    autoplay?: boolean;
    controls?: boolean;
    loop?: boolean;
    muted?: boolean;
    playsInline?: boolean;
    preload?: "none" | "metadata" | "auto";
    poster?: string;
    width?: number | string;
    height?: number | string;
    crossOrigin?: "anonymous" | "use-credentials";
    /** Media readiness events. Without these a <video> has no way to report
     *  that it started playing or failed, so a UI cannot swap a placeholder
     *  for it — the same job `onLoad` does for <img>. */
    onLoadedData?: (e: Event) => void;
    onLoadedMetadata?: (e: Event) => void;
    onCanPlay?: (e: Event) => void;
    onPlaying?: (e: Event) => void;
    onEnded?: (e: Event) => void;
    onStalled?: (e: Event) => void;
  };

/** `<canvas>` — width/height are attributes, not just CSS. */
type AioCanvasAttributes = AioHTMLAttributes<HTMLCanvasElement> & {
  width?: number | string;
  height?: number | string;
};

/** JSX namespace — resolved by `jsxImportSource: "aio"` for JSX ELEMENTS, and
 *  imported by name when you want to ANNOTATE:
 *
 *  ```tsx
 *  import type { JSX } from "aio";          // also: "aio/jsx-runtime"
 *  export default function App(): JSX.Element { … }
 *  ```
 *
 *  That import is the one thing about it worth knowing, because without it
 *  `function App(): JSX.Element` is `TS2503: Cannot find namespace 'JSX'` — an
 *  error naming no remedy, and one a field report hit 23 times on its first
 *  `deno task check`. Two things changed as a result: `JSX` is re-exported
 *  from `aio` itself (so it autocompletes off the import every app already
 *  has), and every scaffold template annotates its component, so a new app
 *  carries the line from the first minute.
 *
 *  It is NOT declared globally, and that is a packaging constraint rather than
 *  a preference: JSR's fast-check refuses `declare global` in a published
 *  module ("global augmentations are not supported"), so shipping the ambient
 *  version would break `deno publish` — a release gate — for a convenience.
 *
 *  The shapes live at module scope so the namespace and the standalone type
 *  aliases cannot drift. */
export type JsxElement = VNode;
/** Anything renderable in JSX — the type for a `children` prop. Gives
 *  React-refugees a name (`children: JSX.Node`) instead of reaching for
 *  React's `ReactNode`. `JSX.Children` is an alias. */
export type JsxNode =
  | VNode
  | string
  | number
  | boolean
  | null
  | undefined
  | JsxNode[];
/** Attributes valid on every JSX element, including function components.
 *  `key` is extracted by `jsx()` before props reach the component. */
export interface JsxIntrinsicAttributes {
  key?: string | number;
  /** Semantic test handle for a COMPONENT — names it in the UI surface, so a
   *  test addresses the handle you chose instead of the function's identifier.
   *  Renaming the function is then a refactor, not a broken test. Elements
   *  have carried `t` all along. */
  t?: string;
}
/** Every intrinsic tag JSX accepts and its attribute type — HTML elements
 *  with their aio-typed handlers, the SVG vocabulary, and an index signature
 *  so unlisted tags still compile with generic attributes. */
export interface JsxIntrinsicElements {
  input: AioInputAttributes;
  textarea: AioTextAreaAttributes;
  select: AioSelectAttributes;
  option: AioOptionAttributes;
  button: AioButtonAttributes;
  form: AioFormAttributes;
  label: AioLabelAttributes;

  a: AioAnchorAttributes;
  img: AioImgAttributes;
  iframe: AioIframeAttributes;
  fieldset: AioFieldSetAttributes;
  optgroup: AioOptGroupAttributes;
  details: AioDetailsAttributes;
  dialog: AioDialogAttributes;
  progress: AioProgressAttributes;
  meter: AioMeterAttributes;
  td: AioTableCellAttributes;
  th: AioTableCellAttributes;
  video: AioMediaAttributes<HTMLVideoElement>;
  audio: AioMediaAttributes<HTMLAudioElement>;
  canvas: AioCanvasAttributes;

  // SVG — must mirror SVG_TAG_LIST in air/vdom-types.ts. AioSVGAttributes
  // carries a `[key: string]: unknown` index, so element-specific attrs
  // (x1, offset, gradientTransform, stdDeviation, …) are admitted without
  // per-element enumeration.
  svg: AioSVGAttributes;
  circle: AioSVGAttributes;
  ellipse: AioSVGAttributes;
  line: AioSVGAttributes;
  path: AioSVGAttributes;
  polygon: AioSVGAttributes;
  polyline: AioSVGAttributes;
  rect: AioSVGAttributes;
  g: AioSVGAttributes;
  defs: AioSVGAttributes;
  symbol: AioSVGAttributes;
  use: AioSVGAttributes;
  text: AioSVGAttributes;
  tspan: AioSVGAttributes;
  textPath: AioSVGAttributes;
  image: AioSVGAttributes;
  clipPath: AioSVGAttributes;
  mask: AioSVGAttributes;
  pattern: AioSVGAttributes;
  marker: AioSVGAttributes;
  linearGradient: AioSVGAttributes;
  radialGradient: AioSVGAttributes;
  stop: AioSVGAttributes;
  filter: AioSVGAttributes;
  feBlend: AioSVGAttributes;
  feColorMatrix: AioSVGAttributes;
  feComponentTransfer: AioSVGAttributes;
  feComposite: AioSVGAttributes;
  feConvolveMatrix: AioSVGAttributes;
  feDiffuseLighting: AioSVGAttributes;
  feDisplacementMap: AioSVGAttributes;
  feFlood: AioSVGAttributes;
  feGaussianBlur: AioSVGAttributes;
  feImage: AioSVGAttributes;
  feMerge: AioSVGAttributes;
  feMergeNode: AioSVGAttributes;
  feMorphology: AioSVGAttributes;
  feOffset: AioSVGAttributes;
  feSpecularLighting: AioSVGAttributes;
  feTile: AioSVGAttributes;
  feTurbulence: AioSVGAttributes;
  foreignObject: AioSVGAttributes;
  animate: AioSVGAttributes;
  animateTransform: AioSVGAttributes;
  set: AioSVGAttributes;

  // deno-lint-ignore no-explicit-any -- index must admit element-specific handler types (AIO-7.3)
  [tag: string]: AioHTMLAttributes<any>;
}

/** The `JSX` namespace, importable by name (`import type { JSX } from "aio"`)
 *  — `JSX.Element`, `JSX.Node`, `JSX.Children`, and the intrinsic maps. Not
 *  declared globally: JSR's fast-check refuses `declare global` in a
 *  published module, so the import is the contract (see the module note). */
// deno-lint-ignore no-namespace
export namespace JSX {
  export type Element = JsxElement;
  export type Node = JsxNode;
  export type Children = JsxNode;
  export interface IntrinsicAttributes extends JsxIntrinsicAttributes {}
  export interface IntrinsicElements extends JsxIntrinsicElements {}
}
