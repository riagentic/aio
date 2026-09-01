// ui-test.ts — first-class semantic UI testing (spec:
// docs/specs/2026-07-10-semantic-ui-testing.md). Mounts a real AIR app and
// exposes every TSX component as an intuitive, deterministic API:
//
//   const ui = await testUI(App, { document: win.document, cells: [todo] });
//   await ui.App.TitleInput.type("buy milk");   // client-only useLocal — real events
//   await ui.App.AddButton.click();             // settles the full loop
//
// Naming is a pure function of the TSX (t > data-testid > aria-label > text >
// placeholder > name attr, + role from tag/class) — predictable and stable.
// Interactions dispatch real DOM event sequences through AIR's own delegation —
// faithful to a user, never calling handlers directly.

import {
  _armTestStrict,
  _watchUnobservedCalls,
  type CallFailureLedger,
} from "./test-strict.ts";
// Server-touching, so NOT in test-strict.ts — see boot-refusals.ts.
import {
  _refuseUnsafeCells,
  type HarnessBootOptions,
} from "./boot-refusals.ts";
import { formatCellState } from "./test-format.ts";
import { frozenWriteMessage, isFrozenWriteError } from "../state/immutable.ts";
import { _resetRootSignals } from "../state/signal.ts";
import { _resetAioRuntime } from "../state/runtime-reset.ts";
import {
  _inflightMethodKeys,
  _pendingCallPromises,
} from "../state/method-cancel.ts";
import type { AioUser, AuthFeatures } from "../protocol/protocol-types.ts";
import { _setDocument, _unmount, mount } from "../air/aio-renderer.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";
import type { ComponentFn } from "../air/vdom-types.ts";
import type { MountHandle, RootState } from "../air/renderer-types.ts";
import { _rootStateMap } from "../air/renderer-state.ts";
import {
  _isForwardedHandle,
  _resetSurfaceWarnings,
  buildUISurface,
  findComponents,
  findElementsDeep,
  serializeSurface,
  type UIElementInfo,
  type UISurfaceNode,
} from "../air/ui-surface.ts";
import type { KeyModifiers } from "../air/ui-trigger.ts";
import {
  assertOperable,
  triggerAction,
  triggerChar,
  triggerClear,
  triggerDragTo,
  triggerScroll,
  triggerSelect,
  triggerSetChecked,
} from "../air/ui-trigger.ts";

// deno-lint-ignore no-explicit-any
type AnyDoc = any;

/** Options for {@linkcode testUI}. */
export interface TestUIOptions {
  /** Document to render into. Omit it — testUI creates (and disposes) a
   *  happy-dom window for you. Pass one only to control the DOM yourself
   *  (jsdom, a shared window, …). Falls back to `globalThis.document`. */
  document?: AnyDoc;
  /** Cells to run on the local (standalone) dispatch loop — the same runtime
   *  the android target uses, so method calls and reactive getters behave for
   *  real. Omit it — every `cell()` your App (transitively) imports has
   *  self-registered and boots automatically. Pass a list only to restrict
   *  the booted set. */
  // deno-lint-ignore no-explicit-any
  cells?: any[];
  /** Persist cell state to localStorage between runs. Default **false** —
   *  tests must be hermetic (the standalone default persistKey is shared, so
   *  leaking state across tests is a flake factory). Opt in to test
   *  persistence flows explicitly. */
  persist?: boolean;
  /** Max settle iterations per action (each ≈ flush + 5ms). Default 20. */
  settleIterations?: number;
  /** The app's `aio.run({ cellDefaults })` — applied here exactly as boot
   *  applies it, so what a cell hides (and therefore what boot refuses) is
   *  the same under test as in production. */
  cellDefaults?: HarnessBootOptions["cellDefaults"];
  /** The app's `aio.run({ localFirst })` — same reason. */
  localFirst?: boolean;
  /** The app's `aio.run({ perfBudget })` — same reason. Without it every
   *  budget is the DEFAULT, so a method the app has already budgeted trips a
   *  ceiling it does not have in production, and the warning recommends the
   *  override the app already wrote. */
  perfBudget?: HarnessBootOptions["perfBudget"];
  /** Starting state for booted cells, installed BEFORE the first render:
   *  `{ hw: { gpus: [...] } }`. Per cell it is a shallow merge over that cell's
   *  declared initial state, so you pin only the fields under test.
   *
   *  For any cell whose state comes from the machine — telemetry, a device, the
   *  clock — this is what lets a test assert a branch instead of observing
   *  whichever one the developer's box happened to take.
   *  An unknown cell name throws, listing what booted: a silently-ignored seed
   *  would look like a pinned fixture while testing nothing. */
  seed?: Record<string, Record<string, unknown>>;
  /** Ambient signed-in user for this mount — `useUser()` resolves to it on
   *  the FIRST render, with no `/__aio/auth/me` fetch (testUI boots no
   *  server, so there is nobody to answer one; without this, every UI test
   *  of an `auth: true` app renders `<SignIn/>` instead of the app).
   *  `null` mounts anonymous (`useUser()` → `null`, the SignIn branch).
   *  Omit for today's behaviour (identity stays unresolved). Reset on
   *  dispose, so the next mount cannot inherit this test's user. */
  user?: AioUser | null;
  /** Auth features the mount advertises — what a real `/me` would return
   *  (`<SignIn/>` adapts to them). Defaults all-false; only read when
   *  `user` is set. */
  authFeatures?: Partial<AuthFeatures>;
  /** Window size this mount reports: `window.innerWidth/innerHeight` and
   *  `document.documentElement.clientWidth/clientHeight`. Default 1024×768.
   *
   *  Any component that asks "how big is the viewport?" — a zoom that anchors
   *  on the top-left element fully inside it, a responsive breakpoint, a
   *  virtualised list — otherwise reads whatever the DOM stub happens to say,
   *  and BOTH branches of that question look green. A field report's zoom test
   *  passed for a full development round for the wrong reason: nothing is ever
   *  fully inside a 0×0 viewport, so the test only ever exercised the
   *  fallback and would have passed against a broken implementation.
   *
   *  Element geometry is a different question and still has no honest answer —
   *  there is no layout engine here, so `getBoundingClientRect()` is all
   *  zeros. testUI says so out loud the first time you ask (see the layout
   *  warning) rather than letting a zero read as a measurement. */
  viewport?: { width: number; height: number };
}

/** Which kind of thing a presence question is about — see
 *  {@linkcode TestUI.present}. One name can address an ELEMENT (`t` on a
 *  `<button>`) and a COMPONENT (`t` on `<Stage/>`, a rename-proof handle) at
 *  the same time; this says which one is meant. */
export type UIKind = "element" | "component";

/** A triggerable element of the semantic UI surface. Actions run on an
 *  ordered queue — **awaits are optional**: `ui.A.click(); ui.B.click();`
 *  executes in order, and the next observation point (`settle`, `expectCell`,
 *  `waitFor`, dispose) waits for everything and surfaces any failure. Each
 *  action still returns a promise that settles the app (renders flushed,
 *  dispatch drained) when you do want to await it. */
export interface UIElementHandle {
  /** Full click sequence: pointerdown → mousedown → pointerup → mouseup →
   *  click, optionally with held modifiers (`{ ctrlKey, metaKey, altKey,
   *  shiftKey }`) — parity with {@linkcode press}.
   *
   *  Ctrl+click to add, shift+click to extend, alt+click to remove are real
   *  gestures, and without this an app whose PRIMARY interaction is one of
   *  them has to test it with raw `new MouseEvent(…)` + `dispatchEvent` —
   *  dropping straight through the semantic surface into the DOM work it
   *  exists to remove. */
  click(mods?: KeyModifiers): Promise<void>;
  /** Double click (after a full click sequence), with optional modifiers. */
  dblclick(mods?: KeyModifiers): Promise<void>;
  /** Type into an input/textarea like a user: focus, then per-character
   *  keydown + value update + input event. Note: `type` APPENDS to the current
   *  value (it does not clear first) — use {@link setValue} to replace. */
  type(text: string): Promise<void>;
  /** Replace an input's value: clears, then types `text` — the "set this field
   *  to X" shortcut, so you don't have to `clear()` before `type()`. */
  setValue(text: string): Promise<void>;
  /** Press a key (keydown/keyup), optionally with modifiers
   *  (`{ ctrlKey, metaKey, altKey, shiftKey }`) — lets you drive chords like
   *  Ctrl+Enter. A bare `"Enter"` inside a form also submits it (browser
   *  implicit submission); a modified Enter does not, so a Ctrl+Enter
   *  shortcut handler is testable. */
  press(key: string, mods?: KeyModifiers): Promise<void>;
  /** Hold a key DOWN — no keyup until {@linkcode keyUp}. The interaction
   *  `press` (a tap) cannot express: "hold left for 10 frames", drag by
   *  keyboard, held modifiers, key-repeat (a field report). */
  keyDown(key: string, mods?: KeyModifiers): Promise<void>;
  /** Release a key held by {@linkcode keyDown}. */
  keyUp(key: string, mods?: KeyModifiers): Promise<void>;
  /** Hover: mouseover + mouseenter, with optional held modifiers (a UI that
   *  reveals delete affordances while ctrl is held is testable this way). */
  hover(mods?: KeyModifiers): Promise<void>;
  /** Focus the element. */
  focus(): Promise<void>;
  /** Blur the element. */
  blur(): Promise<void>;
  /** Select an option on a <select> (value), firing input + change. */
  select(value: string): Promise<void>;
  /** Click a checkbox/radio only if not already checked. */
  check(): Promise<void>;
  /** Click a checkbox only if currently checked. */
  uncheck(): Promise<void>;
  /** Clear an input's value (fires input). */
  clear(): Promise<void>;
  /** Scroll the element: set scrollTop/scrollLeft, fire `scroll`. */
  scroll(to?: { top?: number; left?: number }): Promise<void>;
  /** HTML5 drag-and-drop this element onto another surface element —
   *  dragstart → dragenter → dragover → drop → dragend with one shared
   *  DataTransfer, exactly like a browser. */
  dragTo(target: UIElementHandle): Promise<void>;
  /** The element's current text content. */
  readonly text: string;
  /** The element's current `value` (inputs). */
  readonly value: string;
  /** True while the element is disabled — resolvable and assertable without
   *  interacting (interactions on a disabled element fail loud). */
  readonly disabled: boolean;
  /** True while a checkbox/radio is checked. ALWAYS a boolean, so the natural
   *  assertion for "off" — `assertEquals(ui.LanToggle.checked, false)` — is
   *  writable (it used to read back a lazy callable and fail with
   *  `Actual: [Function: callable]`). `false` for an element with no checked
   *  state; the element itself must exist, or resolving fails loud. */
  readonly checked: boolean;
  /** True while an input/textarea is read-only. Always a boolean. */
  readonly readonly: boolean;
  /** True while an input/select/textarea is required. Always a boolean. */
  readonly required: boolean;
  /** Structured info (tag, events, path) from the surface. */
  readonly info: UIElementInfo;
}

