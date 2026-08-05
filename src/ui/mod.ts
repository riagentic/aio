/**
 * @module aio/ui
 * A small, deliberately basic component kit for aio's core use case —
 * dashboards, ops tools, control panels. Not a design system: just the
 * primitives you'd otherwise rewrite in every app (button, inputs, field,
 * table, card, layout), authored as native AIR components so they bind to
 * cells with no adapter.
 *
 * Styling is class-based and themed through CSS custom properties, injected
 * once via {@link UiStyles} (placed at your app root). Override any `--aio-*`
 * token in your own CSS to reskin. Light/dark both ship by default.
 *
 * @example
 * ```tsx
 * import { UiStyles, Button, Field, Input, Table } from "aio/ui";
 * export default function App() {
 *   return (
 *     <div>
 *       <UiStyles />
 *       <Field label="Name"><Input value={form.name} onInput={form.setName} /></Field>
 *       <Button variant="primary" onClick={() => users.add()}>Add</Button>
 *       <Table columns={cols} rows={users.list} />
 *     </div>
 *   );
 * }
 * ```
 */
import { Fragment, h } from "../air/vdom.ts";
import {
  _getDocument,
  onCleanup,
  onMount,
  signal,
  useSignal,
} from "../air/aio-renderer.ts";
import type { VChild, VNode } from "../air/vdom.ts";

// ── Shared prop helpers ──────────────────────────────────────────────

/** Inline style object accepted by every kit component. */
type Style = Record<string, string | number>;

/** Props common to every component: escape hatches that never fight the kit. */
interface Common {
  /** Extra class names appended after the component's own. */
  class?: string;
  /** Inline style overrides, merged last. */
  style?: Style;
  /** Any other DOM attribute (id, aria-*, data-*, title…). */
  [attr: string]: unknown;
}

/** Merge the kit's class with a caller-supplied one. */
function cx(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base;
}

/** Split Common escape-hatch props from a component's own typed props. */
function rest(props: Record<string, unknown>, own: string[]): Common {
  const out: Common = {};
  for (const k in props) if (!own.includes(k)) out[k] = props[k];
  return out;
}

// ── Button ───────────────────────────────────────────────────────────

/** Props for {@link Button} — variant, size, and native button attributes. */
export interface ButtonProps extends Common {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: (e: Event) => void;
  children?: VChild;
}

/** A button. `variant` sets intent, `size` sets scale. */
export function Button(props: ButtonProps): VNode {
  const { variant = "secondary", size = "md", children, class: cls } = props;
  return h("button", {
    ...rest(props, ["variant", "size", "children", "class"]),
    type: props.type ?? "button",
    class: cx(`aio-btn aio-btn--${variant} aio-btn--${size}`, cls),
  }, children);
}

// ── Text inputs ──────────────────────────────────────────────────────

/** Props for {@link Input} — controlled value plus native input attributes. */
export interface InputProps extends Common {
  value?: string | number;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  onInput?: (value: string, e: Event) => void;
  onChange?: (value: string, e: Event) => void;
}

/** A single-line text input. `onInput` receives the string value directly. */
export function Input(props: InputProps): VNode {
  const { invalid, onInput, onChange, class: cls } = props;
  return h("input", {
    ...rest(props, ["invalid", "onInput", "onChange", "class"]),
    type: props.type ?? "text",
    class: cx(`aio-input${invalid ? " aio-input--invalid" : ""}`, cls),
    onInput: onInput
      ? (e: Event) => onInput((e.target as HTMLInputElement).value, e)
      : undefined,
    onChange: onChange
      ? (e: Event) => onChange((e.target as HTMLInputElement).value, e)
      : undefined,
  });
}

/** Props for {@link Textarea} — controlled value, placeholder, and rows. */
export interface TextareaProps extends Common {
  value?: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  invalid?: boolean;
  onInput?: (value: string, e: Event) => void;
}

/** A multi-line text input. */
export function Textarea(props: TextareaProps): VNode {
  const { invalid, onInput, class: cls } = props;
  return h("textarea", {
    ...rest(props, ["invalid", "onInput", "class"]),
    rows: props.rows ?? 3,
    class: cx(
      `aio-input aio-textarea${invalid ? " aio-input--invalid" : ""}`,
      cls,
    ),
    onInput: onInput
      ? (e: Event) => onInput((e.target as HTMLTextAreaElement).value, e)
      : undefined,
  }, props.value ?? "");
}

