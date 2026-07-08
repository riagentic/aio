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

/** Automatic JSX transform — called by esbuild for single-child elements */
export function jsx(
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

/** Automatic JSX transform — called by esbuild for multi-child elements */
export const jsxs = jsx;

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

type AioMappedEventHandlers<T extends EventTarget = HTMLElement> = {
  [K in keyof AioEventMap as `on${K}`]?: (
    e: AirEvent<T, AioEventMap[K]>,
  ) => void;
};

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
    [key: `data-${string}`]: string | number | boolean | undefined;
    [key: `aria-${string}`]: string | number | boolean | undefined;
    ref?: ((el: HTMLElement | null) => void) | { current: HTMLElement | null };
    key?: string | number;
    children?: unknown;
    dangerouslySetInnerHTML?: { __html: string };
  };

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

type AioAnchorAttributes = AioHTMLAttributes<HTMLAnchorElement> & {
  href?: string;
  target?: string;
  rel?: string;
  download?: string | boolean;
  hreflang?: string;
  type?: string;
};

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
};

type AioFormAttributes = AioHTMLAttributes<HTMLFormElement> & {
  action?: string;
  method?: string;
  encType?: string;
  target?: string;
  noValidate?: boolean;
  autoComplete?: string;
  name?: string;
};

type AioButtonAttributes = AioHTMLAttributes<HTMLButtonElement> & {
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  name?: string;
  value?: string;
  autoFocus?: boolean;
  form?: string;
};

type AioLabelAttributes = AioHTMLAttributes & {
  htmlFor?: string;
  for?: string;
};

type AioOptionAttributes = AioHTMLAttributes & {
  value?: string | number;
  selected?: boolean;
  disabled?: boolean;
  label?: string;
};

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

/** JSX namespace — resolved by `jsxImportSource: "aio"` */
// deno-lint-ignore no-namespace
export namespace JSX {
  export type Element = VNode;
  /** Attributes valid on every JSX element, including function components.
   *  `key` is extracted by `jsx()` before props reach the component. */
  export interface IntrinsicAttributes {
    key?: string | number;
  }
  export interface IntrinsicElements {
    input: AioInputAttributes;
    textarea: AioTextAreaAttributes;
    select: AioSelectAttributes;
    option: AioOptionAttributes;
    button: AioButtonAttributes;
    form: AioFormAttributes;
    label: AioLabelAttributes;

    a: AioAnchorAttributes;
    img: AioImgAttributes;

    svg: AioSVGAttributes;
    path: AioSVGAttributes;
    circle: AioSVGAttributes;
    rect: AioSVGAttributes;
    line: AioSVGAttributes;
    polyline: AioSVGAttributes;
    polygon: AioSVGAttributes;
    text: AioSVGAttributes;
    g: AioSVGAttributes;
    defs: AioSVGAttributes;
    use: AioSVGAttributes;
    clipPath: AioSVGAttributes;
    mask: AioSVGAttributes;

    // deno-lint-ignore no-explicit-any -- index must admit element-specific handler types (AIO-7.3)
    [tag: string]: AioHTMLAttributes<any>;
  }
}