/** A component instance on the surface. Access its interactive elements and
 *  child components as properties: `ui.App.TodoAdd.AddButton.click()`. */
export type UIComponentHandle = {
  /** Serialized surface subtree for this component (safe to print / feed to AI). */
  surface(): UISurfaceNode;
  /** Rendered text content of the component's subtree. */
  readonly text: string;
  /** Nth same-named child component (0-based) or by AIR key. */
  find(component: string, key?: string | number): UIComponentHandle;
} & {
  /** Dynamic access to elements/child components by semantic name. Typed
   *  loosely in v1 (the proxy throws helpful errors for unknown names);
   *  `testgen(App)` generates fully-typed clients — see ui-testgen.ts. */
  // deno-lint-ignore no-explicit-any
  [name: string]: any;
};

/** Handle returned by {@linkcode testUI}. */
export type TestUI = {
  /** Serialized semantic surface of the whole app — the intuitive map of
   *  "what can be done on this screen" (for humans and AI agents alike). */
  surface(): UISurfaceNode;
  /** The window the component is mounted in (happy-dom, owned by this mount;
   *  `null` only when a caller-supplied `document` has no `defaultView`).
   *  `globalThis.window` / `document` / `location` / `history` resolve to the
   *  same objects while the harness is up. */
  // deno-lint-ignore no-explicit-any
  readonly window: any;
  /** The document the component is mounted in — `ui.document.activeElement`,
   *  `ui.document.title`, … */
  // deno-lint-ignore no-explicit-any
  readonly document: any;
  /** Wait until the app is quiescent (renders flushed, no pending updates). */
  settle(): Promise<void>;
  /** Advance the virtual schedule clock by `ms` and fire every **cell**
   *  `schedule.after` / `schedule.every` now due, then settle — makes debounce,
   *  backoff and poll deterministically testable without real timers.
   *
   *  It moves the SCHEDULE clock, not the platform's: anything on a raw
   *  `setTimeout` (including `aio/ui`'s `toast()` auto-dismiss) is untouched by
   *  it — give such a timer a short duration and `waitFor` its effect instead. */
  advance(ms: number): Promise<void>;
  /** Wait until a predicate over the UI holds (polls between settles) — for
   *  async flows (effects, schedules) that update the UI later. Throws with
   *  the current surface on timeout. */
  /** Wait until `pred()` is true. Second arg: options or a description
   *  string (like `expectCell`) shown on timeout. */
  waitFor(
    pred: () => boolean,
    opts?: string | { timeoutMs?: number; msg?: string },
  ): Promise<void>;
  /** Root innerHTML — convenience for assertions. */
  html(): string;
  /** Unfiltered server-authoritative state — what a server route sees via
   *  `app.getState()`, INCLUDING `ui.exclude`d fields the client hides. Use to
   *  test a server flow that reads a hidden field. */
  serverState(): Record<string, unknown>;
  /** Install state into booted cells mid-test — the same shallow-merge-per-cell
   *  as the `seed` option, for when a flow must react to a machine-dependent
   *  value CHANGING rather than starting at one. Unknown cell names throw. */
  seed(partial: Record<string, Record<string, unknown>>): void;
  /** One cell's unfiltered slice from the server-authoritative state. */
  // deno-lint-ignore no-explicit-any
  fullState(cell: any): unknown;
  /** Assert on a cell's reactive state: `await ui.expectCell(todo, t => …)`. */
  // deno-lint-ignore no-explicit-any
  expectCell(cell: any, pred: (c: any) => boolean, msg?: string): Promise<void>;
  /** Find a component anywhere by name (and optionally AIR key). */
  find(component: string, key?: string | number): UIComponentHandle;
  /** True when nothing named `name` is SHOWING — no live element with that
   *  handle, and no component of that name that put anything on screen. A
   *  component which rendered `null` counts as absent: it has a surface node
   *  (it ran), but it produced nothing, and "did it render anything" is the
   *  question being asked. The negative assertion the surface was missing: a
   *  test for "the advice panel is gone" was otherwise written as
   *  `assert(!ui.html().includes("placement-advice"))`, which is stringly-typed
   *  and keeps passing for the wrong reason after a class rename. Composes with
   *  waitFor: `await ui.waitFor(() => ui.absent("Toast"))`.
   *
   *  `kind` pins WHICH thing is being asked about when one name addresses both
   *  — `t` on a component is a component handle, and a component that forwards
   *  its `t` prop to an inner element makes the same string name two things.
   *  `"element"` asks only about elements on screen, `"component"` only about
   *  components. Omit it and an element wins, with a one-time warning on the
   *  ambiguous frame (see the `showing` note). */
  absent(name: string, kind?: UIKind): boolean;
  /** Inverse of {@linkcode absent} — reads better in a positive assertion. */
  present(name: string, kind?: UIKind): boolean;
  /** Unmount and reset the local runtime (the auto-created window is closed
   *  in the background). Prefer `await using ui = await testUI(App)` or the
   *  `testUI(App, name, fn)` wrapper — both dispose for you. */
  unmount(): void;
  /** Full async teardown: unmount + await window close. */
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
} & {
  /** Dynamic access to any component by name: `ui.App`, `ui.TodoRow`. Loosely
   *  typed in v1 — unknown names throw listing what exists. */
  // deno-lint-ignore no-explicit-any
  [component: string]: any;
};

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Does this component instance put anything on screen?
 *
 *  A component that returned `null` still HAS a node in the surface — it was
 *  rendered, it just produced nothing. Counting that as "present" made
 *  `absent("PlacementAdvice")` false while the screen showed no advice at all,
 *  which is the exact case the docstring used as its example. "Present" has to mean *showing*, or the
 *  assertion answers a question nobody asked.
 *
 *  Showing = it contributes an element, a child that shows something, or text.
 *  A component that renders only non-interactive, textless markup is therefore
 *  absent from the SEMANTIC surface — which is the right answer for an API whose
 *  whole premise is "what can be seen and done here". */
function showsSomething(n: UISurfaceNode): boolean {
  if (n.elements.length > 0) return true;
  if (typeof n.text === "string" && n.text.trim().length > 0) return true;
  return n.children.some(showsSomething);
}

/** A failure message you can actually read.
 *
 *  A timeout used to stringify the WHOLE serialized surface, pretty-printed and
 *  uncapped: on one real page that is tens of KB per failure, and the assertion
 *  itself scrolls off the screen. `am surface` grew a text cap
 *  and --component/--path/--depth for exactly this problem; the harness's own
 *  output had not. Same idea here: names first (what you assert against), then a
 *  capped pretty tree, and the full JSON only when it is small enough to help. */
