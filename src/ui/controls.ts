// aio/ui — the controls a dashboard needs that the first kit did not have.
//
// The original kit covered the primitives you rewrite in every app (button,
// inputs, field, table, card, layout, modal, toast). Building a real ops tool
// on it, the gaps were the same ten every time: a radio group, a switch, tabs,
// a progress bar, a tooltip, an action menu, a status callout, breadcrumbs, a
// loading skeleton and an empty state.
//
// Each earns its place by the inclusion razor — useful, not a duplicate of
// something already here, and needed by more than one kind of app. What is NOT
// here is as deliberate: no date picker (a locale problem, not a component
// one), no combobox (an app's search is its own), no data grid (Table is the
// answer, and a grid is a product).
//
// THE RULE every one of these obeys: keyboard first. A menu that opens on
// click and cannot be closed with Escape, tabs you cannot arrow between, a
// switch that is a styled div — those look finished and are not, and shipping
// one is worse than shipping none, because the app author reasonably assumes
// the framework's own components work. Each pattern below implements the WAI-
// ARIA keyboard interaction for its role, and `tests/ui-controls.test.ts`
// drives every one of them by key.
import { Fragment, h } from "../air/vdom.ts";
import { onCleanup, onMount, useSignal } from "../air/aio-renderer.ts";
import type { VChild, VNode } from "../air/vdom.ts";

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

function cx(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base;
}

function rest(props: Record<string, unknown>, own: string[]): Common {
  const out: Common = {};
  for (const k in props) if (!own.includes(k)) out[k] = props[k];
  return out;
}

/** A stable id for wiring `aria-controls` / `aria-labelledby` pairs.
 *
 *  Deterministic per component instance rather than random: an id that changes
 *  between the server render and the client hydration breaks the association
 *  it exists to make, silently. */
let _idSeq = 0;
function nextId(prefix: string): string {
  return `aio-${prefix}-${++_idSeq}`;
}

/** @internal test seam — make ids predictable across cases. */
export function _resetControlIds(): void {
  _idSeq = 0;
}

// ── Radio group ──────────────────────────────────────────────────────

/** One choice in a {@link RadioGroup}. */
export interface RadioOption {
  value: string;
  label: VChild;
  disabled?: boolean;
}

/** Props for {@link RadioGroup}. */
export interface RadioGroupProps extends Common {
  /** The selected value. */
  value?: string;
  options: RadioOption[];
  /** Accessible name for the group — required unless `aria-labelledby` is set:
   *  a set of radios with no group name is announced as loose buttons. */
  label?: string;
  /** Shared `name` for the underlying inputs. Defaults to a generated one,
   *  which is what makes arrow-key navigation work within the group. */
  name?: string;
  disabled?: boolean;
  onChange?: (value: string, e: Event) => void;
}

/** A radio group.
 *
 *  Native `<input type="radio">` with a shared `name`, inside a `role="group"`
 *  — so the browser gives arrow-key navigation, roving focus and the "one of
 *  N" announcement for free. A hand-rolled ARIA radiogroup would have to
 *  reimplement all three, and would get one of them wrong. */
export function RadioGroup(props: RadioGroupProps): VNode {
  const { value, options, label, disabled, onChange, class: cls } = props;
  const name = props.name ?? nextId("radio");
  return h(
    "div",
    {
      ...rest(props, [
        "value",
        "options",
        "label",
        "name",
        "disabled",
        "onChange",
        "class",
      ]),
      class: cx("aio-radios", cls),
      role: "group",
      ...(label && props["aria-labelledby"] === undefined
        ? { "aria-label": label }
        : {}),
    },
    ...options.map((o) =>
      h(
        "label",
        {
          key: o.value,
          class: "aio-radio-row",
          "data-disabled": disabled || o.disabled ? "" : undefined,
        },
        h("input", {
          type: "radio",
          class: "aio-radio",
          name,
          value: o.value,
          checked: value === o.value,
          disabled: disabled || o.disabled,
          // Same reasoning as Checkbox and Switch: the wrapping <label> IS a
          // valid accessible-name association, and it is invisible to anything
          // reading the input's own props — including this framework's own dev
          // a11y check, which told authors their labelled radios had no label,
          // about markup the kit wrote and they could not change.
          // Found by `scripts/audit-round.ts 17`.
          ...(typeof o.label === "string" && o.label.trim()
            ? { "aria-label": o.label.trim() }
            : {}),
          onChange: onChange
            ? (e: Event) => onChange((e.target as HTMLInputElement).value, e)
            : undefined,
        }),
        h("span", null, o.label),
      )
    ),
  );
}

