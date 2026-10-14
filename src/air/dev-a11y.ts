// dev-a11y.ts — the accessibility lint over every element AIR creates.
//
// Advice about markup, said in dev: it returns at its first line unless
// `isDevMode()`, so a production page could never run it and downloaded it
// anyway (2 KB of role tables and prose in aio-renderer.ts). It is part of the
// dev layer now (air/dev-air.ts) — in every runtime that runs source, and in
// no production bundle.
import { isDevMode } from "../state/dev-flag.ts";

// a11y checks run on EVERY element on EVERY render — a single offending
// element in a component that re-renders would flood the console with the
// same message. Warn once per distinct message (cleared when dev mode is
// re-toggled, so a fresh session re-reports).
const _warnedA11y = new Set<string>();
function _warnA11yOnce(msg: string): void {
  if (_warnedA11y.has(msg)) return;
  _warnedA11y.add(msg);
  console.warn(msg);
}

/** Composite-widget items: keyboard handled by the owning widget. */
const COMPOSITE_ITEM_ROLES = new Set([
  "option",
  "row",
  "gridcell",
  "treeitem",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
]);
/** Owners of those items: the keyboard lives ON them (WAI-ARIA). */
const COMPOSITE_OWNER_ROLES = new Set([
  "listbox",
  "grid",
  "treegrid",
  "tree",
  "tablist",
  "menu",
  "menubar",
]);
/** Surfaces whose click is a convenience with a platform keyboard path. */
const DISMISSIBLE_ROLES = new Set(["dialog", "alertdialog", "alert", "status"]);

