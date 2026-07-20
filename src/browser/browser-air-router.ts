// browser-air-router: AIR signal-based router (Route, Outlet, Link, NavLink, Redirect, etc.)

import { createContext, onMount, useContext } from "../air/aio-renderer.ts";
import {
  type ComponentFn,
  Fragment,
  h,
  type VChild,
  type VNode,
} from "../air/vdom.ts";
import {
  ensureConnected,
  type LinkProps,
  matchPath,
  navigate,
  routePath,
  type RouteProps,
  routeSearch,
  type RouteState,
} from "./browser-protocol.ts";

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
export function useRoute(pattern?: string): RouteState {
  ensureConnected();
  const path = routePath.value; // auto-tracked signal read
  const search = routeSearch.value;
  if (!pattern) return { path, params: {}, search, matched: true };
  const params = matchPath(pattern, path);
  return { path, params: params ?? {}, search, matched: params !== null };
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
  ensureConnected();
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
  const hasChildren = !!children;
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
  function handleClick(e: Event) {
    const me = e as MouseEvent;
    if (
      me.button !== 0 || me.metaKey || me.ctrlKey || me.shiftKey || me.altKey
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