// ── Switch ───────────────────────────────────────────────────────────

/** Props for {@link Switch}. */
export interface SwitchProps extends Common {
  checked?: boolean;
  disabled?: boolean;
  /** Accessible name. Required unless `aria-label`/`aria-labelledby` is set —
   *  a toggle with no name is announced as "switch", which says nothing. */
  label?: VChild;
  onChange?: (checked: boolean, e: Event) => void;
}

/** An on/off toggle.
 *
 *  A real `<input type="checkbox" role="switch">`, not a styled div: Space
 *  toggles it, the form submits it, and a screen reader says "on"/"off"
 *  instead of "checked"/"unchecked". The visual is CSS on the input itself. */
export function Switch(props: SwitchProps): VNode {
  const { checked, disabled, label, onChange, class: cls } = props;
  const box = h("input", {
    ...rest(props, ["checked", "disabled", "label", "onChange", "class"]),
    type: "checkbox",
    role: "switch",
    class: label == null ? cx("aio-switch", cls) : "aio-switch",
    checked,
    disabled,
    // Same reasoning as Checkbox: a wrapping <label> is a valid association
    // but is invisible to anything reading the input's own props, including
    // this framework's dev a11y check.
    ...(typeof label === "string" && label.trim() &&
        props["aria-label"] === undefined
      ? { "aria-label": label.trim() }
      : {}),
    onChange: onChange
      ? (e: Event) => onChange((e.target as HTMLInputElement).checked, e)
      : undefined,
  });
  if (label == null) return box;
  return h(
    "label",
    { class: cx("aio-switch-row", cls) },
    box,
    h("span", null, label),
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────

/** One tab in a {@link Tabs}. */
export interface TabItem {
  /** Stable identity — what `value`/`onChange` speak in. */
  id: string;
  label: VChild;
  disabled?: boolean;
  /** Panel content. Only the active one is rendered. */
  children?: VChild;
}

/** Props for {@link Tabs}. */
export interface TabsProps extends Common {
  tabs: TabItem[];
  /** The active tab id. Uncontrolled when omitted — the first enabled tab. */
  value?: string;
  /** Accessible name for the tab list. */
  label?: string;
  onChange?: (id: string) => void;
}

/**
 * Tabs, with the WAI-ARIA keyboard interaction implemented.
 *
 * Arrow keys move between tabs (wrapping, skipping disabled ones), Home/End
 * jump to the ends, and only the active tab is in the page's tab order — so
 * Tab moves OUT of the tab list into the panel, which is the whole point of
 * the pattern. `Left`/`Right` are resolved against the document's writing
 * direction, so this works in RTL without a second implementation.
 */
export function Tabs(props: TabsProps): VNode {
  const { tabs, label, onChange, class: cls } = props;
  const firstEnabled = tabs.find((t) => !t.disabled)?.id ?? tabs[0]?.id ?? "";
  const inner = useSignal(props.value ?? firstEnabled);
  // Controlled when `value` is supplied, uncontrolled otherwise — the same
  // rule every input in this kit follows.
  const active = props.value ?? inner.value;
  const baseId = nextId("tabs");

  const select = (id: string): void => {
    if (props.value === undefined) inner.set(id);
    onChange?.(id);
  };

  const move = (from: number, delta: number, e: KeyboardEvent): void => {
    const n = tabs.length;
    if (n === 0) return;
    for (let step = 1; step <= n; step++) {
      const i = (((from + delta * step) % n) + n) % n;
      const t = tabs[i]!;
      if (t.disabled) continue;
      select(t.id);
      // Roving focus: the newly-selected tab must RECEIVE focus, or the next
      // arrow key goes to the old one and the list feels broken.
      const el = (e.currentTarget as HTMLElement | null)?.parentElement
        ?.querySelector<HTMLElement>(`#${CSS.escape(`${baseId}-tab-${t.id}`)}`);
      el?.focus();
      return;
    }
  };

  const onKeyDown = (i: number) => (e: KeyboardEvent) => {
    // `dir` decides which physical arrow means "next". Reading it from the
    // element rather than assuming LTR is the difference between tabs that
    // work in Arabic and tabs that feel inverted.
    const rtl =
      (e.currentTarget as HTMLElement | null)?.closest?.("[dir]")?.getAttribute(
        "dir",
      ) === "rtl";
    const fwd = rtl ? "ArrowLeft" : "ArrowRight";
    const back = rtl ? "ArrowRight" : "ArrowLeft";
    if (e.key === fwd || e.key === "ArrowDown") {
      e.preventDefault();
      move(i, 1, e);
    } else if (e.key === back || e.key === "ArrowUp") {
      e.preventDefault();
      move(i, -1, e);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(-1, 1, e);
    } else if (e.key === "End") {
      e.preventDefault();
      move(tabs.length, -1, e);
    }
  };

  const activeTab = tabs.find((t) => t.id === active);
  return h(
    "div",
    {
      ...rest(props, ["tabs", "value", "label", "onChange", "class"]),
      class: cx("aio-tabs", cls),
    },
    h(
      "div",
      {
        class: "aio-tablist",
        role: "tablist",
        ...(label ? { "aria-label": label } : {}),
      },
      ...tabs.map((t, i) =>
        h("button", {
          key: t.id,
          type: "button",
          id: `${baseId}-tab-${t.id}`,
          class: `aio-tab${t.id === active ? " aio-tab--active" : ""}`,
          role: "tab",
          "aria-selected": t.id === active ? "true" : "false",
          // ONE panel element, so every tab names the SAME id — the
          // single-panel variant of the WAI-ARIA tabs pattern. Per-tab ids
          // (`…-panel-${t.id}`) looked tidier and were invalid references:
          // only the active panel is rendered, so every INACTIVE tab claimed
          // to control an element that does not exist. Found by
          // `scripts/audit-round.ts 16`, which resolves every ARIA id
          // reference in a rendered tree.
          "aria-controls": `${baseId}-panel`,
          // Exactly one tab is tabbable; the rest are reached with arrows.
          tabIndex: t.id === active ? 0 : -1,
          disabled: t.disabled,
          onClick: () => !t.disabled && select(t.id),
          onKeyDown: onKeyDown(i),
        }, t.label)
      ),
    ),
    h(
      "div",
      {
        class: "aio-tabpanel",
        role: "tabpanel",
        id: `${baseId}-panel`,
        "aria-labelledby": activeTab
          ? `${baseId}-tab-${activeTab.id}`
          : undefined,
        // A panel with focusable content does not need this; one with only
        // text does, or a keyboard user can never read it.
        tabIndex: 0,
      },
      activeTab?.children,
    ),
  );
}

// ── Progress ─────────────────────────────────────────────────────────

/** Props for {@link Progress}. */
export interface ProgressProps extends Common {
  /** 0..max. Omit for an indeterminate bar. */
  value?: number;
  max?: number;
  /** Accessible name — "Progress" alone tells a listener nothing. */
  label?: string;
  /** Show the percentage as text beside the bar. */
  showValue?: boolean;
}

/** A progress bar, determinate or not.
 *
 *  Native `<progress>` so assistive technology announces it and the value is
 *  exposed without ARIA bookkeeping. Omitting `value` gives the indeterminate
 *  form, which is the honest answer when the work has no measurable end. */
export function Progress(props: ProgressProps): VNode {
  const { max = 100, label, showValue, class: cls } = props;
  // A non-finite value is an app bug, and the DOM's answer to it is to THROW
  // ("The provided double value is non-finite") — which blanks the page for a
  // number that was only ever decoration. Dev says so; both modes render the
  // indeterminate bar, which is the honest reading of "we do not know".
  // Found by `scripts/audit-round.ts 16`.
  let value = props.value;
  if (value !== undefined && !Number.isFinite(value)) {
    if ((globalThis as Record<string, unknown>).__aioDev === true) {
      console.warn(
        `[aio-dev] <Progress value={${value}}> is not a finite number — ` +
          `rendering the indeterminate bar. Pass a number, or omit \`value\` ` +
          `when the work has no measurable end.`,
      );
    }
    value = undefined;
  }
  const bar = h("progress", {
    ...rest(props, ["value", "max", "label", "showValue", "class"]),
    class: cx("aio-progress", cls),
    // `value` absent ⇒ indeterminate. `null` would serialise as "null".
    ...(value === undefined ? {} : { value: String(value) }),
    max: String(max),
    ...(label && props["aria-label"] === undefined
      ? { "aria-label": label }
      : {}),
  });
  if (!showValue || value === undefined || !Number.isFinite(max) || max === 0) {
    return bar;
  }
  return h(
    "span",
    { class: "aio-progress-row" },
    bar,
    h(
      "span",
      { class: "aio-progress__value" },
      `${Math.round((value / max) * 100)}%`,
    ),
  );
}

// ── Alert ────────────────────────────────────────────────────────────

/** Props for {@link Alert}. */
export interface AlertProps extends Common {
  variant?: "info" | "success" | "warn" | "error";
  /** Bold lead-in above the body. */
  title?: VChild;
  children?: VChild;
  /** Render a dismiss button that calls this. */
  onDismiss?: () => void;
}

/** A status callout that stays on the page.
 *
 *  Distinct from `toast()`, which interrupts and disappears: an Alert is part
 *  of the layout and is read in document order. An `error` gets `role="alert"`
 *  so it is announced immediately; the calmer variants do not, because
 *  interrupting someone to say "saved" is a bug. */
export function Alert(props: AlertProps): VNode {
  const { variant = "info", title, children, onDismiss, class: cls } = props;
  return h(
    "div",
    {
      ...rest(props, ["variant", "title", "children", "onDismiss", "class"]),
      class: cx(`aio-alert aio-alert--${variant}`, cls),
      role: variant === "error" ? "alert" : "note",
    },
    h(
      "div",
      { class: "aio-alert__body" },
      title ? h("strong", { class: "aio-alert__title" }, title) : null,
      children ? h("div", null, children) : null,
    ),
    onDismiss
      ? h("button", {
        type: "button",
        class: "aio-alert__x",
        "aria-label": "Dismiss",
        onClick: onDismiss,
      }, "×")
      : null,
  );
}

// ── Tooltip ──────────────────────────────────────────────────────────

/** Props for {@link Tooltip}. */
export interface TooltipProps extends Common {
  /** The text shown on hover AND on keyboard focus. */
  text: string;
  /** Where to put it relative to the trigger. */
  placement?: "top" | "bottom";
  children?: VChild;
}

/**
 * A tooltip on hover and on focus.
 *
 * `title=` is the alternative, and it is worse in three ways that matter:
 * it never appears for a keyboard user, it cannot be styled, and on touch it
 * does not appear at all. This one is `aria-describedby`-wired, shows on
 * `:hover` AND `:focus-within` (CSS, so no JS on the hot path), and closes on
 * Escape — which is a WAI-ARIA requirement people forget, because a tooltip
 * stuck over the thing you are trying to read is its own accessibility bug.
 */
export function Tooltip(props: TooltipProps): VNode {
  const { text, placement = "top", children, class: cls } = props;
  const id = nextId("tip");
  const hidden = useSignal(false);
  return h(
    "span",
    {
      ...rest(props, ["text", "placement", "children", "class"]),
      class: cx(`aio-tip aio-tip--${placement}`, cls),
      "data-hidden": hidden.value ? "" : undefined,
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "Escape") hidden.set(true);
      },
      // Re-arm when focus or the pointer leaves and comes back.
      onFocusOut: () => hidden.set(false),
      onMouseLeave: () => hidden.set(false),
    },
    h(
      "span",
      { class: "aio-tip__trigger", "aria-describedby": id },
      children,
    ),
    h("span", { class: "aio-tip__bubble", role: "tooltip", id }, text),
  );
}