/** One option of a {@link Select} — value with optional label/disabled. */
export interface SelectOption {
  value: string;
  label?: string;
  disabled?: boolean;
}

/** Props for {@link Select} — options (strings or {@link SelectOption}s) and controlled value. */
export interface SelectProps extends Common {
  value?: string;
  options: (SelectOption | string)[];
  disabled?: boolean;
  invalid?: boolean;
  onChange?: (value: string, e: Event) => void;
}

/** A dropdown. `options` accepts strings or `{ value, label }`. */
export function Select(props: SelectProps): VNode {
  const { options, value, invalid, onChange, class: cls } = props;
  const opts = options.map((o) => {
    const opt = typeof o === "string" ? { value: o } : o;
    return h("option", {
      value: opt.value,
      disabled: opt.disabled,
      selected: opt.value === value,
    }, opt.label ?? opt.value);
  });
  return h("select", {
    ...rest(props, ["options", "value", "invalid", "onChange", "class"]),
    class: cx(
      `aio-input aio-select${invalid ? " aio-input--invalid" : ""}`,
      cls,
    ),
    onChange: onChange
      ? (e: Event) => onChange((e.target as HTMLSelectElement).value, e)
      : undefined,
  }, ...opts);
}

/** Props for {@link Checkbox} — checked state with an optional inline label. */
export interface CheckboxProps extends Common {
  checked?: boolean;
  disabled?: boolean;
  label?: VChild;
  onChange?: (checked: boolean, e: Event) => void;
}

/** A checkbox, optionally with an inline label. */
export function Checkbox(props: CheckboxProps): VNode {
  const { checked, label, onChange, class: cls } = props;
  const box = h("input", {
    ...rest(props, ["checked", "label", "onChange", "class"]),
    type: "checkbox",
    checked,
    // Unlabelled, the box IS the component, so the caller's `class` belongs on
    // it — it used to be swallowed (only the label row ever received it), so
    // `<Checkbox class="mine"/>` silently rendered without "mine".
    class: label == null ? cx("aio-checkbox", cls) : "aio-checkbox",
    onChange: onChange
      ? (e: Event) => onChange((e.target as HTMLInputElement).checked, e)
      : undefined,
  });
  if (label == null) return box;
  return h(
    "label",
    { class: cx("aio-checkbox-row", cls) },
    box,
    h("span", null, label),
  );
}

// ── Field (label + control + error) ──────────────────────────────────

/** Props for {@link Field} — label, hint, and error wrapping for a control. */
export interface FieldProps extends Common {
  label?: VChild;
  hint?: VChild;
  /** Error text; when present the field renders in its invalid state. */
  error?: string | null;
  required?: boolean;
  children?: VChild;
}

/** Give the field's control the field's label as its accessible name.
 *
 *  A `<label>` that is a SIBLING of its control names nothing: without `for`/`id`
 *  or wrapping, the browser makes no association, screen readers announce the
 *  input as unnamed — and the semantic surface, which reads the same signals,
 *  could only call it `Input`, `Input2`, … So a two-field form was addressable
 *  only positionally (`ui.Field2.Input`), in the kit's own headline example.
 *  Naming the control fixes both at once, and only when the caller hasn't
 *  already named it (an explicit `t`/`aria-label` always wins).
 *
 *  Returns true once it has named a control, so a Field with several inputs
 *  labels the first — exactly what a wrapping `<label>` would do. */
function nameControl(child: unknown, label: string): boolean {
  if (!child || typeof child !== "object") return false;
  if (Array.isArray(child)) {
    for (const c of child) if (nameControl(c, label)) return true;
    return false;
  }
  const v = child as VNode;
  if (!("tag" in v) || !v.props) return false;
  const p = v.props as Record<string, unknown>;
  const isControl = typeof v.tag === "string"
    ? v.tag === "input" || v.tag === "select" || v.tag === "textarea"
    : v.tag === Input || v.tag === Select || v.tag === Textarea ||
      v.tag === Checkbox;
  if (isControl) {
    if (
      p["aria-label"] === undefined && p.t === undefined &&
      p["data-testid"] === undefined
    ) p["aria-label"] = label;
    return true;
  }
  for (const c of v.children ?? []) if (nameControl(c, label)) return true;
  return false;
}

/** Wraps a control with a label, optional hint, and error message. Pass the
 *  same `invalid` to the control (or read `error`) to color it consistently.
 *  A string `label` also becomes the control's accessible name (and therefore
 *  its semantic-surface name: `<Field label="Email">` → `ui.EmailInput`). */
