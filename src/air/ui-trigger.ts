/**
 * @module
 * Faithful UI-event trigger — the single implementation both `testUI`
 * (in-process) and the live-client `__ui` protocol (`am ui`) use to simulate
 * a user. Dispatches real DOM event sequences (pointer → mouse → click,
 * per-character typing with input events, Enter-submits-the-form) so handlers,
 * delegation, `useLocal`, and controlled inputs behave exactly as with a
 * human — never calls handlers directly.
 */

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
  return el.ownerDocument?.defaultView ?? globalThis;
}

function ev(el: AnyEl, name: string, init: Record<string, unknown> = {}) {
  const w = view(el);
  return new w.Event(name, { bubbles: true, cancelable: true, ...init });
}

function mouseEv(el: AnyEl, name: string) {
  const w = view(el);
  return w.MouseEvent
    ? new w.MouseEvent(name, { bubbles: true, cancelable: true, button: 0 })
    : ev(el, name);
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
 *  `readonly` control also refuses. `name` is the caller's semantic name for the
 *  element (testUI has one; the remote tier addresses by path).
 */
export function assertOperable(
  el: AnyEl,
  verb: string,
  opts: { write?: boolean; name?: string; prefix?: string } = {},
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

/** Full user-faithful click sequence. */
export function triggerClick(el: AnyEl): void {
  assertOperable(el, "click");
  el.dispatchEvent(mouseEv(el, "pointerdown"));
  el.dispatchEvent(mouseEv(el, "mousedown"));
  el.dispatchEvent(mouseEv(el, "pointerup"));
  el.dispatchEvent(mouseEv(el, "mouseup"));
  if (typeof el.click === "function") el.click();
  else el.dispatchEvent(mouseEv(el, "click"));
}

/** Type one character like a user: keydown → value += ch → input → keyup.
 *  Callers loop characters (re-resolving controlled inputs between them). */
export function triggerChar(el: AnyEl, ch: string): void {
  assertOperable(el, "type into", { write: true });
  el.dispatchEvent(keyEv(el, "keydown", ch));
  el.value = String(el.value ?? "") + ch;
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
  el.dispatchEvent(ev(el, "input"));
  el.dispatchEvent(ev(el, "change"));
}

/** Clear an input's value like a user (select-all + delete): value = "", input. */
export function triggerClear(el: AnyEl): void {
  assertOperable(el, "clear", { write: true });
  el.focus?.();
  el.value = "";
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
      triggerClick(el);
      break;
    case "dblclick":
      triggerClick(el);
      el.dispatchEvent(mouseEv(el, "dblclick"));
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
      el.dispatchEvent(mouseEv(el, "mouseover"));
      el.dispatchEvent(mouseEv(el, "mouseenter"));
      break;
    case "focus":
      el.focus?.();
      break;
    case "blur":
      el.blur?.();
      el.dispatchEvent(ev(el, "blur", { bubbles: false }));
      break;
  }
}