// ── Menu ─────────────────────────────────────────────────────────────

/** One entry in a {@link Menu}. */
export interface MenuItem {
  /** Stable identity passed to `onSelect`. */
  id: string;
  label: VChild;
  disabled?: boolean;
  /** Renders as a destructive action. */
  danger?: boolean;
}

/** Props for {@link Menu}. */
export interface MenuProps extends Common {
  /** The button that opens it. */
  trigger: VChild;
  items: MenuItem[];
  /** Accessible name for the trigger, when `trigger` is not text. */
  label?: string;
  onSelect?: (id: string) => void;
}

/**
 * An actions menu.
 *
 * The full keyboard contract, because a menu without it is a click-only
 * feature: Enter/Space/ArrowDown open it and focus the first item, arrows and
 * Home/End move, Escape closes and returns focus to the trigger, Tab closes,
 * and a click outside closes. Focus returning to the trigger is the one people
 * skip, and it is the one that strands a keyboard user at the top of the
 * document.
 */
export function Menu(props: MenuProps): VNode {
  const { trigger, items, label, onSelect, class: cls } = props;
  const open = useSignal(false);
  const id = nextId("menu");
  let root: HTMLElement | null = null;

  const focusItem = (i: number): void => {
    const list = root?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!list || list.length === 0) return;
    const n = list.length;
    list[((i % n) + n) % n]?.focus();
  };

  const close = (refocus: boolean): void => {
    if (!open.value) return;
    open.set(false);
    if (refocus) {
      root?.querySelector<HTMLElement>(".aio-menu__trigger")?.focus();
    }
  };

  onMount(() => {
    const doc = root?.ownerDocument;
    if (!doc) return;
    const onDocDown = (e: Event) => {
      if (root && !root.contains(e.target as Node)) close(false);
    };
    doc.addEventListener("pointerdown", onDocDown, true);
    onCleanup(() => doc.removeEventListener("pointerdown", onDocDown, true));
  });

  const openWith = (index: number): void => {
    open.set(true);
    // The list does not exist until this render commits.
    queueMicrotask(() => focusItem(index));
  };

  return h(
    "div",
    {
      ...rest(props, ["trigger", "items", "label", "onSelect", "class"]),
      class: cx("aio-menu", cls),
      ref: (el: HTMLElement | null) => {
        root = el;
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close(true);
        } else if (e.key === "Tab") {
          // Tab means "leave" — closing without stealing focus is correct.
          close(false);
        }
      },
    },
    h("button", {
      type: "button",
      class: "aio-menu__trigger",
      "aria-haspopup": "menu",
      "aria-expanded": open.value ? "true" : "false",
      // ONLY while the list exists. `aria-controls` naming an absent id is an
      // invalid reference: a screen reader is told "this button controls
      // element X", looks for X, and finds nothing. `aria-expanded` is what
      // says the menu is closed. Found by `scripts/audit-round.ts 16`, which
      // resolves every ARIA id reference in a rendered tree.
      ...(open.value ? { "aria-controls": id } : {}),
      ...(label ? { "aria-label": label } : {}),
      onClick: () => open.value ? close(true) : openWith(0),
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          openWith(0);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          openWith(items.length - 1);
        }
      },
    }, trigger),
    open.value
      ? h(
        "div",
        {
          class: "aio-menu__list",
          role: "menu",
          id,
          ...(label ? { "aria-label": label } : {}),
        },
        ...items.map((it, i) =>
          h("button", {
            key: it.id,
            type: "button",
            role: "menuitem",
            class: `aio-menu__item${
              it.danger ? " aio-menu__item--danger" : ""
            }`,
            tabIndex: -1,
            disabled: it.disabled,
            onClick: () => {
              if (it.disabled) return;
              close(true);
              onSelect?.(it.id);
            },
            onKeyDown: (e: KeyboardEvent) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                focusItem(i + 1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                focusItem(i - 1);
              } else if (e.key === "Home") {
                e.preventDefault();
                focusItem(0);
              } else if (e.key === "End") {
                e.preventDefault();
                focusItem(items.length - 1);
              }
            },
          }, it.label)
        ),
      )
      : null,
  );
}

