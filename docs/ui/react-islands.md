# React components in aio — islands

aio's renderer is **AIR**, not React. But you don't have to choose: any React
component (a charting library, a rich text editor, a data grid) can run inside
an aio page as an **island** — a container AIR owns the placement of, but React
owns the contents of.

aio itself never depends on React. **You** supply the `react` / `react-dom`
loaders, so those specifiers resolve in your app's build — React is a component
you bring, not a framework peer.

## Setup

Add React to your project (only if you use it):

```jsonc
// deno.json → imports
{
  "react": "npm:react@19",
  "react-dom": "npm:react-dom@19"
}
```

## Mount a React component

```tsx
import { reactIsland } from "aio/air";
import { market } from "./cells/market.ts";

// PriceChart.tsx is an ordinary React component using recharts, visx, etc.
const PriceChart = reactIsland({
  component: () => import("./PriceChart.tsx"),
  react: () => import("react"),
  reactDomClient: () => import("react-dom/client"),
  props: () => ({ series: market.prices }), // reactive — from a cell
});

export default function App() {
  return (
    <div>
      <h1>Trading</h1>
      <PriceChart /> {/* re-renders when market.prices changes */}
    </div>
  );
}
```

## How it works

- **Lazy-loaded.** `component` / `react` / `react-dom` load on first mount; pass
  `cacheKey` to share the module across instances or force a reload.
- **Reactive props.** `props()` is re-evaluated whenever the cells it reads
  change, and the island re-renders **in place** — no AIR remount, no lost React
  state.
- **Clean teardown.** When AIR unmounts the island, `root.unmount()` runs, so
  React's effects and timers are disposed.
- **Isolation.** React owns the container's DOM; AIR never diffs inside it, so
  the two renderers never fight.

## When to reach for this

- A component that already exists in React and isn't worth porting (charts,
  maps, editors, data grids).
- Migrating an existing React app to aio incrementally — island the parts you
  haven't converted yet.

For simple, aio-native UI, prefer [`aio/ui`](kit.md) and plain AIR components —
islands add a bundle and a second renderer, so use them where they earn it.

> Migrating React _code_ (hooks like `useState`/`useEffect`) rather than
> mounting React _components_? Those compat shims live at `aio/air/compat` — see
> [AIR setup](air-setup.md).

## Targets

Islands are client-side interop — no server, no SSR, no transport — so they work
on every target that renders in a browser engine, including standalone (Android)
builds, where `island()` and `reactIsland()` import from `aio/air` unchanged.
Your React loaders resolve in your app's bundle, so React ships in the APK the
same way it ships to the browser.
