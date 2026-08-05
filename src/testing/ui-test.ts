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

import { _armTestStrict } from "./test-strict.ts";
import { _setDocument, _unmount, mount } from "../air/aio-renderer.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";
import type { ComponentFn } from "../air/vdom-types.ts";
import type { MountHandle, RootState } from "../air/renderer-types.ts";
import { _rootStateMap } from "../air/renderer-state.ts";
import {
  buildUISurface,
  findComponents,
  findElementsDeep,
  serializeSurface,
  type UIElementInfo,
  type UISurfaceNode,
} from "../air/ui-surface.ts";
import type { KeyModifiers } from "../air/ui-trigger.ts";
import {
  triggerAction,
  triggerChar,
  triggerClear,
  triggerDragTo,
  triggerScroll,
  triggerSelect,
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
}

/** A triggerable element of the semantic UI surface. Actions run on an
 *  ordered queue — **awaits are optional**: `ui.A.click(); ui.B.click();`
 *  executes in order, and the next observation point (`settle`, `expectCell`,
 *  `waitFor`, dispose) waits for everything and surfaces any failure. Each
 *  action still returns a promise that settles the app (renders flushed,
 *  dispatch drained) when you do want to await it. */
export interface UIElementHandle {
  /** Full click sequence: pointerdown → mousedown → pointerup → mouseup → click. */
  click(): Promise<void>;
  /** Double click (after a full click sequence). */
  dblclick(): Promise<void>;
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
  /** Hover: mouseover + mouseenter. */
  hover(): Promise<void>;
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
  /** Wait until the app is quiescent (renders flushed, no pending updates). */
  settle(): Promise<void>;
  /** Advance the virtual schedule clock by `ms` and fire every `schedule.after`
   *  / `schedule.every` now due, then settle — makes toast auto-dismiss,
   *  debounce, backoff, and poll deterministically testable without real timers. */
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
  /** True when nothing named `name` is SHOWING — no element with that handle,
   *  and no component of that name that put anything on screen. A component
   *  which rendered `null` counts as absent: it has a surface node (it ran), but
   *  it produced nothing, and "did it render anything" is the question being
   *  asked. The negative assertion the surface was missing: a test for "the
   *  advice panel is gone" was otherwise written as
   *  `assert(!ui.html().includes("placement-advice"))`, which is stringly-typed
   *  and keeps passing for the wrong reason after a class rename. Composes with waitFor: `await ui.waitFor(() => ui.absent("Toast"))`. */
  absent(name: string): boolean;
  /** Inverse of {@linkcode absent} — reads better in a positive assertion. */
  present(name: string): boolean;
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

function fail(msg: string, available: string[]): never {
  throw new Error(
    `${msg}\n  available: ${
      available.length ? available.join(", ") : "(none)"
    }` +
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
 *  in tree (depth-first) order, 2-based to mirror element name de-duping
 *  (`Input`, `Input2`, …). Only kicks in when no exact name matched, so a
 *  component genuinely named `Button2` always wins. */
function ordinalComponent(
  scope: UISurfaceNode,
  prop: string,
): UISurfaceNode | undefined {
  const m = /^(.*[^\d])(\d+)$/.exec(prop);
  if (!m) return undefined;
  const n = Number(m[2]);
  if (n < 2) return undefined;
  const hits = findComponents(scope, m[1]!);
  return hits.length >= n ? hits[n - 1] : undefined;
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

async function _mountTestUI(
  App: ComponentFn,
  opts: TestUIOptions,
): Promise<TestUI> {
  let doc: AnyDoc = opts.document ?? (globalThis as AnyDoc).document;
  // Auto-DOM: create a happy-dom window when none was provided — and own its
  // lifecycle (closed on dispose). Lazy import keeps the DOM dep out of
  // production code paths entirely.
  let ownedWindow: AnyDoc = null;
  // Globals we installed from the owned window (restored on dispose).
  // Local hotfix: was referenced but never declared — TS2304 +
  // ReferenceError on the auto-DOM path.
  const _ownedGlobals: string[] = [];
  /** Teardown callbacks for globals we PATCHED (rather than defined). */
  const _restoreGlobals: (() => void)[] = [];
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
      ownedWindow = new hd.Window({ url: "http://localhost/" });
      doc = ownedWindow.document;
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
    } catch {
      throw new Error(
        "testUI: no DOM available — add happy-dom to your deno.json imports " +
          '("happy-dom": "npm:happy-dom@^17"), or pass { document } yourself',
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
  globalThis.addEventListener = function (
    this: unknown,
    type: string,
    ...rest: unknown[]
  ) {
    if (DOM_UI_EVENTS.has(type) && !_warnedGlobalEvents.has(type)) {
      _warnedGlobalEvents.add(type);
      console.warn(
        `[aio:testUI] "${type}" listener registered on the Deno global — it ` +
          `will NEVER fire here. testUI dispatches on the happy-dom window, ` +
          `so this handler is inert (in a browser the two are the same ` +
          `object, which is why the code looks right).\n` +
          `  fix: register on the document's window — e.g. inside onMount, ` +
          `\`el.ownerDocument.defaultView.addEventListener("${type}", …)\`, ` +
          `or attach the handler to the element itself.`,
      );
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
    } catch { /* read-only host storage — best effort */ }
  }

  // Boot the cells on the local dispatch loop (the android/standalone runtime —
  // real method binding, reactive getters, ack semantics). Default: every
  // `cell()` the App transitively imported has self-registered — boot them
  // all; pass { cells } only to restrict the set.
  let resetRuntime: (() => void) | undefined;
  let advanceSchedules: ((ms: number) => void) | undefined;
  // The standalone (server-authoritative) app handle — exposed via
  // ui.serverState()/ui.fullState() so a test can read UNFILTERED state,
  // including `ui.exclude`d fields a server route legitimately reads.
  let standaloneApp: { getState: () => Record<string, unknown> } | undefined;
  let seedState:
    | ((p: Record<string, Record<string, unknown>>) => void)
    | undefined;
  const cells = opts.cells ?? [...getRegisteredCells().values()];
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
    if (!opts.persist) standalone._resetState();
    standaloneApp = await standalone.aio.run({
      appId: "testui",
      cells,
      // Hermetic by default: no cross-test state leaks through the (shared)
      // localStorage persist key. Opt in via { persist: true }.
      persist: opts.persist ?? false,
      persistKey: `testui:${crypto.randomUUID().slice(0, 8)}`,
    }) as unknown as { getState: () => Record<string, unknown> };
    // Seed BEFORE the first render, so the component's very first pass already
    // sees the fixture (a seed applied after mount would test the re-render path
    // instead of the initial one, which is rarely what a test means).
    if (opts.seed) standalone._seedState(opts.seed);
    seedState = standalone._seedState;
    // Dispose does a state-only reset (keeps the registry so re-mounts boot).
    resetRuntime = standalone._resetState;
  }

  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const handle: MountHandle = mount(root, App);
  const state: RootState | undefined = _rootStateMap.get(handle);

  async function settle(): Promise<void> {
    let prev = "";
    for (let i = 0; i < maxIter; i++) {
      handle._flush();
      await tick();
      const now = root.innerHTML as string;
      if (now === prev && i > 0) return;
      prev = now;
    }
  }

  function currentSurface(): UISurfaceNode {
    const vnode = state?.vnode ?? null;
    const s = buildUISurface(vnode as AnyDoc);
    if (!s) throw new Error("testUI: app is not mounted");
    return s;
  }

  /** Re-resolve an element by path at action time — never acts on stale refs. */
  function resolveElement(path: string): UIElementInfo {
    const found: UIElementInfo[] = [];
    const visit = (n: UISurfaceNode) => {
      for (const e of n.elements) if (e.path === path) found.push(e);
      n.children.forEach(visit);
    };
    visit(currentSurface());
    const el = found[0];
    if (!el || !el._el) {
      const names: string[] = [];
      const collect = (n: UISurfaceNode) => {
        n.elements.forEach((e) => names.push(e.path));
        n.children.forEach(collect);
      };
      collect(currentSurface());
      fail(`testUI: element "${path}" is not on the current surface`, names);
    }
    return el;
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
  }

  function elementHandle(resolveInfo: () => UIElementInfo): UIElementHandle {
    const el = () => resolveInfo()._el! as AnyDoc;
    // A real user cannot operate a disabled control — interacting with one
    // fails loud with its state instead of firing a dead event or a bare
    // "not a function" TypeError. Assert `ui.….X.disabled` instead.
    const assertEnabled = (verb: string) => {
      const i = resolveInfo();
      if (i.disabled) {
        throw new Error(
          `testUI: cannot ${verb} "${i.name}" — the ${i.tag} is disabled\n` +
            `  assert it instead: ui.….${i.name}.disabled === true (or enable it first)`,
        );
      }
    };
    // verb: user-gesture actions guard against disabled at action time
    // (queue-time, so un-awaited sequences fail at the next drain point).
    const act = (verb: string | null, fn: (e: AnyDoc) => void) =>
      enqueue(async () => {
        if (verb) assertEnabled(verb);
        fn(el());
        await settle();
      });
    return {
      get info() {
        return resolveInfo();
      },
      click() {
        return act("click", (e) => triggerAction(e, "click"));
      },
      dblclick() {
        return act("dblclick", (e) => triggerAction(e, "dblclick"));
      },
      type(text: string) {
        return enqueue(async () => {
          assertEnabled("type into");
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
      hover() {
        return act(null, (e) => triggerAction(e, "hover"));
      },
      focus() {
        return act(null, (e) => triggerAction(e, "focus"));
      },
      blur() {
        return act(null, (e) => triggerAction(e, "blur"));
      },
      select(value: string) {
        return act("select on", (e) => triggerSelect(e, value));
      },
      check() {
        return act("check", (e) => {
          if (!e.checked) triggerAction(e, "click");
        });
      },
      uncheck() {
        return act("uncheck", (e) => {
          if (e.checked) triggerAction(e, "click");
        });
      },
      clear() {
        return act("clear", (e) => triggerClear(e));
      },
      setValue(text: string) {
        return enqueue(async () => {
          assertEnabled("set value on");
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
        elsewhere = findElementsDeep(currentSurface(), name);
      } catch { /* unmounted — plain listing below */ }
      fail(
        `testUI: "${name}" is not an element of ${node.path}` +
          (shadowed
            ? `\n  hint: "${node.component}" names both this component and something inside it — use ui.${node.component}.${node.component}`
            : "") +
          (elsewhere.length > 0
            ? `\n  found elsewhere: ${elsewhere.map((e) => e.path).join(", ")}${
              elsewhere.length === 1 ? ` — reachable as ui.${name}` : ""
            }`
            : ""),
        listNames(node),
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
          const hit = findComponents(parent, name)[0] ??
            ordinalComponent(parent, name);
          if (!hit) {
            fail(
              `testUI: component "${name}" not found under ${parent.path}`,
              listNames(parent),
            );
          }
          return hit;
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
      unique = findElementsDeep(selectScope(), name).length === 1;
    } catch { /* not mounted yet — component semantics only */ }
    if (!unique) return comp;
    const eh = elementHandle(() => {
      const els = findElementsDeep(selectScope(), name);
      if (els.length === 1 && els[0]!._el) return els[0]!;
      fail(
        `testUI: element "${name}" is not on the current surface`,
        els.map((e) => e.path),
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
        return componentHandle(() => {
          const hits = findComponents(select(), component, key);
          if (hits.length === 0) {
            fail(
              `testUI: component "${component}"${
                key !== undefined ? ` [key=${key}]` : ""
              } not found under ${select().path}`,
              listNames(select()),
            );
          }
          return hits[0]!;
        });
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
        if (elInfo) return elementHandle(() => resolveElement(elInfo.path));
        // Component by exact name — direct child first, then deep search.
        const child = node.children.find((c) => c.component === prop) ??
          findComponents(node, prop as string)[0];
        if (child) {
          const comp = componentHandle(() => {
            const again = findComponents(select(), prop as string)[0];
            if (!again) {
              fail(`testUI: component "${String(prop)}" disappeared`, []);
            }
            return again;
          });
          return shadowHybrid(select, prop as string, comp);
        }
        // Element anywhere below this node — same hoist the top level does
        //, so `ui.ToolBar.Settings` reaches a `t`-handle inside a
        // child component without positional navigation.
        const els = findElementsDeep(node, prop as string);
        if (els.length === 1) {
          return elementHandle(() => resolveElement(els[0]!.path));
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
          );
        }
        // Not on the surface YET — hand back a lazy handle so un-awaited
        // sequences can target UI a prior queued action will create.
        return lazyHandle(select, prop as string);
      },
    }) as UIComponentHandle;
  }

  await settle();

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

  const api = {
    surface: () => serializeSurface(currentSurface()),
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
      await settle();
    },
    // Advance the virtual schedule clock by `ms` and fire everything now due —
    // drives toast auto-dismiss / debounce / backoff / poll deterministically
    // in tests. Then settles so the UI reflects the fired actions.
    advance: async (ms: number) => {
      advanceSchedules?.(ms);
      await drain();
      await settle();
    },
    html: () => String(root.innerHTML),
    present: (name: string): boolean => {
      const scope = currentSurface();
      return findComponents(scope, name).some(showsSomething) ||
        findElementsDeep(scope, name).length > 0;
    },
    absent: (name: string): boolean => {
      const scope = currentSurface();
      return !findComponents(scope, name).some(showsSomething) &&
        findElementsDeep(scope, name).length === 0;
    },
    async expectCell(
      cell: AnyDoc,
      pred: (c: AnyDoc) => boolean,
      msg?: string,
    ) {
      await drain();
      assertBooted(cell, "expectCell");
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
          if (pred(cell)) return;
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
      throw new Error(
        msg ?? `testUI: expectCell failed for cell '${id}'.${scopeNote}`,
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
          "  current surface: " + surfaceDigest(currentSurface()),
      );
    },
    find(component: string, key?: string | number): UIComponentHandle {
      return componentHandle(() => {
        const hits = findComponents(currentSurface(), component, key);
        if (hits.length === 0) {
          fail(
            `testUI: component "${component}"${
              key !== undefined ? ` [key=${key}]` : ""
            } not found`,
            [currentSurface().component],
          );
        }
        return hits[0]!;
      });
    },
    unmount() {
      _unmount(handle);
      resetRuntime?.();
      // Owned window: close in the background (fire-and-forget is safe for
      // happy-dom; use dispose() when you need to await it).
      ownedWindow?.happyDOM?.close()?.catch?.(() => {});
      ownedWindow = null;
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
        resetRuntime?.();
        if (ownedWindow) {
          await ownedWindow.happyDOM?.close();
          ownedWindow = null;
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
        /* nothing mounted yet — fall through to lazy component find */
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
        const els = findElementsDeep(surf, name);
        if (els.length === 1) {
          return elementHandle(() => resolveElement(els[0]!.path));
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
          );
        }
      }
      // ui.App / ui.AnyComponent → lazy component handle (may appear later)
      return api.find(name);
    },
  }) as TestUI;
}