// ── Breadcrumb ───────────────────────────────────────────────────────

/** One step in a {@link Breadcrumb}. */
export interface Crumb {
  label: VChild;
  /** Omit on the last crumb — the current page is not a link to itself. */
  href?: string;
  onClick?: (e: Event) => void;
}

/** Props for {@link Breadcrumb}. */
export interface BreadcrumbProps extends Common {
  items: Crumb[];
  /** The separator between crumbs. Decorative — hidden from screen readers. */
  separator?: VChild;
}

/** A breadcrumb trail.
 *
 *  `<nav aria-label="Breadcrumb"> <ol>` is the pattern, and the last item
 *  carries `aria-current="page"` rather than being a link — the page you are
 *  on is not somewhere you can navigate to. */
export function Breadcrumb(props: BreadcrumbProps): VNode {
  const { items, separator = "/", class: cls } = props;
  return h(
    "nav",
    {
      ...rest(props, ["items", "separator", "class"]),
      class: cx("aio-crumbs", cls),
      "aria-label": (props["aria-label"] as string) ?? "Breadcrumb",
    },
    h(
      "ol",
      { class: "aio-crumbs__list" },
      ...items.map((c, i) => {
        const last = i === items.length - 1;
        return h(
          "li",
          { key: i, class: "aio-crumbs__item" },
          last || (!c.href && !c.onClick)
            ? h(
              "span",
              { ...(last ? { "aria-current": "page" } : {}) },
              c.label,
            )
            : h("a", { href: c.href, onClick: c.onClick }, c.label),
          last ? null : h(
            "span",
            { class: "aio-crumbs__sep", "aria-hidden": "true" },
            separator,
          ),
        );
      }),
    ),
  );
}

