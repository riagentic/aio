// AIR signal-based router (Route, Outlet, Link, NavLink, Redirect, …).
//
// ONE implementation for every target. It used to live in browser/ and pull
// `ensureConnected` from the WS transport, so the android/standalone bundle —
// which has no transport — could not carry it and an app using `<Route>`
// type-checked green and died at APK bundle time (RIS-11). Routing is state
// (a signal over `location` + the history API), and a WebView has both; the
// only transport-shaped thing the router ever did was "make sure the runtime
// has booted before the first route renders", which is now a hook each
// runtime entry installs (`_setRouterBoot`): the browser entry passes its
// `ensureConnected` (connect the WS), the standalone entry passes its own
// (compose the cells). Same components, same signals, same behaviour.

import { createContext, onMount, useContext } from "./aio-renderer.ts";
import {
  type ComponentFn,
  Fragment,
  h,
  type VChild,
  type VNode,
} from "./vdom.ts";
import {
  type LinkProps,
  matchPath,
  navigate,
  routePath,
  type RouteProps,
  routeSearch,
  type RouteState,
} from "./router-core.ts";

export {
  type LinkProps,
  matchPath,
  navigate,
  routePath,
  type RouteProps,
  routeSearch,
  type RouteState,
};

// ── Runtime boot hook ──────────────────────────────────────────────

let _boot: (() => void) | null = null;

/** Installed by a runtime entry (browser-air.ts / standalone-air.ts): the
 *  "boot before the first route renders" step. Idempotent on the callee's
 *  side; the router just calls it. */
export function _setRouterBoot(fn: (() => void) | null): void {
  _boot = fn;
}

function bootRuntime(): void {
  if (!_boot) {
    // Never silent: a router rendered outside any runtime entry is a wiring
    // bug, not a state the app can run in.
    throw new Error(
      "[aio:router] no runtime installed — import the router through " +
        '"aio/air" (browser) or the standalone entry, never src/air/router.ts ' +
        "directly",
    );
  }
  _boot();
}

// ── page (using h()) ───────────────────────────────────────────────

/** Renders the component matching the current page key. */
export function page<K extends string>(
  current: K,
  routes: Record<K, (props: Record<string, never>) => unknown>,
): VNode | null {
  const Component = routes[current];
  return Component ? h(Component as ComponentFn, null) : null;
}

// ── Router hooks ──────────────────────────────────────────────────

/** Current route state -- reads routePath/routeSearch signals (auto-tracked by AIR). */
export function useRoute<
  P extends Record<string, string> = Record<string, string>,
>(pattern?: string): RouteState<P> {
  bootRuntime();
  const path = routePath.value; // auto-tracked signal read
  const search = routeSearch.value;
  if (!pattern) return { path, params: {} as P, search, matched: true };
  const params = matchPath(pattern, path);
  return {
    path,
    params: (params ?? {}) as P,
    search,
    matched: params !== null,
  };
}

/** Returns the navigate function. */
export function useNavigate(): (
  to: string | number,
  opts?: { replace?: boolean },
) => void {
  return navigate;
}

// ── Route context (nested routes + Outlet) ─────────────────────────

type _RouteCtxType = {
  basePath: string;
  params: Record<string, string>;
  outlet: unknown;
};
const _RouteCtx = createContext<_RouteCtxType>({
  basePath: "",
  params: {},
  outlet: null,
});

