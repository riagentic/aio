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
//
// The render reads cells AS A CLIENT DOES — see withClientView. The server's
// own getters see every field by design, so a UI that blank-screened in the
// browser on a `visible.exclude`d read rendered here, secret and all.

import { dirname, join, relative, toFileUrl } from "@std/path";
import type { CellDef, CellFieldFilter } from "../state/cell-types.ts";
import {
  getRegisteredCells,
  reportHiddenRead,
} from "../state/cell-reactive.ts";
import {
  applyCellFieldFilter,
  uiKeyVisibility,
} from "../state/state-filter.ts";
import { decideForUser } from "./aio-composition.ts";

/** One serialized surface root (shape defined in air/ui-surface.ts). */
export type HeadlessSurfaceResult =
  | { ok: true; roots: unknown[] }
  | { ok: false; error: string };

/** When this process first imported each UI entry (by file URL).
 *
 *  A dynamic import is cached for the life of the process, so every later
 *  render shows the UI as of that moment — after an edit to App.tsx the
 *  watcher reloads the browser, and this render still showed the old UI under
 *  a note that said only "server-side render". Re-importing per edit was
 *  refused (the graph grows per edit, and a busted child module can load fresh
 *  copies of cells instead of the live ones), so the render keeps its import
 *  and says when a source file is newer than it. */
const _importedAt = new Map<string, number>();

/** What a stale headless render carries on each root (`am surface --json`). */
export type StaleSurface = {
  /** The newest changed source file, relative to the entry's directory. */
  file: string;
  changedAt: string;
  importedAt: string;
  note: string;
};

/** Directories a UI never imports from: VCS/tooling dot-dirs, dependencies,
 *  build output, tests. Skipped so an edit there never reads as a UI change. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "tests", "test"]);
const UI_SOURCE = /\.(tsx|jsx|ts|js|mjs)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** A bound on the walk: an inspection command must not stat a monorepo. */
const MAX_FILES = 5000;

/** The newest UI source file under the entry's directory changed after
 *  `importedAt`, or null. The directory, not the entry alone: an edit to a
 *  component App.tsx imports is the common case, and it leaves App.tsx's own
 *  mtime untouched. */
