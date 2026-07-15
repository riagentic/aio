// reactIsland — the blessed path for dropping a React component into an AIR
// page (a chart, a rich editor, any library component). Built on island().
//
// aio never depends on React: YOU supply the react / react-dom loaders, so the
// bare specifiers resolve in your app's build, not aio's. That's why React
// works without being a framework dependency — it's an island, not a peer.
import { island } from "./island.ts";
import type { ComponentFn, VChild } from "./vdom.ts";

// Minimal structural types so aio needs no @types/react.
type ReactComponentLike<P> = (props: P) => unknown;
interface ReactRoot {
  render(node: unknown): void;
  unmount(): void;
}
interface ReactDomClientLike {
  createRoot(el: Element): ReactRoot;
}
interface ReactLike {
  createElement(type: unknown, props: unknown): unknown;
}

/** A component module: either `{ default: Component }` or the component itself. */
type ComponentModule<P> =
  | { default: ReactComponentLike<P> }
  | ReactComponentLike<P>;

/** Configuration for {@link reactIsland}. */
export interface ReactIslandConfig<P extends Record<string, unknown>> {
  /** Load the React component's module — a dynamic import of your component. */
  component: () => Promise<ComponentModule<P>>;
  /** Load the React runtime from your app. Lives in your code (not aio's), so
   *  aio stays React-free. See docs/ui/react-islands.md. */
  react: () => Promise<ReactLike>;
  /** Load ReactDOM's client entry from your app. */
  reactDomClient: () => Promise<ReactDomClientLike>;
  /** Reactive props passed to the React component. Re-runs when cells change,
   *  re-rendering the island in place (no AIR remount). */
  props?: () => P;
  /** Placeholder shown while the module loads. */
  loading?: () => VChild;
  /** Bump to force a reload of the module (e.g. a version hash). */
  cacheKey?: string | number;
}

interface Loaded<P extends Record<string, unknown>> {
  react: ReactLike;
  reactDom: ReactDomClientLike;
  Component: ReactComponentLike<P>;
}

/**
 * Mount a React component as an island inside an AIR page.
 *
 * Returns an AIR component you use like any other. React owns the container's
 * DOM; AIR feeds it reactive props from your cells and unmounts it cleanly.
 *
 * You pass loader functions for the React runtime — they live in your code,
 * so aio never depends on React. See docs/ui/react-islands.md for the full,
 * copy-pasteable example with real loaders.
 *
 * @example
 * ```tsx
 * import { reactIsland } from "aio/air";
 * const PriceChart = reactIsland({
 *   component: loadChartComponent, // your React component module
 *   react: loadReact,              // your react runtime loader
 *   reactDomClient: loadReactDom,  // your react-dom/client loader
 *   props: () => ({ series: market.prices }), // reactive from a cell
 * });
 * // then: <PriceChart />
 * ```
 */
export function reactIsland<P extends Record<string, unknown>>(
  config: ReactIslandConfig<P>,
): ComponentFn {
  return island<Loaded<P>>({
    cacheKey: config.cacheKey,
    loading: config.loading,
    props: (config.props ?? (() => ({} as P))) as () => Record<string, unknown>,
    load: async () => {
      const [react, reactDom, mod] = await Promise.all([
        config.react(),
        config.reactDomClient(),
        config.component(),
      ]);
      const Component = (mod && typeof mod === "object" && "default" in mod)
        ? mod.default
        : (mod as ReactComponentLike<P>);
      return { react, reactDom, Component };
    },
    mount: (container, loaded, props) => {
      const { react, reactDom, Component } = loaded;
      const root = reactDom.createRoot(container);
      const render = (p: Record<string, unknown>) =>
        root.render(react.createElement(Component, p));
      render(props);
      return {
        update: (next) => render(next),
        unmount: () => root.unmount(),
      };
    },
  });
}
