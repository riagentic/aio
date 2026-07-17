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
import { _getDocument, onCleanup, onMount } from "../air/aio-renderer.ts";
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
    class: "aio-checkbox",
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

/** Wraps a control with a label, optional hint, and error message. Pass the
 *  same `invalid` to the control (or read `error`) to color it consistently. */
export function Field(props: FieldProps): VNode {
  const { label, hint, error, required, children, class: cls } = props;
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
      role: "dialog",
      "aria-modal": "true",
      onClick: onBackdrop,
    },
    h(
      "div",
      { class: "aio-modal", role: "document" },
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

// ── Styles ───────────────────────────────────────────────────────────

export { UI_CSS, UiStyles } from "./styles.ts";

// Re-export Fragment so `aio/ui` is self-sufficient for grouping.
export { Fragment };
