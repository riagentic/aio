// server-surface.ts — headless semantic UI surface, rendered ON the server.
//
// `am surface` needed a connected browser/electron client; with
// `--client=server-only` (or simply no client open) it returned an error even
// though the server owns the state and the UI entry. This renders
// the app's UI in-process against LIVE server cell state — module caching
// means the App's `import "./cell.ts"` resolves to the very cells the server
// booted (field getters read real state) — and serializes the same semantic
// surface a client would report.
//
// Dev-only inspection: the mount is transient (render → serialize → unmount),
// but component onMount/effects DO run once — the same contract as testUI.

import { toFileUrl } from "@std/path";

/** One serialized surface root (shape defined in air/ui-surface.ts). */
export type HeadlessSurfaceResult =
  | { ok: true; roots: unknown[] }
  | { ok: false; error: string };

/** Render the app's UI entry headlessly and return its serialized semantic
 *  surface. All heavyweight deps (happy-dom, the AIR renderer) load lazily —
 *  a server that never uses this pays nothing. */
export async function renderHeadlessSurface(
  entryPath: string,
  /** Lift the text cap (`am surface --full`) — see buildUISurface. */
  full = false,
  /** `am preview`: render ONE component from this module, with props, instead
   *  of the module's default-exported app. Everything else — the throwaway
   *  DOM, the mount, the surface walk, the teardown — is identical, which is
   *  the reason this is a parameter and not a second function that drifts. */
  one?: {
    /** Named export to render. Absent → the default export, as before. */
    readonly exportName?: string;
    /** Props to call it with. */
    readonly props?: Record<string, unknown>;
  },
): Promise<HeadlessSurfaceResult> {
  // 1. The app's UI entry. Module cache shares already-imported cell modules,
  //    so the components read the SERVER's live cell instances.
  let App: unknown;
  try {
    const mod = await import(toFileUrl(entryPath).href) as Record<
      string,
      unknown
    >;
    App = one?.exportName ? mod[one.exportName] : mod.default;
    if (one?.exportName && typeof App !== "function") {
      // NAME WHAT IS THERE. "X is not a component" sends someone reading the
      // file they just pointed at; the list says whether they typo'd the name
      // or the export is not a component at all.
      const names = Object.keys(mod).filter((k) =>
        typeof mod[k] === "function"
      );
      return {
        ok: false,
        error: `preview: ${entryPath} exports no component named ` +
          `"${one.exportName}" — components exported here: ` +
          `${names.length > 0 ? names.join(", ") : "(none)"}`,
      };
    }
  } catch (e) {
    return {
      ok: false,
      error: `surface: failed to import UI entry ${entryPath}: ${e}`,
    };
  }
  if (typeof App !== "function") {
    return {
      ok: false,
      error:
        `surface: ${entryPath} has no default-exported component (server-side render needs one)`,
    };
  }

  // 2. A throwaway DOM. Computed specifier so bundlers never chase happy-dom
  //    into client builds (same technique as testing/ui-test.ts).
  // deno-lint-ignore no-explicit-any
  let win: any;
  try {
    const spec = "happy-dom";
    const hd = await import(spec);
    win = new hd.Window({ url: "http://localhost/" });
  } catch {
    return {
      ok: false,
      error:
        'surface: happy-dom unavailable — add "happy-dom": "npm:happy-dom@^17" to deno.json imports for headless `am surface`',
    };
  }

  // 3. Mount → serialize → unmount (same shape as testing/ui-test.ts:
  //    `mount(container, App)`, root vnode via _rootStateMap). Renderer
  //    pieces load lazily too.
  try {
    const [renderer, rstate, surf] = await Promise.all([
      import("../air/aio-renderer.ts"),
      import("../air/renderer-state.ts"),
      import("../air/ui-surface.ts"),
    ]);
    renderer._setDocument(win.document);
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    // With props, the thing mounted is a WRAPPER that calls the component —
    // `mount` renders its argument with none, so a preview without this shows
    // every prop as undefined and looks like a broken component.
    const { h } = await import("../air/vdom.ts");
    // …and ONLY when there are props. An empty wrapper still shows up in the
    // surface as an `Anonymous` component above the real one, which is a node
    // in every path for no reason.
    const hasProps = !!one?.props && Object.keys(one.props).length > 0;
    const root = hasProps
      // deno-lint-ignore no-explicit-any
      ? () => h(App as any, one!.props as any)
      : App;
    // deno-lint-ignore no-explicit-any
    const handle = renderer.mount(container, root as any);
    try {
      const rootVnode = rstate._rootStateMap.get(handle)?.vnode ?? null;
      const node = surf.buildUISurface(
        // deno-lint-ignore no-explicit-any
        rootVnode as any,
        full ? { maxText: Number.MAX_SAFE_INTEGER } : undefined,
      );
      const serialized = node ? [surf.serializeSurface(node)] : [];
      return { ok: true, roots: serialized };
    } finally {
      try {
        renderer._unmount(handle);
      } catch { /* teardown is best-effort for a transient inspection mount */ }
      renderer._setDocument(undefined);
    }
  } catch (e) {
    return { ok: false, error: `surface: server-side render failed: ${e}` };
  } finally {
    // AWAITED: the window's own timers (happy-dom's) must be gone before this
    // returns. A fire-and-forget close left them running past the caller —
    // exactly what the leak sanitizers report as a timer that outlived the
    // test, and what a long-running server accumulates one inspection at a
    // time.
    try {
      await win?.happyDOM?.close();
    } catch {
      // aio-ok: teardown of a transient inspection window — the surface (or
      // the render error) was already returned above; nothing else to say
    }
  }
}
