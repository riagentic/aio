/**
 * @module
 * Faithful UI-event trigger — the single implementation both `testUI`
 * (in-process) and the live-client `__ui` protocol (`am ui`) use to simulate
 * a user. Dispatches real DOM event sequences (pointer → mouse → click,
 * per-character typing with input events, HTML implicit submission, focus
 * moving on click) so handlers,
 * delegation, `useLocal`, and controlled inputs behave exactly as with a
 * human — never calls handlers directly.
 */

import { count } from "../diagnostics/fmt.ts";
import { isDevMode } from "../state/dev-flag.ts";
import { _globalKeyProbe } from "./renderer-lifecycle.ts";

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

/** A pointer event where the DOM has the class (Chromium, happy-dom), a mouse
 *  event otherwise. A browser sends `pointer*` before every `mouse*` — a
 *  tooltip on `onPointerEnter` never showed under the harness (measured). */
function ptrEv(
  el: AnyEl,
  name: string,
  mods?: KeyModifiers,
  extra?: Record<string, unknown>,
) {
  const w = view(el);
  if (!w.PointerEvent) return mouseEv(el, name, mods, extra);
  return new w.PointerEvent(name, {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    ...mods,
    ...extra,
  });
}

/** `beforeinput` / `input` as the browser builds them: an `InputEvent` with
 *  `inputType` and `data`. A bare `Event` left `e.inputType` / `e.data`
 *  undefined, so a handler reading them failed only under the harness.
 *  `input` is not cancelable in a browser; `beforeinput` is. */
