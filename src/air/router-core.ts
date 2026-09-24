// deno-lint-ignore-file
// Router core: path/search signals, navigate(), matchPath(), event listeners.
//
// Lives in air/ (not browser/) because routing is STATE, not transport: a
// signal over `location` plus the history API, which a packaged WebView has as
// surely as a browser tab does. The browser entry re-exports this file
// (src/browser/protocol-router.ts); the standalone/android entry imports it
// directly — ONE `routePath`, one `navigate`, on every target.

import { Listeners } from "../state/listeners.ts";
import { _ssrRouteSaidAt, _ssrRouteWritten } from "./ssr-render.ts";
import {
  _readScopeNow,
  _setScopedEffectHook,
  type Signal,
  signal,
} from "../state/signal.ts";
import type {
  LinkProps,
  RouteProps,
  RouteState,
} from "../protocol/protocol-types.ts";

export type { LinkProps, RouteProps, RouteState };

// ── Route base — the packaged shell is not served from "/" ────────────
//
// A standalone (android) app loads `…/assets/index.html` from the asset
// loader, so `location.pathname` starts as "/assets/index.html" and
// `<Route path="/">` would never match. The runtime tells the router where
// the app's root actually is; `routePath` is read RELATIVE to it and
// `navigate("/x")` writes `<base>/x`. Empty on every other target (a no-op).
let _base = "";

function _relative(pathname: string): string {
  if (!_base) return pathname;
  if (pathname === _base || pathname === _base + "/") return "/";
  return pathname.startsWith(_base + "/")
    ? pathname.slice(_base.length)
    : pathname;
}

/** Sets the path the app's "/" lives under (e.g. "/assets"); re-syncs the
 *  route signals from `location`. "" restores plain root routing. */
export function _setRouteBase(base: string): void {
  _base = base.replace(/\/+$/, "");
  if (typeof location !== "undefined") _rSync();
}

/** The URL an app-absolute `to` really lives at: under the route base. The
 *  one spelling both `navigate` and `<Link href>` use — a Link that wrote
 *  `to` raw pointed its `href` at the ORIGIN's `/about` on android, so every
 *  gesture the router leaves to the anchor (open in new tab, copy link, a
 *  modified click) left the app for a path the asset loader does not serve,
 *  while a plain click went to `/assets/about`. @internal */
export function _appHref(to: string): string {
  // `//host/x` is scheme-relative — another origin, never an app path.
  return _base && to.startsWith("/") && !to.startsWith("//") ? _base + to : to;
}

/** The current route base — "" unless a packaged shell installed one. */
// aio-ok: test seam — read by tests/standalone-router.test.tsx (route base adoption)
export function _getRouteBase(): string {
  return _base;
}

let _rPath = typeof location !== "undefined"
  ? _relative(location.pathname)
  : "/";
let _rSearch: URLSearchParams = typeof location !== "undefined"
  ? new URLSearchParams(location.search)
  : new URLSearchParams();

export const _rListeners = new Listeners<void>();

/** Current pathname as a signal — auto-tracked in AIR components. */
export const routePath: Signal<string> = signal<string>(_rPath);
/** Current query string as a `URLSearchParams` signal. */
export const routeSearch: Signal<URLSearchParams> = signal<URLSearchParams>(
  _rSearch,
);

// Every write — `.set()`, and `.update()` which calls it — stamps the writer's
// async context, so a server render can tell whether the route it reads was
// set in its own synchronous step (air/ssr-render.ts, "Who set the route").
// Observe-only: the write itself is the prototype's, unchanged.
//
// And every READ — `.value`, `routePath()`, `.get()`, `.peek()` — made inside
// a render given its own route (`renderToString(v, { route })`: the signals'
// read scope, see state/signal.ts) answers with that route, never the global:
// such a render never renders from it and never writes it. A tracked read
// still SUBSCRIBES through the prototype getter (tracking only — the value is
// the render's), so an effect over the route keeps its link; a computed read
// in a render is evaluated for that render alone (state/signal.ts, "Read
// scope"). With no read scope (the browser, a render without a route) the
// read is the prototype's, unchanged.
/** The read scope air/vdom-ssr.ts enters: an explicit route (it is the only
 *  one ever entered). */
