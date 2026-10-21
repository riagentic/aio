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
//
// The internals live beside it: ui-test-names.ts (name lookup and misses),
// ui-test-wire.ts (wire emulation), ui-test-env.ts (browser environment),
// ui-test-build.ts (_buildTestUI, the handle builder).

// The bare imports below load what ui-test-*.ts now use in the order this
// file always loaded it — every one of them before the dev-only chunk.
import "../state/method-rejection.ts";
import { _armTestStrict } from "./test-strict.ts";
import { closeWindow } from "./close-window.ts";
import "./happy-dom-repair.ts";
// Server-touching, so NOT in test-strict.ts — see boot-refusals.ts.
import { _shedLeakedScopes } from "./boot-refusals.ts";
import type { HarnessBootOptions } from "./boot-refusals.ts";
import "./test-format.ts";
import { callerTestFile, isVideoFailure } from "./ui-video.ts";
import { frozenWriteMessage, isFrozenWriteError } from "../state/immutable.ts";
import "../state/signal.ts";
import "../state/runtime-reset.ts";
import "../state/method-cancel.ts";
import type { AioUser, AuthFeatures } from "../protocol/protocol-types.ts";
import "../air/aio-renderer.ts";
import "../air/router-core.ts";
// THE DEV-ONLY CHUNK, statically. In a browser it is fetched on demand (a
// production bundle does not carry it — see air/dev-hooks.ts); here it is a
// plain import, so every audit and hint it installs is armed BEFORE the first
// render rather than one microtask into it. Tests are the strictest
// environment, never the most permissive: a harness that raced the load would
// let a warning be green by arriving late.
import "../browser/dev-diagnostics.ts";
import type { ComponentFn } from "../air/vdom-types.ts";
import type { UIElementInfo, UISurfaceNode } from "../air/ui-surface.ts";
import type { KeyModifiers } from "../air/ui-trigger.ts";
import { _reshapedNote } from "./ui-test-wire.ts";
import { _buildTestUI, _dropWindowHold } from "./ui-test-build.ts";
import type { PartialMount } from "./ui-test-build.ts";

