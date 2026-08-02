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
): Promise<HeadlessSurfaceResult> {
  // 1. The app's UI entry. Module cache shares already-imported cell modules,
  //    so the components read the SERVER's live cell instances.
  let App: unknown;
  try {
    const mod = await import(toFileUrl(entryPath).href);
    App = mod.default;
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
    // deno-lint-ignore no-explicit-any
    const handle = renderer.mount(container, App as any);
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
    win?.happyDOM?.close()?.catch?.(() => {});
  }
}