export function Field(props: FieldProps): VNode {
  const { label, hint, error, required, children, class: cls } = props;
  if (typeof label === "string" && label.trim()) {
    nameControl(children, label.trim());
  }
  return h(
    "div",
    {
      ...rest(props, [
        "label",
        "hint",
        "error",
        "required",
        "children",
        "class",
      ]),
      class: cx("aio-field", cls),
    },
    label != null
      ? h(
        "label",
        { class: "aio-field__label" },
        label,
        required ? h("span", { class: "aio-field__req" }, " *") : null,
      )
      : null,
    children,
    hint != null && !error
      ? h("div", { class: "aio-field__hint" }, hint)
      : null,
    error ? h("div", { class: "aio-field__error" }, error) : null,
  );
}

// ── Table ────────────────────────────────────────────────────────────

/** Column definition for {@link Table} — key, header, and cell renderer. */
export interface Column<Row> {
  /** Key into the row, or an id when using `render`. */
  key: string;
  /** Header text. Defaults to `key`. */
  header?: VChild;
  /** Cell renderer. Defaults to `String(row[key])`. */
  render?: (row: Row, index: number) => VChild;
  align?: "left" | "center" | "right";
  width?: string | number;
}

/** Props for {@link Table} — column definitions plus the row data. */
export interface TableProps<Row> extends Common {
  columns: Column<Row>[];
  rows: Row[];
  /** Stable key per row (index by default). Use for correct diffing. */
  getKey?: (row: Row, index: number) => string | number;
  /** Shown when `rows` is empty. */
  empty?: VChild;
  onRowClick?: (row: Row, index: number) => void;
}

/** A basic data table. For very large datasets, drive `rows` with
 *  `useVirtualList` and pass the window — this stays deliberately simple. */
export function Table<Row extends Record<string, unknown>>(
  props: TableProps<Row>,
): VNode {
  const { columns, rows, getKey, empty, onRowClick, class: cls } = props;
  const head = h(
    "thead",
    null,
    h(
      "tr",
      null,
      ...columns.map((c) =>
        h("th", { style: colStyle(c), class: "aio-th" }, c.header ?? c.key)
      ),
    ),
  );
  const body = rows.length === 0
    ? h(
      "tbody",
      null,
      h(
        "tr",
        null,
        h(
          "td",
          { colSpan: columns.length, class: "aio-td aio-table__empty" },
          empty ?? "No rows",
        ),
      ),
    )
    : h(
      "tbody",
      null,
      ...rows.map((row, i) =>
        h(
          "tr",
          {
            key: getKey ? getKey(row, i) : i,
            class: onRowClick ? "aio-tr aio-tr--click" : "aio-tr",
            onClick: onRowClick ? () => onRowClick(row, i) : undefined,
          },
          ...columns.map((c) =>
            h(
              "td",
              { style: colStyle(c), class: "aio-td" },
              c.render ? c.render(row, i) : String(row[c.key] ?? ""),
            )
          ),
        )
      ),
    );
  return h(
    "table",
    {
      ...rest(props, [
        "columns",
        "rows",
        "getKey",
        "empty",
        "onRowClick",
        "class",
      ]),
      class: cx("aio-table", cls),
    },
    head,
    body,
  );
}

function colStyle<R>(c: Column<R>): Style {
  const s: Style = {};
  if (c.align) s.textAlign = c.align;
  if (c.width != null) {
    s.width = typeof c.width === "number" ? `${c.width}px` : c.width;
  }
  return s;
}

// ── Card + layout ────────────────────────────────────────────────────

/** Props for {@link Card} — optional title and footer around the content. */
export interface CardProps extends Common {
  title?: VChild;
  footer?: VChild;
  children?: VChild;
}

/** A padded, bordered surface with optional title and footer. */
export function Card(props: CardProps): VNode {
  const { title, footer, children, class: cls } = props;
  return h(
    "div",
    {
      ...rest(props, ["title", "footer", "children", "class"]),
      class: cx("aio-card", cls),
    },
    title != null ? h("div", { class: "aio-card__title" }, title) : null,
    h("div", { class: "aio-card__body" }, children),
    footer != null ? h("div", { class: "aio-card__footer" }, footer) : null,
  );
}

/** Props for {@link Stack}/{@link Row} — gap, alignment, and children. */
export interface StackProps extends Common {
  gap?: number | string;
  align?: string;
  children?: VChild;
}

/** Vertical flex layout with a gap. */
export function Stack(props: StackProps): VNode {
  return layout(props, "column");
}

