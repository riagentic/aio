// deno-lint-ignore-file
// React router components for aio — Route, Outlet, Link, NavLink, Redirect, useRoute, useNavigate.

import {
  type ComponentType,
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import {
  _getRPath,
  _getRSearch,
  _rSnapshot,
  _rSubscribe,
  type LinkProps,
  matchPath,
  navigate,
  type RouteProps,
  type RouteState,
} from "./browser-protocol.ts";

// ── Route context ─────────────────────────────────────────────────

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

// ── useRoute ──────────────────────────────────────────────────────

/** Current route state — path, params, search, and match status.
 *  With pattern ('/users/:id') extracts params. */
export function useRoute(pattern?: string): RouteState {
  useSyncExternalStore(_rSubscribe, _rSnapshot, () => "/");
  const path = _getRPath();
  const search = _getRSearch();
  if (!pattern) return { path, params: {}, search, matched: true };
  const params = matchPath(pattern, path);
  return { path, params: params ?? {}, search, matched: params !== null };
}

// ── useNavigate ───────────────────────────────────────────────────

/** Returns the navigate function. */
export function useNavigate(): (
  to: string | number,
  opts?: { replace?: boolean },
) => void {
  return navigate;
}

// ── Route ─────────────────────────────────────────────────────────

/** Renders element when path matches. Nest inside other Routes for layouts with Outlet. */
export function Route({ path, index, element, children }: RouteProps): unknown {
  useSyncExternalStore(_rSubscribe, _rSnapshot, () => "/");
  const { basePath, params: parentParams } = useContext(_RouteCtx);
  const currentPath = _getRPath();

  if (index) {
    const base = basePath || "/";
    const match = currentPath === base ||
      currentPath === base.replace(/\/$/, "") ||
      base === "/" && currentPath === "/";
    if (!match) return null;
    return element ?? null;
  }

  if (!path) return null;
  const full =
    (basePath + "/" + path.replace(/^\//, "")).replace(/\/+/g, "/").replace(
      /(.)\/$/,
      "$1",
    ) || "/";
  const hasChildren = !!children;
  const params = matchPath(full, currentPath, !hasChildren);
  if (!params) return null;

  const allParams = { ...parentParams, ...params };
  return createElement(
    _RouteCtx.Provider as ComponentType<{ value: _RouteCtxType }>,
    {
      value: {
        basePath: full,
        params: allParams,
        outlet: hasChildren ? children : null,
      },
    },
    (hasChildren
      ? (element ?? createElement(Outlet as () => null))
      : element ?? null) as ReactNode,
  );
}

// ── Outlet ────────────────────────────────────────────────────────

/** Renders the matching child route inside a parent Route's element. */
export function Outlet(): unknown {
  const { outlet } = useContext(_RouteCtx);
  return outlet ?? null;
}

// ── Link ──────────────────────────────────────────────────────────

/** Anchor that navigates without page reload. Adds activeClass when path matches. */
export function Link(
  { to, replace: rep, exact, activeClass, activeStyle, children, ...rest }:
    LinkProps,
): unknown {
  useSyncExternalStore(_rSubscribe, _rSnapshot, () => "/");
  const path = _getRPath();
  const isActive = (exact || to === "/")
    ? path === to
    : path === to || path.startsWith(to + "/");
  function handleClick(e: MouseEvent) {
    if (
      (e as MouseEvent & { button: number }).button !== 0 || e.metaKey ||
      e.ctrlKey || e.shiftKey || e.altKey
    ) return;
    e.preventDefault();
    navigate(to, { replace: rep });
  }
  const cls = isActive && activeClass
    ? [rest.className, activeClass].filter(Boolean).join(" ")
    : rest.className;
  const sty = isActive && activeStyle
    ? { ...rest.style, ...activeStyle }
    : rest.style;
  return createElement("a", {
    ...rest,
    href: to,
    onClick: handleClick,
    className: cls,
    style: sty,
  }, children as ReactNode);
}

// ── NavLink ───────────────────────────────────────────────────────

/** Link with automatic 'active' class. Prefix match by default, exact for '/' and when exact=true. */
export function NavLink(
  { activeClass = "active", ...rest }: Omit<LinkProps, "activeClass"> & {
    activeClass?: string;
  },
): unknown {
  return createElement(
    Link as ComponentType<LinkProps>,
    { activeClass, ...rest } as LinkProps,
  );
}

// ── Redirect ──────────────────────────────────────────────────────

/** Navigates to `to` on mount — use for auth redirects. Replace=true by default (no history entry). */
export function Redirect(
  { to, replace: rep = true }: { to: string; replace?: boolean },
): null {
  useLayoutEffect(() => {
    navigate(to, { replace: rep });
  }, [to]);
  return null;
}