function surfaceDigest(node: UISurfaceNode, maxChars = 2000): string {
  const names: string[] = [];
  const walk = (n: UISurfaceNode, depth: number) => {
    if (depth > 3) return;
    names.push(
      `${"  ".repeat(depth + 1)}${n.component}${
        n.handle ? ` (t=${n.handle})` : ""
      }${
        n.elements.length ? `: ${n.elements.map((e) => e.name).join(", ")}` : ""
      }`,
    );
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(node, 0);
  const tree = names.join("\n");
  const full = JSON.stringify(serializeSurface(node), null, 2);
  if (full.length <= maxChars) return `\n${tree}\n\n${full}`;
  return `\n${tree}\n\n  (surface JSON omitted — ${full.length} chars; ` +
    `print it with JSON.stringify(ui.surface()) if you need the detail)`;
}

/** Last addressable segment of a path — `App/Stage/Row[3]:title` → `title`. */
function lastSegment(s: string): string {
  const cut = Math.max(s.lastIndexOf(":"), s.lastIndexOf("/"));
  return cut >= 0 ? s.slice(cut + 1) : s;
}

/** Edit distance, capped — only used to rank a listing, so an early exit past
 *  the cap is free accuracy nobody can observe. */
function editDistance(a: string, b: string, cap = 12): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** How many candidate names a failure lists before it stops helping.
 *
 *  A missing handle used to dump EVERY registered name in the app: one field
 *  report's screen has ~50, several hundred characters each, on one line — the
 *  assertion that failed scrolls off the top and the reader has to grep their
 *  own error message. The fix is the one `am surface` already made: rank by
 *  closeness to what was actually asked for, show the few that could plausibly
 *  be meant, and put the exhaustive list behind a flag. */
const NAME_LIMIT = 8;

/** Rank candidates by how close they are to `target`'s last segment, so the
 *  name the caller probably meant is the first thing they read. */
function rankNames(target: string | undefined, names: string[]): string[] {
  const uniq = [...new Set(names)];
  if (!target) return uniq;
  const want = lastSegment(target).toLowerCase();
  return uniq
    .map((n) => {
      const seg = lastSegment(n).toLowerCase();
      // A containment relation beats raw distance: `image-negative` should rank
      // `toggle-image-negative` above an unrelated same-length name.
      const contains = seg.includes(want) || want.includes(seg) ? -1 : 0;
      return { n, score: contains + editDistance(want, seg) / 100 };
    })
    .sort((a, b) => a.score - b.score)
    .map((x) => x.n);
}

function fail(msg: string, available: string[], target?: string): never {
  const all = Deno.env.get("AIO_TEST_NAMES") === "all";
  const ranked = rankNames(target, available);
  const shown = all ? ranked : ranked.slice(0, NAME_LIMIT);
  const hidden = ranked.length - shown.length;
  throw new Error(
    `${msg}\n  available: ${shown.length ? shown.join(", ") : "(none)"}` +
      (hidden > 0
        ? `\n  (closest ${shown.length} of ${ranked.length} shown — ` +
          `AIO_TEST_NAMES=all lists every one)`
        : "") +
      `\n  tip: name elements explicitly with the t prop, e.g. <button t="save">`,
  );
}

/** List a node's addressable names for error messages, annotating same-named
 *  sibling components with their count and the ordinal escape hatch:
 *  `Button ×2 — use Button2 for the 2nd`. */
function listNames(node: UISurfaceNode): string[] {
  const out = node.elements.map((e) => e.name);
  const counts = new Map<string, number>();
  for (const c of node.children) {
    counts.set(c.component, (counts.get(c.component) ?? 0) + 1);
  }
  for (const [name, n] of counts) {
    out.push(
      n > 1
        ? `${name} ×${n} — use ${name}2${
          n > 2 ? `…${name}${n}` : ""
        } for the later instance${n > 2 ? "s" : ""}`
        : name,
    );
  }
  return out;
}

/** Resolve the ordinal component form: `Button2` → the 2nd `Button` instance
 *  in tree (depth-first) order, mirroring element name de-duping (`Input`,
 *  `Input2`, …). Only kicks in when no exact name matched, so a component
 *  genuinely named `Button2` always wins.
 *
 *  `Button1` is accepted too — the explicit spelling of "the first one". It had
 *  no spelling at all while the bare name silently meant it; now that an
 *  ambiguous bare name is an error, "I really do mean the first" must be
 *  sayable. */
function ordinalComponent(
  scope: UISurfaceNode,
  prop: string,
): UISurfaceNode | undefined {
  const m = /^(.*[^\d])(\d+)$/.exec(prop);
  if (!m) return undefined;
  const n = Number(m[2]);
  if (n < 1) return undefined;
  const hits = findComponents(scope, m[1]!);
  return hits.length >= n ? hits[n - 1] : undefined;
}

/** The component instance named `name` in `scope`, or fail loud.
 *
 *  Same-named siblings are POSITIONAL by design, not ambiguous: the bare name
 *  is the first instance and `Name2`, `Name3`, … are the later ones — the
 *  convention the miss listings themselves teach (`Button ×2 — use Button2 for
 *  the 2nd`) and that `tests/ui-kit-semantic.test.tsx` fuzzes as a property.
 *  (Making ambiguity an error here was tried and reverted: it contradicts that
 *  contract, and it makes an element reachable only by an ordinal the author
 *  has no reason to know. Element HOISTING is the different case — a deep
 *  search with two hits genuinely has no answer, so that one throws.) */
function oneComponent(
  scope: UISurfaceNode,
  name: string,
  key?: string | number,
): UISurfaceNode {
  const hits = findComponents(scope, name, key);
  if (hits.length === 0) {
    // ONE name can address two different things: a COMPONENT (`<Stage/>`, or
    // `t` on a component) and an ELEMENT (`t` on a `<button>`). A miss that
    // says "component X not found" and lists only what is directly in scope
    // sends the reader looking in the wrong namespace — two field reports lost
    // time to exactly that, one of them concluding it had misnamed a component
    // while the thing it wanted was an element two levels down. So when the
    // name IS on the surface as an element, say so and name the spelling that
    // works.
    const asElement = findElementsDeep(scope, name).filter((e) => e._el);
    if (asElement.length > 0) {
      fail(
        `testUI: no COMPONENT named "${name}" under ${scope.path} — but there ` +
          `IS an element by that name (${
            asElement.map((e) => e.path).join(", ")
          }).\n  fix: address elements directly — ui["${name}"] (or ` +
          `ui.<Component>.${name}); find() resolves components only`,
        listNames(scope),
        name,
      );
    }
    fail(
      `testUI: no component or element named "${name}"${
        key !== undefined ? ` [key=${key}]` : ""
      } under ${scope.path}`,
      listNames(scope),
      name,
    );
  }
  return hits[0]!;
}

/** Any function component. Wider than ComponentFn on purpose: components
 *  typed via `jsxImportSource: "aio"` return jsx-runtime's JSX.Element —
 *  the same VNode shape under a different declaration — and forcing callers
 *  to cast was a real papercut. The one cast lives here instead. */
// deno-lint-ignore no-explicit-any
export type TestableComponent = (props?: any) => unknown;

/**
 * Mount an AIR app and drive it through its semantic surface — first-class UI
 * testing without DOM/selector lookup. Every TSX component becomes a readable,
 * deterministic API; every interaction is a real event sequence; every action
 * awaits quiescence, so tests have zero sleeps and zero flake.
 *
 * Zero boilerplate — the DOM is created for you, the cells your App imports
 * boot automatically, and the wrapper form cleans everything up:
 *
 * ```ts
 * import { testUI } from "aio/testing";
 * import App from "../src/App.tsx";
 *
 * testUI(App, "add a todo", async (ui) => {
 *   await ui.TodoAdd.TitleInput.type("buy milk");
 *   await ui.TodoAdd.AddButton.click();
 *   await ui.expectCell(todo, (t) => t.items.length === 1);
 * });
 * ```
 *
 * Handle form (compose your own test): `await using ui = await testUI(App);`
 * — disposed at scope end. Options only when you need control:
 * `{ document, cells, persist, settleIterations }`.
 */
export function testUI(
  App: TestableComponent,
  name: string,
  fn: (ui: TestUI) => void | Promise<void>,
): void;
/** Named form WITH options — `testUI(App, "name", { seed }, async (ui) => …)`.
 *  Without it, adopting `seed` (the feature that makes machine-dependent UI
 *  testable at all) meant rewriting a one-line test into the handle form by
 *  hand, for every test that needed it. */
export function testUI(
  App: TestableComponent,
  name: string,
  opts: TestUIOptions,
  fn: (ui: TestUI) => void | Promise<void>,
): void;
export function testUI(
  App: TestableComponent,
  opts?: TestUIOptions,
): Promise<TestUI>;
export function testUI(
  App: TestableComponent,
  optsOrName?: TestUIOptions | string,
  fnOrOpts?: ((ui: TestUI) => void | Promise<void>) | TestUIOptions,
  maybeFn?: (ui: TestUI) => void | Promise<void>,
): void | Promise<TestUI> {
  // Named form: the 3rd arg is either the body or the options.
  const fn = typeof fnOrOpts === "function" ? fnOrOpts : maybeFn;
  const namedOpts = typeof fnOrOpts === "function"
    ? {}
    : (fnOrOpts as TestUIOptions | undefined) ?? {};
  // Arm dev-strict checks: tests must be the strictest environment, so an
  // illegal in-place state mutation throws in a test exactly as it does in
  // dev + prod. This was inlined to avoid a cell-test.ts
  // cycle, and so it armed only HALF of what the shared entry point does — the
  // app-directory sandbox was missing, leaving a testUI-driven app free to
  // write into the developer's real `~/.<appId>`. `test-strict.ts` exists
  // precisely so every harness gets both.
  _armTestStrict();
  // Wrapper form: testUI(App, "name", fn) — a Deno.test with auto-teardown.
  if (typeof optsOrName === "string") {
    if (typeof fn !== "function") {
      throw new Error('testUI(App, "name", fn): missing test function');
    }
    Deno.test(optsOrName, async () => {
      const ui = await _mountTestUI(App as ComponentFn, namedOpts);
      let bodyErr: { e: unknown } | null = null;
      try {
        await fn(ui);
      } catch (e) {
        // Same teaching as testCell's: a frozen-state write from outside a
        // method surfaces as raw engine text that names neither the rule nor
        // the fix. The cell is not knowable here (the write could be to any
        // booted cell), so the message speaks generally.
        const raw = e instanceof Error ? e.message : String(e);
        if (e instanceof Error && isFrozenWriteError(raw)) {
          e.message = frozenWriteMessage(raw);
        }
        bodyErr = { e };
      }
      // Always dispose. dispose drains the action queue — un-awaited action
      // failures surface here. The body's error wins if there was one; a
      // teardown-only failure surfaces on its own (never masking the body).
      let teardownErr: { e: unknown } | null = null;
      try {
        await ui.dispose();
      } catch (e) {
        teardownErr = { e };
      }
      if (bodyErr) throw bodyErr.e;
      if (teardownErr) throw teardownErr.e;
    });
    return;
  }
  return _mountTestUI(App as ComponentFn, optsOrName ?? {});
}

/** Make the mount report a real viewport size.
 *
 *  happy-dom honours `width`/`height` for `window.innerWidth/innerHeight` but
 *  leaves `documentElement.clientWidth/clientHeight` at 0 — and that pair is
 *  the other half of every "how big is the window?" read in real code. Both
 *  answers have to agree, or which one a component happens to use decides
 *  whether its test is meaningful. */
function _installViewport(win: AnyDoc, width: number, height: number): void {
  const el = win.document?.documentElement;
  if (!el) return;
  for (
    const [prop, value] of [
      ["clientWidth", width],
      ["clientHeight", height],
    ] as const
  ) {
    try {
      Object.defineProperty(el, prop, { get: () => value, configurable: true });
    } catch {
      // aio-ok: a capability probe, not an operation. `clientWidth` is
      // non-configurable on any DOM that implements real layout (a browser, a
      // future happy-dom), and there the property already answers honestly —
      // which is strictly better than the number this would have installed.
      // There is nothing to report and nothing to retry.
    }
  }
}

/** Say out loud that there is no layout engine here.
 *
 *  `getBoundingClientRect()` returns all zeros and `clientWidth` is 0 for
 *  every element, because nothing lays anything out. Code that measures then
 *  takes its degenerate branch — and passes. That is the single worst
 *  outcome a test harness can produce: a green test that exercised the
 *  fallback and would have passed against a broken implementation. So the
 *  FIRST measurement per mount says what happened and what to do instead.
 *
 *  Once per mount, not per call: a virtualised list measures every row, and a
 *  warning that scrolls the terminal is a warning nobody reads. */
function _warnOnFakeLayout(win: AnyDoc): void {
  const proto = win.Element?.prototype;
  if (!proto) return;
  let warned = false;
  const warn = (what: string) => {
    if (warned) return;
    warned = true;
    console.warn(
      `[aio:testUI] ${what} was read, and there is no layout engine here — ` +
        `every element measures 0×0 at position 0,0. A component that ` +
        `branches on its own size therefore takes its DEGENERATE branch, and ` +
        `the test passes without exercising the real one.\n` +
        `  fix: assert the behaviour, not the geometry — or stub the ` +
        `measurement for this test (\`Object.defineProperty(el, ` +
        `"clientWidth", { value: 800 })\`).\n` +
        `  note: the WINDOW does have a size — set it with ` +
        `testUI(App, { viewport: { width, height } }).`,
    );
  };
  const origRect = proto.getBoundingClientRect;
  if (typeof origRect === "function") {
    proto.getBoundingClientRect = function (this: AnyDoc) {
      const r = origRect.call(this);
      if (!r || (!r.width && !r.height)) warn("getBoundingClientRect()");
      return r;
    };
  }
  for (const prop of ["clientWidth", "clientHeight"] as const) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc?.get) continue;
    const get = desc.get;
    try {
      Object.defineProperty(proto, prop, {
        configurable: true,
        get(this: AnyDoc) {
          const v = get.call(this);
          // documentElement carries the viewport (see _installViewport) and
          // has its own own-property getter, so it never reaches this one.
          if (!v) warn(prop);
          return v;
        },
      });
    } catch {
      // aio-ok: the property is non-configurable in this runtime, so the
      // harness cannot install its own — the caller gets the runtime's, which
      // is the correct fallback and needs no report.
    }
  }
}

/** Everything a HALF-BUILT mount has already installed into the process.
 *
 *  Setup installs `document`, `window`, `location`, `history`, `matchMedia`
 *  and `localStorage` as globals, patches `addEventListener`, boots the cells
 *  and mounts the tree — and any of those steps can throw (a component that
 *  explodes on first render; a boot refusal; a seed naming no cell). The
 *  initializer never returned, so there is no handle, `await using` has
 *  nothing to dispose, and every global stayed. The next `testUI` in the
 *  process then hit its own `if (globalThis[key]) continue` guard and ADOPTED
 *  the dead test's document: `body.children` grew 1 → 2 → 3, `ui.html()`
 *  showed a previous test's markup, and no later `dispose()` could ever clean
 *  it (nothing owned those globals any more).
 *
 *  So setup records what it installed HERE, in a value the caller holds, and
 *  the caller undoes exactly that on a throw. */
