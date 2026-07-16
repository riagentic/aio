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
   *  keydown + value update + input event. */
  type(text: string): Promise<void>;
  /** Press a key (keydown/keyup). `"Enter"` inside a form also submits it,
   *  mirroring browser implicit submission. */
  press(key: string): Promise<void>;
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
  waitFor(pred: () => boolean, opts?: { timeoutMs?: number }): Promise<void>;
  /** Root innerHTML — convenience for assertions. */
  html(): string;
  /** Assert on a cell's reactive state: `await ui.expectCell(todo, t => …)`. */
  // deno-lint-ignore no-explicit-any
  expectCell(cell: any, pred: (c: any) => boolean, msg?: string): Promise<void>;
  /** Find a component anywhere by name (and optionally AIR key). */
  find(component: string, key?: string | number): UIComponentHandle;
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

function fail(msg: string, available: string[]): never {
  throw new Error(
    `${msg}\n  available: ${
      available.length ? available.join(", ") : "(none)"
    }` +
      `\n  tip: name elements explicitly with the t prop, e.g. <button t="save">`,
  );
}

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
  App: ComponentFn,
  name: string,
  fn: (ui: TestUI) => void | Promise<void>,
): void;
export function testUI(App: ComponentFn, opts?: TestUIOptions): Promise<TestUI>;
export function testUI(
  App: ComponentFn,
  optsOrName?: TestUIOptions | string,
  fn?: (ui: TestUI) => void | Promise<void>,
): void | Promise<TestUI> {
  // Wrapper form: testUI(App, "name", fn) — a Deno.test with auto-teardown.
  if (typeof optsOrName === "string") {
    if (typeof fn !== "function") {
      throw new Error('testUI(App, "name", fn): missing test function');
    }
    Deno.test(optsOrName, async () => {
      const ui = await _mountTestUI(App, {});
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
  return _mountTestUI(App, optsOrName ?? {});
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
  if (!doc) {
    try {
      // Computed specifier ON PURPOSE: cell.ts re-exports testCell, so this
      // module rides in every app bundle graph — a static "happy-dom" import
      // makes esbuild try to bundle a Node-flavored test DOM into browser/
      // android bundles (51 errors). Opaque = resolved only at test runtime.
      const spec = "happy-dom";
      const hd = await import(spec);
      ownedWindow = new hd.Window();
      doc = ownedWindow.document;
    } catch {
      throw new Error(
        "testUI: no DOM available — add happy-dom to your deno.json imports " +
          '("happy-dom": "npm:happy-dom@^17"), or pass { document } yourself',
      );
    }
  }
  const maxIter = opts.settleIterations ?? 20;

  // Standalone runtime needs localStorage — shim an in-memory one if absent
  // so tests need zero extra setup (persistence still behaves).
  if (!(globalThis as AnyDoc).localStorage) {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      configurable: true,
    });
  }

  // Boot the cells on the local dispatch loop (the android/standalone runtime —
  // real method binding, reactive getters, ack semantics). Default: every
  // `cell()` the App transitively imported has self-registered — boot them
  // all; pass { cells } only to restrict the set.
  let resetRuntime: (() => void) | undefined;
  let advanceSchedules: ((ms: number) => void) | undefined;
  const cells = opts.cells ?? [...getRegisteredCells().values()];
  if (cells.length > 0) {
    const standalone = await import("../standalone-air.ts");
    advanceSchedules = standalone._advanceSchedules;
    // Hermetic by default: cells are module singletons, so both their signal
    // state AND the standalone dispatch store survive across mounts. Reset the
    // runtime state (keeping the registry) so this mount re-composes from the
    // cells' declared initials — no cross-test leaks. Skipped when the test
    // opts into persistence (it wants continuity across runs).
    if (!opts.persist) standalone._resetState();
    await standalone.aio.run({
      appId: "testui",
      cells,
      // Hermetic by default: no cross-test state leaks through the (shared)
      // localStorage persist key. Opt in via { persist: true }.
      persist: opts.persist ?? false,
      persistKey: `testui:${crypto.randomUUID().slice(0, 8)}`,
    });
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
  let _queuedError: unknown = null;
  let _hasQueuedError = false;
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = _tail.then(fn);
    // The tail handler makes un-awaited rejections "handled" (no process
    // unhandledrejection) while stashing the first failure for the drain.
    _tail = run.then(() => {}, (e) => {
      if (!_hasQueuedError) {
        _hasQueuedError = true;
        _queuedError = e;
      }
    });
    return run;
  }
  async function drain(): Promise<void> {
    let t: Promise<void>;
    do {
      t = _tail;
      await t;
    } while (_tail !== t); // actions queued while waiting — keep draining
    if (_hasQueuedError) {
      const e = _queuedError;
      _hasQueuedError = false;
      _queuedError = null;
      throw e;
    }
  }

  function elementHandle(resolveInfo: () => UIElementInfo): UIElementHandle {
    const el = () => resolveInfo()._el! as AnyDoc;
    const act = (fn: (e: AnyDoc) => void) =>
      enqueue(async () => {
        fn(el());
        await settle();
      });
    return {
      get info() {
        return resolveInfo();
      },
      click() {
        return act((e) => triggerAction(e, "click"));
      },
      dblclick() {
        return act((e) => triggerAction(e, "dblclick"));
      },
      type(text: string) {
        return enqueue(async () => {
          el().focus?.();
          for (const ch of text) {
            triggerChar(el(), ch); // re-resolve — controlled inputs re-render
            handle._flush();
          }
          await settle();
        });
      },
      press(key: string) {
        return act((e) => triggerAction(e, "press", key));
      },
      hover() {
        return act((e) => triggerAction(e, "hover"));
      },
      focus() {
        return act((e) => triggerAction(e, "focus"));
      },
      blur() {
        return act((e) => triggerAction(e, "blur"));
      },
      select(value: string) {
        return act((e) => triggerSelect(e, value));
      },
      check() {
        return act((e) => {
          if (!e.checked) triggerAction(e, "click");
        });
      },
      uncheck() {
        return act((e) => {
          if (e.checked) triggerAction(e, "click");
        });
      },
      clear() {
        return act((e) => triggerClear(e));
      },
      scroll(to?: { top?: number; left?: number }) {
        return act((e) => triggerScroll(e, to));
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
      fail(
        `testUI: "${name}" is not an element of ${node.path}`,
        [
          ...node.elements.map((e) => e.name),
          ...node.children.map((c) => c.component),
        ],
      );
    };
    const eh = elementHandle(resolveInfo);
    return new Proxy(eh as AnyDoc, {
      get(target, prop: string | symbol) {
        if (typeof prop === "symbol" || prop in target) {
          return (target as AnyDoc)[prop];
        }
        // Treated as a component that will exist by the time it's used:
        // ui.Modal.ConfirmButton — resolve "Modal" lazily, then chain.
        return lazyHandle(() => {
          const parent = selectParent();
          const hit = findComponents(parent, name)[0];
          if (!hit) {
            fail(
              `testUI: component "${name}" not found under ${parent.path}`,
              parent.children.map((c) => c.component),
            );
          }
          return hit;
        }, prop as string);
      },
    }) as UIElementHandle;
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
              select().children.map((c) => c.component),
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
        const child = node.children.find((c) => c.component === prop);
        if (child) {
          return componentHandle(() => {
            const again = findComponents(select(), prop as string)[0];
            if (!again) {
              fail(`testUI: component "${String(prop)}" disappeared`, []);
            }
            return again;
          });
        }
        // deep search below this node
        const deep = findComponents(node, prop as string)[0];
        if (deep) {
          return componentHandle(() => {
            const again = findComponents(select(), prop as string)[0];
            if (!again) {
              fail(`testUI: component "${String(prop)}" disappeared`, []);
            }
            return again;
          });
        }
        // Not on the surface YET — hand back a lazy handle so un-awaited
        // sequences can target UI a prior queued action will create.
        return lazyHandle(select, prop as string);
      },
    }) as UIComponentHandle;
  }

  await settle();

  const api = {
    surface: () => serializeSurface(currentSurface()),
    // Public settle is an observation point: drains the action queue first
    // (surfacing failures from un-awaited actions), then waits quiescence.
    settle: async () => {
      await drain();
      await settle();
    },
    // Advance the virtual schedule clock by `ms` and fire everything now due —
    // drives toast auto-dismiss / debounce / backoff / poll deterministically
    // in tests (risoto). Then settles so the UI reflects the fired actions.
    advance: async (ms: number) => {
      advanceSchedules?.(ms);
      await drain();
      await settle();
    },
    html: () => String(root.innerHTML),
    async expectCell(
      cell: AnyDoc,
      pred: (c: AnyDoc) => boolean,
      msg?: string,
    ) {
      await drain();
      await settle();
      if (!pred(cell)) {
        throw new Error(
          msg ?? `testUI: expectCell failed for cell '${cell?.__aio?.id}'`,
        );
      }
    },
    async waitFor(
      pred: () => boolean,
      o?: { timeoutMs?: number },
    ): Promise<void> {
      await drain();
      const deadline = Date.now() + (o?.timeoutMs ?? 3000);
      while (Date.now() < deadline) {
        await settle();
        try {
          if (pred()) return;
        } catch { /* keep waiting — surface may still be changing */ }
        await tick(20);
      }
      throw new Error(
        "testUI: waitFor timed out.\n  current surface: " +
          JSON.stringify(serializeSurface(currentSurface()), null, 2),
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
      } catch { /* nothing mounted yet — fall through to lazy component find */ }
      if (surf && findComponents(surf, name).length > 0) return api.find(name);
      // risoto #2: hoist a `t`/data-testid element handle to the top level,
      // regardless of nesting — `ui.watchPubkey` instead of the positional
      // `ui.find("Input", 1).watchPubkey`. Requires a UNIQUE match.
      if (surf) {
        const els = findElementsDeep(surf, name);
        if (els.length === 1) {
          return elementHandle(() => resolveElement(els[0]!.path));
        }
        if (els.length > 1) {
          fail(
            `testUI: "${name}" matches ${els.length} elements on the surface — ` +
              `disambiguate with ui.find("Component", key).${name}`,
            els.map((e) => e.path),
          );
        }
      }
      // ui.App / ui.AnyComponent → lazy component handle (may appear later)
      return api.find(name);
    },
  }) as TestUI;
}