// deno-lint-ignore no-explicit-any
export type AnyDoc = any;

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
  /** The app's `aio.run({ wire })` — same reason: with
   *  `omitTrailingUndefined` a UI call's trailing `undefined` is not sent, so
   *  it is not a wire loss here either and the method gets its default.
   *  Unset, a trailing `undefined` fails the test (it arrives as `null`).
   *
   *  `strict: true` — the rest of a client call crosses the wire too, as it
   *  does in the app (docs/testing/ui-testing.md, "Calls cross the wire"):
   *  a rejected call reaches its caller as a plain `Error` with the server's
   *  message and `code`; a component's `serverFn` call goes through the
   *  server's route (its access rule, JSON arguments, the `[server] ` prefix
   *  on a failure); `useAio().send(action)` runs the method, and an unknown
   *  type fails the test. Off by default — a test written against an older
   *  aio keeps the harness it passed on, and is told once per run what a
   *  real client would have seen instead. `am create` turns it on for a new
   *  app's whole run (`AIO_TEST_WIRE=strict` in its `test` task); this key
   *  decides for one mount, either way. */
  wire?: { omitTrailingUndefined?: boolean; strict?: boolean };
  /** Let a CONTAINED failure stay contained, instead of failing the test.
   *
   *  A hook that throws (`onMount`, a returned cleanup, a rAF callback) and an
   *  event handler that throws are caught on purpose: the render is kept and
   *  production logs and carries on. `testUI` surfaces them, because a
   *  `TypeError` in an `onClick` reported as a PASS is the green-test-broken-
   *  prod shape the harness exists to prevent.
   *
   *  Set this only when the throw IS the subject — a test proving that a
   *  broken hook does not collapse the surface, or that an error boundary
   *  catches what it should. The console line is printed either way. */
  allowContainedErrors?: boolean;
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
  /** The network for this test: every `fetch` the component makes — from the
   *  FIRST mount on — is answered by this function instead of the real one.
   *  Restored on dispose.
   *
   *  The component is mounted before the test body runs, so a stub the body
   *  installs is too late for an `onMount` fetch: that request has already
   *  gone to the real network (a field report's blocklist refresh did, and
   *  the test failed 2 of 6 runs with the download's speed). A module-level
   *  `globalThis.fetch = …` is in time but leaks into every other test in the
   *  file.
   *
   *  ```ts
   *  await testUI(Gate, { fetch: () => Response.json({ blocked: [] }) });
   *  ```
   *
   *  Omit for today's behaviour (the `fetch` that is installed at the mount). */
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Response | Promise<Response>;
  /** Enforce each cell's declarative `access` rule on interactions, as the
   *  server does for a real client. Default `true` since alpha76.
   *
   *  It used to be unenforced, so a `customer` clicking an admin-only Delete
   *  DELETED the product under `testUI` while the identical click over a real
   *  socket answered `ACCESS_DENIED`. That is the harness being MORE permissive
   *  than production, with authorization as the thing it was lenient about —
   *  the exact inversion of "tests are the strictest environment".
   *
   *  `access` is a rule about network callers, and a `testUI` click stands in
   *  for one. Set `false` only to drive a gated method deliberately (seeding a
   *  fixture, or testing the method itself rather than the button). */
  enforceAccess?: boolean;
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
  /** Simulated round trip, in ms. Each cell-method call is dispatched this
   *  much later (in call order), and `type()` / `setValue()` yield a
   *  macrotask between characters — so a UI that is only right when the
   *  answer is instant (a controlled input bound to a cell, typed faster
   *  than the server answers) fails here as it does over a real socket.
   *  Default 0: the local loop answers inside the handler. */
  latency?: number;
  /** Names this mount's video under `--video=<dir>/` (`"checkout flow"` →
   *  `checkout-flow.mp4`). The wrapper form uses the test's name; without
   *  this the handle form is named after the test FILE. */
  name?: string;
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
   *  shortcut handler is testable.
   *
   *  Implicit submission follows the HTML rule, not "always": the form's first
   *  submit button is CLICKED, and a form without one submits only while at
   *  most one field blocks implicit submission — two text/number fields and a
   *  `type="button"` Send are dead to Enter here exactly as in the browser.
   *  Constraint validation then runs: an invalid field (a `required` blank, a
   *  `type="number"` holding "1.5" with the default `step` of 1) REFUSES the
   *  submit and throws with the field and its `validationMessage`, where a
   *  browser would show its bubble and submit nothing. `noValidate` on the
   *  `<form>` opts out, as it does in the browser. */
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
  /** True while a toggle button's `aria-pressed` is `"true"`. ALWAYS a
   *  boolean — same contract as {@linkcode UIElementHandle.checked} — so
   *  `assertEquals(ui.Mute.pressed, false)` is writable. `false` when the
   *  element has no `aria-pressed`. */
  readonly pressed: boolean;
  /** True while a disclosure/menu trigger's `aria-expanded` is `"true"`.
   *  ALWAYS a boolean. `false` when the element has no `aria-expanded`. */
  readonly expanded: boolean;
  /** Read a live DOM attribute (`getAttribute`). Returns `null` when absent —
   *  same contract as the DOM. For asserting `aria-*` / `data-*` / `role` state
   *  the surface does not promote to first-class fields (except `pressed` /
   *  `expanded` / `checked`, which are assertable booleans). */
  attr(name: string): string | null;
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
   *  same objects while the harness is up.
   *
   *  It also answers the three KEY actions, for a binding that belongs to no
   *  element (`onGlobalKey`): `ui.window.press("Escape")`,
   *  `ui.window.keyDown("ArrowLeft")`, `ui.window.keyUp("ArrowLeft")` — same
   *  address as `am trigger window press`, same ordered queue as every other
   *  action. Aiming a window-level key at a field instead is skipped by
   *  `ignoreInInput` and warns. */
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