type PartialMount = {
  /** Globals we DEFINED (deleted on teardown). */
  owned: string[];
  /** Globals we PATCHED (restore callbacks). */
  restore: (() => void)[];
  /** The happy-dom window we created, if any. */
  window: AnyDoc;
  /** Undo a cell boot that already happened (state + process-global runtime). */
  reset?: () => void;
  /** Unmount an AIR tree that already mounted. */
  unmount?: () => void;
};

/** Undo a mount that threw halfway — the same steps `dispose()` runs, in the
 *  same order. Every step is independent: one failing must not strand the
 *  rest, and the original error is what the test needs to see. */
function _teardownPartialMount(p: PartialMount): void {
  const step = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      // Loud, not silent: teardown of a failed mount that itself fails leaves
      // the process dirty, and the NEXT test pays for it. The mount's own
      // error still propagates — this only makes sure the second failure is
      // not invisible.
      console.error(
        `[aio:testUI] tearing down a failed mount: ${what} threw — the ` +
          `process may still hold this test's globals: ${e}`,
      );
    }
  };
  step("unmount", () => p.unmount?.());
  step("runtime reset", () => p.reset?.());
  step("window close", () => {
    p.window?.happyDOM?.close()?.catch?.(() => {
      // aio-ok: happy-dom teardown is fire-and-forget here exactly as it is in
      // `unmount()`; the mount's own error is the one that must surface.
    });
    p.window = null;
  });
  step("globals", () => {
    for (const key of p.owned.splice(0)) delete (globalThis as AnyDoc)[key];
  });
  for (const restore of p.restore.splice(0)) step("restore", restore);
}

async function _mountTestUI(
  App: ComponentFn,
  opts: TestUIOptions,
): Promise<TestUI> {
  // A throw anywhere in setup must leave the process exactly as it found it —
  // see PartialMount.
  const partial: PartialMount = { owned: [], restore: [], window: null };
  try {
    return await _buildTestUI(App, opts, partial);
  } catch (e) {
    _teardownPartialMount(partial);
    throw e;
  }
}