async function staleSince(
  entryPath: string,
  importedAt: number,
): Promise<StaleSurface | null> {
  const root = dirname(entryPath);
  let newest: { path: string; at: number } | null = null;
  let seen = 0;
  const walk = async (dir: string): Promise<void> => {
    try {
      for await (const e of Deno.readDir(dir)) {
        if (++seen > MAX_FILES) return;
        if (e.name.startsWith(".")) continue;
        const path = join(dir, e.name);
        if (e.isDirectory) {
          if (!SKIP_DIRS.has(e.name)) await walk(path);
          continue;
        }
        if (!UI_SOURCE.test(e.name) || TEST_FILE.test(e.name)) continue;
        const at = (await Deno.stat(path).catch(() => null))?.mtime?.getTime();
        if (at !== undefined && at > importedAt && at > (newest?.at ?? 0)) {
          newest = { path, at };
        }
      }
    } catch {
      // aio-ok: a directory that vanished or denies reading mid-walk has no
      // edit to report; the walk is a staleness hint, not the render
    }
  };
  await walk(root);
  if (!newest) return null;
  const { path, at } = newest as { path: string; at: number };
  const file = relative(root, path);
  const clock = (ms: number) => new Date(ms).toISOString();
  return {
    file,
    changedAt: clock(at),
    importedAt: clock(importedAt),
    note: `this server-side render is STALE — ${file} changed at ` +
      `${clock(at)}, after the server imported the UI at ${
        clock(importedAt)
      }, ` +
      `and the server keeps the import it has. Open a client (am open, or ` +
      `--client=browser) to read the current UI.`,
  };
}

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
  const href = toFileUrl(entryPath).href;
  // Recorded BEFORE the first import resolves, so an edit landing during the
  // import reads as newer than it (stale), never the other way round.
  if (!_importedAt.has(href)) _importedAt.set(href, Date.now());
  try {
    const mod = await import(href) as Record<
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
    const [renderer, rstate, surf, router] = await Promise.all([
      import("../air/aio-renderer.ts"),
      import("../air/renderer-state.ts"),
      import("../air/ui-surface.ts"),
      import("../air/router.ts"),
    ]);
    // The router's "boot the runtime before the first route renders" hook is
    // whatever entry the app's imports loaded — in a Deno process that is the
    // BROWSER entry, whose boot opens a WebSocket to `location` and throws
    // "page has no HTTP origin" when there is none. So every component with a
    // <Route> or useRoute() failed `am surface` (no client) and `am preview`,
    // while the same component rendered in a real window. A headless mount
    // has nothing to connect: the cells it reads are the server's own (or,
    // for `am preview`, booted by the caller), and the route is "/" — the
    // router's value with no `location`. Put back after the render.
    const prevBoot = router._getRouterBoot();
    router._setRouterBoot(() => {});
    renderer._setDocument(win.document);
    // The restore covers a mount that THROWS too: a boot hook or document
    // left swapped in a long-running server would outlive this inspection.
    try {
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      // With props, the thing mounted is a WRAPPER that calls the component —
      // `mount` renders its argument with none, so a preview without this
      // shows every prop as undefined and looks like a broken component.
      const { h } = await import("../air/vdom.ts");
      // …and ONLY when there are props. An empty wrapper still shows up in the
      // surface as an `Anonymous` component above the real one, which is a
      // node in every path for no reason.
      const hasProps = !!one?.props && Object.keys(one.props).length > 0;
      const root = hasProps
        // deno-lint-ignore no-explicit-any
        ? () => h(App as any, one!.props as any)
        : App;
      // Mount AND serialize inside one synchronous client-view window: no
      // await between install and restore, so no other server code can run
      // while the cells answer as a client.
      let handle: ReturnType<typeof renderer.mount> | undefined;
      let serialized: unknown[] = [];
      try {
        withClientView(() => {
          // deno-lint-ignore no-explicit-any
          handle = renderer.mount(container, root as any);
          const rootVnode = rstate._rootStateMap.get(handle)?.vnode ?? null;
          const node = surf.buildUISurface(
            // deno-lint-ignore no-explicit-any
            rootVnode as any,
            full ? { maxText: Number.MAX_SAFE_INTEGER } : undefined,
          );
          serialized = node ? [surf.serializeSurface(node)] : [];
        });
      } catch (e) {
        // A mount that throws never returns its handle, but it already
        // registered the root — and in a long-running server every failed
        // inspection would leave one more dead root in the live set that the
        // client-side surface walks. Drop it by its container.
        if (!handle) {
          for (const st of rstate._liveRoots) {
            if (st.root === container) {
              st.disposed = true;
              rstate._liveRoots.delete(st);
            }
          }
        }
        // The component chain, as the browser's blank-screen report names it.
        const chain = (e as { __aioComponents?: unknown })?.__aioComponents;
        return {
          ok: false,
          error: `surface: server-side render failed: ${e}${
            Array.isArray(chain) && chain.length > 0
              ? ` (in ${chain.map((c) => `<${c}>`).join(" \u2190 ")})`
              : ""
          }`,
        };
      }
      try {
        const stale = await staleSince(entryPath, _importedAt.get(href)!);
        if (stale) {
          for (const r of serialized) {
            if (r && typeof r === "object") {
              (r as Record<string, unknown>).stale = stale;
            }
          }
        }
        return { ok: true, roots: serialized };
      } finally {
        try {
          renderer._unmount(handle!);
        } catch {
          /* teardown is best-effort for a transient inspection mount */
        }
      }
    } finally {
      renderer._setDocument(undefined);
      router._setRouterBoot(prevBoot);
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

// ── The client's read surface, for one render ──────────────────────────────

type Slice = Record<string, unknown>;
type AnyDef = CellDef & Record<string, unknown>;

/** A dot-path exclude, with the tripwire a client read has: the dropped leaf
 *  comes back as a non-enumerable getter that reports, so
 *  `settings.account.key` refuses exactly as a top-level hidden field does
 *  (the same shape as `deepExcludeLoud` in state/cell-reactive.ts, which is
 *  not exported; the outcome is pinned by
 *  tests/server-surface-client-view.test.ts). */
function excludeLoud(
  value: unknown,
  segs: string[],
  onRead: () => void,
): unknown {
  if (segs.length === 0 || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((el): unknown => excludeLoud(el, segs, onRead));
  }
  const obj = value as Slice;
  const head = segs[0]!;
  if (segs.length === 1) {
    const kept: Slice = { ...obj };
    delete kept[head];
    Object.defineProperty(kept, head, {
      get() {
        onRead();
        return undefined;
      },
      enumerable: false,
      configurable: true,
    });
    return kept;
  }
  if (!(head in obj)) return value;
  return { ...obj, [head]: excludeLoud(obj[head], segs.slice(1), onRead) };
}

/** Run `fn` (synchronously) with every registered cell answering reads the
 *  way a CLIENT's bound cell does, then put the server's accessors back.
 *
 *  Why the swap and not a second binding: the UI entry's
 *  `import { settings } from "./cell.ts"` resolves, through the module cache,
 *  to the very object the server bound — there is no other `settings` to hand
 *  it. So for the length of one mount the object's state getters and selectors
 *  are the client's:
 *
 *  - the VALUES are what a client receives: the live server slice through the
 *    cell's `visible` filter, then `visible.forUser` for a caller with no user
 *    (a cell whose filter throws or returns a non-object is omitted, and a
 *    client with no slice reads declared state — the broadcast's fail-closed
 *    rule and the client getter's fallback);
 *  - the READS refuse as a client's do: a hidden field throws
 *    `reportHiddenRead`'s error, a selector reading one throws the same, a
 *    dot-path exclude trips on the nested read;
 *  - a cell the server never bound — the UI imports it, the server entry did
 *    not — still gets its selectors (a client binds every cell it imports);
 *    its methods keep their own "called before the cell's runtime is booted"
 *    refusal, which already names the cell and the fix.
 *
 *  Synchronous on purpose: with no await inside, nothing else in the server
 *  can run while its cells answer as a client. */
function withClientView<T>(fn: () => T): T {
  const restore: (() => void)[] = [];
  try {
    const cells = [...getRegisteredCells().values()] as AnyDef[];
    const views = new Map<string, { filter?: CellFieldFilter; view: Slice }>();
    for (const def of cells) {
      views.set(def.__aio.id, clientSliceOf(def));
    }
    // Every other cell's client slice, guarded — a deps-form selector reading
    // another cell's hidden field must refuse too.
    const guarded = (def: AnyDef): Slice => {
      const { filter, view } = views.get(def.__aio.id)!;
      const slice = !filter || filter === "all"
        ? view
        : applyCellFieldFilter(filter, view) ?? {};
      const hidden = Object.keys(def.__aio.state).filter((k) =>
        uiKeyVisibility(filter, k).hidden
      );
      if (hidden.length === 0) return slice;
      return new Proxy(slice, {
        get(target, prop) {
          if (typeof prop === "string" && hidden.includes(prop)) {
            reportHiddenRead(
              def.__aio.id,
              prop,
              uiKeyVisibility(filter, prop).reason!,
            );
          }
          return (target as Record<string | symbol, unknown>)[prop];
        },
      });
    };
    const byId = new Map(cells.map((d) => [d.__aio.id, d]));
    for (const def of cells) {
      installClientView(def, views.get(def.__aio.id)!, guarded, byId, restore);
    }
    return fn();
  } finally {
    for (let i = restore.length - 1; i >= 0; i--) restore[i]!();
  }
}

/** What a client holds for this cell — see withClientView. Read through the
 *  server's CURRENT accessors, before any of them is swapped. */
function clientSliceOf(def: AnyDef): { filter?: CellFieldFilter; view: Slice } {
  const a = def.__aio;
  const declared = a.state as Slice;
  // Client-scoped cells live in the client only: no filter, declared state.
  if (a.scope === "client") return { view: declared };
  const filter = a.ui;
  const raw: Slice = {};
  for (const key of Object.keys(declared)) {
    const v = def[key];
    raw[key] = typeof v === "function" ? declared[key] : v;
  }
  let slice: Slice | undefined = !filter || filter === "all"
    ? raw
    : applyCellFieldFilter(filter, raw);
  if (slice && a.uiForUser) {
    // The broadcast's decision, not a copy of it: a filter that throws,
    // returns a Promise, or returns a non-object omits the cell, and a client
    // with no slice reads declared state. Not logged here — the broadcast
    // logs the same failing filter for every real client; this render only
    // needs to not show what the filter would have hidden.
    const out = decideForUser(a.id, a.uiForUser, slice, undefined);
    slice = "view" in out ? out.view : undefined;
  }
  return { filter, view: slice ?? declared };
}

function installClientView(
  def: AnyDef,
  { filter, view }: { filter?: CellFieldFilter; view: Slice },
  guarded: (def: AnyDef) => Slice,
  byId: ReadonlyMap<string, AnyDef>,
  restore: (() => void)[],
): void {
  const a = def.__aio;
  const id = a.id;
  const swap = (key: string, desc: PropertyDescriptor) => {
    const prev = Object.getOwnPropertyDescriptor(def, key);
    if (prev && !prev.configurable) return;
    Object.defineProperty(def, key, { enumerable: false, ...desc });
    restore.push(() => {
      if (prev) Object.defineProperty(def, key, prev);
      else delete def[key];
    });
  };

  for (const key of Object.keys(a.state)) {
    // A callable owns the name (cannot happen per AIO-6.1; the client bind
    // skips it too).
    if (
      typeof Object.getOwnPropertyDescriptor(def, key)?.value === "function"
    ) {
      continue;
    }
    const vis = uiKeyVisibility(filter, key);
    swap(key, {
      get() {
        if (vis.hidden) reportHiddenRead(id, key, vis.reason!);
        const v = view[key];
        return vis.deepSegs
          ? vis.deepSegs.reduce(
            (acc, segs) =>
              excludeLoud(acc, segs, () =>
                reportHiddenRead(
                  id,
                  `${key}.${segs.join(".")}`,
                  "the field is under a visible.exclude path",
                )),
            v,
          )
          : v;
      },
      configurable: true,
    });
  }

  const deps = a.selectorDeps ?? {};
  for (const [key, selectorFn] of Object.entries(a.selectors)) {
    const isDeps = key in deps;
    swap(key, {
      value: (...args: unknown[]) => {
        const own = guarded(def);
        if (!isDeps && args.length > 0) {
          return (selectorFn as (s: unknown, ...x: unknown[]) => unknown)(
            own,
            ...args,
          );
        }
        const full = new Proxy({} as Slice, {
          get(_t, prop) {
            if (typeof prop !== "string") return undefined;
            const other = byId.get(prop);
            return other ? guarded(other) : undefined;
          },
        });
        return isDeps
          ? (selectorFn as (
            s: unknown,
            f: unknown,
            ...x: unknown[]
          ) => unknown)(
            own,
            full,
            ...args,
          )
          : selectorFn(own, full);
      },
      writable: true,
      configurable: true,
    });
  }
}