/** Renders element when path matches. Nest inside other Routes for layouts with Outlet. */
export function Route(
  { path, index, element, children }: RouteProps,
): VNode | null {
  bootRuntime();
  const currentPath = routePath.value; // auto-tracked signal read
  const { basePath, params: parentParams } = useContext(_RouteCtx);

  if (index) {
    const base = basePath || "/";
    const match = currentPath === base ||
      currentPath === base.replace(/\/$/, "") ||
      base === "/" && currentPath === "/";
    if (!match) return null;
    return (element ?? null) as VNode | null;
  }

  if (!path) return null;
  const full =
    (basePath + "/" + path.replace(/^\//, "")).replace(/\/+/g, "/").replace(
      /(.)\/$/,
      "$1",
    ) || "/";
  // Nested routes make this a PREFIX match; a leaf route is exact. The JSX
  // runtime always passes `children` — as `[]` when there are none — so
  // `!!children` was true for every `<Route/>` written in TSX and
  // `<Route path="/" element={<Home/>}/>` matched every path (the `h()`
  // call sites in the tests passed no children at all, which is why the
  // suite never saw it). Empty means none.
  const hasChildren = Array.isArray(children)
    ? children.length > 0
    : children != null;
  const params = matchPath(full, currentPath, !hasChildren);
  if (!params) return null;

  const allParams = { ...parentParams, ...params };
  return h(
    _RouteCtx.Provider,
    {
      value: {
        basePath: full,
        params: allParams,
        outlet: hasChildren ? children : null,
      },
    },
    (hasChildren
      ? (element ?? h(Outlet as ComponentFn, {}))
      : element ?? null) as VChild,
  );
}

/** Renders the matching child route inside a parent Route's element. */
export function Outlet(): VNode | null {
  const { outlet } = useContext(_RouteCtx);
  if (outlet == null) return null;
  // The renderer passes a component's children as an array; a bare array is
  // not a renderable VNode — wrap it so nested <Route> children render.
  return Array.isArray(outlet)
    ? h(Fragment, null, ...(outlet as VChild[]))
    : (outlet as VNode);
}

/** Anchor that navigates without page reload. Adds activeClass when path matches. */
export function Link(
  { to, replace: rep, exact, activeClass, activeStyle, children, ...rest }:
    LinkProps,
): VNode {
  const path = routePath.value; // auto-tracked signal read
  const isActive = (exact || to === "/")
    ? path === to
    : path === to || path.startsWith(to + "/");
  // A click this router must NOT take over. Every one of these is a gesture the
  // browser already handles correctly, and intercepting it replaces the user's
  // intent with an in-page route change:
  //
  //  • a modified / non-primary click — open in a new tab, a new window, save;
  //  • `target` (other than `_self`) or `download` on the anchor — the author
  //    said where this goes, and `<Link to="/x" target="_blank">` silently
  //    navigated in place instead (measured);
  //  • a destination on another ORIGIN, or a non-http scheme (`mailto:`,
  //    `tel:`) — there is no in-app route there. `<Link to="https://…">` used
  //    to `preventDefault()` and then throw a SecurityError out of
  //    `history.pushState`, so the link did nothing at all.
  //
  // In every case the handler simply returns and the anchor's own `href` does
  // the right thing.
  function ownedByBrowser(e: MouseEvent): boolean {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return true;
    }
    const el = e.currentTarget as HTMLAnchorElement | null;
    const target = el?.getAttribute?.("target");
    if (target && target !== "_self") return true;
    if (el?.hasAttribute?.("download")) return true;
    if (typeof location === "undefined") return false;
    try {
      const url = new URL(to, location.href);
      if (url.origin !== location.origin) return true;
      if (url.protocol !== "http:" && url.protocol !== "https:") return true;
    } catch {
      // Not a URL this router can resolve — let the anchor try.
      return true;
    }
    return false;
  }
  function handleClick(e: Event) {
    if (ownedByBrowser(e as MouseEvent)) return;
    e.preventDefault();
    navigate(to, { replace: rep });
  }
  const cls = isActive && activeClass
    ? [rest.className, activeClass].filter(Boolean).join(" ")
    : rest.className;
  const sty = isActive && activeStyle
    ? { ...rest.style, ...activeStyle }
    : rest.style;
  return h("a", {
    ...rest,
    href: to,
    onClick: handleClick,
    className: cls,
    style: sty,
  }, children as VChild);
}

/** Link with automatic 'active' class. */
export function NavLink(
  { activeClass = "active", ...rest }: Omit<LinkProps, "activeClass"> & {
    activeClass?: string;
  },
): VNode {
  return Link({ activeClass, ...rest } as LinkProps);
}

/** Navigates to `to` on mount. Replace=true by default (no history entry). */
export function Redirect(
  { to, replace: rep = true }: { to: string; replace?: boolean },
): null {
  onMount(() => {
    navigate(to, { replace: rep });
  });
  return null;
}
