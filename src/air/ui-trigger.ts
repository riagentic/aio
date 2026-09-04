/**
 * @module
 * Faithful UI-event trigger — the single implementation both `testUI`
 * (in-process) and the live-client `__ui` protocol (`am ui`) use to simulate
 * a user. Dispatches real DOM event sequences (pointer → mouse → click,
 * per-character typing with input events, Enter-submits-the-form) so handlers,
 * delegation, `useLocal`, and controlled inputs behave exactly as with a
 * human — never calls handlers directly.
 */

import { count } from "../diagnostics/fmt.ts";

// deno-lint-ignore no-explicit-any
type AnyEl = any;

/** Actions the trigger can perform on a surface element. */
export type UITriggerAction =
  | "click"
  | "dblclick"
  | "type"
  | "press"
  | "keyDown"
  | "keyUp"
  | "hover"
  | "focus"
  | "blur";

function view(el: AnyEl): AnyEl {
  // `el` is usually an element; it is the DOCUMENT when a key is aimed at the
  // window (`onGlobalKey` has no element to own it). A document's
  // `ownerDocument` is null and its own `defaultView` is the window — without
  // that second hop the event would be constructed from `globalThis`, which is
  // the right object in a browser and the wrong one under a harness that
  // mounts its own window.
  return el.ownerDocument?.defaultView ?? el.defaultView ?? globalThis;
}

function ev(el: AnyEl, name: string, init: Record<string, unknown> = {}) {
  const w = view(el);
  return new w.Event(name, { bubbles: true, cancelable: true, ...init });
}

function mouseEv(
  el: AnyEl,
  name: string,
  mods?: KeyModifiers,
  extra?: Record<string, unknown>,
) {
  const w = view(el);
  const init = {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...mods,
    ...extra,
  };
  return w.MouseEvent ? new w.MouseEvent(name, init) : ev(el, name, init);
}

/** Why `el` is invisible to a user, or null when it is on screen.
 *
 *  Walks the ancestor chain, because a computed `display` is the element's OWN
 *  specified value: a `<button>` inside a `display:none` wrapper computes
 *  `inline-block` and looks perfectly clickable to a naive check (measured in
 *  happy-dom and true of real browsers too). An `[hidden]` attribute is read
 *  directly for the same reason — happy-dom does not apply the UA stylesheet
 *  rule that turns it into `display:none`. */