/** Horizontal flex layout with a gap (wraps on overflow). */
export function Row(props: StackProps): VNode {
  return layout(props, "row");
}

function layout(props: StackProps, direction: "row" | "column"): VNode {
  const { gap = 12, align, children, class: cls, style } = props;
  return h(
    "div",
    {
      ...rest(props, ["gap", "align", "children", "class", "style"]),
      class: cx("aio-stack", cls),
      style: {
        display: "flex",
        flexDirection: direction,
        flexWrap: direction === "row" ? "wrap" : "nowrap",
        gap: typeof gap === "number" ? `${gap}px` : gap,
        ...(align ? { alignItems: align } : {}),
        ...(style ?? {}),
      },
    },
    children,
  );
}

// ── Modal ────────────────────────────────────────────────────────────

/** Props for {@link Modal} — open state, dismiss callback, and content. */
export interface ModalProps extends Common {
  /** Whether the modal is shown. When false, nothing renders. */
  open: boolean;
  /** Called on Escape or backdrop click (when dismissable). */
  onClose?: () => void;
  title?: VChild;
  footer?: VChild;
  /** Close on Escape / backdrop click. Default true. */
  dismissable?: boolean;
  children?: VChild;
}

/** A dialog with backdrop, Escape-to-close, backdrop-click-to-close, and the
 *  right ARIA — the modal/focus primitive apps otherwise re-roll per form. */
export function Modal(props: ModalProps): VNode | null {
  if (!props.open) return null;
  const { onClose, title, footer, children, dismissable = true, class: cls } =
    props;

  // Escape-to-close, DOM-safe (no-op without a document — SSR/tests).
  onMount(() => {
    const doc = _getDocument();
    if (!dismissable || !onClose || !doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    doc.addEventListener("keydown", onKey);
    onCleanup(() => doc.removeEventListener("keydown", onKey));
  });

  const onBackdrop = dismissable && onClose
    ? (e: Event) => {
      if (e.target === e.currentTarget) onClose();
    }
    : undefined;

  return h(
    "div",
    {
      // The dismiss target needs a name of its own: an unlabelled clickable
      // <div> is just "Button" on the semantic surface — indistinguishable from
      // a real button, and the ONE thing a test wants to drive here ("click
      // outside to close"). A caller-supplied `t` still wins (it comes from
      // `rest`, spread after).
      t: "modalBackdrop",
      ...rest(props, [
        "open",
        "onClose",
        "title",
        "footer",
        "dismissable",
        "children",
        "class",
      ]),
      class: cx("aio-modal-backdrop", cls),
      onClick: onBackdrop,
    },
    h(
      "div",
      {
        class: "aio-modal",
        // ARIA belongs on the dialog BOX, not on the backdrop that surrounds
        // it: role="dialog" + aria-modal on the outer element told assistive
        // tech the whole overlay was the dialog, and left the box itself
        // announced as a generic group.
        role: "dialog",
        "aria-modal": "true",
        ...(typeof title === "string" ? { "aria-label": title } : {}),
      },
      title != null ? h("div", { class: "aio-modal__title" }, title) : null,
      h("div", { class: "aio-modal__body" }, children),
      footer != null ? h("div", { class: "aio-modal__footer" }, footer) : null,
    ),
  );
}

// ── Spinner ──────────────────────────────────────────────────────────

/** A minimal loading spinner. */
export function Spinner(props: Common = {}): VNode {
  return h("span", {
    ...rest(props, ["class"]),
    class: cx("aio-spinner", props.class as string | undefined),
    role: "status",
    "aria-label": "Loading",
  });
}

// ── Avatar ───────────────────────────────────────────────────────────

/** Props for {@link Avatar} — a name (initials + deterministic color) or an
 *  image. `size` is a pixel diameter. */
export interface AvatarProps extends Common {
  /** Display name — first letters become the initials, and seed the color. */
  name: string;
  /** Image URL. When set, shown instead of initials. */
  src?: string;
  /** Diameter in px. Default 32. */
  size?: number;
  /** Override the derived background color (any CSS color). */
  color?: string;
}

const AVATAR_HUES = [210, 12, 145, 275, 32, 190, 330, 95];

/** Up to two initials from a name ("Ada Lovelace" → "AL", "root" → "R"). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "";
  return (first + last).toUpperCase();
}

/** Stable hue from a string, so the same name always gets the same color. */
function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length]!;
}

/** A circular avatar — an image, or deterministic initials + color from the
 *  name. The one every app with users otherwise re-rolls. */