type SsrRouteLike = { path: string; search: URLSearchParams };
for (
  const [sig, pick] of [
    [routePath, (r: { path: string }) => r.path],
    [routeSearch, (r: { search: URLSearchParams }) => r.search],
  ] as [
    Signal<unknown>,
    (r: { path: string; search: URLSearchParams }) => unknown,
  ][]
) {
  const proto = Object.getPrototypeOf(sig) as object;
  const value = Object.getOwnPropertyDescriptor(proto, "value")!;
  const peek = (proto as { peek(): unknown }).peek;
  Object.defineProperty(sig, "value", {
    configurable: true,
    get(this: Signal<unknown>): unknown {
      const global = value.get!.call(this); // tracks, in every scope
      const r = _readScopeNow() as SsrRouteLike | null;
      return r !== null ? pick(r) : global;
    },
    set(this: Signal<unknown>, v: unknown): void {
      value.set!.call(this, v);
    },
  });
  Object.defineProperty(sig, "peek", {
    configurable: true,
    writable: true,
    value: function (this: Signal<unknown>): unknown {
      const r = _readScopeNow() as SsrRouteLike | null;
      return r !== null ? pick(r) : peek.call(this);
    },
  });
}
// An effect or watch CREATED during a render given its own route runs on the
// GLOBAL route (state/signal.ts, "Read scope") — so one that reads the route
// and writes a value the page shows puts the global route's value into the
// render, silently. Said, per call site with a count, when its first run read
// the route. Observe-only; dev and prod alike.
_setScopedEffectHook((reads) => {
  if (!reads([routePath, routeSearch])) return;
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  const at = frames.find((f) =>
    !/state\/signal\.ts|state\/watch\.ts|air\/router-core\.ts/.test(f)
  )?.trim() ?? "unknown";
  const more = _ssrRouteSaidAt("effect " + at);
  if (more === null) {
    return;
  }
  console.warn(
    "[aio] an effect (or watch) created during a render given its own route " +
      "read routePath/routeSearch — it runs on the GLOBAL route, never the " +
      "render's, so a value it writes for the page is the global route's. " +
      "Derive render values with computed() or useRoute() instead " +
      `(${at}).${more}`,
  );
});

for (const sig of [routePath, routeSearch] as Signal<unknown>[]) {
  const write = sig.set;
  Object.defineProperty(sig, "set", {
    configurable: true,
    writable: true,
    value: function (
      this: Signal<unknown>,
      next: unknown,
      opts?: { force?: boolean },
    ): void {
      _ssrRouteWritten();
      write.call(this, next, opts);
    },
  });
}

export function _rSync(): void {
  _rPath = _relative(location.pathname);
  _rSearch = new URLSearchParams(location.search);
  routePath.set(_rPath);
  routeSearch.set(_rSearch);
  _rListeners.notify(undefined);
}

export let _popstateHandler: (() => void) | null = null;
export let _navigateHandler: EventListener | null = null;

export function _setPopstateHandler(h: (() => void) | null): void {
  _popstateHandler = h;
}
export function _setNavigateHandler(h: EventListener | null): void {
  _navigateHandler = h;
}

/** The DOM whose history this router follows: the page's `window` (in a
 *  browser `window === globalThis`; under testUI it is the happy-dom window
 *  the harness installed). `null` where there is no DOM at all. Listeners
 *  are attached HERE, never on the Deno global — a `popstate` registered
 *  there would never fire, and the testUI guard refuses it. */
function _routerWindow(): EventTarget | null {
  const w = (globalThis as { window?: EventTarget }).window;
  return w && typeof (w as EventTarget).addEventListener === "function"
    ? w
    : null;
}
let _listenersOn: EventTarget | null = null;

/** Attach the history listeners once, on demand — called by the runtime that
 *  mounts the router (browser transport, standalone boot), not at import. */
export function _installRouterListeners(): void {
  const w = _routerWindow();
  if (!w || _listenersOn === w) return;
  _listenersOn = w;
  const addEventListener = w.addEventListener.bind(w);

  _popstateHandler = _rSync;
  addEventListener("popstate", _popstateHandler);
  // AIO-54: Electron swallows <a> clicks before DOM dispatch. The main process
  // intercepts via will-navigate, prevents navigation, and relays the URL back
  // to the renderer as CustomEvent('aio:navigate'). We handle it here so both
  // browser.ts (React) and browser-air.ts (AIR) get navigation support.
  // Store ref for cleanup in _reset() (AIO-141)
  _navigateHandler = ((e: CustomEvent<{ url: string }>) => {
    try {
      const url = new URL(e.detail.url);
      navigate(url.pathname + url.search + url.hash);
    } catch { /* invalid URL — ignore */ }
  }) as EventListener;
  addEventListener("aio:navigate", _navigateHandler);
}

export function _rSubscribe(fn: () => void): () => void {
  return _rListeners.add(() => fn());
}

export function _rSnapshot(): string {
  return typeof location !== "undefined"
    ? location.pathname + location.search
    : "/";
}

/** Decode a path's percent-escapes for COMPARISON, keeping the two that would
 *  change its shape: `%2F` (a slash inside one segment) and `%25` (a literal
 *  percent, which a second decode would otherwise read as the start of an
 *  escape).
 *
 *  `routePath` is `location.pathname`, and a browser percent-encodes that: the
 *  page at `/café` has the pathname `/caf%C3%A9`, `/about us` has
 *  `/about%20us`. Static pattern segments were compared against it raw, so
 *  `<Route path="/café">` never matched ANY url — reached by a link, by
 *  `navigate("/café")` or typed in the address bar — and nothing said why. A
 *  malformed escape run is left as written, exactly as a param always was. */