export function hiddenReason(el: AnyEl): string | null {
  if (String(el?.type ?? "").toLowerCase() === "hidden") {
    return `it is an <input type="hidden"> — it has no box and no keyboard focus`;
  }
  const w = view(el);
  const computed = (n: AnyEl): Record<string, string> | undefined => {
    try {
      return typeof w.getComputedStyle === "function"
        ? w.getComputedStyle(n)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const where = (n: AnyEl) =>
    n === el ? "" : ` (on the enclosing <${String(n.tagName).toLowerCase()}>)`;
  let node: AnyEl = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < 200; depth++) {
    if (node.hidden === true) {
      return `it has the \`hidden\` attribute${where(node)}`;
    }
    const cs = computed(node);
    const display = cs?.display ?? node.style?.display;
    if (display === "none") return `\`display: none\`${where(node)}`;
    const vis = cs?.visibility ?? node.style?.visibility;
    if (vis === "hidden" || vis === "collapse") {
      return `\`visibility: ${vis}\`${where(node)}`;
    }
    node = node.parentElement ?? node.parentNode;
  }
  return null;
}

/** What a real user physically cannot do — decided ONCE, here.
 *
 *  Both tiers go through this module, so the rule has to live in it: the
 *  in-process guard used to sit in `testUI` alone, which made `am trigger` the
 *  permissive tier (a click on a `disabled` button reported `ok: true` after
 *  firing a dead event) and contradicted this module's own promise that "a test
 *  and an `am` session behave identically". Typing was worse than permissive: a
 *  `readonly` input silently ACCEPTED characters in both tiers, so a test could
 *  prove a value a browser would never let a user enter — a harness more lenient
 *  than production, which CLAUDE.md forbids outright.
 *
 *  `write` covers the value-mutating actions (type / clear / select), which a
 *  `readonly` control also refuses. `text` narrows that to the KEYSTROKE
 *  actions, which need something that actually takes keystrokes. `name` is the
 *  caller's semantic name for the element (testUI has one; the remote tier
 *  addresses by path).
 */
export function assertOperable(
  el: AnyEl,
  verb: string,
  opts: {
    write?: boolean;
    text?: boolean;
    name?: string;
    prefix?: string;
  } = {},
): void {
  const tag = String(el?.tagName ?? "element").toLowerCase();
  const who = opts.name ? `"${opts.name}"` : `<${tag}>`;
  const p = opts.prefix ?? "";
  const how = opts.name ? `ui.….${opts.name}.` : "the element's .";
  if (el?.disabled === true) {
    throw new Error(
      `${p}cannot ${verb} ${who} — the ${tag} is disabled\n` +
        `  assert it instead: ${how}disabled === true (or enable it first)`,
    );
  }
  if (opts.write && el?.readOnly === true) {
    throw new Error(
      `${p}cannot ${verb} ${who} — the ${tag} is readonly\n` +
        `  a user cannot change it either; assert it instead: ${how}readonly === true`,
    );
  }
  // A user cannot reach what is not on screen. A browser delivers no click, no
  // keystroke and no focus to a `display:none` / `[hidden]` / `visibility:
  // hidden` element — the harness used to fire the whole sequence at it and
  // report success, which is a green test over a control the user never sees.
  const invisible = hiddenReason(el);
  if (invisible) {
    throw new Error(
      `${p}cannot ${verb} ${who} — the ${tag} is not visible: ${invisible}\n` +
        `  a browser delivers no event to it; show it first, or assert on the ` +
        `state that hides it`,
    );
  }
  // Keystrokes need something that HOLDS them. Typing into a <div> used to
  // write a `value` expando onto the node — a property no browser has, that
  // no handler reads, and that the surface then reported back as if a user had
  // entered it.
  if (opts.text && tag !== "input" && tag !== "textarea") {
    const editable = el?.isContentEditable === true ||
      el?.getAttribute?.("contenteditable") === "" ||
      el?.getAttribute?.("contenteditable") === "true";
    throw new Error(
      `${p}cannot ${verb} ${who} — a <${tag}> takes no keystrokes` +
        (editable
          ? `. It is contenteditable, which this harness does not drive: ` +
            `assert its text, or expose the editor's value through a control.`
          : `\n  only <input> / <textarea> do — target the control itself ` +
            `(a <select> takes ${how}select(value))`),
    );
  }
}

/** Keyboard modifier flags for {@linkcode triggerPress} — lets tests express
 *  Ctrl/Cmd/Alt/Shift chords (e.g. a Ctrl+Enter submit shortcut). */
export interface KeyModifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

function keyEv(el: AnyEl, name: string, key: string, mods?: KeyModifiers) {
  const w = view(el);
  const init = { bubbles: true, cancelable: true, key, ...mods };
  return w.KeyboardEvent ? new w.KeyboardEvent(name, init) : ev(el, name, init);
}

/** Full user-faithful click sequence, optionally with held modifiers
 *  (`{ ctrlKey, metaKey, altKey, shiftKey }`).
 *
 *  Modified clicks are a real interaction vocabulary — ctrl+click to add,
 *  shift+click to extend a range, alt+click to peel one off — and a harness
 *  that cannot express them forces every test of the app's PRIMARY gesture
 *  down to raw `new MouseEvent(…, { ctrlKey: true })` + `dispatchEvent`, which
 *  is exactly the selector-level DOM work the semantic surface exists to
 *  delete (a field report: "my single largest source of test friction").
 *
 *  With modifiers the final `click` is dispatched rather than delegated to
 *  `el.click()`: the native method carries no modifier state, so it would fire
 *  a plain click and silently test the wrong gesture.
 *
 *  The control's own state is left to the DOM's ACTIVATION BEHAVIOUR, which a
 *  dispatched click runs exactly as `el.click()` does. Flipping `el.checked`
 *  first (what this used to do) made a modified click a net no-op: the pre-flip
 *  set it, activation flipped it back, and `ui.cb.click({ ctrlKey: true })`
 *  left both the DOM and the app state exactly as they were — while a radio
 *  moved in the DOM and fired no input/change at all, because activation saw
 *  nothing left to change. Both measured. */
export function triggerClick(el: AnyEl, mods?: KeyModifiers): void {
  assertOperable(el, "click");
  el.dispatchEvent(mouseEv(el, "pointerdown", mods));
  el.dispatchEvent(mouseEv(el, "mousedown", mods));
  el.dispatchEvent(mouseEv(el, "pointerup", mods));
  el.dispatchEvent(mouseEv(el, "mouseup", mods));
  const held = mods &&
    (mods.ctrlKey || mods.metaKey || mods.altKey || mods.shiftKey);
  if (!held && typeof el.click === "function") {
    el.click();
    return;
  }
  const type = String(el.type ?? "").toLowerCase();
  const checkable = type === "checkbox" || type === "radio";
  const before = el.checked === true;
  // A DOM without activation behaviour for synthetic clicks would leave the
  // control untouched and silent; watch for the state events the spec requires
  // so the fallback below can tell "the DOM did it" from "nothing happened".
  let sawStateEvent = false;
  const note = () => {
    sawStateEvent = true;
  };
  if (checkable) {
    el.addEventListener?.("input", note);
    el.addEventListener?.("change", note);
  }
  const click = mouseEv(el, "click", mods);
  try {
    el.dispatchEvent(click);
  } finally {
    if (checkable) {
      el.removeEventListener?.("input", note);
      el.removeEventListener?.("change", note);
    }
  }
  if (!checkable || sawStateEvent || click.defaultPrevented) return;
  if (el.checked !== before) return; // the DOM ran activation behaviour
  el.checked = type === "radio" ? true : !before;
  markEdited(el);
  el.dispatchEvent(ev(el, "input"));
  fireChangeIfEdited(el);
}

/** Controls whose value a trigger has changed since their last `change`.
 *
 *  A browser fires `change` on a text control at BLUR (or Enter), not per
 *  keystroke — so an `onChange` handler was unreachable from either tier:
 *  `type("ab"); blur()` produced `input, input` and nothing else. Green test,
 *  dead handler in production. Tracked on the node, so a control whose DOM node
 *  is replaced mid-edit simply does not fire one (as before) rather than firing
 *  a change on the wrong element. */
const _edited = new WeakSet<object>();

/** Note that a trigger changed `el`'s value — a `change` is now owed. */
function markEdited(el: AnyEl): void {
  if (el && typeof el === "object") _edited.add(el as object);
}

/** Fire the owed `change` (once) — at blur, exactly like a browser. */
function fireChangeIfEdited(el: AnyEl): void {
  if (el && typeof el === "object" && _edited.delete(el as object)) {
    el.dispatchEvent(ev(el, "change"));
  }
}

/** Type one character like a user: keydown → value += ch → input → keyup.
 *  Callers loop characters (re-resolving controlled inputs between them).
 *
 *  `maxLength` is honoured: a browser DROPS the keystroke at the limit, so a
 *  harness that appended past it proved a value no user can enter (and the
 *  server-side validation it was meant to exercise never sees that string). */
export function triggerChar(el: AnyEl, ch: string): void {
  assertOperable(el, "type into", { write: true, text: true });
  const current = String(el.value ?? "");
  const max = typeof el.maxLength === "number" ? el.maxLength : -1;
  if (max >= 0 && current.length >= max) {
    throw new Error(
      `cannot type "${ch}" into <${
        String(el.tagName ?? "input").toLowerCase()
      }> — it already holds ${
        count(current.length, "character")
      } and maxLength is ` +
        `${max}\n  a browser drops the keystroke; type a shorter value, or ` +
        `raise maxLength`,
    );
  }
  el.dispatchEvent(keyEv(el, "keydown", ch));
  el.value = current + ch;
  markEdited(el);
  el.dispatchEvent(ev(el, "input"));
  el.dispatchEvent(keyEv(el, "keyup", ch));
}

/** Press a key, optionally with modifiers (Ctrl/Cmd/Alt/Shift). A bare Enter
 *  inside a form submits it (browser implicit submission); a modified Enter
 *  (e.g. Ctrl+Enter) does not — it's a shortcut the handler owns, matching
 *  real browsers. */
export function triggerPress(
  el: AnyEl,
  key: string,
  mods?: KeyModifiers,
): void {
  assertOperable(el, "press a key on");
  el.dispatchEvent(keyEv(el, "keydown", key, mods));
  el.dispatchEvent(keyEv(el, "keyup", key, mods));
  const modified = mods
    ? (mods.ctrlKey || mods.metaKey || mods.altKey || mods.shiftKey)
    : false;
  if (key === "Enter" && !modified && typeof el.closest === "function") {
    const form = el.closest("form");
    if (form) form.dispatchEvent(ev(el, "submit"));
  }
}

/** Hold a key DOWN (no keyup) — games, drag interactions, held modifiers,
 *  key-repeat. `triggerPress` is a tap, which cannot express "hold left for
 *  10 frames" (a field report); pair this with
 *  {@linkcode triggerKeyUp} around the frames/assertions in between. */
export function triggerKeyDown(
  el: AnyEl,
  key: string,
  mods?: KeyModifiers,
): void {
  assertOperable(el, "hold a key on");
  el.dispatchEvent(keyEv(el, "keydown", key, mods));
}

/** Release a key held by {@linkcode triggerKeyDown}. */
export function triggerKeyUp(
  el: AnyEl,
  key: string,
  mods?: KeyModifiers,
): void {
  assertOperable(el, "release a key on");
  el.dispatchEvent(keyEv(el, "keyup", key, mods));
}

/** Select an option on a <select> like a user (sets value, fires change+input).
 *
 *  A user can only pick an option that EXISTS and is enabled. Assigning an
 *  unknown value to a `<select>` silently resets it to `""` (DOM spec), so a
 *  typo'd or stale option value used to look like a successful selection and
 *  the change handler ran with the empty string — the failure surfaced later, as
 *  a wrong assertion somewhere else. Say it here instead. */
export function triggerSelect(el: AnyEl, value: string): void {
  assertOperable(el, "select on", { write: true });
  const tag = String(el?.tagName ?? "").toLowerCase();
  if (tag !== "select") {
    throw new Error(
      `select("${value}") on <${tag || "element"}> — only a <select> has ` +
        `options; use type()/setValue() for a text input`,
    );
  }
  const options: AnyEl[] = [...(el.options ?? [])];
  const match = options.find((o) => String(o.value) === value);
  if (!match) {
    throw new Error(
      `select("${value}") — no such option\n  available: ${
        options.map((o) => JSON.stringify(String(o.value))).join(", ") ||
        "(none)"
      }`,
    );
  }
  if (match.disabled === true) {
    throw new Error(
      `select("${value}") — that option is disabled; a user cannot pick it`,
    );
  }
  el.focus?.();
  el.value = value;
  markEdited(el);
  el.dispatchEvent(ev(el, "input"));
  fireChangeIfEdited(el); // a <select> commits immediately, like a browser
}

/** Tick / untick a box like a user — THE one implementation of "check",
 *  shared by `testUI`'s `check()`/`uncheck()` and the live tier's
 *  `am trigger … check`.
 *
 *  It exists because those two had a guard each. testUI refused an element with
 *  no checked state; the live tier compared `el.checked !== want`, and
 *  `el.checked` is `undefined` on a `<button>` — so `undefined !== true` fired
 *  a REAL click on `<button t="danger">Delete everything</button>` and answered
 *  `{"ok":true}`. An agent driving a live app could destroy data through a word
 *  that promises to tick a box. Measured, and the docs claimed one
 *  implementation served both tiers all along.
 *
 *  Already-in-that-state is a no-op, exactly as clicking a checked box to
 *  "check" it would be pointless — never a click, so no handler runs. */
export function triggerSetChecked(
  el: AnyEl,
  want: boolean,
  opts: { name?: string; prefix?: string } = {},
): void {
  const verb = want ? "check" : "uncheck";
  const tag = String(el?.tagName ?? "element").toLowerCase();
  const who = opts.name ? `"${opts.name}"` : `<${tag}>`;
  if (typeof el?.checked !== "boolean") {
    throw new Error(
      `${opts.prefix ?? ""}cannot ${verb} ${who} — the ${tag} has no checked ` +
        `state (only a checkbox/radio does)
` +
        `  use .click() for a plain control`,
    );
  }
  assertOperable(el, verb, { name: opts.name, prefix: opts.prefix });
  if (el.checked === want) return;
  triggerClick(el);
}

/** Clear an input's value like a user (select-all + delete): value = "", input. */
export function triggerClear(el: AnyEl): void {
  assertOperable(el, "clear", { write: true, text: true });
  el.focus?.();
  el.value = "";
  markEdited(el);
  el.dispatchEvent(ev(el, "input"));
}

/** Scroll an element like a user: set scrollTop/scrollLeft, fire `scroll`
 *  (scroll does not bubble from elements, matching browsers). */
export function triggerScroll(
  el: AnyEl,
  to: { top?: number; left?: number } = {},
): void {
  if (to.top !== undefined) el.scrollTop = to.top;
  if (to.left !== undefined) el.scrollLeft = to.left;
  el.dispatchEvent(ev(el, "scroll", { bubbles: false }));
}

/** Minimal DataTransfer for DOMs without a constructable one (happy-dom). */
function makeDataTransfer(w: AnyEl): AnyEl {
  if (w.DataTransfer) {
    try {
      return new w.DataTransfer();
    } catch { /* exposed but not constructable — fall through to the shim */ }
  }
  const data = new Map<string, string>();
  return {
    dropEffect: "move",
    effectAllowed: "all",
    get types() {
      return [...data.keys()];
    },
    setData: (t: string, v: string) => void data.set(t, v),
    getData: (t: string) => data.get(t) ?? "",
    clearData: () => void data.clear(),
    files: [],
    items: [],
    setDragImage: () => {},
  };
}

function dragEv(el: AnyEl, name: string, dataTransfer: AnyEl) {
  const w = view(el);
  const e = w.DragEvent
    ? new w.DragEvent(name, { bubbles: true, cancelable: true })
    : mouseEv(el, name);
  if (!e.dataTransfer) {
    try {
      Object.defineProperty(e, "dataTransfer", { value: dataTransfer });
    } catch { /* readonly on some DOMs — handlers get a bare event */ }
  }
  return e;
}

/** Full user-faithful HTML5 drag-and-drop: dragstart on the source,
 *  dragenter → dragover → drop on the target, dragend on the source — one
 *  shared DataTransfer across the whole sequence, exactly like a browser. */
export function triggerDragTo(source: AnyEl, target: AnyEl): void {
  // The one gesture that used to skip the guard entirely, in BOTH tiers: a
  // disabled or invisible source could be "dragged" onto an invisible target
  // and both tiers reported success.
  assertOperable(source, "drag");
  assertOperable(target, "drop onto");
  const dt = makeDataTransfer(view(source));
  source.dispatchEvent(dragEv(source, "dragstart", dt));
  target.dispatchEvent(dragEv(target, "dragenter", dt));
  target.dispatchEvent(dragEv(target, "dragover", dt));
  target.dispatchEvent(dragEv(target, "drop", dt));
  source.dispatchEvent(dragEv(source, "dragend", dt));
}

/** Perform a non-typing action (typing is looped by callers via
 *  {@linkcode triggerChar} for per-character fidelity). */
export function triggerAction(
  el: AnyEl,
  action: Exclude<UITriggerAction, "type">,
  key?: string,
  mods?: KeyModifiers,
): void {
  switch (action) {
    case "click":
      triggerClick(el, mods);
      break;
    case "dblclick":
      triggerClick(el, mods);
      el.dispatchEvent(mouseEv(el, "dblclick", mods));
      break;
    case "press":
      triggerPress(el, key ?? "Enter", mods);
      break;
    case "keyDown":
      triggerKeyDown(el, key ?? "Enter", mods);
      break;
    case "keyUp":
      triggerKeyUp(el, key ?? "Enter", mods);
      break;
    case "hover":
      el.dispatchEvent(mouseEv(el, "mouseover", mods));
      // `mouseenter` does NOT bubble in a browser — dispatching it with
      // bubbles:true ran every ancestor's onMouseEnter as well, so a hover on
      // one row fired the whole list's handlers and a test could not tell.
      el.dispatchEvent(mouseEv(el, "mouseenter", mods, { bubbles: false }));
      break;
    case "focus":
      el.focus?.();
      break;
    case "blur": {
      // A browser commits a changed value at blur — `change` first, then
      // `blur`. Without this the onChange path was unreachable from either
      // tier (`type("ab"); blur()` fired input, input and nothing else).
      fireChangeIfEdited(el);
      // `el.blur()` on a FOCUSED element already fires the event; dispatching
      // one unconditionally on top of it delivered TWO blurs to the handler
      // (measured) while an unfocused element got exactly one. A browser fires
      // one, so: dispatch only when the native call fired nothing.
      let fired = false;
      const note = () => {
        fired = true;
      };
      el.addEventListener?.("blur", note);
      try {
        el.blur?.();
      } finally {
        el.removeEventListener?.("blur", note);
      }
      if (!fired) el.dispatchEvent(ev(el, "blur", { bubbles: false }));
      break;
    }
  }
}