export function Avatar(props: AvatarProps): VNode {
  const { name, src, size = 32, color, class: cls } = props;
  const style: Style = {
    width: `${size}px`,
    height: `${size}px`,
    "font-size": `${Math.round(size * 0.4)}px`,
    ...(color
      ? { background: color }
      : { background: `hsl(${hueFor(name)}, 55%, 45%)` }),
    ...(props.style ?? {}),
  };
  const common = rest(props, [
    "name",
    "src",
    "size",
    "color",
    "class",
    "style",
  ]);
  return h(
    "span",
    {
      ...common,
      class: cx("aio-avatar", cls),
      style,
      role: "img",
      "aria-label": name,
      title: name,
    },
    src
      ? h("img", {
        src,
        alt: name,
        class: "aio-avatar__img",
        width: size,
        height: size,
      })
      : initials(name),
  );
}

// ── Pagination ───────────────────────────────────────────────────────

/** Props for {@link Pagination} — 1-based current page, total pages, and a
 *  change handler. */
export interface PaginationProps extends Common {
  /** Current page, 1-based. */
  page: number;
  /** Total number of pages. */
  pages: number;
  /** Called with the target page when the user navigates. */
  onPage: (page: number) => void;
  /** Max numbered buttons to show around the current page. Default 5. */
  window?: number;
}

