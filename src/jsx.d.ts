// AIO-62: Native DOM event types for AIR JSX.
// When jsxImportSource is "aio", TypeScript uses these types instead of @types/react.
// Event handlers receive native DOM events — no SyntheticEvent, no `as any` casts.

type AioEventHandler<E extends Event = Event> = (event: E) => void;

// Mapped event handlers — eliminates index signature conflict (AIO-76)
type AioEventMap = {
  Click: MouseEvent;
  DblClick: MouseEvent;
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
type AioMappedEventHandlers = {
  [K in keyof AioEventMap as `on${K}`]?: AioEventHandler<AioEventMap[K]>;
};

type AioHTMLAttributes = AioMappedEventHandlers & {
  // Standard HTML attributes
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

  // Data attributes
  [key: `data-${string}`]: string | number | boolean | undefined;

  // ARIA attributes
  [key: `aria-${string}`]: string | number | boolean | undefined;

  // Ref callback or object
  ref?: ((el: HTMLElement | null) => void) | { current: HTMLElement | null };

  // Key for reconciliation
  key?: string | number;

  // Children
  children?: unknown;

  // dangerouslySetInnerHTML
  dangerouslySetInnerHTML?: { __html: string };
};

type AioInputAttributes = AioHTMLAttributes & {
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

type AioTextAreaAttributes = AioHTMLAttributes & {
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

type AioSelectAttributes = AioHTMLAttributes & {
  value?: string | number;
  defaultValue?: string | number;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  multiple?: boolean;
  size?: number;
  autoFocus?: boolean;
};

type AioAnchorAttributes = AioHTMLAttributes & {
  href?: string;
  target?: string;
  rel?: string;
  download?: string | boolean;
  hreflang?: string;
  type?: string;
};

type AioImgAttributes = AioHTMLAttributes & {
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

type AioFormAttributes = AioHTMLAttributes & {
  action?: string;
  method?: string;
  encType?: string;
  target?: string;
  noValidate?: boolean;
  autoComplete?: string;
  name?: string;
};

type AioButtonAttributes = AioHTMLAttributes & {
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
  // Allow any SVG-specific attribute
  [key: string]: unknown;
};

// Module-scoped JSX types for jsxImportSource: "aio"
// NOT a global `declare namespace JSX` — avoids TS2300 collision with @types/react
// TypeScript resolves these via the "aio/jsx-runtime" module declaration below.

declare module "aio/jsx-runtime" {
  export namespace JSX {
    type Element = import("./vdom.ts").VNode;
    interface IntrinsicElements {
      // Form elements
      input: AioInputAttributes;
      textarea: AioTextAreaAttributes;
      select: AioSelectAttributes;
      option: AioOptionAttributes;
      button: AioButtonAttributes;
      form: AioFormAttributes;
      label: AioLabelAttributes;

      // Links and media
      a: AioAnchorAttributes;
      img: AioImgAttributes;

      // SVG
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

      // All other HTML elements use base attributes
      [tag: string]: AioHTMLAttributes;
    }
  }
}