function _pathForMatch(path: string): string {
  return path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    let out = "";
    let pending = "";
    const flush = () => {
      if (!pending) return;
      try {
        out += decodeURIComponent(pending);
      } catch {
        out += pending;
      }
      pending = "";
    };
    for (let i = 0; i < run.length; i += 3) {
      const tok = run.slice(i, i + 3);
      const hex = tok.slice(1).toUpperCase();
      if (hex === "2F" || hex === "25") {
        flush();
        out += tok;
      } else {
        pending += tok;
      }
    }
    flush();
    return out;
  });
}

/** A path reduced to what route matching compares: no query or hash, escapes
 *  decoded (see `_pathForMatch`), no trailing slash except on the root.
 *  @internal */
export function _normalizeRoutePath(path: string): string {
  const bare = path.replace(/[?#].*$/, "");
  const decoded = _pathForMatch(bare);
  return decoded.length > 1 ? decoded.replace(/\/+$/, "") || "/" : decoded;
}

export function matchPath(
  pattern: string,
  path: string,
  exact = true,
): Record<string, string> | null {
  const keys: string[] = [];
  const segments = pattern.replace(/\/+$/, "").split("/");
  const regParts = segments.map((seg) => {
    if (seg.startsWith(":")) {
      keys.push(seg.slice(1));
      return "([^/]+)";
    }
    if (seg === "*") {
      keys.push("*");
      return "(.*)";
    }
    // `*` is escaped too: only a WHOLE `*` segment is the wildcard. Left raw,
    // `/a*b` became the regex `a*b` — "zero or more a's, then b" — and matched
    // `/b`.
    return _pathForMatch(seg).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  const suffix = exact ? "\\/?$" : "(\\/|$)";
  // A trailing wildcard's separator is optional: `/files/*` matches `/files`
  // with `*` = "". The server's `matchRoute` always did, and this required the
  // slash — so the same app answered `/files` from its HTTP route and rendered
  // nothing for it in `<Route path="/files/*">`. Pinned against the server over
  // one table in tests/route-matching-parity.test.ts.
  const last = regParts.length - 1;
  const re = new RegExp(
    "^" +
      (last > 0 && segments[last] === "*"
        ? regParts.slice(0, last).join("\\/") + "(?:\\/(.*))?"
        : regParts.join("\\/")) +
      suffix,
  );
  const m = re.exec(_pathForMatch(path));
  if (!m) return null;
  const params: Record<string, string> = {};
  keys.forEach((k, i) => {
    let v: string;
    try {
      v = decodeURIComponent(m[i + 1] ?? "");
    } catch {
      v = m[i + 1] ?? "";
    }
    if (k === "*") v = v.replace(/\/$/, "");
    params[k] = v;
  });
  return params;
}

/**
 * Programmatic navigation. Pass a path (`navigate("/users/42")`, optionally
 * `{ replace: true }`) or a history delta (`navigate(-1)`).
 */
export function navigate(
  to: string | number,
  opts?: { replace?: boolean },
): void {
  if (typeof to === "number") {
    history.go(to);
    return;
  }
  // AIO-193: guard against malformed URLs — prevents route state desync
  let url: URL;
  try {
    // An app-absolute path is relative to the route base, never to the origin.
    url = new URL(_appHref(to), location.href);
  } catch {
    console.error(`[aio:navigate] Invalid URL: ${to}`);
    return;
  }
  // A CROSS-ORIGIN destination cannot be a history entry — `pushState` throws a
  // SecurityError for one, by spec. That throw used to escape `navigate()`
  // uncaught (from inside a click handler, after `preventDefault()` had already
  // run), so `navigate("https://example.com/x")` and `<Link to="https://…">`
  // did NOTHING at all: no navigation, no history entry, and a framework-level
  // "event handler error" as the only trace. Leaving the app IS what an
  // absolute cross-origin URL asks for, so do it — a real navigation, which
  // is exactly what the plain `<a>` would have done.
  if (url.origin !== location.origin) {
    location.assign(url.href);
    return;
  }
  // Navigating to the URL the page is ALREADY at replaces its entry — the HTML
  // navigate algorithm's own rule for a same-URL navigation, and what a plain
  // `<a>` does. Pushing made a `<Link>` to the current page (a nav bar's own
  // item, clicked twice) a duplicate history entry, so Back looked dead once
  // per click. A different hash or query is a different URL and still pushes.
  if (opts?.replace || url.href === location.href) {
    history.replaceState(null, "", url);
  } else history.pushState(null, "", url);
  _rSync();
}

export function _getRPath(): string {
  return _rPath;
}

export function _getRSearch(): URLSearchParams {
  return _rSearch;
}