async function _buildTestUI(
  App: ComponentFn,
  opts: TestUIOptions,
  partial: PartialMount,
): Promise<TestUI> {
  let doc: AnyDoc = opts.document ?? (globalThis as AnyDoc).document;
  // Auto-DOM: create a happy-dom window when none was provided — and own its
  // lifecycle (closed on dispose). Lazy import keeps the DOM dep out of
  // production code paths entirely.
  let ownedWindow: AnyDoc = null;
  // Globals we installed from the owned window (restored on dispose) — held in
  // `partial` so a throw before we return can undo them too.
  const _ownedGlobals: string[] = partial.owned;
  /** Teardown callbacks for globals we PATCHED (rather than defined). */
  const _restoreGlobals: (() => void)[] = partial.restore;
  if (!doc) {
    try {
      // Computed specifier ON PURPOSE: cell.ts re-exports testCell, so this
      // module rides in every app bundle graph — a static "happy-dom" import
      // makes esbuild try to bundle a Node-flavored test DOM into browser/
      // android bundles (51 errors). Opaque = resolved only at test runtime.
      const spec = "happy-dom";
      const hd = await import(spec);
      // Non-about:blank base URL so router code (navigate/Link) has a real
      // origin to resolve against.
      const vw = opts.viewport?.width ?? 1024;
      const vh = opts.viewport?.height ?? 768;
      ownedWindow = new hd.Window({
        url: "http://localhost/",
        width: vw,
        height: vh,
      });
      doc = ownedWindow.document;
      partial.window = ownedWindow; // so a later throw still closes it
      _installViewport(ownedWindow, vw, vh);
      _warnOnFakeLayout(ownedWindow);
      // `document` and `window` as GLOBALS, from the same owned window.
      //
      // A component that writes `document.addEventListener("keydown", …)` —
      // the most common form there is — reached `globalThis.document`, which
      // is `undefined` in Deno. The read throws inside `onMount`, lifecycle
      // hooks are error-guarded by design, and the result was a handler that
      // simply never ran: no error, no clue. testUI's whole job is to BE a
      // browser for the component under test, and a browser has these.
      for (
        const [key, value] of [
          ["document", ownedWindow.document],
          ["window", ownedWindow],
        ] as const
      ) {
        if ((globalThis as AnyDoc)[key]) continue;
        Object.defineProperty(globalThis, key, {
          get: () => value,
          configurable: true,
        });
        _ownedGlobals.push(key);
      }
      // Router support: `navigate()` reads globalThis.location/history — put
      // the owned window's (same-origin, in-memory) pair there so routed apps
      // test with ZERO shim code. Restored on unmount.
      for (const key of ["location", "history"] as const) {
        if ((globalThis as AnyDoc)[key]) continue;
        Object.defineProperty(globalThis, key, {
          get: () => ownedWindow?.[key],
          configurable: true,
        });
        _ownedGlobals.push(key);
      }
    } catch (e) {
      throw new Error(
        "testUI: no DOM available — add happy-dom to your deno.json imports " +
          '("happy-dom": "npm:happy-dom@^17"), or pass { document } yourself',
        { cause: e },
      );
    }
  }
  const maxIter = opts.settleIterations ?? 20;

  // Components using media queries must boot under testUI:
  // forward the owned window's real matchMedia when it has one, else a minimal
  // always-false stub. Legacy addListener/removeListener included — older
  // libraries still call them. Removed on unmount/dispose.
  if (!(globalThis as AnyDoc).matchMedia) {
    const stub = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
    Object.defineProperty(globalThis, "matchMedia", {
      get: () =>
        ownedWindow?.matchMedia
          ? ownedWindow.matchMedia.bind(ownedWindow)
          : stub,
      configurable: true,
    });
    _ownedGlobals.push("matchMedia");
  }

  // A UI listener registered on the DENO GLOBAL never fires under testUI.
  //
  // `globalThis.addEventListener("keydown", …)` is the natural thing to write
  // in a component — in a browser, `window` IS the global. Under testUI the
  // events are dispatched on the happy-dom window, so the handler is simply
  // never called: no error, no clue, just a component that does nothing. One
  // report lost its whole UI-test suite to this until it was diagnosed by
  // hand. Registration is the moment we can still say so.
  //
  // Only DOM-UI events are flagged. Deno's own lifecycle events (`unload`,
  // `error`, `unhandledrejection`) are legitimately global — the framework's
  // own sandbox uses them — and must stay silent.
  const DOM_UI_EVENTS = new Set([
    "keydown",
    "keyup",
    "keypress",
    "resize",
    "scroll",
    "click",
    "dblclick",
    "mousedown",
    "mouseup",
    "mousemove",
    "pointerdown",
    "pointerup",
    "pointermove",
    "touchstart",
    "touchend",
    "touchmove",
    "wheel",
    "focus",
    "blur",
    "input",
    "change",
    "submit",
    "visibilitychange",
    "hashchange",
    "popstate",
  ]);
  const _origAddEventListener = globalThis.addEventListener;
  const _warnedGlobalEvents = new Set<string>();
  // A DOM listener on the Deno global is INERT here and correct in a browser
  // (where `window` IS the global). Tests are the strictest environment, so
  // under the harness this is not a warning: the registration THROWS at the
  // site (inside `onMount`, usually — a contained hook error), and the same
  // error is stashed so the NEXT observation point (`settle`/`expectCell`/
  // `waitFor`/`dispose`) fails the test with it — a hook error alone is only
  // logged and kept, which is exactly the silence field report §4.1 reported.
  // The fix is named: `ui.window.addEventListener`, or `onGlobalKey`.
  const _globalListenerFailures: Error[] = [];
  globalThis.addEventListener = function (
    this: unknown,
    type: string,
    ...rest: unknown[]
  ) {
    if (DOM_UI_EVENTS.has(type)) {
      const msg =
        `[aio:testUI] "${type}" listener registered on the Deno global — it ` +
        `will NEVER fire here. testUI dispatches on the happy-dom window, ` +
        `so this handler is inert (in a browser the two are the same ` +
        `object, which is why the code looks right).\n` +
        `  fix: register on the document's window — \`ui.window\` in the ` +
        `test, \`el.ownerDocument.defaultView\` inside onMount — e.g. ` +
        `\`el.ownerDocument.defaultView.addEventListener("${type}", …)\`, ` +
        `use \`onGlobalKey\` for a key binding, or attach the handler to ` +
        `the element itself.`;
      if ((globalThis as AnyDoc).__aioDev === true) {
        const err = new Error(msg);
        _globalListenerFailures.push(err);
        throw err;
      }
      if (!_warnedGlobalEvents.has(type)) {
        _warnedGlobalEvents.add(type);
        console.warn(msg);
      }
    }
    return (_origAddEventListener as AnyDoc).call(this, type, ...rest);
  } as typeof globalThis.addEventListener;
  _restoreGlobals.push(() => {
    globalThis.addEventListener = _origAddEventListener;
  });

  // localStorage isolation. The standalone runtime needs localStorage;
  // some hosts (Deno test) already expose a PERSISTENT one. Either way, an
  // un-isolated store bleeds writes test→test while signals get correctly
  // reset. So: install a fresh in-memory shim when absent (owned → torn down →
  // fresh next mount), or CLEAR the existing one per mount for a hermetic
  // start. `{ persist: true }` opts into continuity and skips the clear.
  const _existingLS = (globalThis as AnyDoc).localStorage;
  if (!_existingLS) {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
          return store.size;
        },
      },
      configurable: true,
    });
    _ownedGlobals.push("localStorage");
  } else if (!opts.persist) {
    try {
      _existingLS.clear();
    } catch {
      // aio-ok: the host's localStorage is read-only (Deno's --location store
      // under some permissions). Clearing is a hermeticity nicety, not a
      // correctness requirement — the mount below uses a per-mount persist
      // key, so a stale entry cannot reach this test's state.
    }
  }

  // Boot the cells on the local dispatch loop (the android/standalone runtime —
  // real method binding, reactive getters, ack semantics). Default: every
  // `cell()` the App transitively imported has self-registered — boot them
  // all; pass { cells } only to restrict the set.
  let resetRuntime: (() => void) | undefined;
  let advanceSchedules: ((ms: number) => Promise<void>) | undefined;
  // The standalone (server-authoritative) app handle — exposed via
  // ui.serverState()/ui.fullState() so a test can read UNFILTERED state,
  // including `ui.exclude`d fields a server route legitimately reads.
  let standaloneApp: { getState: () => Record<string, unknown> } | undefined;
  let seedState:
    | ((p: Record<string, Record<string, unknown>>) => void)
    | undefined;
  let ledger: CallFailureLedger | undefined;
  const cells = opts.cells ?? [...getRegisteredCells().values()];
  // The state that does NOT live in a cell. A module-level `signal()` survives
  // a mount exactly as a cell singleton does, and used to be the half nothing
  // restored — so `zoom.set(2)` in one test silently became the starting point
  // of the next (an order-dependent failure that passes under --filter, which
  // is the worst way to find anything). Hermetic means all of the state, not
  // most of it. Before the cells boot, and independent of whether this app has
  // any: a signals-only UI leaked just as hard.
  if (!opts.persist) _resetRootSignals();
  // Every boot refusal a real `aio.run()` performs, BEFORE anything boots.
  // testUI composes on the standalone runtime, which is not the server's boot
  // path — so an app whose cell exposes a credential to the UI passed here and
  // was refused the moment it started, in dev and in prod alike.
  _refuseUnsafeCells(cells, {
    cellDefaults: opts.cellDefaults,
    localFirst: opts.localFirst,
    perfBudget: opts.perfBudget,
  });
  if (cells.length > 0) {
    const standalone = await import("../standalone-air.ts");
    // Opt into virtual time BEFORE anything registers a schedule — the same
    // runtime ships on Android, where the default must be real timers.
    standalone._useVirtualSchedules();
    advanceSchedules = standalone._advanceSchedules;
    // Hermetic by default: cells are module singletons, so both their signal
    // state AND the standalone dispatch store survive across mounts. Reset the
    // runtime state (keeping the registry) so this mount re-composes from the
    // cells' declared initials — no cross-test leaks. Skipped when the test
    // opts into persistence (it wants continuity across runs).
    if (!opts.persist) {
      standalone._resetState();
      // …and the PROCESS-GLOBAL half of the runtime, which `_resetState()` does
      // not own: `_pending` (in-flight calls), the degraded registry, the
      // cancel registry, subscriptions, warn-dedup sets. `testCell` has always
      // reset these; testUI never did, so ONE hung method leaked into `_pending`
      // for the rest of the process and every later `settle()` burned its whole
      // budget on a promise that would never resolve — then returned as if the
      // app had quiesced. Every assertion after that point was unguarded.
      // AFTER `_resetState()`: that call destroys the previous mount's cells,
      // and their onDestroy hooks must still find their methods bound.
      _resetAioRuntime();
    }
    standaloneApp = await standalone.aio.run({
      appId: "testui",
      cells,
      // Hermetic by default: no cross-test state leaks through the (shared)
      // localStorage persist key. Opt in via { persist: true }.
      persist: opts.persist ?? false,
      persistKey: `testui:${crypto.randomUUID().slice(0, 8)}`,
      cellDefaults: opts.cellDefaults,
      localFirst: opts.localFirst,
    }) as unknown as { getState: () => Record<string, unknown> };
    // Seed BEFORE the first render, so the component's very first pass already
    // sees the fixture (a seed applied after mount would test the re-render path
    // instead of the initial one, which is rarely what a test means).
    if (opts.seed) standalone._seedState(opts.seed);
    seedState = standalone._seedState;
    // Dispose does a state-only reset (keeps the registry so re-mounts boot).
    resetRuntime = standalone._resetState;
    // A failing async method NOBODY awaited must not pass for silence — the
    // same ledger `testCell` keeps, so the same app code cannot pass one
    // harness and fail the other (see test-strict.ts). `onClick={() =>
    // todo.add()}` is exactly this shape. Installed after the boot, because it
    // wraps the bound methods the boot just installed.
    ledger = _watchUnobservedCalls(cells);
    partial.restore.push(() => ledger?.restore());
    // A throw AFTER the cells booted (the seed, the first render) must not
    // leave them booted for the next test either.
    partial.reset = () => {
      standalone._resetState();
      _resetAioRuntime();
    };
  } else if (!opts.persist) {
    // A signals-only UI boots no cells, but the process-global runtime residue
    // is the SAME process — a `_pending` entry left by an earlier test makes
    // this mount's `settle()` lie exactly as hard.
    _resetAioRuntime();
  }

  // Ambient identity — installed BEFORE the first render so the very first
  // pass is already signed in (or anonymous), and the /me fetch is marked
  // done so a real fetch cannot race the injected user. Lazy import: the
  // auth UI must not ride into bundles of apps that never use auth.
  if (opts.user !== undefined) {
    const auth = await import("../browser/browser-auth-ui.ts");
    auth._resetAuthUi();
    auth._setAuthUser(opts.user);
    auth._setAuthFeatures({
      signup: false,
      oidc: false,
      totp: false,
      mail: false,
      ...opts.authFeatures,
    });
    // Reset on teardown — the NEXT mount must not inherit this user (the
    // second test in a file inheriting the first test's identity is the exact
    // trap the option exists to close).
    _restoreGlobals.push(() => auth._resetAuthUi());
  }

  // Duplicate-`t` reports are deduped per process (the surface is rebuilt on
  // every observation), so each mount starts fresh — otherwise the FIRST test
  // in a file gets the warning and every later one is silent about its own.
  _resetSurfaceWarnings();
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const handle: MountHandle = mount(root, App);
  partial.unmount = () => _unmount(handle);
  const state: RootState | undefined = _rootStateMap.get(handle);

  /** Why the last `settle()` stopped, when it stopped for the wrong reason.
   *  `null` once the app really did go quiet. */
  let _gaveUp: string | null = null;

  /** Wait for the app to go quiet.
   *
   *  `strict` decides what happens when the iteration budget runs out. It used
   *  to be a plain `return` in every case — so "the app quiesced" and "I gave
   *  up waiting" were the SAME answer, and every assertion after settle() ran
   *  against a half-finished app while looking guarded. Now the reason is
   *  recorded either way, and the OBSERVATION points (`ui.settle()`,
   *  `ui.advance()`) throw it. The retry loops (`expectCell`, `waitFor`) pass
   *  `strict: false` — giving up on one poll is normal there — and fold
   *  `_gaveUp` into their own timeout message instead. */
  async function settle(strict = false): Promise<void> {
    let prev = "";
    for (let i = 0; i < maxIter; i++) {
      handle._flush();
      await tick();
      // A cell-method dispatch set in motion WITHOUT an await (an outer
      // method firing a follow-up, `void fs.open(parent)`) is still in
      // flight when the HTML goes quiet — the quiescence early-exit read
      // that gap as settled and the UI showed the old state (a field
      // report). Await what is actually pending — bounded by the iteration
      // budget, so a deliberately long-running call (a stream driving
      // progressive UI) is REPORTED rather than silently called settled.
      const pending = _pendingCallPromises();
      if (pending.length > 0) {
        await Promise.race([Promise.allSettled(pending), tick()]);
        prev = "in-flight"; // never valid HTML — forces ≥1 more quiet round
        continue;
      }
      const now = root.innerHTML as string;
      if (now === prev && i > 0) {
        _gaveUp = null;
        // "Everything has landed" includes "and here is what went wrong": an
        // async method that failed with nobody awaiting it surfaces here,
        // exactly as it does in `testCell`.
        ledger?.raise();
        return;
      }
      prev = now;
    }
    // A method that failed is a likelier explanation than a slow one, and it
    // names a line in the app rather than a budget in the harness.
    ledger?.raise();
    const stillPending = _pendingCallPromises().length;
    const why = stillPending > 0
      ? `${stillPending} method call(s) are still in flight \u2014 ${
        _inflightMethodKeys().join(", ") || "(unnamed calls)"
      }`
      : "the rendered HTML never stopped changing (a render that re-renders " +
        "itself \u2014 e.g. a signal written during render)";
    _gaveUp =
      `testUI: settle() gave up after ${maxIter} iterations. ${why}.\n` +
      `  Nothing after this point is guarded: the app has NOT quiesced.\n` +
      `  fix: await the call itself; drive time with \`await ui.advance(ms)\` ` +
      `if it waits on a schedule; raise the budget with ` +
      `\`testUI(App, { settleIterations: n })\` for a legitimately long ` +
      `render; or give the method an abort path (\`s.$signal\`).`;
    if (strict) {
      const msg = _gaveUp;
      _gaveUp = null; // reported here — never twice
      throw new Error(msg);
    }
  }

  function currentSurface(): UISurfaceNode {
    const vnode = state?.vnode ?? null;
    const s = buildUISurface(vnode as AnyDoc);
    if (!s) throw new Error("testUI: app is not mounted");
    return s;
  }

  /** Elements named `name` that are actually ON SCREEN — a surface entry whose
   *  vnode never got (or no longer has) a DOM node is not showing anything.
   *
   *  This is what made three of the harness's own APIs disagree about one
   *  element: `present()` counted every surface entry, while resolving one
   *  required a live node, so a report could see `present("x") === true`,
   *  `ui.html()` containing it, and `ui.x` throwing "not on the current
   *  surface" — all at the same instant. One definition of "on screen", used by
   *  every API, or the harness is lying to somebody. */
  function liveElements(scope: UISurfaceNode, name: string): UIElementInfo[] {
    return findElementsDeep(scope, name).filter((e) => e._el);
  }

  /** Re-resolve an element at ACTION time — never acts on a stale reference.
   *
   *  The NAME is the address; the path is only a tie-breaker. Resolving by path
   *  alone made a handle die the moment its subtree remounted: switching views
   *  so one stage unmounts and another mounts re-parents the element, its path
   *  changes, and every handle taken before the switch threw for good — with
   *  `ui.html()` and `present()` both insisting the element was right there.
   *  `settle()` could not help, because nothing was pending; the address had
   *  simply gone stale. So: prefer the exact path (it disambiguates same-named
   *  siblings), and fall back to the unique live element of that name. */
  function resolveElement(path: string, name?: string): UIElementInfo {
    const surface = currentSurface();
    const byPath: UIElementInfo[] = [];
    const visit = (n: UISurfaceNode) => {
      for (const e of n.elements) if (e.path === path) byPath.push(e);
      n.children.forEach(visit);
    };
    visit(surface);
    const exact = byPath.find((e) => e._el);
    if (exact) return exact;
    // The path moved (remount / re-parent / a sibling appearing ahead of it).
    // The name still addresses exactly one live element → that is the element.
    const label = name ?? lastSegment(path);
    const live = liveElements(surface, label);
    if (live.length === 1) return live[0]!;
    if (live.length > 1) {
      fail(
        `testUI: "${label}" was at ${path}, which no longer exists, and the ` +
          `name now matches ${live.length} live elements — address the ` +
          `instance: ui.….<Component>2.${label} (ordinal, tree order)`,
        live.map((e) => e.path),
        path,
      );
    }
    const names: string[] = [];
    const collect = (n: UISurfaceNode) => {
      n.elements.forEach((e) => names.push(e.path));
      n.children.forEach(collect);
    };
    collect(surface);
    fail(
      `testUI: element "${path}" is not on the current surface`,
      names,
      path,
    );
  }

  // ── Action queue — awaits are optional ───────────────────────────────
  // Every action chains onto one FIFO tail, so ordering is guaranteed
  // WITHOUT an await per action: `ui.A.click(); ui.B.click();` runs in
  // order. A failure from an un-awaited action is stashed and rethrown at
  // the next observation point (settle / expectCell / waitFor / dispose) —
  // nothing is silently lost. Awaiting an action still works and delivers
  // its own failure immediately.
  let _tail: Promise<void> = Promise.resolve();
  // Failures of queued actions, each paired with "did the caller ever look?".
  //
  // The decision used to be made the moment `run` rejected, but a LATE await
  // (`const p = ui.X.click(); … await p;`) attaches its handler after that —
  // so the failure was stashed AND then delivered to the late awaiter, and the
  // next drain threw it a second time, contradicting the guarantee right
  // below. Deciding at drain time is what makes "awaited" mean awaited-ever.
  const _failures: { err: unknown; seen: () => boolean }[] = [];
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = _tail.then(fn);
    // A failure the caller AWAITED (attached a rejection handler to) is
    // delivered there and must NOT resurface at the next drain point — else
    // an `assertRejects(() => ui.X.click())` test re-fails at dispose.
    let delivered = false;
    // The tail handler makes un-awaited rejections "handled" (no process
    // unhandledrejection) while recording the failure for the drain.
    _tail = run.then(() => {}, (e) => {
      _failures.push({ err: e, seen: () => delivered });
    });
    return {
      then: (onF, onR) => {
        if (onR) delivered = true;
        return run.then(onF, onR);
      },
      catch: (onR) => {
        delivered = true;
        return run.catch(onR);
      },
      finally: (onC) => run.finally(onC),
      [Symbol.toStringTag]: "Promise",
    } as Promise<T>;
  }
  async function drain(): Promise<void> {
    let t: Promise<void>;
    do {
      t = _tail;
      await t;
    } while (_tail !== t); // actions queued while waiting — keep draining
    const first = _failures.find((f) => !f.seen());
    _failures.length = 0; // delivered or reported — either way, done with them
    if (first) throw first.err;
    const inert = _globalListenerFailures.shift();
    if (inert) {
      _globalListenerFailures.length = 0;
      throw inert;
    }
    // …and an async cell method that failed with nobody awaiting it. Last,
    // because the two above are failures of the TEST's own actions and name
    // the line that caused them; this one names the app's method.
    ledger?.raise();
  }

  function elementHandle(resolveInfo: () => UIElementInfo): UIElementHandle {
    const el = () => resolveInfo()._el! as AnyDoc;
    // A real user cannot operate a disabled control, nor change a readonly
    // one — interacting fails loud with its state instead of firing a dead
    // event or (worse) writing a value the browser would have refused. The RULE
    // lives in ui-trigger.ts so the live `am trigger` tier enforces exactly the
    // same one; this call site only adds the semantic name to the message.
    const assertEnabled = (verb: string, write = false) => {
      const i = resolveInfo();
      assertOperable(i._el, verb, {
        name: i.name,
        write,
        prefix: "testUI: ",
      });
    };
    // verb: user-gesture actions guard against disabled at action time
    // (queue-time, so un-awaited sequences fail at the next drain point).
    // `write` marks the value-mutating gestures, which readonly also refuses.
    const act = (
      verb: string | null,
      fn: (e: AnyDoc) => void,
      write = false,
    ) =>
      enqueue(async () => {
        if (verb) assertEnabled(verb, write);
        fn(el());
        await settle();
      });
    return {
      get info() {
        return resolveInfo();
      },
      click(mods?: KeyModifiers) {
        return act(
          "click",
          (e) => triggerAction(e, "click", undefined, mods),
        );
      },
      dblclick(mods?: KeyModifiers) {
        return act(
          "dblclick",
          (e) => triggerAction(e, "dblclick", undefined, mods),
        );
      },
      type(text: string) {
        return enqueue(async () => {
          assertEnabled("type into", true);
          el().focus?.();
          for (const ch of text) {
            triggerChar(el(), ch); // re-resolve — controlled inputs re-render
            handle._flush();
          }
          await settle();
        });
      },
      press(key: string, mods?: KeyModifiers) {
        return act(
          "press a key on",
          (e) => triggerAction(e, "press", key, mods),
        );
      },
      keyDown(key: string, mods?: KeyModifiers) {
        return act(
          "hold a key on",
          (e) => triggerAction(e, "keyDown", key, mods),
        );
      },
      keyUp(key: string, mods?: KeyModifiers) {
        return act(
          "release a key on",
          (e) => triggerAction(e, "keyUp", key, mods),
        );
      },
      hover(mods?: KeyModifiers) {
        return act(null, (e) => triggerAction(e, "hover", undefined, mods));
      },
      focus() {
        return act(null, (e) => triggerAction(e, "focus"));
      },
      blur() {
        return act(null, (e) => triggerAction(e, "blur"));
      },
      select(value: string) {
        return act("select on", (e) => triggerSelect(e, value), true);
      },
      // check()/uncheck() only mean something on a checkbox/radio — and the
      // rule lives in ui-trigger.ts, so the live tier (`am trigger … check`)
      // cannot drift from it. It used to be duplicated here, and the copy in
      // the live tier let a "check" click a plain <button>.
      check() {
        return act(
          null,
          (e) =>
            triggerSetChecked(e, true, {
              name: resolveInfo().name,
              prefix: "testUI: ",
            }),
        );
      },
      uncheck() {
        return act(
          null,
          (e) =>
            triggerSetChecked(e, false, {
              name: resolveInfo().name,
              prefix: "testUI: ",
            }),
        );
      },
      clear() {
        return act("clear", (e) => triggerClear(e), true);
      },
      setValue(text: string) {
        return enqueue(async () => {
          assertEnabled("set value on", true);
          triggerClear(el()); // replace, don't append
          handle._flush();
          el().focus?.();
          for (const ch of text) {
            triggerChar(el(), ch); // re-resolve — controlled inputs re-render
            handle._flush();
          }
          await settle();
        });
      },
      scroll(to?: { top?: number; left?: number }) {
        return act(null, (e) => triggerScroll(e, to));
      },
      dragTo(target: UIElementHandle) {
        return enqueue(async () => {
          const dst = target.info._el! as AnyDoc;
          triggerDragTo(el(), dst);
          await settle();
        });
      },
      get text() {
        return String(el().textContent ?? "");
      },
      get value() {
        return String(el().value ?? "");
      },
      // The four state booleans, always boolean — never undefined, and never
      // the proxy's lazy callable. Reading one still RESOLVES the element, so
      // asserting on something that isn't there fails loud with the name
      // listing instead of quietly answering `false`.
      get disabled() {
        return resolveInfo().disabled === true;
      },
      get checked() {
        return resolveInfo().checked === true;
      },
      get readonly() {
        return resolveInfo().readonly === true;
      },
      get required() {
        return resolveInfo().required === true;
      },
    };
  }

  /** Handle for a name that isn't on the surface YET — actions resolve it
   *  inside the queue (after prior actions ran, e.g. a click that opens a
   *  modal), so `ui.OpenButton.click(); ui.Modal.ConfirmButton.click()`
   *  works without awaits. Unknown-forever names fail at the next drain
   *  with the usual listing. Child access chains lazily. */
  function lazyHandle(
    selectParent: () => UISurfaceNode,
    name: string,
  ): UIElementHandle {
    const resolveInfo = (): UIElementInfo => {
      const node = selectParent();
      const found = node.elements.find((e) => e.name === name);
      if (found?._el) return found;
      // HOIST at use time, exactly as the eager path hoists at access time.
      //
      // Without this the documented promise — "acting on UI a previous action
      // creates just works: `ui.OpenButton.click(); ui.Modal.Confirm.click()`,
      // the modal is resolved when its turn comes" — held only for elements
      // that happen to sit DIRECTLY under the scope. A field report hit the
      // gap on the most ordinary shape there is (`ui.signIn.click();
      // ui.username.type(…)`, where the form the click reveals is a child
      // component) and came away carrying a comment explaining why one action
      // had to be awaited. A resolution rule that holds at access time and not
      // at use time is worse than no lazy resolution at all, because the
      // failure looks like a naming mistake.
      const hoisted = liveElements(node, name);
      if (hoisted.length === 1) return hoisted[0]!;
      // Component/element name SHADOWING: a component named like its own
      // inner element makes `ui.X` resolve to the component, so `ui.X.type()`
      // looks up an element "type" here and fails — say how to reach the
      // shadowed element.
      const shadowed = node.elements.some((e) => e.name === node.component) ||
        node.children.some((c) => c.component === node.component);
      // The name may exist on a DIFFERENT branch — typically inside a
      // same-type SIBLING instance that shares this one's semantic name.
      // Point at every live location instead of a dead end.
      let elsewhere: UIElementInfo[] = [];
      try {
        elsewhere = liveElements(currentSurface(), name);
      } catch {
        // aio-ok: `currentSurface()` throws when nothing is mounted, and this
        // is the failure path already — we are only enriching the error the
        // caller is about to get with "the name lives over here instead".
      }
      if (hoisted.length > 1) {
        fail(
          `testUI: "${name}" matches ${hoisted.length} elements under ` +
            `${node.path} — address the instance: ` +
            `ui.….<Component>2.${name} (ordinal, tree order)`,
          hoisted.map((e) => e.path),
          name,
        );
      }
      fail(
        `testUI: no element or component named "${name}" under ${node.path}` +
          (shadowed
            ? `\n  hint: "${node.component}" names both this component and something inside it — use ui.${node.component}.${node.component}`
            : "") +
          (elsewhere.length > 0
            ? `\n  found elsewhere: ${
              elsewhere.slice(0, NAME_LIMIT).map((e) => e.path).join(", ")
            }${elsewhere.length === 1 ? ` — reachable as ui.${name}` : ""}`
            : ""),
        listNames(node),
        name,
      );
    };
    const eh = elementHandle(resolveInfo);
    // Callable Proxy target: chaining past an unknown action and INVOKING it
    // (e.g. `ui.PasswordInput.type()` when "PasswordInput" resolved to a
    // component, or a typo'd action) must fail with the aio name listing —
    // a bare `TypeError: … is not a function` names nothing.
    //
    // The target carries a self-describing NAME because this handle can also be
    // read as a VALUE, and then it lands in an assertion diff: `Actual:
    // [Function: callable]` named neither the property nor the reason (a field
    // report). Deno prints a function's name, so the diff now says what it is.
    // The lazy callable itself is load-bearing (un-awaited sequences target UI a
    // queued action will create), so it stays — it just stops being anonymous.
    const label = `aio testUI: "${name}" is unresolved — a pending element/` +
      `component reference, not a value. For state use .checked/.disabled/` +
      `.readonly/.required/.value/.text on an element that exists.`;
    const callable = { [label]: function () {} }[label] as unknown as AnyDoc;
    return new Proxy(callable, {
      get(_target, prop: string | symbol) {
        if (typeof prop === "symbol" || prop in eh) {
          return (eh as AnyDoc)[prop];
        }
        // Treated as a component that will exist by the time it's used:
        // ui.Modal.ConfirmButton — resolve "Modal" lazily, then chain.
        return lazyHandle(() => {
          const parent = selectParent();
          const ord = findComponents(parent, name).length === 0
            ? ordinalComponent(parent, name)
            : undefined;
          return ord ?? oneComponent(parent, name);
        }, prop as string);
      },
      apply() {
        // Invoked as an action: either the name never resolves (throws the
        // helpful listing) or it resolved but `name` isn't a real action.
        resolveInfo();
        return fail(
          `testUI: "${name}" resolved but is not an element action`,
          [],
        );
      },
    }) as UIElementHandle;
  }

  /** Component/element name SHADOWING: when `name` addresses a
   *  component AND exactly one interactive element in `scope`, the INTERACTABLE
   *  thing wins for element concerns (`click`, `type`, `value`, `disabled`, …)
   *  while unknown properties still navigate the component (children, `find`,
   *  `surface`). Ambiguous element matches (≥2) keep the plain component. */
  function shadowHybrid(
    selectScope: () => UISurfaceNode,
    name: string,
    comp: UIComponentHandle,
  ): UIComponentHandle {
    let unique = false;
    try {
      unique = liveElements(selectScope(), name).length === 1;
    } catch {
      // aio-ok: `currentSurface()` throws before the first mount. "Not
      // mounted" is the same answer as "no unique element by that name" —
      // both mean this handle stays a plain component handle.
    }
    if (!unique) return comp;
    const eh = elementHandle(() => {
      const els = liveElements(selectScope(), name);
      if (els.length === 1) return els[0]!;
      fail(
        `testUI: element "${name}" is not on the current surface`,
        els.map((e) => e.path),
        name,
      );
    });
    return new Proxy(eh as AnyDoc, {
      get(target, prop: string | symbol) {
        if (typeof prop !== "symbol" && prop in (target as object)) {
          return (target as AnyDoc)[prop];
        }
        return (comp as AnyDoc)[prop];
      },
      has(target, prop) {
        return prop in (target as object) || prop in (comp as object);
      },
    }) as UIComponentHandle;
  }

  /** A handle for a name that is on the surface as NEITHER kind — yet.
   *
   *  Element actions (`click`, `type`, …) resolve against the live surface
   *  when they RUN, hoisting through child components exactly as the eager
   *  path does; anything else is a component reference and defers to
   *  `find()`. Whichever the name turns out to be, the first use decides. */
  function lazyHybrid(name: string): UIComponentHandle {
    const comp = api.find(name);
    const eh = elementHandle(() => {
      const surf = currentSurface();
      const els = liveElements(surf, name);
      if (els.length === 1) return els[0]!;
      if (els.length > 1) {
        fail(
          `testUI: "${name}" matches ${els.length} elements on the surface — ` +
            `disambiguate with ui.<Component>2.${name} (ordinal, tree order)`,
          els.map((e) => e.path),
          name,
        );
      }
      // No element. If a COMPONENT by that name exists, the caller asked an
      // element question of a component and deserves to be told which;
      // otherwise oneComponent throws the canonical both-namespaces miss.
      oneComponent(surf, name);
      fail(
        `testUI: "${name}" is a COMPONENT, not an element — element actions ` +
          `(click/type/…) need an element. Reach one inside it with ` +
          `ui.${name}.<Element>, or put a t handle on the node you mean`,
        listNames(surf),
        name,
      );
    });
    return new Proxy(eh as AnyDoc, {
      get(target, prop: string | symbol) {
        if (typeof prop !== "symbol" && prop in (target as object)) {
          return (target as AnyDoc)[prop];
        }
        return (comp as AnyDoc)[prop];
      },
      has(target, prop) {
        return prop in (target as object) || prop in (comp as object);
      },
    }) as UIComponentHandle;
  }

  function componentHandle(select: () => UISurfaceNode): UIComponentHandle {
    const base = {
      surface: () => serializeSurface(select()),
      get text() {
        // Component subtree text via its own rendered DOM (precise), falling
        // back to the mount root.
        const n = select();
        const dom = (n as AnyDoc)._dom ?? n.elements[0]?._el;
        return String(dom?.textContent ?? root.textContent ?? "");
      },
      find(component: string, key?: string | number): UIComponentHandle {
        return componentHandle(() => oneComponent(select(), component, key));
      },
    };
    return new Proxy(base as AnyDoc, {
      get(target, prop: string | symbol) {
        if (typeof prop === "symbol" || prop in target) {
          return (target as AnyDoc)[prop];
        }
        let node: UISurfaceNode;
        try {
          node = select();
        } catch {
          // This component isn't on the surface yet (a queued action may be
          // about to create it) — defer everything to use time.
          return lazyHandle(select, prop as string);
        }
        const elInfo = node.elements.find((e) => e.name === prop);
        if (elInfo) {
          return elementHandle(() => resolveElement(elInfo.path, elInfo.name));
        }
        // Component by exact name — resolved fresh at use time, and ambiguity
        // is an error rather than "whichever came first in tree order".
        if (findComponents(node, prop as string).length > 0) {
          const comp = componentHandle(() =>
            oneComponent(select(), prop as string)
          );
          return shadowHybrid(select, prop as string, comp);
        }
        // Element anywhere below this node — same hoist the top level does
        //, so `ui.ToolBar.Settings` reaches a `t`-handle inside a
        // child component without positional navigation.
        const els = liveElements(node, prop as string);
        if (els.length === 1) {
          return elementHandle(() =>
            resolveElement(els[0]!.path, prop as string)
          );
        }
        // Ordinal instance access for same-type siblings: `Button2` → 2nd
        // `Button` in tree order (only when nothing exact matched).
        const ord = ordinalComponent(node, prop as string);
        if (ord) {
          return componentHandle(() => {
            const again = ordinalComponent(select(), prop as string);
            if (!again) {
              fail(`testUI: component "${String(prop)}" disappeared`, []);
            }
            return again;
          });
        }
        if (els.length > 1) {
          fail(
            `testUI: "${
              String(prop)
            }" matches ${els.length} elements under ${node.path} — ` +
              `address the instance: ui.….<Component>2.${
                String(prop)
              } (ordinal, tree order)`,
            els.map((e) => e.path),
            prop as string,
          );
        }
        // Not on the surface YET — hand back a lazy handle so un-awaited
        // sequences can target UI a prior queued action will create.
        return lazyHandle(select, prop as string);
      },
    }) as UIComponentHandle;
  }

  await settle();

  // Explained once per mount, not per poll — `waitFor(() => ui.absent(x))`
  // asks dozens of times.
  const _ambiguityWarned = new Set<string>();

  /** Is anything named `name` SHOWING? — the one definition `present`/`absent`
   *  both answer from.
   *
   *  A name can address two things: `t` on an ELEMENT names that element, `t`
   *  on a COMPONENT is a rename-proof handle for the component. They collide
   *  only when a component takes `t` as a data prop and forwards it down, and
   *  then the two answers differ exactly when the element is conditional:
   *
   *      <NegativePrompt t="image-negative" … />   // switch always; field when on
   *      ui.absent("image-negative")               // false — but the FIELD is gone
   *
   *  An element that is really on screen therefore wins — it is the more
   *  specific answer and the one a reader of the assertion expects — and
   *  `kind` pins the question outright.
   *
   *  That leaves exactly one frame where the two answers differ: the element is
   *  gone while the component still renders something else. The answer there is
   *  "the component is showing", which is TRUE and almost never what was meant,
   *  so it is explained rather than returned bare. Only for names known to be
   *  forwarded to an element (see `_isForwardedHandle`) — a component handle
   *  that names nothing else is unambiguous and must stay silent. */
  function showing(name: string, kind?: UIKind): boolean {
    const scope = currentSurface();
    if (kind !== "component" && liveElements(scope, name).length > 0) {
      return true;
    }
    if (kind === "element") return false;
    const comps = findComponents(scope, name);
    const shows = comps.some(showsSomething);
    if (
      shows && kind === undefined && _isForwardedHandle(name) &&
      !_ambiguityWarned.has(name)
    ) {
      _ambiguityWarned.add(name);
      const owner = comps.find((c) => c.handle === name);
      console.warn(
        `[aio:testUI] "${name}" is showing as a COMPONENT${
          owner ? ` (<${owner.component}> at ${owner.path})` : ""
        }, but NO element of that name is on screen — and elsewhere this app ` +
          `uses "${name}" as an element handle, so this answer is probably ` +
          `not the one you wanted.\n` +
          `  the element is absent: ui.absent("${name}", "element") === true\n` +
          `  ask about the component on purpose: ui.present("${name}", ` +
          `"component") — which also silences this.`,
      );
    }
    return shows;
  }

  /** A predicate may only read keys the cell actually has.
   *
   *  Field report: `expectCell(core, (c) => c.view !== null)` PASSED against a
   *  `view` the cell does not declare — `undefined !== null` is true — so it
   *  was "a green test for a screen that never rendered", and it cost a
   *  debugging session to a test that was passing for the wrong reason.
   *
   *  `assertBooted` above already refuses a cell this mount never booted. This
   *  is the same class one level in: the cell is booted, and the KEY is not
   *  there. Their words, and the rule this file should be held to: "a test
   *  kit's failure mode should never be 'silently true'."
   *
   *  Declared state, methods, selectors and the internals a runtime probes
   *  (`__aio`, `then`, symbols) read through untouched; anything else throws
   *  naming the key and what the cell does have. */
  const guardUnknownKeys = (cell: AnyDoc, api: string): AnyDoc => {
    const declared = new Set(
      Object.keys((cell?.__aio?.state ?? {}) as object),
    );
    const id = (cell?.__aio?.id as string | undefined) ?? "?";
    return new Proxy(cell as object, {
      get(target, prop, recv) {
        if (typeof prop === "symbol") return Reflect.get(target, prop, recv);
        // A method, a selector, or anything the cell really exposes — the
        // shape question answered with a DESCRIPTOR, never by reading the
        // value (that would invoke a reactive getter just to ask about it).
        if (
          declared.has(prop) || prop.startsWith("__") || prop === "then" ||
          Object.getOwnPropertyDescriptor(target, prop) !== undefined ||
          prop in (Object.getPrototypeOf(target) ?? {})
        ) return Reflect.get(target, prop, recv);
        throw new Error(
          `[aio] ui.${api}(): cell '${id}' has no '${String(prop)}'. Reading ` +
            `it would be \`undefined\`, so a check like \`c.${String(prop)} ` +
            `!== null\` passes without testing anything — a green test for a ` +
            `screen that never rendered. It has: ${
              [...declared].sort().join(", ") || "(no state keys)"
            }.`,
        );
      },
    }) as AnyDoc;
  };

  /** A cell this mount never booted cannot be asserted against.
   *
   *  `expectCell`'s predicate receives the cell DEF, whose reactive getters
   *  fall back to `__aio.state` — the pristine declared initial — when no
   *  signal exists. So `expectCell(cart, (c) => c.items.length === 0)` against
   *  a cell missing from `{ cells }` read the declaration and PASSED, while
   *  `fullState(cart)` returned undefined for the very same cell: two APIs
   *  disagreeing, one of them silently vacuous. Assert on what is
   *  running, or say plainly that nothing is. */
  const assertBooted = (cell: AnyDoc, api: string): void => {
    const id = cell?.__aio?.id as string | undefined;
    if (!id) {
      throw new Error(
        `[aio] ui.${api}(): not a cell — pass the cell itself, e.g. ui.${api}(todo, …)`,
      );
    }
    if (cells.some((c) => c.__aio.id === id)) return;
    const booted = cells.map((c) => c.__aio.id).join(", ") || "(none)";
    throw new Error(
      `[aio] ui.${api}(): cell '${id}' is not booted in this mount, so its ` +
        `state would read as its DECLARED INITIAL and the assertion would ` +
        `pass without testing anything. Booted: ${booted}. Import '${id}' ` +
        `from your App's module graph, or pass it in { cells: [...] }.`,
    );
  };

  /** The state `expectCell`'s predicate just read — the booted slice from the
   *  standalone store, falling back to the cell def's own view for a client
   *  cell (whose state lives in the page runtime, not the server store). */
  const cellStateFor = (cell: AnyDoc): unknown => {
    const id = cell?.__aio?.id as string | undefined;
    const slice = id === undefined
      ? undefined
      : standaloneApp?.getState()?.[id];
    if (slice !== undefined) return slice;
    try {
      // A client cell: read its declared keys off the reactive def.
      const keys = Object.keys((cell?.__aio?.state ?? {}) as object);
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = (cell as Record<string, unknown>)[k];
      return out;
    } catch {
      return undefined;
    }
  };

  const api = {
    surface: () => serializeSurface(currentSurface()),
    // The mount's OWN window and document — the same objects `window` and
    // `document` resolve to inside the component. A test that needs the real
    // thing (dispatch a `resize`, read `location`, register a listener where
    // the component's one lives) reaches them here instead of re-creating a
    // happy-dom of its own (field report §4.1).
    window: (ownedWindow ?? (doc as AnyDoc).defaultView ?? null) as AnyDoc,
    document: doc as AnyDoc,
    // Unfiltered server-authoritative state — what a server route sees
    // via app.getState(), including `ui.exclude`d fields the client proxy hides.
    // `serverState()` = whole store; `fullState(cell)` = one cell's slice.
    serverState: (): Record<string, unknown> => standaloneApp?.getState() ?? {},
    // Mid-test seeding, for a flow that must react to a machine-dependent value
    // CHANGING (a device appearing, telemetry moving) rather than starting at
    // one. `{ seed }` at mount covers the common case.
    seed: (partial: Record<string, Record<string, unknown>>) => {
      if (!seedState) {
        throw new Error(
          "[aio] ui.seed(): no cells are booted in this mount — pass { cells } " +
            "or import the cells your App uses",
        );
      }
      seedState(partial);
    },
    fullState: (cell: AnyDoc): unknown => {
      assertBooted(cell, "fullState");
      return standaloneApp?.getState()?.[cell?.__aio?.id as string];
    },
    // Public settle is an observation point: drains the action queue first
    // (surfacing failures from un-awaited actions), then waits quiescence.
    settle: async () => {
      await drain();
      // strict: this IS the observation point. "Quiesced" and "gave up" must
      // not be the same answer here.
      await settle(true);
    },
    // Advance the virtual schedule clock by `ms` and fire everything now due —
    // drives toast auto-dismiss / debounce / backoff / poll deterministically
    // in tests. Then settles so the UI reflects the fired actions.
    advance: async (ms: number) => {
      await advanceSchedules?.(ms);
      await drain();
      await settle(true); // an observation point too — see settle above
    },
    html: () => String(root.innerHTML),
    present: (name: string, kind?: UIKind): boolean => showing(name, kind),
    absent: (name: string, kind?: UIKind): boolean => !showing(name, kind),
    async expectCell(
      cell: AnyDoc,
      pred: (c: AnyDoc) => boolean,
      msg?: string,
    ) {
      await drain();
      assertBooted(cell, "expectCell");
      // …and a key the cell does not HAVE is a broken assertion, not a false
      // one. See `guardUnknownKeys`.
      const subject = guardUnknownKeys(cell, "expectCell");
      // Retry briefly (like waitFor): a client-scoped cell's reactive binding
      // can land a beat after the first render, and a one-shot check read it
      // as "predicate wrong" — which sent people debugging the app instead of
      // the harness (a field report).
      const deadline = Date.now() + 2000;
      // A predicate that keeps THROWING is a broken predicate, not a slow one:
      // `c.missing.nested === 5` used to be swallowed for the full 2s and then
      // reported as a plain assertion failure, hiding the TypeError that says
      // exactly what is wrong.
      let lastErr: unknown;
      while (true) {
        await settle();
        try {
          if (pred(subject)) return;
          lastErr = undefined; // it ran; it was merely false
        } catch (e) {
          lastErr = e;
        }
        if (Date.now() >= deadline) break;
        await tick(20);
      }
      if (lastErr !== undefined) throw lastErr;
      const id = cell?.__aio?.id ?? "?";
      const scopeNote = cell?.__aio?.scope === "client"
        ? ` Note: '${id}' is scope:'client' — its state lives in the page ` +
          `runtime. If this predicate is true in the UI, read the cell ` +
          `directly after ui.settle() (client cells are invisible to the ` +
          `server store and to \`am state\`; \`am surface\` sees their UI).`
        : "";
      // The state the predicate saw. `t.expect.state` has printed it since it
      // existed; `expectCell` said only "failed for cell 'notes'", so the two
      // assertion APIs for the same fact disagreed on whether a failure is
      // worth explaining — and the one people are told to use was the useless
      // one. Same formatter, so they cannot drift again.
      throw new Error(
        `${
          msg ?? `testUI: expectCell failed for cell '${id}'.${scopeNote}`
        } state: ${formatCellState(cellStateFor(cell))}` +
          // The predicate may be false only because the app never went quiet —
          // that is a different bug with a different fix, and saying so beats
          // sending the reader after a predicate that is fine.
          (_gaveUp ? `\n  ${_gaveUp}` : ""),
      );
    },
    async waitFor(
      pred: () => boolean,
      o?: string | { timeoutMs?: number; msg?: string },
    ): Promise<void> {
      // Trailing description string mirrors expectCell's — the asymmetry
      // (`waitFor(pred, "msg")` → TS2559) surprised the field.
      const opts = typeof o === "string" ? { msg: o } : o;
      await drain();
      const deadline = Date.now() + (opts?.timeoutMs ?? 3000);
      // Transient throws are expected (the surface is still changing), a
      // PERMANENT one is a bug in the predicate — so keep the last error and
      // raise it instead of a timeout that says nothing about the TypeError
      // that actually happened.
      let lastErr: unknown;
      while (Date.now() < deadline) {
        await settle();
        try {
          if (pred()) return;
          lastErr = undefined; // it ran; it was merely false
        } catch (e) {
          lastErr = e;
        }
        await tick(20);
      }
      if (lastErr !== undefined) throw lastErr;
      throw new Error(
        `testUI: waitFor timed out${opts?.msg ? ` — ${opts.msg}` : ""}.\n` +
          "  current surface: " + surfaceDigest(currentSurface()) +
          // "waited 3s and the predicate stayed false" reads as an app bug; if
          // settle() was giving up every poll, it is not (see settle()).
          (_gaveUp ? `\n  ${_gaveUp}` : ""),
      );
    },
    find(component: string, key?: string | number): UIComponentHandle {
      return componentHandle(() =>
        oneComponent(currentSurface(), component, key)
      );
    },
    unmount() {
      _unmount(handle);
      ledger?.restore(); // put the cells' own methods back before the reset
      resetRuntime?.();
      // The process-global half — see the note at boot. Teardown that leaves
      // `_pending` populated hands the NEXT test a `settle()` that can only
      // time out.
      _resetAioRuntime();
      // Owned window: close in the background (fire-and-forget is safe for
      // happy-dom; use dispose() when you need to await it).
      ownedWindow?.happyDOM?.close()?.catch?.(() => {
        // aio-ok: teardown is fire-and-forget by design here — dispose() is
        // the spelling that awaits it.
      });
      ownedWindow = null;
      partial.window = null;
      for (const key of _ownedGlobals.splice(0)) {
        delete (globalThis as AnyDoc)[key];
      }
      for (const restore of _restoreGlobals.splice(0)) restore();
    },
    async dispose() {
      // Drain first — a failure from an un-awaited action must fail the
      // test, not vanish in teardown. Teardown runs regardless.
      try {
        await drain();
      } finally {
        _unmount(handle);
        ledger?.restore(); // put the cells' own methods back before the reset
        resetRuntime?.();
        _resetAioRuntime(); // see unmount() — process-global residue
        if (ownedWindow) {
          await ownedWindow.happyDOM?.close();
          ownedWindow = null;
          partial.window = null;
        }
        for (const key of _ownedGlobals.splice(0)) {
          delete (globalThis as AnyDoc)[key];
        }
        for (const restore of _restoreGlobals.splice(0)) restore();
      }
    },
    [Symbol.asyncDispose]() {
      return this.dispose();
    },
  };

  return new Proxy(api as AnyDoc, {
    get(target, prop: string | symbol) {
      if (typeof prop === "symbol" || prop in target) {
        return (target as AnyDoc)[prop];
      }
      const name = prop as string;
      // A component by that name wins (ui.App / ui.TodoRow).
      let surf: UISurfaceNode | undefined;
      try {
        surf = currentSurface();
      } catch {
        // aio-ok: `currentSurface()` throws before the first mount. Nothing is
        // on screen yet BY DEFINITION, so the lazy handle below (which
        // re-resolves at use time) is the correct answer, not an error.
      }
      if (surf && findComponents(surf, name).length > 0) {
        // Shadow rule: if the name ALSO uniquely addresses an
        // interactive element, the returned handle acts as the ELEMENT
        // (click/type/value) while still navigating the component.
        return shadowHybrid(currentSurface, name, api.find(name));
      }
      // hoist a `t`/data-testid element handle to the top level,
      // regardless of nesting — `ui.watchPubkey` instead of the positional
      // `ui.find("Input", 1).watchPubkey`. Requires a UNIQUE match.
      if (surf) {
        const els = liveElements(surf, name);
        if (els.length === 1) {
          return elementHandle(() => resolveElement(els[0]!.path, name));
        }
        // Ordinal instance access: ui.Button2 → 2nd Button in tree order.
        const ord = ordinalComponent(surf, name);
        if (ord) {
          return componentHandle(() => {
            const again = ordinalComponent(currentSurface(), name);
            if (!again) fail(`testUI: component "${name}" disappeared`, []);
            return again;
          });
        }
        if (els.length > 1) {
          fail(
            `testUI: "${name}" matches ${els.length} elements on the surface — ` +
              `disambiguate with ui.<Component>2.${name} (ordinal, tree order) ` +
              `or ui.find("Component", key).${name}`,
            els.map((e) => e.path),
            name,
          );
        }
      }
      // Nothing by that name is on the surface YET. It may be either kind —
      // a component that has not mounted, or an ELEMENT a queued action is
      // about to reveal — so commit to neither: element actions resolve as
      // elements at use time, everything else falls through to the component
      // handle. Committing to "component" here is what made the documented
      // promise ("ui.OpenButton.click(); ui.Modal.Confirm.click() — resolved
      // when its turn comes") false for `ui.reveal.click(); ui.field.type(…)`,
      // and the failure named the wrong namespace on the way out.
      return lazyHybrid(name);
    },
  }) as TestUI;
}
