// deno-lint-ignore-file
// Client-side router: path/search signals, navigate(), matchPath(), event listeners.

import { Listeners } from "./listeners.ts";
import { type Signal, signal } from "./signal.ts";
import type { LinkProps, RouteProps, RouteState } from "./protocol-types.ts";

export type { LinkProps, RouteProps, RouteState };

let _rPath = typeof location !== "undefined" ? location.pathname : "/";
let _rSearch: URLSearchParams = typeof location !== "undefined"
  ? new URLSearchParams(location.search)
  : new URLSearchParams();

export const _rListeners = new Listeners<void>();

export const routePath: Signal<string> = signal<string>(_rPath);
export const routeSearch: Signal<URLSearchParams> = signal<URLSearchParams>(
  _rSearch,
);

export function _rSync(): void {
  _rPath = location.pathname;
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

if (typeof window !== "undefined") {
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
    url = new URL(to, location.href);
  } catch {
    console.error(`[aio:navigate] Invalid URL: ${to}`);
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