/** Any function component. Wider than ComponentFn on purpose: components
 *  typed via `jsxImportSource: "aio"` return jsx-runtime's JSX.Element —
 *  the same VNode shape under a different declaration — and forcing callers
 *  to cast was a real papercut. The one cast lives here instead. */
// deno-lint-ignore no-explicit-any
export type TestableComponent = (props?: any) => unknown;

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
  // The test file is on the stack HERE — not in the wrapper's body, which the
  // runner calls — and the video takes the app's look from its project.
  const testFile = callerTestFile();
  // Wrapper form: testUI(App, "name", fn) — a Deno.test with auto-teardown.
  if (typeof optsOrName === "string") {
    if (typeof fn !== "function") {
      throw new Error('testUI(App, "name", fn): missing test function');
    }
    Deno.test(optsOrName, async () => {
      const ui = await _mountTestUI(
        App as ComponentFn,
        namedOpts,
        optsOrName,
        testFile,
      );
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
        if (e instanceof Error) e.message += _reshapedNote();
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
      if (bodyErr) {
        // The body's error is the one thrown; a teardown failure behind it
        // is still SAID — dropped, a video that could not be made left
        // nothing at all (no file, no line).
        if (teardownErr) {
          const t = teardownErr.e;
          console.error(
            isVideoFailure(t)
              ? `[aio:video] no video for this failed test: ${t}`
              : `[aio:testUI] teardown failed too, behind the test's own ` +
                `error: ${t}`,
          );
        }
        throw bodyErr.e;
      }
      if (teardownErr) throw teardownErr.e;
    });
    return;
  }
  return _mountTestUI(
    App as ComponentFn,
    optsOrName ?? {},
    undefined,
    testFile,
  );
}

