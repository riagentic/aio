// testUI's handle builder — _buildTestUI, which turns a mounted component's
// surface into the TestUI handle (element/component proxies, the ordered
// action queue, observations), the per-run state it sets, and the window
// holds a mount takes. Split out of ui-test.ts; internal to it — nothing
// here was ever exported.

import { withRefusalCode } from "../state/method-rejection.ts";
import {
  _abandonedCallsWarning,
  _DISPOSE_DRAIN_MS,
  _recordCalls,
  _watchInitFailures,
  _watchUnobservedCalls,
} from "./test-strict.ts";
import type { CallFailureLedger } from "./test-strict.ts";
import { _observationLedger } from "./test-strict.ts";
import { closeWindow } from "./close-window.ts";
import {
  acceptHostEvents,
  repairLabelActivation,
  repairProxiedSiblings,
} from "./happy-dom-repair.ts";
import {
  _armBootScope,
  _fenceMountRoot,
  _inMount,
  _isolateWorkerCellsInProcess,
  _refuseUnsafeCells,
} from "./boot-refusals.ts";
import { formatCellState, predicateVerdict } from "./test-format.ts";
import { appDirOf, openUiVideo } from "./ui-video.ts";
import type { UiVideoRecorder } from "./ui-video.ts";
import { _resetRootSignals } from "../state/signal.ts";
import { _resetAioRuntime } from "../state/runtime-reset.ts";
import {
  _inflightMethodKeys,
  _pendingCallPromises,
} from "../state/method-cancel.ts";
import { _setDocument, _unmount, mount } from "../air/aio-renderer.ts";
import { _installRouterListeners } from "../air/router-core.ts";
import {
  _resetContrastAudit,
  _setContrastCascadeProbe,
} from "../air/contrast-audit.ts";
import { contrastCascadeNotice } from "../air/contrast-cascade.ts";
import { _resetSelectorAudit } from "../air/selector-audit.ts";
import { _resetUntrackedReadWarnings } from "../air/untracked-read.ts";
import { _readAsClient, getRegisteredCells } from "../state/cell-reactive.ts";
import type { AioUser } from "../protocol/protocol-types.ts";
import { _resetDevWarnings } from "../air/vdom-types.ts";
import type { ComponentFn } from "../air/vdom-types.ts";
import type { MountHandle, RootState } from "../air/renderer-types.ts";
import { _activeRoot, _rootStateMap } from "../air/renderer-state.ts";
import { _setRenderErrorSink } from "../air/renderer-rerender.ts";
import { _setContainedErrorSink } from "../air/hook-error.ts";
import {
  _isForwardedHandle,
  _resetSurfaceWarnings,
  buildUISurface,
  collectElementPaths,
  findComponents,
  findElementsDeep,
  serializeSurface,
} from "../air/ui-surface.ts";
import type { UIElementInfo, UISurfaceNode } from "../air/ui-surface.ts";
import {
  assertOperable,
  hiddenReason as _hiddenReason,
  takesCharacters,
  triggerAction,
  triggerAssign,
  triggerChar,
  triggerClear,
  triggerDragTo,
  triggerScroll,
  triggerSelect,
  triggerSetChecked,
} from "../air/ui-trigger.ts";
import type { KeyModifiers } from "../air/ui-trigger.ts";
import { fetchWaitNote } from "./ui-test.ts";
import type {
  AnyDoc,
  TestUI,
  TestUIOptions,
  UIComponentHandle,
  UIElementHandle,
  UIKind,
} from "./ui-test.ts";
import {
  _historyFiresHashchange,
  _installSameDocumentHistory,
  _installViewport,
  _isolateLocalStorage,
  _nativeDialogs,
  _persistRunKey,
  _refuseDialog,
  _warnOnFakeLayout,
} from "./ui-test-env.ts";
import {
  _crossClientWire,
  _enforceCellAccess,
  _sendOverWire,
  _serverFnsOverWire,
  _useServerOriginScope,
  _useWireConfig,
  _wireStrict,
  _workerCallOverWire,
} from "./ui-test-wire.ts";
import {
  DOM_ANTIPATTERN_PROPS,
  elementSuggestions,
  fail,
  lastSegment,
  listNames,
  liveSubtreeElements,
  NAME_LIMIT,
  oneComponent,
  ordinalComponent,
  parentOf,
  refuseDomAntipattern,
  resolveKey,
  showsSomething,
  surfaceDigest,
  tick,
  traceSafe,
  uiSpelling,
  writeTrace,
} from "./ui-test-names.ts";

/** The live trace inputs, installed per mount. `null` between mounts. */
export let _traceSource: (() => Record<string, unknown>) | null = null;

/** The live root a miss spells its candidates against. `null` between
 *  mounts. Installed and cleared beside `_traceSource`. */
export let _missSurface: (() => UISurfaceNode) | null = null;

/** The current mount's {@linkcode _wireStrict} — per mount, as `_reshaped`. */
export let _strict = false;

/** Is the current mount the handle form (`await using ui = await
 *  testUI(App)`)? Its body's failure never passes through the harness, so
 *  {@linkcode _reshapedNote} has no error to ride on: what a rejection lost
 *  on the wire is said when it is lost. Per mount, as `_strict`. */
export let _handleForm = false;

/** What the wire dropped from the rejections of this mount's client calls
 *  (newest last, capped) — said when the test body fails (`testUI`'s wrapper
 *  form): a check on what did not cross is why. Reset per mount. */