function inputEv(
  el: AnyEl,
  name: "beforeinput" | "input",
  inputType: string,
  data: string | null,
) {
  const w = view(el);
  const init = {
    bubbles: true,
    cancelable: name === "beforeinput",
    composed: true,
    inputType,
    data,
  };
  const e = w.InputEvent ? new w.InputEvent(name, init) : ev(el, name, init);
  // happy-dom turns a null `data` into "" — a browser keeps null for a line
  // break or a deletion, and `e.data ?? …` must read the same in both.
  if (data === null && e.data !== null) {
    Object.defineProperty(e, "data", { value: null, configurable: true });
  }
  return e;
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

// US-layout `code` / legacy `keyCode` for a `key` — what Chromium reports.
// Without them `e.code === "Enter"` and `e.keyCode === 13` were dead under the
// harness while working in every browser (measured).
const _ROW = "`1234567890-=[]\\;',./";
const _SHIFT_ROW = '~!@#$%^&*()_+{}|:"<>?';
const _ROW_CODES = ("Backquote 1 2 3 4 5 6 7 8 9 0 Minus Equal BracketLeft " +
  "BracketRight Backslash Semicolon Quote Comma Period Slash").split(" ");
const _ROW_KC = [192, 49, 50, 51, 52, 53, 54, 55, 56, 57, 48, 189, 187, 219];
_ROW_KC.push(221, 220, 186, 222, 188, 190, 191);
const _NAMED_KEYS: Record<string, [string, number]> = {
  Enter: ["Enter", 13],
  Escape: ["Escape", 27],
  Tab: ["Tab", 9],
  Backspace: ["Backspace", 8],
  Delete: ["Delete", 46],
  " ": ["Space", 32],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowUp: ["ArrowUp", 38],
  ArrowRight: ["ArrowRight", 39],
  ArrowDown: ["ArrowDown", 40],
  Home: ["Home", 36],
  End: ["End", 35],
  PageUp: ["PageUp", 33],
  PageDown: ["PageDown", 34],
  Shift: ["ShiftLeft", 16],
  Control: ["ControlLeft", 17],
  Alt: ["AltLeft", 18],
  Meta: ["MetaLeft", 91],
};

/** `{ code, keyCode }` for a `key` value (unknown keys: `""` / 0). */
function keyCodes(key: string): { code: string; keyCode: number } {
  const named = _NAMED_KEYS[key];
  if (named) return { code: named[0], keyCode: named[1] };
  if (/^F([1-9]|1[0-2])$/.test(key)) {
    return { code: key, keyCode: 111 + Number(key.slice(1)) };
  }
  if (/^[a-z]$/i.test(key)) {
    const u = key.toUpperCase();
    return { code: "Key" + u, keyCode: u.charCodeAt(0) };
  }
  let i = key.length === 1 ? _ROW.indexOf(key) : -1;
  if (i < 0 && key.length === 1) i = _SHIFT_ROW.indexOf(key);
  const c = _ROW_CODES[i];
  return c
    ? { code: /\d/.test(c) ? "Digit" + c : c, keyCode: _ROW_KC[i]! }
    : { code: "", keyCode: 0 };
}

/** A keyboard event with `code` / `keyCode` / `which` (and, for `keypress`,
 *  `charCode`) filled in. The legacy numbers are pinned on the instance when
 *  the DOM's constructor ignores them (happy-dom drops `which`/`charCode`). */
function keyEv(
  el: AnyEl,
  name: string,
  key: string,
  mods?: KeyModifiers,
  charCode = 0,
) {
  const w = view(el);
  const { code, keyCode } = keyCodes(key);
  const kc = name === "keypress" ? charCode : keyCode;
  const legacy: Record<string, number> = {
    keyCode: kc,
    which: kc,
    charCode: name === "keypress" ? charCode : 0,
  };
  const init = {
    bubbles: true,
    cancelable: true,
    key,
    code,
    ...legacy,
    ...mods,
  };
  const e = w.KeyboardEvent
    ? new w.KeyboardEvent(name, init)
    : ev(el, name, init);
  for (const k in legacy) {
    if (e[k] !== legacy[k]) {
      try {
        Object.defineProperty(e, k, { value: legacy[k], configurable: true });
      } catch {
        // aio-ok: a DOM whose event pins these fields keeps its own values —
        // the init above already asked for the same numbers.
      }
    }
  }
  return e;
}

/** The char code a `keypress` carries, or 0 when the key sends none (a browser
 *  fires `keypress` only for keys that produce a character — and for Enter). */
function pressCode(key: string, mods?: KeyModifiers): number {
  if (mods?.ctrlKey || mods?.metaKey || mods?.altKey) return 0;
  if (key === "Enter") return 13;
  return key.length === 1 ? key.charCodeAt(0) : 0;
}

/** Controls a mouse press can focus — a click on anything else blurs. */
const _FOCUSABLE = "a[href],area[href],button,input,select,textarea," +
  'summary,iframe,[tabindex],[contenteditable]:not([contenteditable="false"])';

/** The focused element, looking through open shadow roots. */
function activeOf(doc: AnyEl): AnyEl {
  let a = doc?.activeElement ?? null;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

/** What a browser does between `mousedown` and `mouseup`: focus moves to the
 *  pressed control (or away, onto nothing), and the field being edited commits
 *  its `change` first. The harness used to leave focus where it was, so a
 *  click on "Save" after typing ran no `onChange`/`onBlur` and left
 *  `activeElement` on the input (measured against Chromium). */
function moveFocus(el: AnyEl): void {
  const doc = el.ownerDocument;
  if (!doc || typeof el.closest !== "function") return;
  const prev = activeOf(doc);
  const target = el.closest(_FOCUSABLE);
  if (target === prev) return;
  const leaving = prev && prev !== doc.body && prev !== doc.documentElement;
  if (leaving) fireChangeIfEdited(prev);
  if (target) target.focus?.();
  else if (leaving) prev.blur?.();
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
export function triggerClick(
  el: AnyEl,
  mods?: KeyModifiers,
  detail = 1,
): void {
  assertOperable(el, "click");
  trackModals(view(el));
  const d = { detail };
  el.dispatchEvent(ptrEv(el, "pointerdown", mods, d));
  const down = mouseEv(el, "mousedown", mods, d);
  el.dispatchEvent(down);
  // A browser moves focus as the DEFAULT action of mousedown — a handler that
  // prevents it (a toolbar button keeping the editor focused) keeps it put.
  if (!down.defaultPrevented) moveFocus(el);
  el.dispatchEvent(ptrEv(el, "pointerup", mods, d));
  el.dispatchEvent(mouseEv(el, "mouseup", mods, d));
  const held = mods &&
    (mods.ctrlKey || mods.metaKey || mods.altKey || mods.shiftKey);
  // `el.click()` carries no `detail`: the second click of a double-click is
  // dispatched, like a modified one.
  if (!held && detail === 1 && typeof el.click === "function") {
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
  const click = mouseEv(el, "click", mods, d);
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

/** Note that a trigger changed `el`'s value — a `change` is now owed, and the
 *  value is now one the USER edited (which `minlength`/`maxlength` depend on,
 *  see {@link _userEdited}). */
function markEdited(el: AnyEl): void {
  if (el && typeof el === "object") {
    _edited.add(el as object);
    _userEdited.add(el as object);
  }
}

/** Fire the owed `change` (once) — at blur, exactly like a browser. */
function fireChangeIfEdited(el: AnyEl): void {
  if (el && typeof el === "object" && _edited.delete(el as object)) {
    el.dispatchEvent(ev(el, "change"));
  }
}

/** What the harness itself last wrote into a control, and what the control
 *  showed right after. A browser keeps the typed text in its own editing
 *  buffer, which is NOT `el.value`: a number field holding "1e" reports `""`,
 *  so re-reading `.value` before each keystroke typed "1e5" as "5" (Chromium
 *  sanitizes) — while happy-dom does not sanitize at all and typed "1a2".
 *  Three tiers, three values (measured). The buffer is used only while the
 *  control still shows what the harness left there; anything else (the app
 *  rewrote the value, the user cleared it) wins. */
const _typed = new WeakMap<object, { buf: string; seen: string }>();

function baseValue(el: AnyEl): string {
  const cur = String(el.value ?? "");
  const t = _typed.get(el);
  return t && t.seen === cur ? t.buf : cur;
}

function writeTyped(el: AnyEl, next: string): void {
  el.value = next;
  _typed.set(el, { buf: next, seen: String(el.value ?? "") });
}

function inputTypeOf(el: AnyEl): string {
  return String(el?.tagName ?? "").toLowerCase() === "input"
    ? String(el.type ?? "text").toLowerCase()
    : "";
}

/** `<input>` types whose value is not a character stream: a browser gives
 *  them segments, pickers, sliders or a click — never "append this char".
 *  Typing "2024-01-05" into a date field produced `""` in both harness tiers
 *  and a garbled year in Chromium (measured). */
const _EXAMPLE: Record<string, string> = {
  date: "2024-01-05",
  time: "13:45",
  month: "2024-01",
  week: "2024-W01",
  "datetime-local": "2024-01-05T13:45",
  color: "#ff8800",
  range: "50",
};
const _WHOLE_VALUE = new Set(Object.keys(_EXAMPLE));
const _BUTTON_TYPES = "submit button reset image";
const _NO_KEYSTROKES = new Set([
  ..._WHOLE_VALUE,
  ...`file checkbox radio ${_BUTTON_TYPES}`.split(" "),
]);

/** Can `type()` put characters into `el`? False for the whole-value and the
 *  click-only `<input>` types. */
export function takesCharacters(el: AnyEl): boolean {
  return !_NO_KEYSTROKES.has(inputTypeOf(el));
}

/** Characters a browser lets into an `<input type="number">`. */
const _NUMBER_CHAR = /^[0-9+\-.eE]$/;

/** `beforeinput` → value → `input`, the way an edit reaches a control. A
 *  cancelled `beforeinput` edits nothing. */
function insertText(
  el: AnyEl,
  next: string,
  inputType: string,
  data: string | null,
): void {
  if (!el.dispatchEvent(inputEv(el, "beforeinput", inputType, data))) return;
  writeTyped(el, next);
  markEdited(el);
  el.dispatchEvent(inputEv(el, "input", inputType, data));
}

/** Type one character like a user: keydown → keypress → beforeinput → value
 *  += ch → input → keyup. Callers loop characters (re-resolving controlled
 *  inputs between them).
 *
 *  `maxLength` is honoured: a browser DROPS the keystroke at the limit, so a
 *  harness that appended past it proved a value no user can enter (and the
 *  server-side validation it was meant to exercise never sees that string).
 *  A `number` field drops what is not part of a number, as a browser does. */
export function triggerChar(el: AnyEl, ch: string): void {
  assertOperable(el, "type into", { write: true, text: true });
  const type = inputTypeOf(el);
  if (_NO_KEYSTROKES.has(type)) {
    throw new Error(
      `cannot type into <input type="${type}"> — a browser has no character ` +
        `stream there\n  ` +
        (_WHOLE_VALUE.has(type)
          ? `set the whole value at once: .setValue(${
            JSON.stringify(_EXAMPLE[type])
          }) (am trigger … setValue)`
          : `use .click() / .check() / .uncheck()`),
    );
  }
  trackModals(view(el));
  const current = baseValue(el);
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
  const down = keyEv(el, "keydown", ch);
  if (el.dispatchEvent(down)) {
    const code = pressCode(ch);
    const pressed = code === 0 ||
      el.dispatchEvent(keyEv(el, "keypress", ch, undefined, code));
    if (pressed && (type !== "number" || _NUMBER_CHAR.test(ch))) {
      insertText(el, current + ch, "insertText", ch);
    }
  }
  el.dispatchEvent(keyEv(el, "keyup", ch));
}

/** Set a whole-value control (`date`, `time`, `color`, `range`, …) the way
 *  its picker does: one assignment, `input`, then `change`. A value the
 *  control refuses is an error, not a silent `""`. */
export function triggerAssign(el: AnyEl, text: string): void {
  assertOperable(el, "set the value of", { write: true, text: true });
  const type = inputTypeOf(el);
  if (!_WHOLE_VALUE.has(type)) {
    throw new Error(
      `cannot set the value of <input type="${type || "text"}"> in one step ` +
        `— only a picker-style input takes a whole value; type() it instead`,
    );
  }
  el.focus?.();
  el.value = text;
  if (String(el.value ?? "") !== text) {
    throw new Error(
      `cannot set <input type="${type}"> to ${JSON.stringify(text)} — the ` +
        `control refuses it (value is ${JSON.stringify(String(el.value))})\n` +
        `  use the stored format, e.g. ${JSON.stringify(_EXAMPLE[type])}`,
    );
  }
  _typed.delete(el);
  markEdited(el);
  el.dispatchEvent(inputEv(el, "input", "insertReplacementText", null));
  fireChangeIfEdited(el); // a picker commits at once
}

const _TEXTISH = new Set(" text search url tel email password".split(" "));

/** `<input>` types that block implicit submission when a form has more than
 *  one of them and no submit button (HTML § implicit submission). */
const _BLOCKING = new Set([
  ..._TEXTISH,
  ..."number date month week time datetime-local".split(" "),
]);

function tagOf(el: AnyEl): string {
  return String(el?.tagName ?? "").toLowerCase();
}

/** Controls a key activates (a click): Enter clicks buttons, links and
 *  `<summary>`; Space (on keyup) clicks buttons, `<summary>` and checkables. */
function keyClicks(el: AnyEl, space: boolean): boolean {
  const tag = tagOf(el);
  if (tag === "button" || tag === "summary") return true;
  if (tag === "a") return !space && el.hasAttribute?.("href") === true;
  return tag === "input" &&
    (space ? _SPACE_CLICKS : _ENTER_CLICKS).includes(inputTypeOf(el));
}
const _ENTER_CLICKS = _BUTTON_TYPES.split(" ");
const _SPACE_CLICKS = [..._ENTER_CLICKS, "checkbox", "radio"];

/** Is this a form's SUBMIT control? HTML's own rule, written ONCE.
 *
 *  Two tiers ask it and they must never disagree: the trigger asks it to find
 *  the button implicit submission clicks, and the semantic surface
 *  (`ui-surface.ts`) asks it to report that clicking this button drives the
 *  FORM's `submit` handler. The surface used to answer that question with the
 *  button's own `on*` props alone, so `<button>Add</button>` inside a
 *  `<form onSubmit>` came back as `events: []` — an agent choosing a target
 *  from the surface read the one button that works as inert (measured on
 *  `examples/todo`: `am trigger "App:AddButton" click` added the todo while
 *  its surface entry listed nothing).
 *
 *  `tag` / `type` exactly as HTML sees them: a `<button>` with no `type` IS a
 *  submit button (that is the default that surprises everyone), an `<input>`
 *  with no `type` is a text field and is not. Pure. */
export function isSubmitControl(tag: string, type?: string): boolean {
  const t = tag.toLowerCase();
  const ty = type?.toLowerCase();
  if (t === "button") return (ty ?? "submit") === "submit";
  return t === "input" && (ty === "submit" || ty === "image");
}

function isSubmitButton(el: AnyEl): boolean {
  return isSubmitControl(
    tagOf(el),
    el?.type == null ? undefined : String(el.type),
  );
}

/** How a field names itself in a refusal — `name`, else `id`, else the
 *  accessible label, else just the tag. */
function fieldLabel(el: AnyEl): string {
  const tag = tagOf(el);
  const type = tag === "input" ? ` type="${inputTypeOf(el)}"` : "";
  for (const a of ["name", "id", "aria-label"]) {
    const v = el.getAttribute?.(a);
    if (v) return `<${tag}${type} ${a}="${v}">`;
  }
  return `<${tag}${type}>`;
}

/** A number the wording can show: 1.5000000000000002 helps nobody. */
function tidy(n: number): string {
  return String(Number(n.toPrecision(12)));
}

/** The two nearest values a stepped control would accept. */
function stepText(el: AnyEl): string {
  const type = inputTypeOf(el);
  if (type !== "number" && type !== "range") {
    return "Please enter a valid value.";
  }
  const step = Number(el.step) > 0 ? Number(el.step) : 1;
  const base = stepBase(el);
  const val = Number(el.value);
  if (!Number.isFinite(val) || !Number.isFinite(base)) {
    return "Please enter a valid value.";
  }
  const lo = base + Math.floor((val - base) / step) * step;
  return `Please enter a valid value. The two nearest valid values are ` +
    `${tidy(lo)} and ${tidy(lo + step)}.`;
}

/** A control's constraint-validation message, in the browser's own words.
 *
 *  The DOM the harness mounts implements `validity` but leaves
 *  `validationMessage` empty (happy-dom), so a refusal could name the field and
 *  then say nothing about WHY — the one sentence the reader needs. A real DOM's
 *  message always wins (a browser, `am trigger` on a live app); these
 *  stand-ins mirror Chromium's wording for the cases it does not fill in. */
function validationText(el: AnyEl, flags: readonly string[]): string {
  const native = typeof el.validationMessage === "string"
    ? el.validationMessage
    : "";
  if (native) return native;
  // Only a flag a BROWSER would raise ({@link browserFlags}) may name the
  // reason — the harness DOM's own `validity` holds ones Chromium does not set.
  const v: Record<string, boolean> = {};
  for (const f of flags) v[f] = true;
  const type = inputTypeOf(el);
  if (v.valueMissing) return "Please fill out this field.";
  if (v.typeMismatch) {
    return type === "email"
      ? "Please include an '@' in the email address."
      : type === "url"
      ? "Please enter a URL."
      : "Please enter a valid value.";
  }
  if (v.patternMismatch) return "Please match the requested format.";
  if (v.tooLong) {
    return `Please shorten this text to ${el.maxLength} characters or less.`;
  }
  if (v.tooShort) {
    return `Please lengthen this text to ${el.minLength} characters or more.`;
  }
  if (v.rangeUnderflow) {
    return `Value must be greater than or equal to ${el.min}.`;
  }
  if (v.rangeOverflow) return `Value must be less than or equal to ${el.max}.`;
  if (v.stepMismatch) return stepText(el);
  if (v.badInput) return "Please enter a number.";
  return "The value is invalid.";
}

/** Is `el` BARRED from constraint validation? A barred control is always
 *  valid, whatever its `required`/`pattern` says.
 *
 *  `willValidate` answers this in a browser, and the DOM the harness mounts
 *  (happy-dom) answers it for `disabled`/`readonly`/`type=hidden` — but NOT for
 *  the one that is inherited rather than written on the control: a descendant
 *  of a `<fieldset disabled>` (outside that fieldset's first `<legend>`) is
 *  disabled too, and is therefore barred. Without this the harness refuses a
 *  form Chromium submits, which is the same defect as submitting one it
 *  refuses — pointed the other way, at every suite that already drives that
 *  form. */
function barredFromValidation(el: AnyEl): boolean {
  if (el?.willValidate === false) return true;
  if (el?.disabled === true || el?.readOnly === true) return true;
  if (tagOf(el) === "input" && inputTypeOf(el) === "hidden") return true;
  let fs = el?.parentElement?.closest?.("fieldset[disabled]");
  while (fs) {
    // The first <legend> of a disabled fieldset is NOT disabled.
    const legend = fs.querySelector?.("legend");
    if (!legend || !legend.contains?.(el)) return true;
    fs = fs.parentElement?.closest?.("fieldset[disabled]");
  }
  return false;
}

/** Every `validity` flag a browser can raise, in the order a message picks
 *  them. `valid` is not one of them, and `customError` is never second-guessed
 *  — `setCustomValidity` is the app's own word. */
const _VALIDITY_FLAGS = [
  "customError",
  "valueMissing",
  "typeMismatch",
  "patternMismatch",
  "tooLong",
  "tooShort",
  "rangeUnderflow",
  "rangeOverflow",
  "stepMismatch",
  "badInput",
] as const;

/** Is `el`'s value ON its step ladder, by the browser's own arithmetic?
 *
 *  The step BASE is `min` when there is one (else the `value` attribute, else
 *  0) — `min="0.5"` with the default `step` of 1 accepts 0.5, 1.5, 2.5…, which
 *  the harness DOM gets wrong by always measuring from 0. Scaled to integers by
 *  the decimal places in play, so 4.5 − 0.5 = 4.000000000000001 does not decide
 *  a test. Returns null when the question does not apply (no value, `step` is
 *  "any", a non-numeric control) and the DOM's own answer stands. */
function onStepLadder(el: AnyEl): boolean | null {
  const type = inputTypeOf(el);
  if (type !== "number" && type !== "range") return null;
  if (String(el.step ?? "").toLowerCase() === "any") return true;
  const val = Number(el.value);
  if (String(el.value ?? "") === "" || !Number.isFinite(val)) return null;
  const step = Number(el.step) > 0 ? Number(el.step) : 1;
  const base = Number(stepBase(el));
  if (!Number.isFinite(step) || !Number.isFinite(base)) return null;
  const scale = 10 ** Math.max(decimals(val), decimals(step), decimals(base));
  const off = Math.round(val * scale) - Math.round(base * scale);
  return off % Math.round(step * scale) === 0;
}

/** The step base: `min`, else the `value` ATTRIBUTE, else 0 (HTML § step). */
function stepBase(el: AnyEl): number {
  for (const a of ["min", "value"]) {
    const raw = el.getAttribute?.(a);
    if (raw != null && raw !== "" && Number.isFinite(Number(raw))) {
      return Number(raw);
    }
  }
  return 0;
}

function decimals(n: number): number {
  const s = String(n);
  const dot = s.indexOf(".");
  return dot < 0 || s.includes("e") ? 0 : s.length - dot - 1;
}

/** Controls a trigger has edited AS A USER — never cleared, unlike the
 *  change-owed set. `minlength`/`maxlength` ("too short"/"too long") apply only
 *  to a value the USER edited: a browser lets a form submit a programmatic
 *  (controlled, server-pushed, `value=` in the markup) value that is shorter
 *  than `minlength`, and the harness DOM does not model that flag at all. */
const _userEdited = new WeakSet<object>();

/** The `validity` flags a BROWSER would raise for `el` — the DOM's own answer,
 *  minus the two the harness DOM computes by a rule Chromium does not use. */
function browserFlags(el: AnyEl): string[] {
  const v = el.validity ?? {};
  const dirty = typeof el === "object" && el !== null &&
    _userEdited.has(el as object);
  const step = onStepLadder(el);
  return _VALIDITY_FLAGS.filter((f) => {
    if (v[f] !== true) return false;
    if ((f === "tooShort" || f === "tooLong") && !dirty) return false;
    if (f === "stepMismatch" && step === true) return false;
    return true;
  });
}

/** The first control of `form` the browser's constraint validation rejects, or
 *  null when the form submits (including a `novalidate` form, which never
 *  validates). */
function firstInvalid(form: AnyEl): AnyEl | null {
  if (form.noValidate === true || form.hasAttribute?.("novalidate")) {
    return null;
  }
  const els: AnyEl[] = [
    ...(form.elements ?? form.querySelectorAll("button,input,select,textarea")),
  ];
  for (const el of els) {
    if (barredFromValidation(el)) continue;
    if (typeof el?.checkValidity !== "function") continue;
    if (el.checkValidity() === false && browserFlags(el).length > 0) return el;
  }
  return null;
}

/** Constraint validation, out loud (a field report).
 *
 *  A browser refuses to submit a form holding an invalid control and shows a
 *  bubble over the field. The harness cannot show a bubble, and the refusal it
 *  DID make was a bare `return` — the submit simply never happened and the
 *  reader was left to bisect a passing-looking sequence to find out why. Worse,
 *  the DOM's own refusal on a submit BUTTON is equally silent. So the one place
 *  the harness decides — implicit submission — says exactly what a browser
 *  would have shown: the field, its value, and its `validationMessage`.
 *
 *  Refusing is not optional: a harness that submits "1.5" into a
 *  `<input type="number">` (step defaults to 1) where the browser refuses is
 *  MORE PERMISSIVE than production, which is how a green test ships a dead
 *  form. */
function refuseInvalid(form: AnyEl, how: string): void {
  const bad = firstInvalid(form);
  if (!bad) return;
  throw new Error(
    `${how} did not submit the form — the browser's constraint validation ` +
      `refuses it:\n  ${fieldLabel(bad)} value ${
        JSON.stringify(String(bad.value ?? ""))
      } is invalid: ${validationText(bad, browserFlags(bad))}\n` +
      `  A browser shows that message over the field and submits nothing, so ` +
      `the form's onSubmit never runs.\n` +
      `  Give the field a value the constraint accepts, relax the constraint ` +
      `(step="any", min/max, pattern, required), or set novalidate on the ` +
      `<form> if the app validates by itself.`,
  );
}

/** HTML implicit submission. The DEFAULT button (the form's first submit
 *  button) is CLICKED — its `onClick` runs and the submit event names it as
 *  `submitter`; a disabled one means nothing happens; with no button the form
 *  submits only when at most one field blocks it. The harness used to fire a
 *  bare `submit` in every case (six divergences from Chromium, measured).
 *
 *  Constraint validation runs either way, and refuses LOUDLY — see
 *  {@link refuseInvalid}. The default button is clicked FIRST: a browser runs
 *  the button's activation behaviour (its `onClick`) and only then blocks the
 *  submission, and a handler that calls `preventDefault()` cancels the
 *  submission itself, which is not a validation refusal to report. */
function implicitSubmit(form: AnyEl, how: string): void {
  if (!form) return;
  const els: AnyEl[] = [
    ...(form.elements ?? form.querySelectorAll("button,input")),
  ];
  const btn = els.find(isSubmitButton);
  if (btn) {
    if (btn.disabled === true) return;
    // The click event OBJECT, read after the dispatch has finished — not
    // `defaultPrevented` as this listener sees it. AIR DELEGATES `click` to the
    // mount root, so the app's own handler runs after every listener on the
    // button: a `preventDefault()` there was invisible from here, and the
    // cancelled submission was reported as a validation refusal.
    let click: AnyEl | null = null;
    let submitted = false;
    const note = (e: AnyEl) => {
      click = e;
    };
    const sawSubmit = () => {
      submitted = true;
    };
    btn.addEventListener?.("click", note);
    form.addEventListener?.("submit", sawSubmit);
    try {
      btn.click();
    } finally {
      btn.removeEventListener?.("click", note);
      form.removeEventListener?.("submit", sawSubmit);
    }
    if ((click as AnyEl | null)?.defaultPrevented === true) return;
    if (btn.formNoValidate !== true) refuseInvalid(form, how);
    // The DOM's own activation behaviour usually fires the submit. When it
    // declined although the browser would not have — the harness DOM bars
    // fewer controls from constraint validation than Chromium does, so a
    // `<fieldset disabled>` swallowed the submission — the harness supplies
    // the event the browser would have sent, naming the button as submitter.
    if (!submitted) dispatchSubmit(form, btn);
    return;
  }
  const blocking =
    els.filter((e) => tagOf(e) === "input" && _BLOCKING.has(inputTypeOf(e)))
      .length;
  if (blocking > 1) return;
  refuseInvalid(form, how);
  dispatchSubmit(form, null);
}

/** The `submit` event a browser sends, naming its `submitter`. */
function dispatchSubmit(form: AnyEl, submitter: AnyEl | null): void {
  const w = view(form);
  form.dispatchEvent(
    w.SubmitEvent
      ? new w.SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter,
      })
      : ev(form, "submit"),
  );
}

/** Enter's default action on `el`. */
function enterDefault(el: AnyEl): void {
  const tag = tagOf(el);
  if (tag === "textarea") {
    insertText(el, baseValue(el) + "\n", "insertLineBreak", null);
    return;
  }
  if (keyClicks(el, false)) {
    el.click?.();
    return;
  }
  if (tag !== "input" && tag !== "select") return;
  if (tag === "input" && _TEXTISH.has(inputTypeOf(el))) {
    el.dispatchEvent(inputEv(el, "beforeinput", "insertLineBreak", null));
  }
  fireChangeIfEdited(el); // Enter commits the edit before the form sees it
  implicitSubmit(el.form ?? el.closest?.("form"), `press("Enter")`);
}

// ── Modal dialogs ─────────────────────────────────────────────────────
// Escape closes the topmost MODAL dialog. Chromium answers `dialog:modal`;
// a DOM without modality (happy-dom's `showModal` is `show`) cannot, so its
// `showModal`/`close` are wrapped — from the first trigger on — to remember
// which dialogs were opened modally.
const _modals = new WeakSet<object>();
const _TRACKED = Symbol.for("aio.trigger.modalTracked");

function trackModals(w: AnyEl): void {
  const P = w?.HTMLDialogElement?.prototype;
  if (!P || P[_TRACKED] || typeof P.showModal !== "function") return;
  P[_TRACKED] = true;
  if (String(P.showModal).includes("[native code]")) return;
  const show = P.showModal;
  const close = P.close;
  P.showModal = function (this: object, ...a: unknown[]) {
    const r = show.apply(this, a);
    _modals.add(this);
    return r;
  };
  P.close = function (this: object, ...a: unknown[]) {
    _modals.delete(this);
    return close.apply(this, a);
  };
}

function topModal(doc: AnyEl): AnyEl {
  const open: AnyEl[] = [...(doc?.querySelectorAll?.("dialog[open]") ?? [])];
  let modal: AnyEl[] = [];
  try {
    modal = [...doc.querySelectorAll("dialog:modal")];
  } catch {
    // aio-ok: a selector engine without `:modal` — the tracked set answers.
  }
  const all = open.filter((d) => _modals.has(d) || modal.includes(d));
  return all.at(-1) ?? null;
}

/** Escape's default action: `cancel` (cancelable) on the top modal, then
 *  `close`. */
function escapeDefault(el: AnyEl): void {
  const dlg = topModal(el.ownerDocument ?? el);
  if (!dlg) return;
  const w = view(dlg);
  if (!dlg.dispatchEvent(new w.Event("cancel", { cancelable: true }))) return;
  dlg.close();
}

/** Press a key, optionally with modifiers (Ctrl/Cmd/Alt/Shift), with the
 *  browser's default actions: Enter in a text field commits it and runs
 *  implicit submission (see {@link implicitSubmit}); Enter in a `<textarea>`
 *  inserts a line break; Enter on a button/link/summary clicks it, Space on a
 *  button/checkbox clicks it on keyup; Escape closes the top modal dialog. A
 *  modified Enter (e.g. Ctrl+Enter) is a shortcut the handler owns, and a
 *  `preventDefault()` on keydown or keypress cancels every default action. */
export function triggerPress(
  el: AnyEl,
  key: string,
  mods?: KeyModifiers,
): void {
  assertOperable(el, "press a key on");
  trackModals(view(el));
  const probe = {
    ran: _globalKeyProbe.ran,
    swallowed: _globalKeyProbe.swallowed,
  };
  // Keep the keydown Event — a browser skips implicit form submit when the
  // keydown was preventDefault'd (combobox: Enter picks an option). The
  // harness used to dispatch submit unconditionally after keyup, so testUI
  // submitted while the real window did not (field report §2).
  let go = el.dispatchEvent(keyEv(el, "keydown", key, mods));
  const code = pressCode(key, mods);
  if (go && code) go = el.dispatchEvent(keyEv(el, "keypress", key, mods, code));
  const modified = mods
    ? (mods.ctrlKey || mods.metaKey || mods.altKey || mods.shiftKey)
    : false;
  if (go && !modified) {
    if (key === "Enter") enterDefault(el);
    else if (key === "Escape") escapeDefault(el);
  }
  el.dispatchEvent(keyEv(el, "keyup", key, mods));
  if (go && !modified && key === " " && keyClicks(el, true)) el.click?.();
  warnKeySwallowedByInput(el, "press", key, probe);
}

/** A press that a window-level binding WOULD have heard, aimed at a field that
 *  `ignoreInInput` makes it deaf to.
 *
 *  The event dispatches, `bubbles: true` carries it to the document, the call
 *  returns ok — and the handler ran ZERO times, so every assertion after it
 *  passes without testing anything. `tests/ui-window-key.test.tsx` called this
 *  "the trap" and left it armed; this is the disarm. Deciding from
 *  {@link _globalKeyProbe}'s delta rather than from the element's tag is what
 *  keeps it quiet on correct code: a binding that RAN (any of them — one with
 *  `ignoreInInput: false`, or a second component's), or no matching binding at
 *  all (the press belongs to the element, not to a shortcut), says nothing.
 *
 *  Observe-only, so dev and prod behave identically — and the harness runs
 *  dev-strict, so it fires in tests, which is where this bug is written. */
function warnKeySwallowedByInput(
  el: AnyEl,
  action: "press" | "keyDown",
  key: string,
  probe: { ran: number; swallowed: number },
): void {
  if (_globalKeyProbe.swallowed === probe.swallowed) return; // nobody listening
  if (_globalKeyProbe.ran !== probe.ran) return; // something ran — correct code
  if (!isDevMode()) return;
  const tag = String(el?.tagName ?? "").toLowerCase();
  const what = tag ? `<${tag}>` : "element";
  const article = /^[aeiou]/.test(tag) ? "an" : "a";
  const editable = el?.isContentEditable ? " (contenteditable)" : "";
  console.warn(
    `[aio-dev] ${action}(${JSON.stringify(key)}) on ${article} ${what}` +
      `${editable} — window key handlers skip inputs by design ` +
      `(ignoreInInput), so nothing ran. Press on a non-input, or address the ` +
      `window (testUI: \`ui.window.${action}(${JSON.stringify(key)})\`; am: ` +
      `\`am trigger window ${action} ${key}\`).`,
  );
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
  // Same keydown, same listener, same trap as `press` — a hold aimed at a
  // field is as silent as a tap, so it is named the same way.
  const probe = {
    ran: _globalKeyProbe.ran,
    swallowed: _globalKeyProbe.swallowed,
  };
  el.dispatchEvent(keyEv(el, "keydown", key, mods));
  warnKeySwallowedByInput(el, "keyDown", key, probe);
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
  if (
    !el.dispatchEvent(inputEv(el, "beforeinput", "deleteContentBackward", null))
  ) {
    return;
  }
  writeTyped(el, "");
  markEdited(el);
  el.dispatchEvent(inputEv(el, "input", "deleteContentBackward", null));
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
      // A browser delivers TWO clicks before the dblclick (detail 1, 2).
      triggerClick(el, mods, 1);
      triggerClick(el, mods, 2);
      el.dispatchEvent(mouseEv(el, "dblclick", mods, { detail: 2 }));
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
    case "hover": {
      // Chromium's order: pointerover, pointerenter, mouseover, mouseenter,
      // pointermove, mousemove. `*enter` does NOT bubble in a browser —
      // dispatching it with bubbles:true ran every ancestor's onMouseEnter as
      // well, so a hover on one row fired the whole list's handlers.
      const hover = { button: -1 };
      el.dispatchEvent(ptrEv(el, "pointerover", mods, hover));
      el.dispatchEvent(
        ptrEv(el, "pointerenter", mods, { ...hover, bubbles: false }),
      );
      el.dispatchEvent(mouseEv(el, "mouseover", mods));
      el.dispatchEvent(mouseEv(el, "mouseenter", mods, { bubbles: false }));
      el.dispatchEvent(ptrEv(el, "pointermove", mods, hover));
      el.dispatchEvent(mouseEv(el, "mousemove", mods));
      break;
    }
    case "focus": {
      // Focus leaving an edited field commits it, as a click would.
      const prev = activeOf(el.ownerDocument);
      if (prev && prev !== el) fireChangeIfEdited(prev);
      el.focus?.();
      break;
    }
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