/** @internal Dev-mode a11y checks on element creation. */
export function _devA11yCheck(
  tag: string,
  props: Record<string, unknown>,
  inLabel = false,
): void {
  // The check is installed once at module load rather than by `setDevMode()`,
  // so it asks the flag here. Wired only from `setDevMode()`, the whole a11y
  // layer was dark for every app that never called it — which was every app.
  if (!isDevMode()) return;
  if (tag === "img" && !("alt" in props)) {
    _warnA11yOnce(
      '[aio-dev] <img> missing "alt" attribute. Add alt="" for decorative images or descriptive text for meaningful ones.',
    );
  }
  // `role="presentation"` / `role="none"` is the author declaring that this
  // element carries no semantics — a scrim, an overlay, a decorative wrapper
  // whose click is a convenience the keyboard reaches another way (a modal's
  // Escape). Telling them to bolt a keydown onto a non-focusable div is advice
  // that helps nobody, and the framework's own <Modal> backdrop tripped it, so
  // the warning arrived about markup the app could not change.
  const presentational = props.role === "presentation" || props.role === "none";
  // Elements the platform ALREADY activates from the keyboard: they are
  // natively focusable and Enter/Space dispatches a real `click`, so the
  // handler already runs. Asking for an `onKeyDown` here does not add
  // accessibility, it adds a DOUBLE FIRE — a field report pointed out that on
  // `<summary>` the suggested fix toggles the disclosure twice, i.e. the
  // warning asks for a bug. `summary` and `label` were the two missing from
  // this list; both forward activation to something else by spec.
  // ARIA roles whose keyboard lives ELSEWHERE by the WAI-ARIA pattern, where
  // "add onKeyDown here" is advice that cannot be followed (field report §10). A
  // composite item (`option`, `row`, `tab`, …) is never itself focused in the
  // `aria-activedescendant` pattern: the arrows and Enter belong to its owner.
  // The owner (`listbox`, `grid`, …) is where that keyboard LIVES, so it is
  // exempt only when it visibly carries it: a key handler (checked below) or
  // `aria-activedescendant`. A focusable listbox with a click and neither is
  // keyboard-dead — Tab reaches it, the arrows and Enter do nothing — and is
  // exactly the one owner that CAN follow "add onKeyDown". A `dialog` /
  // `alert` / `status` click is a convenience by construction (Escape, the
  // auto-expiry), and `role="presentation"` would erase the semantics that
  // make them accessible.
  const role = typeof props.role === "string" ? props.role : "";
  const keyboardElsewhere = COMPOSITE_ITEM_ROLES.has(role) ||
    DISMISSIBLE_ROLES.has(role) ||
    (COMPOSITE_OWNER_ROLES.has(role) &&
      props["aria-activedescendant"] !== undefined);
  const nativelyActivatable = tag === "button" || tag === "a" ||
    tag === "input" || tag === "select" || tag === "textarea" ||
    tag === "summary" || tag === "label" || tag === "option";
  if (
    props.onClick &&
    !presentational &&
    !keyboardElsewhere &&
    !props.onKeyDown &&
    !props.onKeyUp &&
    !props.onKeyPress &&
    !nativelyActivatable
  ) {
    _warnA11yOnce(
      `[aio-dev] <${tag}> has onClick but no keyboard handler. Add onKeyDown for keyboard accessibility.`,
    );
  }
  if (
    (tag === "input" || tag === "textarea" || tag === "select") &&
    !props["aria-label"] &&
    !props["aria-labelledby"] &&
    !props.id
  ) {
    // A control NESTED in a <label> is labelled by it — valid HTML and the
    // recommended form for a checkbox. The element has no parent yet when
    // this runs, so the renderer says whether it is building one (a field
    // report: three label-wrapped checkboxes, all flagged).
    if (!inLabel) {
      _warnA11yOnce(
        `[aio-dev] <${tag}> has no label association. Wrap it in a <label>, or add id (for <label htmlFor>), aria-label, or aria-labelledby.`,
      );
    }
  }
  // ── The five below are the rest of what a linter would catch ──
  //
  // Each is a mistake that renders perfectly and fails only for someone using
  // a keyboard, a screen reader, or a zoomed page — i.e. exactly the class of
  // defect nobody finds by looking at the app. Dev-only and warn-once, like
  // everything above: an a11y warning is an observation, never a behaviour.

  // A <button> inside a form defaults to type="submit", so the "just a
  // button" that opens a menu also submits the form and reloads the page.
  // The single most common React-to-anything porting bug there is.
  if (tag === "button" && !props.type) {
    _warnA11yOnce(
      `[aio-dev] <button> without type — inside a <form> it defaults to ` +
        `type="submit" and will submit it. Write type="button" for a button ` +
        `that is not the form's submit.`,
    );
  }
  // `<a>` with no href is not a link: it is not focusable, Enter does nothing,
  // and a screen reader announces nothing. An onClick on one is a button.
  if (tag === "a" && props.onClick && props.href === undefined) {
    _warnA11yOnce(
      `[aio-dev] <a onClick> with no href is not focusable and not ` +
        `announced — keyboard users cannot reach it. Use <button> for an ` +
        `action, or give the <a> a real href.`,
    );
  }
  // A positive tabindex re-orders the whole document's tab sequence, not just
  // this element's, and the damage is invisible until someone tabs.
  const ti = Number(props.tabIndex ?? props.tabindex);
  if (Number.isFinite(ti) && ti > 0) {
    _warnA11yOnce(
      `[aio-dev] tabIndex={${ti}} — a positive tabindex re-orders the tab ` +
        `sequence of the ENTIRE page, not just this element. Use 0 (focusable ` +
        `in document order) or -1 (focusable only from script).`,
    );
  }
  // `aria-hidden` on something focusable removes it from the accessibility
  // tree while leaving it in the tab order: a keyboard user lands on an
  // element their screen reader will not describe.
  if (
    props["aria-hidden"] === true || props["aria-hidden"] === "true"
  ) {
    const focusable = tag === "button" || tag === "a" || tag === "input" ||
      tag === "select" || tag === "textarea" || tag === "summary" ||
      (props.tabIndex !== undefined && Number(props.tabIndex) >= 0);
    if (focusable) {
      _warnA11yOnce(
        `[aio-dev] <${tag}> is aria-hidden but still focusable — a keyboard ` +
          `user lands on an element a screen reader will not describe. Add ` +
          `tabIndex={-1} (or the \`inert\` attribute) as well.`,
      );
    }
  }
  // A control the author disabled through ARIA alone is still clickable and
  // still keyboard-operable: the attribute describes it, it does not disable
  // it. Real `disabled` (or a guard in the handler) is what stops the action.
  if (
    (props["aria-disabled"] === true || props["aria-disabled"] === "true") &&
    props.onClick && !props.disabled
  ) {
    _warnA11yOnce(
      `[aio-dev] <${tag}> is aria-disabled but its onClick still fires — ` +
        `aria-disabled DESCRIBES a control, it does not disable it. Add the ` +
        `\`disabled\` attribute, or return early in the handler.`,
    );
  }
}

/** Forget which messages were said — `setDevMode()` re-arms a session. */
export function _rearmA11y(): void {
  _warnedA11y.clear();
}