export let _reshaped: string[] = [];
let _dialogHolds = 0;

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
export type PartialMount = {
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
 *  rest, and the original error is what the test needs to see.
 *
 *  Awaited, window close included: a refused mount (`testUI` says no to a
 *  credential-bearing cell, a component that throws) used to close its
 *  happy-dom window fire-and-forget, and happy-dom's abort-all-tasks arms a
 *  timer the test then ended on top of — so every test that asserts a
 *  refusal was a test that leaked, and the harness itself was what leaked. */
/** How many mounts are using each window testUI made.
 *
 *  A `testUI` started while another is mounted renders into the FIRST one's
 *  document — it is `globalThis.document` by then — so that window has to
 *  outlive whichever of them is disposed first. MEASURED (happy-dom 20.14.5):
 *  a closed window is destroyed, and its nodes dispatch to no listener;
 *  17.6.3's went on working after `close()`, which is all the overlapping
 *  case ever stood on. The last mount out closes it. */
const _windowHolds = new WeakMap<object, number>();

/** Drop one mount's hold on `win`; true when it was the last, and the caller
 *  closes the window. */
/** The handle's count of queued actions that have not run yet — read by the
 *  `testUI(App, name, fn)` wrapper when the body throws. @internal */
export const _QUEUED: unique symbol = Symbol("aio.testUI.queued");

export function _dropWindowHold(win: object): boolean {
  const left = (_windowHolds.get(win) ?? 1) - 1;
  if (left > 0) {
    _windowHolds.set(win, left);
    return false;
  }
  _windowHolds.delete(win);
  return true;
}

export async function _buildTestUI(
  App: ComponentFn,
  opts: TestUIOptions,
  partial: PartialMount,
  name?: string,
  testFile?: string | null,
): Promise<TestUI> {
  let doc: AnyDoc = opts.document ?? (globalThis as AnyDoc).document;
  // The contrast walk stands down, SAYING so, on a DOM whose style cascade is
  // not a browser's — happy-dom's is not (report 9 §1). Installed here, not
  // imported by the renderer: production pages never need the CSSOM walk.
  _setContrastCascadeProbe(contrastCascadeNotice);
  // Auto-DOM: create a happy-dom window when none was provided — and own its
  // lifecycle (closed on dispose). Lazy import keeps the DOM dep out of
  // production code paths entirely.
  let ownedWindow: AnyDoc = null;
  /** A window another mount owns and this one renders into. */
  let sharedWindow: AnyDoc = null;
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
      _windowHolds.set(ownedWindow, 1);
      partial.window = ownedWindow; // so a later throw still closes it
      // BEFORE anything renders: happy-dom answers `null` for a `<form>` or
      // `<select>`'s siblings, and the reconciler's positional cursor walks
      // siblings. See happy-dom-repair.ts — it proves the defect first, so a
      // fixed happy-dom is left untouched.
      repairProxiedSiblings(ownedWindow);
      acceptHostEvents(ownedWindow);
      repairLabelActivation(ownedWindow);
      _installViewport(ownedWindow, vw, vh);
      _installSameDocumentHistory(
        ownedWindow,
        await _historyFiresHashchange(hd),
      );
      _warnOnFakeLayout(ownedWindow);
      // `document` and `window` as GLOBALS, from the same owned window.
      //
      // A component that writes `document.addEventListener("keydown", …)` —
      // the most common form there is — reached `globalThis.document`, which
      // is `undefined` in Deno. The read throws inside `onMount`, lifecycle
      // hooks are error-guarded by design, and the result was a handler that
      // simply never ran: no error, no clue. testUI's whole job is to BE a
      // browser for the component under test, and a browser has these.
      //
      // `CSS` for the same reason, and it was live in this repo: aio's own
      // `<Tabs>` called `CSS.escape` to find the tab to focus, and under
      // testUI the handler threw `CSS is not defined` — contained by design,
      // so the arrow keys just did nothing. A browser has it; the owned window
      // has it; only `globalThis` did not.
      for (
        const [key, value] of [
          ["document", ownedWindow.document],
          ["window", ownedWindow],
          ["CSS", ownedWindow.CSS],
        ] as const
      ) {
        if (value === undefined) continue;
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
          '("happy-dom": "npm:happy-dom@^20"), or pass { document } yourself',
        { cause: e },
      );
    }
  } else {
    // The caller's OWN document needs the same repair as the window above —
    // `testComponent` has always done it, and this path did not, so
    // `testUI(App, { document })` still stopped AIR's cursor at a `<form>` and
    // printed a false "ran out of DOM nodes" (report 9b §4). It proves the
    // defect first, so a browser-faithful DOM is left untouched.
    repairProxiedSiblings(doc.defaultView);
    acceptHostEvents(doc.defaultView);
    repairLabelActivation(doc.defaultView);
    // Another mount's window (see `_windowHolds`): held until this one is done.
    const held = _windowHolds.get(doc.defaultView);
    if (held) {
      sharedWindow = doc.defaultView;
      _windowHolds.set(sharedWindow, held + 1);
      partial.window = sharedWindow;
    }
  }
  const maxIter = opts.settleIterations ?? 20;
  /** The `fetch` calls made through this mount's guard and not answered yet. */
  const fetching = new Set<{ url: string; stubbed: boolean }>();

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

  // A relative `fetch("/media/x.txt")` has no server to reach under testUI.
  //
  // The component is right: in a browser the path resolves against the page's
  // origin and the app's own server answers. testUI runs the component in THIS
  // process with no HTTP server, so Deno's fetch said only `Invalid URL:
  // '/media/x.txt'` — true, and no help (a wall with no door). The call still
  // fails exactly as before; the error now says why and what to do instead.
  // Absolute URLs, `URL` objects and `Request`s pass through untouched.
  {
    const origFetch = globalThis.fetch;
    // `opts.fetch` is this test's network; without it, the one that was there.
    const stub = opts.fetch;
    const answer = stub
      ? (input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((res) => res(stub(input, init)))
      : origFetch;
    const guarded = function (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> {
      // What `settle()` names when it gives up: a call that waits on the
      // network reads as a slow METHOD otherwise, and the reader must work
      // out that the mount, not the test body, made the request.
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      const waiting = { url, stubbed: stub !== undefined };
      fetching.add(waiting);
      // Call through FIRST: a test that stubbed fetch before the mount may
      // answer relative URLs on purpose, and it must keep doing so. Only a
      // failure on a relative URL gets the better message.
      return Promise.resolve(answer(input, init)).catch(async (e: unknown) => {
        if (
          typeof input === "string" && !URL.canParse(input) &&
          e instanceof TypeError
        ) {
          // Under a deno.json `assets` mount the app's server answers it —
          // so testUI does, from disk, by the server's own rules. Not when
          // the test brought its own network (`opts.fetch`).
          const served = stub ? null : await _mountFetch(input, init, testFile);
          if (served) return served;
          throw withRefusalCode(
            new TypeError(
              `testUI: fetch("${input}") is a relative URL, and testUI runs the ` +
                `component with no HTTP server to answer it. Test what the ` +
                `server serves with testServer() from "aio/testing" (a real ` +
                `server: \`await srv.fetch("${input}")\`), or replace ` +
                `globalThis.fetch for this test to hand the component a Response.`,
              { cause: e },
            ),
            "RELATIVE_FETCH",
          );
        }
        throw e;
      }).finally(() => {
        fetching.delete(waiting);
      });
    } as typeof globalThis.fetch;
    globalThis.fetch = guarded;
    _restoreGlobals.push(() => {
      // Only undo OUR wrapper — a test that replaced fetch keeps its own.
      if (globalThis.fetch === guarded) globalThis.fetch = origFetch;
    });
  }

  // `new FormData(form)` is how a submit handler reads its form, and Deno's
  // `FormData` refuses an element that is not its own ("Illegal constructor"):
  // a form whose handler does that — `<SignIn/>` for one — could not be
  // submitted under testUI at all. The global becomes one that reads the
  // mounted DOM's form with the DOM's own `FormData` and is otherwise the
  // native one (what `fetch` takes as a body, what `instanceof` knows).
  {
    const Native = globalThis.FormData;
    const DomFormData = (doc.defaultView as AnyDoc)?.FormData;
    if (Native && DomFormData) {
      class TestFormData extends Native {
        constructor(form?: unknown, submitter?: unknown) {
          super();
          if (form === undefined || form === null) return;
          for (const [name, value] of new DomFormData(form, submitter)) {
            if (typeof value !== "string") {
              throw withRefusalCode(
                new TypeError(
                  `testUI: new FormData(form) met the file field "${name}" — ` +
                    `a file of the test DOM is not one this process's fetch ` +
                    `can send. Read the input's files in the handler instead.`,
                ),
                "FORMDATA_FILE",
              );
            }
            this.append(name, value);
          }
        }
        static override [Symbol.hasInstance](v: unknown): boolean {
          return Function.prototype[Symbol.hasInstance].call(Native, v);
        }
      }
      globalThis.FormData = TestFormData;
      _restoreGlobals.push(() => {
        // Only undo OUR class — a test that replaced it keeps its own.
        if (globalThis.FormData === TestFormData) globalThis.FormData = Native;
      });
    }
  }

  // A native dialog has no one to answer it under testUI. happy-dom has none,
  // so a component's `confirm("Delete?")` reached Deno's own: with no terminal
  // it answers false without a word (the click silently did nothing), on a
  // terminal it blocks the test on a y/N prompt — one test, hung at a desk and
  // a no-op in CI. It throws instead; a test that answers it
  // (`globalThis.confirm = () => true`) — before the mount or after —
  // gets its answer. `window.confirm` is the same dialog: the owned window
  // has none, so it defers to the global (the refusal or the test's answer).
  const dialogs = globalThis as unknown as Record<string, unknown>;
  for (const name of ["alert", "confirm", "prompt"] as const) {
    if (ownedWindow && typeof ownedWindow[name] !== "function") {
      ownedWindow[name] = (message?: unknown) =>
        (dialogs[name] as (m?: unknown) => unknown)(message);
    }
    if (dialogs[name] === _nativeDialogs[name]) {
      dialogs[name] = _refuseDialog[name];
    }
  }
  // Held per mount: an overlapping testUI's dispose must not hand the one
  // still mounted back to Deno's dialogs, nor leave the refusal behind the last.
  _dialogHolds++;
  _restoreGlobals.push(() => {
    if (--_dialogHolds > 0) return;
    for (const name of ["alert", "confirm", "prompt"] as const) {
      if (dialogs[name] === _refuseDialog[name]) {
        dialogs[name] = _nativeDialogs[name];
      }
    }
  });

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
  // …and the renderer's own failures. A component that throws on its FIRST
  // render fails the test (mount propagates); every render error AFTER that
  // was `console.error`'d and dropped, so the UI silently kept stale content
  // and an assertion on the old value passed. Same channel, same delivery
  // point: the next observation raises it.
  _setRenderErrorSink((err, component) => {
    _globalListenerFailures.push(
      withRefusalCode(
        new Error(
          `[aio:testUI] <${component}> threw while re-rendering, so the UI is ` +
            `showing STALE content: ${err.message}`,
          { cause: err },
        ),
        "STALE_RENDER",
      ),
    );
  });
  // …and the two channels beside it. A hook that throws (`onMount`, a
  // returned cleanup, a rAF callback) and an event handler that throws are
  // CONTAINED on purpose — the render is kept and production logs and carries
  // on — so both reached `console.error` and nothing else. A `TypeError` in
  // an `onClick`, which is the single most common app bug there is, was
  // reported by `testUI` as a PASS. Same channel as the render sink above,
  // same delivery point: the next observation raises it.
  _setContainedErrorSink((kind, e, component) => {
    if (opts.allowContainedErrors) return;
    const msg = e instanceof Error ? e.message : String(e);
    _globalListenerFailures.push(
      withRefusalCode(
        new Error(
          `[aio:testUI] ${kind}${
            component ? ` in <${component}>` : ""
          } threw. The framework CONTAINS this so production keeps rendering; ` +
            `a test must not pass on it: ${msg}`,
          e instanceof Error ? { cause: e } : undefined,
        ),
        "CONTAINED_THROW",
      ),
    );
  });
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
        const err = withRefusalCode(new Error(msg), "GLOBAL_LISTENER");
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
  // reset. So every hermetic mount gets a fresh in-memory store (see
  // `_isolateLocalStorage` — the host store is never cleared, and a reference
  // captured at import time is isolated too). `{ persist: true }` opts into
  // the host store for continuity.
  if (!opts.persist || !(globalThis as AnyDoc).localStorage) {
    _restoreGlobals.push(_isolateLocalStorage());
  }

  // Boot the cells on the local dispatch loop (the android/standalone runtime —
  // real method binding, reactive getters, ack semantics). Default: every
  // `cell()` the App transitively imported has self-registered — boot them
  // all; pass { cells } only to restrict the set.
  let resetRuntime: (() => void) | undefined;
  let advanceSchedules: ((ms: number) => Promise<void>) | undefined;
  let fireDueSchedules: (() => Promise<void> | null) | undefined;
  // The standalone (server-authoritative) app handle — exposed via
  // ui.serverState()/ui.fullState() so a test can read UNFILTERED state,
  // including `ui.exclude`d fields a server route legitimately reads.
  let standaloneApp: { getState: () => Record<string, unknown> } | undefined;
  /** This mount's boot fence: what the mount runs — its renders, its queued
   *  actions, its drains — arms timers as THIS mount's (boot-refusals.ts). */
  let mountFence: Parameters<typeof _inMount>[0];
  let seedState:
    | ((p: Record<string, Record<string, unknown>>) => void)
    | undefined;
  let ledger: CallFailureLedger | undefined;
  const latency = Math.max(0, opts.latency ?? 0);
  const latent = new Set<Promise<unknown>>(); // calls not yet dispatched
  const cells = opts.cells ?? [...getRegisteredCells().values()];
  // The state that does NOT live in a cell. A module-level `signal()` survives
  // a mount exactly as a cell singleton does, and used to be the half nothing
  // restored — so `zoom.set(2)` in one test silently became the starting point
  // of the next (an order-dependent failure that passes under --filter, which
  // is the worst way to find anything). Hermetic means all of the state, not
  // most of it. Before the cells boot, and independent of whether this app has
  // any: a signals-only UI leaked just as hard.
  if (!opts.persist) _resetRootSignals();
  // The renderer's own dev-audit memories. They are the same
  // "have I already said this?" class `_resetAioRuntime` clears for the
  // state layer — unreset, the SECOND test to trigger the same finding
  // sees silence, so "it warns about X" passes alone and fails in a suite
  // (or the reverse). They cannot live in `_resetAioRuntime` itself:
  // that is `src/state/`, which may not import `src/air/` (the boundary
  // matrix), and loosening a red gate to save a line is the wrong trade.
  // The harness is the next-best owner, and it is the one every UI test
  // goes through.
  //
  // EVERY mount: these sat inside `if (cells.length > 0)` below, so a
  // cell-less App mounted within the contrast walk's throttle of the mount
  // before it was never walked. Under `persist` too — that keeps the app's
  // state, and what an audit has already said is not state.
  _resetContrastAudit();
  _resetSelectorAudit();
  _resetUntrackedReadWarnings();
  _resetDevWarnings();
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
    _armBootScope(standalone._installBootScope);
    advanceSchedules = standalone._advanceSchedules;
    fireDueSchedules = standalone._fireDueSchedules;
    // Hermetic by default: cells are module singletons, so both their signal
    // state AND the standalone dispatch store survive across mounts. Reset the
    // runtime state (keeping the registry) so this mount re-composes from the
    // cells' declared initials — no cross-test leaks. Skipped when the test
    // opts into persistence (it wants continuity across runs).
    if (!opts.persist) {
      standalone._warnResetOfLiveBoot("testUI");
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
    // BEFORE the boot, because the boot is what runs `onInit` — and `onInit`
    // is one of the four things `access` documents as server origin. The GATE
    // cannot move here (it wraps the bound methods the boot installs, which do
    // not exist yet), but the SCOPE can, and the two are separable: the scope
    // is just an AsyncLocalStorage holder, refcounted, so installing it twice
    // is a no-op with two undos.
    //
    // Without this the claim was true by ACCIDENT — nothing refused an
    // `onInit` call because no gate existed yet, while `isServerOrigin()` read
    // false inside it. Three places said otherwise (`cell-types.ts`,
    // docs/auth/auth.md, and the commit that added the marker), and nothing
    // tested it. A claim with no test is this project's most reliable source
    // of bugs, so the claim is now the mechanism.
    partial.restore.push(_useServerOriginScope());
    // An `onInit` that throws fails the test at settle()/dispose() — recorded
    // during the boot, handed to the ledger below (test-strict.ts).
    const inits = _watchInitFailures(cells);
    partial.restore.push(() => inits.restore());
    standaloneApp = await standalone.aio.run({
      appId: "testui",
      cells,
      // Hermetic by default: no cross-test state leaks through the (shared)
      // localStorage persist key. Opt in via { persist: true }.
      persist: opts.persist ?? false,
      // `{ persist: true }` keeps ONE key per process — continuity across
      // this run's mounts, never a previous run's entry in Deno's on-disk
      // localStorage (see _persistRunKey).
      // Under the harness-only symbol: the runtime ignores an app's
      // `persistKey` (a server option) by design.
      // The store's debounce is the PRODUCTION one (100 ms), never a harness
      // value: a test that reads localStorage while mounted must see the write
      // an app's user would. (A 60 s window stood here for two releases to
      // make one internal test deterministic — and `{ persist: true }` wrote
      // nothing at all until dispose.)
      // The declared-type write guard a dev server runs, dev-strict.
      [standalone._HARNESS_SHAPE_GUARD]: true,
      [standalone._HARNESS_PERSIST_KEY]: opts.persist
        ? _persistRunKey()
        : `testui:${crypto.randomUUID().slice(0, 8)}`,
      cellDefaults: opts.cellDefaults,
      localFirst: opts.localFirst,
      // The harness is the STRICTEST environment (pitfalls.md): a refused
      // write rejects the method that made it, as it does over the wire —
      // whatever the app chose for its own in-process callers.
      refusalsReject: true,
      // The app's budgets — the effect budget AND the per-method call
      // ceiling: a method budgeted at 300 ms must reject at 300 here too, not
      // wait the built-in 30 s. (It was handed to the boot refusals above and
      // never to the runtime.)
      perfBudget: opts.perfBudget,
    }) as unknown as { getState: () => Record<string, unknown> };
    mountFence = standalone._bootFence(standaloneApp);
    // Undoable from HERE: everything after the boot can throw (a refused
    // seed, the gates below), and a boot left live dispatched a later test's
    // plain `cell.method()` into this dead mount's store. It used to be armed
    // only at the end of this block, after the seed.
    const bootedHere = standaloneApp;
    partial.reset = () => {
      standalone._resetState();
      // Retired, as `dispose()` retires it: from here its dispatch refuses.
      standalone._retire(bootedHere);
      _resetAioRuntime();
    };
    // Seed BEFORE the first render, so the component's very first pass already
    // sees the fixture (a seed applied after mount would test the re-render path
    // instead of the initial one, which is rarely what a test means).
    // Every seeded KEY should be one the cell has — the rule `t.init(seed)`
    // enforces. A typo (`gpuCount` for `gpus`) lands as a stray key the
    // component never reads: a fixture that looks pinned and pins nothing.
    // WARNED, not refused: 1.0.11 accepted any key (and silently dropped an
    // undeclared one), and the surface is frozen — so the mount still runs,
    // and the no-op is said out loud with the fix. Unknown CELL names
    // are refused by `_seedState` itself (they were in 1.0.11 too).
    const app = standaloneApp;
    const checkedSeed = (p: Record<string, Record<string, unknown>>): void => {
      const now = app.getState();
      for (const [cellName, slice] of Object.entries(p)) {
        const known = now[cellName];
        if (!known || typeof known !== "object" || !slice) continue;
        // OWN keys: `k in known` is true for `toString`/`valueOf`/… inherited
        // from Object.prototype, so a seed key named like a builtin was never
        // warned about — the no-op the warning exists to name.
        const bad = Object.keys(slice).filter((k) => !Object.hasOwn(known, k));
        if (bad.length > 0) {
          console.warn(
            `[aio] seed: cell "${cellName}" has no ${
              bad.map((k) => `"${k}"`).join(", ")
            } — its state is { ${Object.keys(known).join(", ")} }. A seed ` +
              `that lands nowhere looks like a fixture and pins nothing — ` +
              `the component never sees it.\n` +
              `  a typo: seed the declared key instead.\n` +
              `  an OPTIONAL key (\`{} as { ${bad[0]}?: … }\`) counts only ` +
              `once declared: declare \`${bad[0]}: undefined\` in \`state:\``,
          );
        }
      }
      standalone._seedState(p);
    };
    if (opts.seed) checkedSeed(opts.seed);
    seedState = checkedSeed;
    // Dispose does a state-only reset (keeps the registry so re-mounts boot),
    // then retires this boot: the cells are module singletons, so a call an
    // `onInit` started and nobody awaited would otherwise commit into the NEXT
    // test's mount (feedback cc §2) — the same fence `bootCells` closes.
    const booted = standaloneApp;
    resetRuntime = () => {
      // `_resetState()` CANCELS the debounced save (right for a hermetic
      // mount); a persistence-flow test keeps its last change, so the next
      // `{ persist: true }` mount restores what this one ended with.
      if (opts.persist) standalone._flushPendingPersist();
      standalone._resetState();
      standalone._retire(booted);
    };
    // A failing async method NOBODY awaited must not pass for silence — the
    // same ledger `testCell` keeps, so the same app code cannot pass one
    // harness and fail the other (see test-strict.ts). `onClick={() =>
    // todo.add()}` is exactly this shape. Installed after the boot, because it
    // wraps the bound methods the boot just installed.
    // The server's `access` gate, applied to interactions. Installed after the
    // boot (it wraps the bound methods the boot just installed) and BEFORE the
    // ledger, so a denied call is just "an async method that rejected" and is
    // reported the harness's way — through `settle()` — instead of escaping as
    // an unhandled rejection that kills the whole test module.
    // WHO the page is: the `user` option when given; otherwise whoever its
    // session resolved to — a login through the form (`testPageFetch`) signs
    // the page in mid-test, and from then on it reads and calls as that user,
    // as its socket would. It stayed anonymous here: the anonymous
    // `visible.forUser` view, and member-only calls refused.
    const auth = opts.user === undefined
      ? await import("../browser/browser-auth-ui.ts")
      : undefined;
    const viewer = (): AioUser | undefined =>
      auth ? auth.authUser.peek() ?? undefined : opts.user ?? undefined;
    const ungate = opts.enforceAccess !== false
      ? _enforceCellAccess(cells, viewer)
      : undefined;
    // The wire, around the gate: the server decodes a frame first and asks
    // `access` about what it decoded. Undone first (restores run in push
    // order), so the gate's undo is the one that puts the bound method back.
    _strict = _wireStrict(opts);
    _handleForm = name === undefined;
    partial.restore.push(_crossClientWire(cells));
    _reshaped = [];
    partial.restore.push(
      _serverFnsOverWire(viewer, opts.enforceAccess !== false),
    );
    if (opts.wire) partial.restore.push(_useWireConfig(opts.wire));
    if (ungate) partial.restore.push(ungate);
    // What this user's SOCKET would carry, not the server's whole state: a
    // real client only ever holds the `visible.forUser` view, so a component
    // under testUI must read that view too — anonymous when no `user` is
    // given, which is exactly what an unsigned connection receives. Reading
    // the server's state instead passed a UI test that showed every user's
    // rows. Same identity `_enforceCellAccess` gates calls with.
    partial.restore.push(
      _readAsClient(viewer, (def) => def.__aio.uiForUser),
    );
    // What a real worker refuses — a peer read, any method call — refused in
    // process too (boot-refusals.ts). Installed BEFORE the ledger so the
    // ledger wraps it, and undone AFTER the ledger's restore (restores run in
    // push order), so each identity-checked undo finds its own wrapper.
    const unisolate = _isolateWorkerCellsInProcess(cells);
    ledger = _watchUnobservedCalls(cells, _workerCallOverWire);
    inits.pipe(ledger);
    partial.restore.push(() => ledger?.restore());
    partial.restore.push(_sendOverWire(cells, ledger));
    partial.restore.push(unisolate);
    // The call ring a failure trace reads. Installed beside the ledger and
    // torn down with it, so the two cannot disagree about which methods are
    // wrapped.
    const calls = _recordCalls(cells);
    partial.restore.push(() => {
      calls.restore();
      _traceSource = null;
    });
    if (latency > 0) {
      partial.restore.unshift(_delayCalls(cells, latency, latent));
    }
    _traceSource = () => ({
      when: new Date().toISOString(),
      // How it got here — the half a failing assertion can never print.
      calls: calls.recent(),
      surface: traceSafe(() => serializeSurface(currentSurface())),
      html: traceSafe(() => String(root.innerHTML)),
      state: traceSafe(() =>
        Object.fromEntries(
          cells.map((c) => [
            c.__aio.id,
            standaloneApp?.getState()?.[c.__aio.id] ?? null,
          ]),
        )
      ),
    });
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
  // No transport for the length of the mount: the cells are local, and a
  // `useAio()` in the tree must not open a socket to the happy-dom origin
  // (see `_withoutTransport`). Restored on unmount/dispose, and after a
  // mount that threw.
  {
    const { _withoutTransport } = await import(
      "../browser/protocol-subscription.ts"
    );
    const restoreTransport = _withoutTransport();
    _restoreGlobals.push(restoreTransport);
    partial.restore.push(restoreTransport);
  }
  _setDocument(doc);
  // The router's `popstate` listener goes on the window THIS mount renders
  // into. Both runtime entries attach it once, when they load: `aio/air` at
  // import (a browser has its window by then) and the standalone boot when it
  // runs. Under testUI an `aio/air` import happens before any window exists,
  // and a cell-less app never boots the standalone runtime — so Back moved the
  // URL and the routed page never followed. Idempotent per window.
  _installRouterListeners();
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  // `--video` / AIO_VIDEO: a recording made from the command line. Opened
  // BEFORE the mount so a bad flag or a missing browser fails here, loudly;
  // it only ever READS the DOM, synchronously, so the run it records is the
  // run it would have been (see ui-video.ts).
  let video: UiVideoRecorder | null = openUiVideo({
    name: name ?? opts.name,
    testFile,
    doc,
    root,
    viewport: {
      width: opts.viewport?.width ?? 1024,
      height: opts.viewport?.height ?? 768,
    },
  });
  // A mount that fails from here on records nothing: give the name back.
  partial.unmount = () => video?.cancel();
  _fenceMountRoot(root, mountFence, () => _activeRoot?.root);
  const handle: MountHandle = _inMount(mountFence, () => mount(root, App));
  partial.unmount = () => {
    video?.cancel();
    _unmount(handle);
  };
  // What a miss spells its candidates against (see `fail`) — every mount,
  // cells or not; cleared with the rest of the harness.
  _missSurface = () => currentSurface();
  partial.restore.push(() => {
    _missSurface = null;
  });
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
  function settle(strict = false): Promise<void> {
    return _inMount(mountFence, () => _settle(strict));
  }
  async function _settle(strict: boolean): Promise<void> {
    let prev = "";
    for (let i = 0; i < maxIter; i++) {
      // Timers ALREADY DUE fire, as the event loop would fire them: a
      // `schedule.next` (a true 0 ms timer, "right after the current method
      // returns") ran within milliseconds on a real server and never here
      // until the test advanced the clock — so `settle()` claimed quiet while
      // work was queued, and `waitFor` timed out on it. Only what is due NOW:
      // anything later is still the test's to drive with `advance(ms)`.
      // No await when nothing is due: the rounds keep their exact ordering.
      const due = fireDueSchedules?.();
      if (due) await due;
      handle._flush();
      await tick();
      // A cell-method dispatch set in motion WITHOUT an await (an outer
      // method firing a follow-up, `void fs.open(parent)`) is still in
      // flight when the HTML goes quiet — the quiescence early-exit read
      // that gap as settled and the UI showed the old state (a field
      // report). Await what is actually pending — bounded by the iteration
      // budget, so a deliberately long-running call (a stream driving
      // progressive UI) is REPORTED rather than silently called settled.
      const pending = [..._pendingCallPromises(), ...latent];
      if (pending.length > 0) {
        // Same wake-timer rule as `settle()` in cell-test.ts: cleared when the
        // calls win, or it outlives this wait and a sanitized test reports it.
        let wake: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled(pending),
          new Promise((r) => wake = setTimeout(r, 5)),
        ]).finally(() => clearTimeout(wake));
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
    const net = fetchWaitNote([...fetching]);
    _gaveUp =
      `testUI: settle() gave up after ${maxIter} iterations. ${why}.\n` +
      net +
      `  Nothing after this point is guarded: the app has NOT quiesced.\n` +
      `  fix: await the call itself; drive time with \`await ui.advance(ms)\` ` +
      `if it waits on a schedule; raise the budget with ` +
      `\`testUI(App, { settleIterations: n })\` for a legitimately long ` +
      `render; or give the method an abort path (\`s.$signal\`).`;
    if (strict) {
      const msg = _gaveUp;
      _gaveUp = null; // reported here — never twice
      throw withRefusalCode(new Error(msg), "SETTLE_GAVE_UP");
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
  // Actions queued and not yet finished — a body that reads state right after
  // `ui.X.click()` (no await between) reads it BEFORE the click ran.
  let _queued = 0;
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    _queued++;
    const run = _tail.then(() => _inMount(mountFence, fn));
    // A failure the caller AWAITED (attached a rejection handler to) is
    // delivered there and must NOT resurface at the next drain point — else
    // an `assertRejects(() => ui.X.click())` test re-fails at dispose.
    let delivered = false;
    // The tail handler makes un-awaited rejections "handled" (no process
    // unhandledrejection) while recording the failure for the drain.
    _tail = run.then(() => {
      _queued--;
    }, (e) => {
      _queued--;
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
      // `.finally()` hands the rejection on to whoever holds ITS promise — an
      // `assertRejects(() => ui.X.click().finally(…))` observed it there, and
      // the next drain threw it a second time.
      finally: (onC) => {
        delivered = true;
        return run.finally(onC);
      },
      [Symbol.toStringTag]: "Promise",
    } as Promise<T>;
  }
  function drain(): Promise<void> {
    return _inMount(mountFence, _drain);
  }
  async function _drain(): Promise<void> {
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
    // A step, as the video sees it: framed (with its target ringed and a
    // caption) before it acts, and framed again once it has settled — even
    // when it fails, because the frame of a failing step is the useful one.
    const step = (caption: string, fn: () => Promise<void>) => {
      if (!video) return enqueue(fn);
      return enqueue(async () => {
        let target: AnyDoc = null;
        let label = "";
        try {
          const i = resolveInfo();
          target = i._el;
          label = `${i.name} · `;
        } catch {
          // aio-ok: the element does not resolve — `fn` is about to fail with
          // the real message; the frame just goes without a ring.
        }
        video?.before(target, label + caption);
        try {
          await fn();
        } finally {
          video?.after();
        }
      });
    };
    const modsLabel = (mods?: KeyModifiers) =>
      (["ctrlKey", "metaKey", "altKey", "shiftKey"] as const)
        .filter((k) => mods?.[k])
        .map((k) =>
          ({
            ctrlKey: "Ctrl+",
            metaKey: "Meta+",
            altKey: "Alt+",
            shiftKey: "Shift+",
          })[k]
        )
        .join("");
    const act = (
      verb: string | null,
      fn: (e: AnyDoc) => void,
      write = false,
      caption = verb ?? "",
    ) =>
      step(caption, async () => {
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
          false,
          `${modsLabel(mods)}click`,
        );
      },
      dblclick(mods?: KeyModifiers) {
        return act(
          "dblclick",
          (e) => triggerAction(e, "dblclick", undefined, mods),
          false,
          `${modsLabel(mods)}double-click`,
        );
      },
      type(text: string) {
        return step(`type ${JSON.stringify(text)}`, async () => {
          assertEnabled("type into", true);
          el().focus?.();
          for (const ch of text) {
            triggerChar(el(), ch); // re-resolve — controlled inputs re-render
            handle._flush();
            if (latency > 0) await new Promise((r) => setTimeout(r, 0));
          }
          await settle();
        });
      },
      press(key: string, mods?: KeyModifiers) {
        return act(
          "press a key on",
          (e) => {
            const k = resolveKey(
              key,
              mods,
              e.ownerDocument?.defaultView?.navigator?.platform,
            );
            triggerAction(e, "press", k.key, k.mods);
          },
          false,
          `press ${modsLabel(mods)}${key}`,
        );
      },
      keyDown(key: string, mods?: KeyModifiers) {
        return act(
          "hold a key on",
          (e) => {
            const k = resolveKey(
              key,
              mods,
              e.ownerDocument?.defaultView?.navigator?.platform,
            );
            triggerAction(e, "keyDown", k.key, k.mods);
          },
          false,
          `hold ${modsLabel(mods)}${key}`,
        );
      },
      keyUp(key: string, mods?: KeyModifiers) {
        return act(
          "release a key on",
          (e) => {
            const k = resolveKey(
              key,
              mods,
              e.ownerDocument?.defaultView?.navigator?.platform,
            );
            triggerAction(e, "keyUp", k.key, k.mods);
          },
          false,
          `release ${modsLabel(mods)}${key}`,
        );
      },
      hover(mods?: KeyModifiers) {
        return act(
          null,
          (e) => {
            // A pointer cannot rest on what is not rendered: a browser fires
            // no mouseenter on a `display:none` element, and the harness ran
            // its onMouseEnter. Visibility only — a DISABLED control still
            // takes hover in a browser (its tooltip is the point).
            const invisible = _hiddenReason(e);
            if (invisible) {
              throw withRefusalCode(
                new Error(
                  `testUI: cannot hover "${resolveInfo().name}" — it is not ` +
                    `visible: ${invisible}\n  a browser delivers no event to ` +
                    `it; show it first, or assert on the state that hides it`,
                ),
                "NOT_VISIBLE",
              );
            }
            triggerAction(e, "hover", undefined, mods);
          },
          false,
          `${modsLabel(mods)}hover`,
        );
      },
      focus() {
        // Guarded like every gesture: a browser focuses neither a disabled
        // control nor an invisible one, and the harness fired onFocus on a
        // `display:none` element.
        return act("focus", (e) => triggerAction(e, "focus"), false, "focus");
      },
      blur() {
        return act(null, (e) => triggerAction(e, "blur"), false, "blur");
      },
      select(value: string) {
        return act(
          "select on",
          (e) => triggerSelect(e, value),
          true,
          `select ${JSON.stringify(value)}`,
        );
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
          false,
          "check",
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
          false,
          "uncheck",
        );
      },
      clear() {
        return act("clear", (e) => triggerClear(e), true);
      },
      setValue(text: string) {
        return step(`set ${JSON.stringify(text)}`, async () => {
          assertEnabled("set value on", true);
          if (!takesCharacters(el())) {
            triggerAssign(el(), text); // a date/color/range: one assignment
            await settle();
            return;
          }
          triggerClear(el()); // replace, don't append
          handle._flush();
          el().focus?.();
          for (const ch of text) {
            triggerChar(el(), ch); // re-resolve — controlled inputs re-render
            handle._flush();
            if (latency > 0) await new Promise((r) => setTimeout(r, 0));
          }
          await settle();
        });
      },
      scroll(to?: { top?: number; left?: number }) {
        return act(null, (e) => triggerScroll(e, to), false, "scroll");
      },
      dragTo(target: UIElementHandle) {
        return step("drag", async () => {
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
      get pressed() {
        return resolveInfo().pressed === true;
      },
      get expanded() {
        return resolveInfo().expanded === true;
      },
      attr(name: string) {
        return el().getAttribute?.(name) ?? null;
      },
    };
  }

  /** The element handle's ACTION names, READ OFF the handle itself rather than
   *  hand-kept — add an action to `elementHandle` and this set has it, so the
   *  "you called an element action on a component" diagnosis below can never go
   *  stale against the real API. Methods only: the state getters
   *  (`value`/`checked`/…) are properties, not `.foo()` calls.
   *
   *  Probed with a resolver that throws, and read through property DESCRIPTORS,
   *  so building the probe never resolves an element. */
  let _actionNames: ReadonlySet<string> | null = null;
  function elementActionNames(): ReadonlySet<string> {
    if (_actionNames) return _actionNames;
    const probe = elementHandle(() => {
      throw new Error("testUI: action-name probe — never resolved");
    }) as unknown as object;
    _actionNames = new Set(
      Object.entries(Object.getOwnPropertyDescriptors(probe))
        .filter(([, d]) => typeof d.value === "function")
        .map(([k]) => k),
    );
    return _actionNames;
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
      // THE HANDLE WAS RIGHT AND ITS KIND WAS WRONG.
      //
      // `t="SendSol"` on a COMPONENT makes `ui.SendSol` a component handle, so
      // `ui.SendSol.click()` looks "click" up as a CHILD NAME and misses. The
      // generic listing below is literally accurate and aims at the wrong
      // question — it reads as "your handle is wrong" when the handle was the
      // one thing that was right. A field report calls this the most common
      // way to lose ten minutes in testUI: always one INFERENCE short, never
      // information short. The resolver already knows it landed on a component,
      // that the name is a real element action, and what is inside and beside
      // that component — so it says so.
      //
      // Only when nothing else explains the miss: a SHADOWED name has a better
      // hint, and a name that lives elsewhere on the surface is a genuine
      // find-it-over-there. A mistyped CHILD name is not an action name and
      // keeps the message below, which is right about it.
      if (
        !shadowed && elsewhere.length === 0 && elementActionNames().has(name)
      ) {
        const addr = node.handle ?? node.component;
        const own = liveSubtreeElements(node);
        const inner = elementSuggestions(own, 2, "its");
        let sibs: string[] = [];
        try {
          const parent = parentOf(currentSurface(), node);
          if (parent) {
            const mine = new Set(own.map((e) => e.path));
            sibs = elementSuggestions(
              liveSubtreeElements(parent).filter((e) => !mine.has(e.path)),
              1,
              "a",
            );
          }
        } catch {
          // aio-ok: nothing mounted — the miss is already being raised and the
          // sibling hint is pure enrichment, never the reason for the throw.
        }
        fail(
          `testUI: ${uiSpelling(addr)} is a COMPONENT${
            node.handle && node.handle !== node.component
              ? ` (${node.component})`
              : ""
          } at ${node.path}, not an element — components have no .${name}(). ` +
            (inner.length > 0
              ? `Did you mean ${inner.join(", or ")}?`
              : `It renders no element you can act on — put a t handle on the node you mean.`) +
            (sibs.length > 0
              ? ` Or a sibling element such as ${sibs[0]}.`
              : ""),
          listNames(node),
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
      `component reference, not a value. For state use .checked/.pressed/` +
      `.expanded/.disabled/.readonly/.required/.value/.text on an element ` +
      `that exists.`;
    const callable = { [label]: function () {} }[label] as unknown as AnyDoc;
    return new Proxy(callable, {
      get(_target, prop: string | symbol) {
        if (typeof prop === "symbol" || prop in eh) {
          return (eh as AnyDoc)[prop];
        }
        if (typeof prop === "string" && DOM_ANTIPATTERN_PROPS.has(prop)) {
          refuseDomAntipattern(prop);
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
        if (typeof prop === "string" && DOM_ANTIPATTERN_PROPS.has(prop)) {
          refuseDomAntipattern(prop);
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
        if (typeof prop === "string" && DOM_ANTIPATTERN_PROPS.has(prop)) {
          refuseDomAntipattern(prop);
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
        if (typeof prop === "string" && DOM_ANTIPATTERN_PROPS.has(prop)) {
          refuseDomAntipattern(prop);
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
    // "Showing" means a USER can see it, which is the definition
    // `hiddenReason` already owns and `ui.X.click()` already enforces (it
    // refuses to click a `display:none` element). `present`/`absent` used to
    // ask a weaker question — "is it in the surface tree" — so the same toast
    // was both un-clickable and `present`, and
    // `waitFor(() => ui.absent("Toast"))` never fired for a CSS-hidden toast:
    // a green wait for a screen state that was not on screen. One decider.
    if (
      kind !== "component" &&
      liveElements(scope, name).some((e) => _hiddenReason(e._el) === null)
    ) {
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
        throw withRefusalCode(
          new Error(
            `[aio] ui.${api}(): cell '${id}' has no '${
              String(prop)
            }'. Reading ` +
              `it would be \`undefined\`, so a check like \`c.${
                String(prop)
              } ` +
              `!== null\` passes without testing anything — a green test for a ` +
              `screen that never rendered. It has: ${
                [...declared].sort().join(", ") || "(no state keys)"
              }.`,
          ),
          "UNKNOWN_CELL_KEY",
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
      throw withRefusalCode(
        new Error(
          `[aio] ui.${api}(): not a cell — pass the cell itself, e.g. ui.${api}(todo, …)`,
        ),
        "NOT_A_CELL",
      );
    }
    if (cells.some((c) => c.__aio.id === id)) return;
    const booted = cells.map((c) => c.__aio.id).join(", ") || "(none)";
    throw withRefusalCode(
      new Error(
        `[aio] ui.${api}(): cell '${id}' is not booted in this mount, so its ` +
          `state would read as its DECLARED INITIAL and the assertion would ` +
          `pass without testing anything. Booted: ${booted}. Import '${id}' ` +
          `from your App's module graph, or pass it in { cells: [...] }.`,
      ),
      "CELL_NOT_BOOTED",
    );
  };

  /** The state `expectCell`'s predicate just read — off the reactive def, the
   *  same door the predicate reads through. NOT the standalone store's slice:
   *  that is the SERVER's view, and under `{ user }` the def answers with the
   *  client's `visible.forUser` view — so a failure printed rows the predicate
   *  never saw (`items.length === 2` false, dump showing two items). A key
   *  hidden from the client (its read throws) is left out, as the client
   *  holds no such key. The store slice is only the fallback for a cell with
   *  no declared keys. */
  const cellStateFor = (cell: AnyDoc): unknown => {
    const id = cell?.__aio?.id as string | undefined;
    const keys = Object.keys((cell?.__aio?.state ?? {}) as object);
    if (keys.length === 0) {
      return id === undefined ? undefined : standaloneApp?.getState()?.[id];
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      try {
        out[k] = (cell as Record<string, unknown>)[k];
      } catch {
        // aio-ok: a `visible:`-hidden key — the client holds no such field,
        // so the dump of what the predicate saw has none either.
      }
    }
    // A machine cell's status is not a declared key, and still what a status
    // assertion is about.
    const slice = id === undefined
      ? undefined
      : standaloneApp?.getState()?.[id];
    const status = (slice as { __aio_status?: unknown } | undefined)
      ?.__aio_status;
    if (status !== undefined) out.__aio_status = status;
    return out;
  };

  // The mount's own window, with a NAME for the key that belongs to no
  // element. `onGlobalKey` ("Escape closes the lightbox", "⌘K opens the
  // palette") registers on the document, so nothing on the semantic surface
  // owns it — and the obvious `ui.<field>.press("Escape")` is skipped by
  // `ignoreInInput`, which is the trap `triggerPress` now warns about. The
  // `am` tier has had the address since alpha71 (`am trigger window press`);
  // this is the same address in-process, so the warning can name a fix that
  // exists. ADDITIVE: the methods are defined ON the real window object, so
  // `ui.window` keeps its identity and every DOM member it already had.
  const uiWindow =
    (ownedWindow ?? (doc as AnyDoc).defaultView ?? null) as AnyDoc;
  const keyLabel = (key: string, mods?: KeyModifiers) =>
    (["ctrlKey", "metaKey", "altKey", "shiftKey"] as const)
      .filter((k) => mods?.[k])
      .map((k) => k.replace("Key", "") + "+")
      .join("") + key;
  if (uiWindow) {
    const winKey = (
      action: "press" | "keyDown" | "keyUp",
      caption: string,
    ) =>
    (key: string, mods?: KeyModifiers): Promise<void> =>
      enqueue(async () => {
        video?.before(null, `window · ${caption} ${keyLabel(key, mods)}`);
        try {
          // Resolve the document at ACT time, off the window itself: a
          // caller-supplied window outlives this mount, and a stale document
          // would dispatch into a detached tree that nothing listens to.
          const k = resolveKey(key, mods, uiWindow.navigator?.platform);
          triggerAction(uiWindow.document ?? doc, action, k.key, k.mods);
          await settle();
        } finally {
          video?.after();
        }
      });
    for (
      const [name, fn] of [
        ["press", winKey("press", "press")],
        ["keyDown", winKey("keyDown", "hold")],
        ["keyUp", winKey("keyUp", "release")],
      ] as const
    ) {
      Object.defineProperty(uiWindow, name, {
        value: fn,
        writable: true,
        configurable: true,
        enumerable: false, // a window is enumerated by test helpers; stay out
      });
    }
  }

  const observations = _observationLedger("testUI");
  const api = {
    [_QUEUED]: () => _queued,
    surface: () => serializeSurface(currentSurface()),
    // The mount's OWN window and document — the same objects `window` and
    // `document` resolve to inside the component. A test that needs the real
    // thing (dispatch a `resize`, read `location`, register a listener where
    // the component's one lives) reaches them here instead of re-creating a
    // happy-dom of its own (field report §4.1).
    window: uiWindow,
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
        throw withRefusalCode(
          new Error(
            "[aio] ui.seed(): no cells are booted in this mount — pass { cells } " +
              "or import the cells your App uses",
          ),
          "CELL_NOT_BOOTED",
        );
      }
      seedState(partial);
    },
    fullState: (cell: AnyDoc): unknown => {
      assertBooted(cell, "fullState");
      return standaloneApp?.getState()?.[cell?.__aio?.id as string];
    },
    names: (): string[] => {
      try {
        return collectElementPaths(currentSurface());
      } catch {
        // aio-ok: `currentSurface()` throws before the first mount, and "no
        // names yet" is the honest answer to asking early — not an error worth
        // failing a test over, and the empty array says it.
        return [];
      }
    },
    // Public settle is an observation point: drains the action queue first
    // (surfacing failures from un-awaited actions), then waits quiescence.
    settle: async () => {
      await drain();
      // strict: this IS the observation point. "Quiesced" and "gave up" must
      // not be the same answer here.
      await settle(true);
      video?.observe();
    },
    // Advance the virtual schedule clock by `ms` and fire everything now due —
    // drives toast auto-dismiss / debounce / backoff / poll deterministically
    // in tests. Then settles so the UI reflects the fired actions.
    advance: async (ms: number) => {
      // The queued actions run FIRST: `ui.Start.click(); await ui.advance(5000)`
      // reads as "click, then five seconds pass". Advancing before the click
      // ran armed its schedule after the time had passed — nothing fired, and
      // a "has not fired yet" assertion passed for the wrong reason.
      await drain();
      await _inMount(mountFence, async () => await advanceSchedules?.(ms));
      await drain();
      await settle(true); // an observation point too — see settle above
      video?.observe();
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
        let r: unknown;
        try {
          r = pred(subject);
          lastErr = undefined; // it ran
        } catch (e) {
          // A key the cell does not have stays missing however long we poll:
          // fail now, not after the 2s retry budget.
          if ((e as { code?: unknown })?.code === "UNKNOWN_CELL_KEY") throw e;
          lastErr = e;
        }
        if (predicateVerdict(r, "testUI: expectCell")) {
          return video?.observe();
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
          (_gaveUp ? `\n  ${_gaveUp}` : "") +
          (_traceSource ? writeTrace(_traceSource()) : ""),
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
      // The predicate is asked BEFORE the deadline is: checked first, a
      // `timeoutMs: 0` (or a first settle() slower than the budget) timed out
      // without asking once — failing a condition that was already true.
      for (;;) {
        await settle();
        let r: unknown;
        try {
          r = pred();
          lastErr = undefined; // it ran
        } catch (e) {
          lastErr = e;
        }
        if (predicateVerdict(r, "testUI: waitFor")) return video?.observe();
        if (Date.now() >= deadline) break;
        await tick(20);
      }
      if (lastErr !== undefined) throw lastErr;
      throw new Error(
        `testUI: waitFor timed out${opts?.msg ? ` — ${opts.msg}` : ""}.\n` +
          "  current surface: " + surfaceDigest(currentSurface()) +
          // "waited 3s and the predicate stayed false" reads as an app bug; if
          // settle() was giving up every poll, it is not (see settle()).
          (_gaveUp ? `\n  ${_gaveUp}` : "") +
          (_traceSource ? writeTrace(_traceSource()) : ""),
      );
    },
    find(component: string, key?: string | number): UIComponentHandle {
      return componentHandle(() =>
        oneComponent(currentSurface(), component, key)
      );
    },
    unmount() {
      if (video) {
        // Synchronous teardown cannot wait for a video to be drawn — say so
        // rather than let a requested recording silently not exist — and
        // give the file's name back for the next mount.
        video.cancel();
        video = null;
        console.warn(
          "[aio:video] ui.unmount() cannot wait for the video to be written, " +
            "so this mount has none — use `await ui.dispose()` (or " +
            "`await using ui = …`) to record it.",
        );
      }
      _unmount(handle);
      ledger?.restore(); // put the cells' own methods back before the reset
      resetRuntime?.();
      // The process-global half — see the note at boot. Teardown that leaves
      // `_pending` populated hands the NEXT test a `settle()` that can only
      // time out.
      _resetAioRuntime();
      // Owned window: close in the background (fire-and-forget is safe for
      // happy-dom; use dispose() when you need to await it).
      const win = ownedWindow ?? sharedWindow;
      if (win && _dropWindowHold(win)) {
        win.happyDOM?.close()?.catch?.(() => {
          // aio-ok: teardown is fire-and-forget by design here — dispose() is
          // the spelling that awaits it.
        });
      }
      ownedWindow = sharedWindow = null;
      partial.window = null;
      for (const key of _ownedGlobals.splice(0)) {
        delete (globalThis as AnyDoc)[key];
      }
      for (const restore of _restoreGlobals.splice(0)) restore();
    },
    async dispose() {
      // Drain first — a failure from an un-awaited action must fail the
      // test, not vanish in teardown. Teardown runs regardless: the drain's
      // error is re-thrown once teardown (and the video) are done.
      let drainErr: { e: unknown } | null = null;
      try {
        await observations.raise();
        await drain();
        // …and the un-awaited CALLS. `drain()` waits for the test's own action
        // queue, not for a method one of those actions (or the test body)
        // started: `c.save(); }` — or `onClick={() => c.save()}` clicked on
        // the last line — reached teardown with the call a microtask from
        // failing, the ledger still empty, and the reset about to orphan it.
        // Green test, method blew up. Bounded, and a call still running after
        // the budget is named rather than failed (see the warning's text).
        const still = await ledger?.drain(_DISPOSE_DRAIN_MS) ?? [];
        ledger?.raise();
        if (still.length > 0) {
          console.warn(_abandonedCallsWarning("testUI", still, "ui"));
        }
      } catch (e) {
        drainErr = { e };
      }
      video?.observe(); // the final state, before the unmount clears it
      _unmount(handle);
      ledger?.restore(); // put the cells' own methods back before the reset
      resetRuntime?.();
      _resetAioRuntime(); // see unmount() — process-global residue
      const win = ownedWindow ?? sharedWindow;
      if (win) {
        if (_dropWindowHold(win)) await closeWindow(win);
        ownedWindow = sharedWindow = null;
        partial.window = null;
      }
      for (const key of _ownedGlobals.splice(0)) {
        delete (globalThis as AnyDoc)[key];
      }
      for (const restore of _restoreGlobals.splice(0)) restore();
      // The video is drawn AFTER teardown, from what was recorded: nothing
      // it does can reach the app. A failed test still gets its video —
      // that is the one most worth watching — and a video that cannot be
      // made fails a passing test rather than vanishing; behind a failing
      // one it is reported and the test's own error stands.
      const rec = video;
      video = null;
      if (rec) {
        try {
          await rec.finish();
        } catch (e) {
          if (!drainErr) throw e;
          console.error(`[aio:video] no video for this failed test: ${e}`);
        }
      }
      if (drainErr) throw drainErr.e;
    },
    [Symbol.asyncDispose]() {
      return this.dispose();
    },
  };

  // The observation points, tracked: one the test never awaits is awaited by
  // dispose() and fails THIS test (see `_observationLedger`).
  for (const k of ["settle", "advance", "expectCell", "waitFor"] as const) {
    const run = api[k] as (...a: unknown[]) => Promise<void>;
    (api as AnyDoc)[k] = (...a: unknown[]) =>
      observations.track(`ui.${k}(…)`, run.apply(api, a));
  }

  // SETTLE ONCE, BEFORE HANDING THE UI OVER.
  //
  // `mount()` is synchronous, and a component that rehydrates on mount — an
  // `onMount` that dispatches, a `resource` that fetches, a `useLocal` that
  // restores — has that work IN FLIGHT when the test body starts. Whether the
  // first assertion saw the before or the after came down to how many
  // microtasks the harness happened to have spent, which is why one repo
  // measured ~40% flake and why the answer so far was a house rule and a
  // comment on every affected test (report 8 §11). A rule enforced by
  // remembering is not enforced.
  //
  // Non-strict on purpose. A mount that never quiesces must not fail HERE,
  // where the error would name the harness rather than the app; `_gaveUp` is
  // recorded and the first real observation point reports it with its own
  // context.
  await settle(false);
  video?.observe(); // the first frame: the app as it mounted

  return new Proxy(api as AnyDoc, {
    get(target, prop: string | symbol) {
      if (typeof prop === "symbol" || prop in target) {
        return (target as AnyDoc)[prop];
      }
      const name = prop as string;
      let surf: UISurfaceNode | undefined;
      try {
        surf = currentSurface();
      } catch {
        // aio-ok: `currentSurface()` throws before the first mount. Nothing is
        // on screen yet BY DEFINITION, so the lazy handle below (which
        // re-resolves at use time) is the correct answer, not an error.
      }
      // A FULL PATH is addressable too. `uiNames(ui)` returns
      // `Component…:Element` paths — documented as "the same form `am trigger`
      // takes, and the only form that can say WHICH instance" — and `ui[…]`
      // refused every one of them ("no component or element named
      // \"App:SaveButton\""). So the discovery list this very harness
      // produces was not usable in it, and the doc page that teaches
      // `uiNames(ui)` teaches it beside a `testUI` example. A path names one
      // element exactly, which is the disambiguation a bare name cannot do.
      if (surf && name.includes(":")) {
        let found = false;
        const visit = (n: UISurfaceNode) => {
          for (const e of n.elements) if (e.path === name) found = true;
          n.children.forEach(visit);
        };
        visit(surf);
        if (found) {
          return elementHandle(() => resolveElement(name, lastSegment(name)));
        }
      }
      // A component by that name wins (ui.App / ui.TodoRow).
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

/** `testUI({ latency })`: dispatch every bound cell method `ms` later, in
 *  call order, tracking the not-yet-dispatched calls in `latent` so
 *  `settle()` waits for them. A Proxy keeps the method's own properties
 *  (`.action()`, `.type`). Returns the undo. */
/** The deno.json `assets` mounts, per project dir — read once, as a server
 *  booting there reads them. */
const _mountsOf = new Map<
  string,
  Promise<
    ((path: string, req?: Request) => Promise<Response | null>) | null
  >
>();

/** A relative GET/HEAD `fetch` under one of the app's deno.json `assets`
 *  mounts, answered BY the app's server (`mountFileServer`: its own static
 *  handler — app dir first, the mount filling in) — `null` when no mount
 *  claims it. The server modules load only here, and by a computed
 *  specifier: this module rides in app bundle graphs (see "happy-dom"). */
async function _mountFetch(
  input: string,
  init: RequestInit | undefined,
  testFile: string | null | undefined,
): Promise<Response | null> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  // The dir the app's server serves from (its entry's folder), not the test's.
  const dir = appDirOf(testFile ?? null) ?? Deno.cwd();
  let serve = _mountsOf.get(dir);
  if (!serve) {
    const spec = "../server/server.ts";
    const staticSpec = "../server/server-static.ts";
    serve = Promise.all([
      import(new URL(spec, import.meta.url).href) as Promise<
        typeof import("../server/server.ts")
      >,
      import(new URL(staticSpec, import.meta.url).href) as Promise<
        typeof import("../server/server-static.ts")
      >,
    ]).then(([m, st]) => {
      const served = m._servedAssets(undefined, dir) ?? {};
      if (Object.keys(served).length === 0) return null;
      return st.mountFileServer(
        dir,
        served,
        m._mountsDenoJsonOnly(undefined, served),
      );
    });
    _mountsOf.set(dir, serve);
  }
  const server = await serve;
  if (!server) return null;
  const base = (globalThis as AnyDoc).location?.href ?? "http://localhost/";
  const url = new URL(input, base);
  return await server(url.pathname, new Request(url, init));
}

function _delayCalls(
  // deno-lint-ignore no-explicit-any
  cells: any[],
  ms: number,
  latent: Set<Promise<unknown>>,
): () => void {
  const undo: (() => void)[] = [];
  for (const def of cells) {
    const holder = def as Record<string, unknown>;
    for (const key of def.__aio?.actionKeys ?? []) {
      const original = holder[key];
      if (typeof original !== "function") continue;
      holder[key] = new Proxy(original, {
        apply(target, self, args) {
          const call = new Promise((resolve) =>
            setTimeout(() => resolve(Reflect.apply(target, self, args)), ms)
          );
          const gate = call.then(() => {}, () => {});
          latent.add(gate);
          void gate.then(() => latent.delete(gate));
          return call;
        },
      });
      undo.push(() => {
        holder[key] = original;
      });
    }
  }
  return () => undo.splice(0).reverse().forEach((u) => u());
}
