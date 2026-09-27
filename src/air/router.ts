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
import { isSignal } from "./signal-binding.ts";
import {
  _isSsrRendering,
  _registerSsrCapture,
  _SSR_NO_CONTEXT,
  _ssrContextValue,
  _ssrRouteNow,
  _ssrRouteRead,
} from "./vdom-ssr.ts";
import {
  type ComponentFn,
  Fragment,
  h,
  type VChild,
  type VNode,
} from "./vdom.ts";
import {
  _appHref,
  _normalizeRoutePath,
  _resolveTo,
  _routePathOf,
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

/** The installed boot hook — read by a TRANSIENT renderer (the headless mount
 *  behind `am surface` / `am preview`) so it can put back exactly what it
 *  replaced for the length of one render. */
export function _getRouterBoot(): (() => void) | null {
  return _boot;
}

// ── The route a server render sees ────────────────────────────────

type _RouteNow = { path: string; search: URLSearchParams };
const _SSR_ROUTE = Symbol("aio.ssrRoute");
// Snapshotted when a server render starts, so a stream keeps the route of the
// request that started it (see `_registerSsrCapture`).
_registerSsrCapture(
  _SSR_ROUTE,
  (): _RouteNow => ({ path: routePath.peek(), search: routeSearch.peek() }),
  (a, b) => {
    const x = a as _RouteNow, y = b as _RouteNow;
    return x.path === y.path && x.search.toString() === y.search.toString();
  },
);

/** The render's route snapshot on the server; null everywhere else. */
function _ssrRoute(): _RouteNow | null {
  // A render given its route (`renderToString(v, { route })`) routes by it
  // alone: no global, nothing to check.
  const explicit = _ssrRouteNow();
  if (explicit !== null) return explicit;
  const ssr = _ssrContextValue(_SSR_ROUTE);
  if (ssr === null || ssr === _SSR_NO_CONTEXT) return null;
  // A server render READ the route: said if it was set outside the render's
  // synchronous step (air/ssr-render.ts, "Who set the route").
  _ssrRouteRead();
  return ssr as _RouteNow;
}

/** The current path — the auto-tracked signal on the client. */
function _pathNow(): string {
  return _ssrRoute()?.path ?? routePath.value;
}

function bootRuntime(): void {
  // A server render has no runtime to boot and needs none: the route is the
  // `routePath` the request handler set, and the page is a string. The browser
  // hook is `ensureConnected`, which threw "page has no HTTP origin and no IPC
  // bridge" from inside `renderToString` — so every app with a `<Route>` or a
  // `useRoute` failed to server-render at all, the case docs/ui/air-advanced.md
  // shows. `useHead` asks the same question for the same reason.
  if (_isSsrRendering()) return;
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

/** The params a route PATTERN declares, as a type.
 *
 *  `"/users/:id/posts/:postId"` → `{ id: string; postId: string }`, and a
 *  wildcard contributes `"*"`. Everything is `string` — that is what a URL
 *  segment is — so the value this adds is the KEY set: `params.postId` exists
 *  and `params.postld` is a compile error instead of `undefined` at runtime.
 *
 *  Two field reports asked for this independently, and one checked the
 *  implementation with `deno check` including a `@ts-expect-error` case proving
 *  `{ idd: "1" }` is rejected for `"/users/:id"`. Zero runtime. */
export type RouteParams<S extends string> = string extends S
  // A non-literal `string` pattern promises nothing about its keys, so it keeps
  // the open map rather than narrowing to `{}` — narrowing there would be a
  // confident wrong answer about a pattern nobody typed.
  ? Record<string, string>
  : S extends `${string}:${infer P}/${infer Rest}`
    ? { [K in P]: string } & RouteParams<`/${Rest}`>
  : S extends `${string}:${infer P}` ? { [K in P]: string }
  // `*` is a wildcard only as a WHOLE segment; `/a*b` is a literal.
  : S extends "*" | `${string}/*` | `${string}/*/${string}` ? { "*": string }
  : Record<never, string>;

/** Current route state -- reads routePath/routeSearch signals (auto-tracked by AIR).
 *
 *  TWO OVERLOADS, and the first is the one that has always been here — so every
 *  existing call compiles unchanged, including `useRoute<{ id: string }>(…)`
 *  with the params spelled by hand. The second infers them from the pattern
 *  when it is a literal, which is what a router user checks first. Overload
 *  resolution tries them in order, so the explicit form always wins where it
 *  was used; the inferring one is reachable only where nothing was passed.
 *  @tier Kit */
export function useRoute<
  P extends Record<string, string> = Record<string, string>,
>(pattern?: string): RouteState<P>;
export function useRoute<const S extends string>(
  pattern: S,
): RouteState<RouteParams<S>>;
export function useRoute<
  P extends Record<string, string> = Record<string, string>,
>(pattern?: string): RouteState<P> {
  bootRuntime();
  const ssr = _ssrRoute();
  const path = ssr?.path ?? routePath.value; // auto-tracked signal read
  const search = ssr?.search ?? routeSearch.value;
  if (!pattern) return { path, params: {} as P, search, matched: true };
  const params = matchPath(pattern, path);
  return {
    path,
    params: (params ?? {}) as P,
    search,
    matched: params !== null,
  };
}

/** Returns the navigate function.
 *  @tier Kit */
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
  const currentPath = _pathNow(); // auto-tracked signal read
  const { basePath, params: parentParams } = useContext(_RouteCtx);

  if (index) {
    // `basePath` is the parent's PATTERN, not a concrete path — compared as a
    // string, an index under `/users/:id` waited for the url to literally be
    // "/users/:id" and never rendered, and one under `/dash` stayed empty at
    // `/dash/`. The parent matched through `matchPath`; its default child has
    // to ask the same question, exactly.
    if (!matchPath(basePath || "/", currentPath, true)) return null;
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

/** The route path a `<Link to>` leads to from the route `at`, normalised for
 *  comparison — or null when it leaves the app (another origin or scheme,
 *  or no URL at all), which is never the current route. */
function _linkTarget(to: string, at: string): string | null {
  // An ABSOLUTE `to` (a scheme, or `//host`) is never active. Whether it is
  // this app's origin is only knowable in the browser: a server render has no
  // origin to compare with, so judging it there and again in the browser gave
  // the SSR markup one `class` and the first client render another. An in-app
  // link is written as a path; this is the answer both sides can give.
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(to.trim())) return null;
  // The page's own URL at that route. No `location` (a server render), or one
  // that cannot hold a path (`about:blank`), still has a route to resolve
  // against — a stand-in origin keeps the answer about paths only.
  let from: URL;
  try {
    from = new URL(_appHref(at), location.href);
  } catch {
    from = new URL(_appHref(at), "http://aio.invalid/");
  }
  try {
    const url = _resolveTo(to, from);
    if (url.protocol !== from.protocol || url.origin !== from.origin) {
      return null;
    }
    return _normalizeRoutePath(_routePathOf(url));
  } catch {
    return null;
  }
}

/** Anchor that navigates without page reload. Adds activeClass when path matches. */
export function Link(
  { to, replace: rep, exact, activeClass, activeStyle, children, ...rest }:
    LinkProps,
): VNode {
  // Compared as PATHS, not strings: `routePath` is the browser's encoded
  // pathname and `to` is what the author wrote, so `to="/about us"` (url
  // `/about%20us`), `to="/users/"`, `to="/users?tab=1"` and `to="/users#top"`
  // were never active on the very page they point at.
  //
  // And `to` is resolved first, by `navigate`'s own resolver: a relative
  // `to="api"` from `/docs/x` leads to `/docs/api`, and was compared as the
  // raw string "api" — never active on the very page a click takes you to.
  // Resolved against the ROUTE being rendered (not `location`), so a server
  // render, which has no `location`, answers the same as the browser.
  const raw = _pathNow(); // auto-tracked signal read
  const path = _normalizeRoutePath(raw);
  const target = _linkTarget(to, raw);
  const isActive = target === null
    ? false
    : (exact || target === "/")
    ? path === target
    : path === target || path.startsWith(target + "/");
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
      // A fragment on THIS document (`#install`, `/docs#install` at /docs):
      // the browser scrolls to it and fires `hashchange`; `pushState` does
      // neither, so taking the click over broke every in-page anchor.
      const dest = new URL(_appHref(to), location.href);
      if (
        dest.hash && dest.pathname === location.pathname &&
        dest.search === location.search
      ) return true;
    } catch {
      // Not a URL this router can resolve — let the anchor try.
      return true;
    }
    return false;
  }
  // The author's own `onClick` runs first, and a `preventDefault()` in it
  // keeps the link from routing — the anchor contract. It was overwritten by
  // the spread below, so `<Link onClick={closeMenu}>` navigated and never
  // closed the menu, with nothing said anywhere.
  const own = rest.onClick as ((e: Event) => void) | undefined;
  function handleClick(e: Event) {
    if (typeof own === "function") own(e);
    if (e.defaultPrevented) return;
    if (ownedByBrowser(e as MouseEvent)) return;
    e.preventDefault();
    navigate(to, { replace: rep });
  }
  // `class` is the spelling aio apps write, and it and `className` land on the
  // same attribute — so the active class REPLACED a `class` the author set
  // (`<NavLink class="nav">` rendered `class="active"` on its own page).
  // Both are folded into one before the active class is added — when both
  // are strings. A SIGNAL class stays bound, passed through as 1.0.11 did:
  // folding it wrote its source text as the class, frozen.
  const bound = isSignal(rest.class) || isSignal(rest.className);
  const base = bound
    ? rest.className
    : [rest.class, rest.className].filter(Boolean).join(" ") || undefined;
  const cls = isActive && activeClass
    ? [base, activeClass].filter(Boolean).join(" ")
    : base;
  const sty = isActive && activeStyle
    ? { ...rest.style, ...activeStyle }
    : rest.style;
  const { class: _class, ...attrs } = rest;
  return h("a", {
    ...(bound ? rest : attrs),
    // Under the route base, as `navigate` resolves it (`_appHref`).
    href: _appHref(to),
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
