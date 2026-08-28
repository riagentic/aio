// deno-lint-ignore-file
// Router core: path/search signals, navigate(), matchPath(), event listeners.
//
// Lives in air/ (not browser/) because routing is STATE, not transport: a
// signal over `location` plus the history API, which a packaged WebView has as
// surely as a browser tab does. The browser entry re-exports this file
// (src/browser/protocol-router.ts); the standalone/android entry imports it
// directly — ONE `routePath`, one `navigate`, on every target.

import { Listeners } from "../state/listeners.ts";
import { type Signal, signal } from "../state/signal.ts";
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
    return seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  });
  const suffix = exact ? "\\/?$" : "(\\/|$)";
  const re = new RegExp("^" + regParts.join("\\/") + suffix);
  const m = re.exec(path);
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
    url = new URL(_base && to.startsWith("/") ? _base + to : to, location.href);
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
  if (opts?.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  _rSync();
}

export function _getRPath(): string {
  return _rPath;
}

export function _getRSearch(): URLSearchParams {
  return _rSearch;
}