async function _teardownPartialMount(p: PartialMount): Promise<void> {
  const step = async (what: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
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
  await step("unmount", () => p.unmount?.());
  await step("runtime reset", () => p.reset?.());
  await step("window close", async () => {
    const win = p.window;
    p.window = null;
    if (win && _dropWindowHold(win)) await closeWindow(win);
  });
  await step("globals", () => {
    for (const key of p.owned.splice(0)) delete (globalThis as AnyDoc)[key];
  });
  for (const restore of p.restore.splice(0)) await step("restore", restore);
}

async function _mountTestUI(
  App: ComponentFn,
  opts: TestUIOptions,
  name?: string,
  testFile?: string | null,
): Promise<TestUI> {
  // Synchronous, before the first await: the CALLER's context — the wrapper's
  // Deno.test body, or the handle form's own test — starts outside every
  // boot. A reducer's first import() pinned a dead boot's fence as Deno's
  // ambient context, and the next test's first call was refused.
  _shedLeakedScopes();
  // A throw anywhere in setup must leave the process exactly as it found it —
  // see PartialMount.
  const partial: PartialMount = { owned: [], restore: [], window: null };
  try {
    return await _buildTestUI(App, opts, partial, name, testFile);
  } catch (e) {
    await _teardownPartialMount(partial);
    throw e;
  }
}

/** Every addressable name on a mounted surface, in tree order.
 *
 * The list existed all along and was reachable only by PROVOKING A FAILURE: a
 * miss prints `available: …`, so "what can I address?" was answered by asking
 * for something that is not there (report 6 §5a). A fine recovery path and a
 * poor discovery one — and it is exactly the list you want BEFORE writing the
 * first line, not after the first mistake. `am surface --names` is the same
 * answer for a running app.
 *
 * ```ts
 * await using ui = await testUI(App);
 * await ui.settle();
 * console.log(uiNames(ui)); // ["Panel:SearchInput", "Panel:SaveButton", …]
 * ```
 *
 * Full `Component…:Element` paths — the form `am trigger` takes, and the only
 * form that can say WHICH instance. A surface with nothing addressable answers
 * `[]`; asking before the first mount answers `[]` too, because "no names yet"
 * is the honest reply to asking early, and making discovery itself throw would
 * be the shape this removes.
 *
 * A free function rather than a `ui.names()` member, and deliberately only
 * one spelling: a caller writes `uiNames(ui)` with no `?.`, where an optional
 * member would read `ui.names?.()` forever (the published `TestUI` is frozen,
 * so a member could only ever be added as optional). One name for one thing.
 */
export function uiNames(ui: TestUI): string[] {
  const f = (ui as unknown as { names?: () => string[] }).names;
  return typeof f === "function" ? f.call(ui) : [];
}

/**
 * Layout geometry for every addressable element in a surface, keyed by the
 * SAME `Component…:Element` path `am trigger` takes.
 *
 * happy-dom measures everything 0×0. That hid two security-relevant defects in
 * a wallet behind 1546 passing tests — a dApp origin running off the edge of
 * the approval card, and that dialog opening scrolled past the origin (report 1
 * §19.1/§22.2, report 6 §10.1). A harness that answers "0×0" to "where is
 * this?" is not merely unhelpful; it makes a layout assertion PASS.
 *
 * So this does not read the harness's DOM. It reads a surface that a REAL
 * client measured — `am surface --rects`, or the trojan `surface/N?rects=1`
 * against a browser opened with {@linkcode testBrowser}:
 *
 * ```ts
 * await using srv = await testServer({ cells: [todo] });
 * await using browser = await testBrowser(srv.url);
 * const { roots, measured } = await srv.trojan("surface/0?rects=1");
 * const box = uiRects(roots);
 * assert(box["App:OriginText"]!.w <= box["App:Card"]!.w, "origin overflows the card");
 * ```
 *
 * `measured.laidOut === 0` means nothing was laid out — a headless render, or
 * a window with no size yet — and the surface route says so rather than
 * answering with zeroes. Check it before trusting a rect, or use the value
 * this returns, which omits an unmeasured element entirely rather than
 * reporting it at the origin with no size.
 */
export function uiRects(
  roots: unknown,
): Record<string, { x: number; y: number; w: number; h: number }> {
  const out: Record<string, { x: number; y: number; w: number; h: number }> =
    {};
  const walk = (n: unknown): void => {
    const node = n as {
      elements?: {
        path?: string;
        rect?: { x: number; y: number; w: number; h: number };
      }[];
      children?: unknown[];
    };
    for (const el of node.elements ?? []) {
      // An UNMEASURED element is omitted, never reported as 0×0 at the
      // origin. A missing key fails an assertion loudly; a plausible zero
      // passes one.
      if (el.path && el.rect) out[el.path] = el.rect;
    }
    for (const c of node.children ?? []) walk(c);
  };
  for (const r of Array.isArray(roots) ? roots : [roots]) walk(r);
  return out;
}

/** The line `settle()` adds when it gives up while a `fetch` the component
 *  made is unanswered: which URL, and — when the test gave `testUI` no
 *  `fetch` — that it went to whatever was installed at the mount. `""` when
 *  nothing waits. */
export function fetchWaitNote(
  waiting: readonly { url: string; stubbed: boolean }[],
): string {
  if (waiting.length === 0) return "";
  const urls = [...new Set(waiting.map((w) => w.url))];
  const shown = urls.slice(0, 3).map((u) => `fetch(${u})`).join(", ") +
    (urls.length > 3 ? ` and ${urls.length - 3} more` : "");
  const how = waiting.every((w) => w.stubbed)
    ? "the `fetch:` given to testUI has not answered"
    : "testUI was given no `fetch:`, so it went to the fetch installed at " +
      "the mount (the real network, unless the file replaced it). A stub " +
      "set in the test body is too late for a request the mount makes: " +
      "pass `testUI(App, { fetch: () => new Response(…) })`";
  return `  waiting on ${shown} \u2014 ${how}.\n`;
}