// ── Skeleton ─────────────────────────────────────────────────────────

/** Props for {@link Skeleton}. */
export interface SkeletonProps extends Common {
  /** CSS width — a number is px. */
  width?: string | number;
  height?: string | number;
  /** Render as a circle (an avatar placeholder). */
  circle?: boolean;
  /** How many stacked bars. */
  lines?: number;
}

/** A loading placeholder.
 *
 *  `aria-hidden` and NOT announced: a screen reader user does not want six
 *  grey rectangles read to them. The surrounding region should carry
 *  `aria-busy="true"` instead, which says the one useful thing. Its shimmer
 *  respects `prefers-reduced-motion` (in the stylesheet). */
export function Skeleton(props: SkeletonProps): VNode {
  const { width, height, circle, lines = 1, class: cls } = props;
  const px = (v: string | number | undefined) =>
    v === undefined ? undefined : typeof v === "number" ? `${v}px` : v;
  const one = (key?: number) =>
    h("span", {
      key,
      class: cx(`aio-skel${circle ? " aio-skel--circle" : ""}`, cls),
      "aria-hidden": "true",
      style: {
        ...(px(width) ? { width: px(width)! } : {}),
        ...(px(height) ? { height: px(height)! } : {}),
        ...(props.style ?? {}),
      },
    });
  if (lines <= 1) return one();
  return h(
    "span",
    {
      ...rest(props, ["width", "height", "circle", "lines", "class", "style"]),
      class: "aio-skel-stack",
      "aria-hidden": "true",
    },
    ...Array.from({ length: lines }, (_, i) => one(i)),
  );
}

// ── EmptyState ───────────────────────────────────────────────────────

/** Props for {@link EmptyState}. */
export interface EmptyStateProps extends Common {
  /** A single glyph or small node. Decorative — hidden from screen readers. */
  icon?: VChild;
  title: VChild;
  /** One sentence on what to do about it. */
  description?: VChild;
  /** The action that resolves the emptiness. */
  action?: VChild;
}

/** The panel a list shows when it has nothing in it.
 *
 *  Every dashboard writes this and every one writes it differently. An empty
 *  table with no explanation is indistinguishable from a failed load, which is
 *  the actual bug this component exists to prevent. */
export function EmptyState(props: EmptyStateProps): VNode {
  const { icon, title, description, action, class: cls } = props;
  return h(
    "div",
    {
      ...rest(props, ["icon", "title", "description", "action", "class"]),
      class: cx("aio-empty", cls),
    },
    icon
      ? h("div", { class: "aio-empty__icon", "aria-hidden": "true" }, icon)
      : null,
    h("p", { class: "aio-empty__title" }, title),
    description ? h("p", { class: "aio-empty__desc" }, description) : null,
    action ? h("div", { class: "aio-empty__action" }, action) : null,
  );
}

export { Fragment };
