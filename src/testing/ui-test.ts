// ui-test.ts — first-class semantic UI testing (spec:
// docs/specs/2026-07-10-semantic-ui-testing.md). Mounts a real AIR app and
// exposes every TSX component as an intuitive, deterministic API:
//
//   const ui = await testUI(App, { document: win.document, cells: [todo] });
//   await ui.App.TitleInput.type("buy milk");   // client-only useLocal — real events
//   await ui.App.AddButton.click();             // settles the full loop
//
// Naming is a pure function of the TSX (t > aria-label > text > placeholder >
// name attr, + role from tag/class), so the API is predictable and stable.
// Interactions dispatch real DOM event sequences through AIR's own delegation —
// faithful to a user, never calling handlers directly.

import { _setDocument, _unmount, mount } from "../air/aio-renderer.ts";
import type { ComponentFn } from "../air/vdom-types.ts";
import type { MountHandle, RootState } from "../air/renderer-types.ts";
import { _rootStateMap } from "../air/renderer-state.ts";
import {
  buildUISurface,
  findComponents,
  serializeSurface,
  type UIElementInfo,
  type UISurfaceNode,
} from "../air/ui-surface.ts";
import {
  triggerAction,
  triggerChar,
  triggerClear,
  triggerSelect,
} from "../air/ui-trigger.ts";

// deno-lint-ignore no-explicit-any
type AnyDoc = any;

/** Options for {@linkcode testUI}. */
export interface TestUIOptions {
  /** Document to render into — bring a happy-dom / jsdom document (keeps test
   *  DOM deps out of the framework). Falls back to `globalThis.document`. */
  document?: AnyDoc;
  /** Cells to run on the local (standalone) dispatch loop — the same runtime
   *  the android target uses, so method calls and reactive getters behave for
   *  real. Omit for pure client-only components. */
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

/** A triggerable element of the semantic UI surface. Every action is async and
 *  settles the app (renders flushed, dispatch drained) before resolving. */
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
   *  `deno task testgen` (planned) generates fully-typed clients. */
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
  /** Unmount and reset the local runtime. */
  unmount(): void;
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
 * ```ts
 * import { Window } from "happy-dom";
 * import { testUI } from "aio/testing";
 *
 * const win = new Window();
 * const ui = await testUI(App, { document: win.document, cells: [todo] });
 * await ui.App.TitleInput.type("buy milk");
 * await ui.App.AddButton.click();
 * await ui.expectCell(todo, (t) => t.items.length === 1);
 * ui.unmount();
 * ```
 */
export async function testUI(
  App: ComponentFn,
  opts: TestUIOptions = {},
): Promise<TestUI> {
  const doc: AnyDoc = opts.document ?? (globalThis as AnyDoc).document;
  if (!doc) {
    throw new Error(
      "testUI: no document — pass { document } (e.g. new Window().document " +
        "from happy-dom) or set globalThis.document",
    );
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
  // real method binding, reactive getters, ack semantics).
  let resetRuntime: (() => void) | undefined;
  if (opts.cells && opts.cells.length > 0) {
    const standalone = await import("../standalone-air.ts");
    await standalone.aio.run({
      appId: "testui",
      cells: opts.cells,
      // Hermetic by default: no cross-test state leaks through the (shared)
      // localStorage persist key. Opt in via { persist: true }.
      persist: opts.persist ?? false,
      persistKey: `testui:${crypto.randomUUID().slice(0, 8)}`,
    });
    resetRuntime = standalone._reset;
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

  function elementHandle(info: UIElementInfo): UIElementHandle {
    const path = info.path;
    const el = () => resolveElement(path)._el! as AnyDoc;
    const act = async (fn: (e: AnyDoc) => void) => {
      fn(el());
      await settle();
    };
    return {
      info,
      async click() {
        await act((e) => triggerAction(e, "click"));
      },
      async dblclick() {
        await act((e) => triggerAction(e, "dblclick"));
      },
      async type(text: string) {
        el().focus?.();
        for (const ch of text) {
          triggerChar(el(), ch); // re-resolve — controlled inputs re-render
          handle._flush();
        }
        await settle();
      },
      async press(key: string) {
        await act((e) => triggerAction(e, "press", key));
      },
      async hover() {
        await act((e) => triggerAction(e, "hover"));
      },
      async focus() {
        await act((e) => triggerAction(e, "focus"));
      },
      async blur() {
        await act((e) => triggerAction(e, "blur"));
      },
      async select(value: string) {
        await act((e) => triggerSelect(e, value));
      },
      async check() {
        const e = el();
        if (!e.checked) await this.click();
      },
      async uncheck() {
        const e = el();
        if (e.checked) await this.click();
      },
      async clear() {
        await act((e) => triggerClear(e));
      },
      get text() {
        return String(el().textContent ?? "");
      },
      get value() {
        return String(el().value ?? "");
      },
    };
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
        const node = select();
        const elInfo = node.elements.find((e) => e.name === prop);
        if (elInfo) return elementHandle(elInfo);
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
        fail(
          `testUI: "${
            String(prop)
          }" is not an element or component of ${node.path}`,
          [
            ...node.elements.map((e) => e.name),
            ...node.children.map((c) => c.component),
          ],
        );
      },
    }) as UIComponentHandle;
  }

  await settle();

  const api = {
    surface: () => serializeSurface(currentSurface()),
    settle,
    html: () => String(root.innerHTML),
    async expectCell(
      cell: AnyDoc,
      pred: (c: AnyDoc) => boolean,
      msg?: string,
    ) {
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
    },
  };

  return new Proxy(api as AnyDoc, {
    get(target, prop: string | symbol) {
      if (typeof prop === "symbol" || prop in target) {
        return (target as AnyDoc)[prop];
      }
      // ui.App / ui.AnyComponent → component handle (root or deep)
      return api.find(prop as string);
    },
  }) as TestUI;
}