/** Windowed page range around `page` (with clamping at the ends). */
function pageWindow(page: number, pages: number, win: number): number[] {
  if (pages <= win) return Array.from({ length: pages }, (_, i) => i + 1);
  const half = Math.floor(win / 2);
  let lo = Math.max(1, page - half);
  const hi = Math.min(pages, lo + win - 1);
  lo = Math.max(1, hi - win + 1);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/** A pager: prev / windowed page numbers / next. Pure — you own the data
 *  slice; this only reports the page the user wants. */
export function Pagination(props: PaginationProps): VNode {
  const { page, pages, onPage, window: win = 5, class: cls } = props;
  const go = (p: number) => {
    if (p >= 1 && p <= pages && p !== page) onPage(p);
  };
  // Every pager button carries an accessible name. "‹" and "›" are pure
  // punctuation: a screen reader announces nothing, and the semantic surface
  // (which derives a name from the same text) could only call them "Button" and
  // "Button2" — prev and next indistinguishable, page numbers landing on
  // identifiers like "1Button".
  const btn = (label: VChild, target: number, opts?: {
    disabled?: boolean;
    current?: boolean;
    aria?: string;
  }) =>
    h("button", {
      type: "button",
      class: cx(
        "aio-page__btn",
        opts?.current ? "aio-page__btn--current" : undefined,
      ),
      disabled: opts?.disabled,
      "aria-label": opts?.aria,
      "aria-current": opts?.current ? "page" : undefined,
      onClick: () => go(target),
    }, label);
  return h(
    "nav",
    {
      ...rest(props, ["page", "pages", "onPage", "window", "class"]),
      class: cx("aio-page", cls),
      "aria-label": "Pagination",
    },
    btn("‹", page - 1, { disabled: page <= 1, aria: "Previous page" }),
    ...pageWindow(page, pages, win).map((p) =>
      btn(String(p), p, { current: p === page, aria: `Page ${p}` })
    ),
    btn("›", page + 1, { disabled: page >= pages, aria: "Next page" }),
  );
}

// ── Confirm ──────────────────────────────────────────────────────────

/** Props for {@link Confirm} — a controlled confirmation dialog on top of
 *  {@link Modal}. */
export interface ConfirmProps extends Common {
  /** Whether the dialog is shown. */
  open: boolean;
  /** Fired when the user confirms. */
  onConfirm: () => void;
  /** Fired on cancel / Escape / backdrop. */
  onCancel: () => void;
  title?: VChild;
  /** The question / consequence text. */
  message?: VChild;
  /** Confirm button label. Default "Confirm". */
  confirmLabel?: string;
  /** Cancel button label. Default "Cancel". */
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
}

/** A confirm dialog — the "are you sure?" every destructive action needs,
 *  built on Modal so focus/Escape/ARIA come for free. */
export function Confirm(props: ConfirmProps): VNode | null {
  const {
    open,
    onConfirm,
    onCancel,
    title,
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger,
  } = props;
  return Modal({
    open,
    onClose: onCancel,
    title,
    class: props.class,
    children: message != null
      ? h("div", { class: "aio-confirm__msg" }, message)
      : null,
    footer: h(
      Fragment,
      null,
      Button({ variant: "ghost", onClick: onCancel, children: cancelLabel }),
      Button({
        variant: danger ? "danger" : "primary",
        onClick: onConfirm,
        children: confirmLabel,
      }),
    ),
  });
}

/** Props for {@link ConfirmButton} — a Button that confirms before acting. */
export interface ConfirmButtonProps extends ButtonProps {
  /** The confirmation message shown in the dialog. */
  confirm: VChild;
  /** Fired only after the user confirms. */
  onConfirm: () => void;
  confirmTitle?: VChild;
  confirmLabel?: string;
  cancelLabel?: string;
}

/** A button that pops a {@link Confirm} dialog and only fires `onConfirm` when
 *  the user agrees — the whole destructive-action pattern in one element.
 *  `variant="danger"` also makes the confirm button destructive. */
export function ConfirmButton(props: ConfirmButtonProps): VNode {
  const openS = useSignal(false);
  const {
    confirm,
    onConfirm,
    confirmTitle,
    confirmLabel,
    cancelLabel,
    children,
    variant,
  } = props;
  const btnProps = rest(props, [
    "confirm",
    "onConfirm",
    "confirmTitle",
    "confirmLabel",
    "cancelLabel",
    "children",
    "onClick",
  ]) as ButtonProps;
  return h(
    Fragment,
    null,
    Button({
      ...btnProps,
      children,
      onClick: () => openS.set(true),
    }),
    Confirm({
      open: openS.value,
      title: confirmTitle,
      message: confirm,
      confirmLabel,
      cancelLabel,
      danger: variant === "danger",
      onCancel: () => openS.set(false),
      onConfirm: () => {
        openS.set(false);
        onConfirm();
      },
    }),
  );
}

// ── Toast ────────────────────────────────────────────────────────────

/** Toast intent. */
export type ToastVariant = "info" | "success" | "warn" | "error";

interface ToastItem {
  id: number;
  message: VChild;
  variant: ToastVariant;
}

// Module-level reactive queue — one host renders it; `toast()` pushes to it.
const _toasts = signal<ToastItem[]>([]);
let _toastSeq = 0;

/** Show a toast. Returns a dismiss function; auto-dismisses after `duration`
 *  ms (default 4000; pass 0 to keep it until dismissed). Call from anywhere —
 *  event handlers, effects, after a method resolves. Render {@link ToastHost}
 *  once at your app root. */
export function toast(
  message: VChild,
  opts?: { variant?: ToastVariant; duration?: number },
): () => void {
  const id = ++_toastSeq;
  const variant = opts?.variant ?? "info";
  _toasts.set([..._toasts.peek(), { id, message, variant }]);
  const dismiss = () => _toasts.set(_toasts.peek().filter((t) => t.id !== id));
  const duration = opts?.duration ?? 4000;
  if (duration > 0 && typeof setTimeout !== "undefined") {
    setTimeout(dismiss, duration);
  }
  return dismiss;
}

/** The container that renders active toasts — place once at your app root
 *  (a fixed-position ARIA live region). Reactive: reads the module toast
 *  queue, so `toast(...)` anywhere updates it. */
export function ToastHost(props: Common = {}): VNode {
  const items = _toasts.value; // reactive read → re-renders on toast()/dismiss
  return h(
    "div",
    {
      ...rest(props, ["class"]),
      class: cx("aio-toasts", props.class as string | undefined),
      role: "status",
      "aria-live": "polite",
    },
    ...items.map((t) =>
      h(
        "div",
        {
          key: t.id,
          class: `aio-toast aio-toast--${t.variant}`,
          role: t.variant === "error" ? "alert" : undefined,
        },
        h("span", { class: "aio-toast__msg" }, t.message),
        h("button", {
          type: "button",
          class: "aio-toast__x",
          "aria-label": "Dismiss",
          onClick: () =>
            _toasts.set(_toasts.peek().filter((x) => x.id !== t.id)),
        }, "×"),
      )
    ),
  );
}

/** Test/reset hook — clear the toast queue between tests.
 *  @internal */
export function _resetToasts(): void {
  _toasts.set([]);
  _toastSeq = 0;
}

// ── Markdown ─────────────────────────────────────────────────────────

export { Markdown, type MarkdownProps } from "./markdown.ts";

// ── Styles ───────────────────────────────────────────────────────────

export { UI_CSS, UiStyles } from "./styles.ts";

// Re-export Fragment so `aio/ui` is self-sufficient for grouping.
export { Fragment };
