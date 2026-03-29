// AIO-62: Native DOM event types for AIR JSX.
// When jsxImportSource is "aio", TypeScript uses these types instead of @types/react.
// Event handlers receive native DOM events — no SyntheticEvent, no `as any` casts.

type AioEventHandler<E extends Event = Event> = (event: E) => void;

type AioHTMLAttributes = {
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

  // Mouse events — native MouseEvent
  onClick?: AioEventHandler<MouseEvent>;
  onDblClick?: AioEventHandler<MouseEvent>;
  onMouseDown?: AioEventHandler<MouseEvent>;
  onMouseUp?: AioEventHandler<MouseEvent>;
  onMouseMove?: AioEventHandler<MouseEvent>;
  onMouseEnter?: AioEventHandler<MouseEvent>;
  onMouseLeave?: AioEventHandler<MouseEvent>;
  onMouseOver?: AioEventHandler<MouseEvent>;
  onMouseOut?: AioEventHandler<MouseEvent>;
  onContextMenu?: AioEventHandler<MouseEvent>;

  // Keyboard events — native KeyboardEvent
  onKeyDown?: AioEventHandler<KeyboardEvent>;
  onKeyUp?: AioEventHandler<KeyboardEvent>;
  onKeyPress?: AioEventHandler<KeyboardEvent>;

  // Focus events — native FocusEvent
  onFocus?: AioEventHandler<FocusEvent>;
  onBlur?: AioEventHandler<FocusEvent>;
  onFocusIn?: AioEventHandler<FocusEvent>;
  onFocusOut?: AioEventHandler<FocusEvent>;

  // Form events — native Event/InputEvent
  onChange?: AioEventHandler<Event>;
  onInput?: AioEventHandler<InputEvent>;
  onSubmit?: AioEventHandler<SubmitEvent>;
  onReset?: AioEventHandler<Event>;
  onInvalid?: AioEventHandler<Event>;

  // Touch events — native TouchEvent
  onTouchStart?: AioEventHandler<TouchEvent>;
  onTouchEnd?: AioEventHandler<TouchEvent>;
  onTouchMove?: AioEventHandler<TouchEvent>;
  onTouchCancel?: AioEventHandler<TouchEvent>;

  // Pointer events — native PointerEvent
  onPointerDown?: AioEventHandler<PointerEvent>;
  onPointerUp?: AioEventHandler<PointerEvent>;
  onPointerMove?: AioEventHandler<PointerEvent>;
  onPointerEnter?: AioEventHandler<PointerEvent>;
  onPointerLeave?: AioEventHandler<PointerEvent>;
  onPointerOver?: AioEventHandler<PointerEvent>;
  onPointerOut?: AioEventHandler<PointerEvent>;
  onPointerCancel?: AioEventHandler<PointerEvent>;

  // Wheel/scroll events
  onWheel?: AioEventHandler<WheelEvent>;
  onScroll?: AioEventHandler<Event>;

  // Drag events — native DragEvent
  onDrag?: AioEventHandler<DragEvent>;
  onDragStart?: AioEventHandler<DragEvent>;
  onDragEnd?: AioEventHandler<DragEvent>;
  onDragEnter?: AioEventHandler<DragEvent>;
  onDragLeave?: AioEventHandler<DragEvent>;
  onDragOver?: AioEventHandler<DragEvent>;
  onDrop?: AioEventHandler<DragEvent>;

  // Clipboard events
  onCopy?: AioEventHandler<ClipboardEvent>;
  onCut?: AioEventHandler<ClipboardEvent>;
  onPaste?: AioEventHandler<ClipboardEvent>;

  // Animation/transition events
  onAnimationStart?: AioEventHandler<AnimationEvent>;
  onAnimationEnd?: AioEventHandler<AnimationEvent>;
  onAnimationIteration?: AioEventHandler<AnimationEvent>;
  onTransitionEnd?: AioEventHandler<TransitionEvent>;

  // Media events
  onLoad?: AioEventHandler<Event>;
  onError?: AioEventHandler<Event>;

  // Catch-all for any other event handler
  [key: `on${Uppercase<string>}${string}`]: AioEventHandler | undefined;
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

declare namespace JSX {
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
