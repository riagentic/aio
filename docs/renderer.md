# AIO Renderers

AIO ships two renderers in one package. Pick the one that fits your project.

## Two Renderers, One Framework

```
aio/air    → AIR (AIO Internal Renderer) — signal-based, zero dependencies, ~8KB
aio/react  → React adapter — standard React hooks over aio's state pipeline
```

Both connect to the same server, use the same features, and share the same
protocol. The difference is how they manage UI reactivity.

|                        | AIR (`aio/air`)                            | React (`aio/react`)                    |
| ---------------------- | ------------------------------------------ | -------------------------------------- |
| **Reactivity**         | Signals — auto-tracked, no dep arrays      | React hooks — `useSyncExternalStore`   |
| **Memoization**        | Automatic (shallow prop compare)           | Manual (`React.memo`, `useCallback`)   |
| **Dependencies**       | Zero (built-in VDOM)                       | React 18+ and ReactDOM                 |
| **Bundle size**        | ~8KB total                                 | React + ReactDOM (~40KB min)           |
| **Built-in utilities** | Forms, animation, virtual scroll, devtools | Bring your own (react-hook-form, etc.) |
| **JSX**                | Same TSX syntax                            | Same TSX syntax                        |
| **Server state**       | `useFeature`, `useAio`, `useLocal`         | `useFeature`, `useAio`, `useLocal`     |

## Import Paths

```ts
// Server code — features, protocol, types (no renderer, no DOM)
import { aio, feature, log } from "aio";

// AIR components
import { mount, signal, useFeature } from "aio/air";

// React components
import { useFeature, useLocal } from "aio/react";
```

The base `aio` import is renderer-free. It works in headless Deno with zero DOM
dependencies. Feature definitions and server logic always import from `aio`.

## When to Use Which

**Choose AIR when:**

- Starting a new project
- You want zero external dependencies
- You want automatic optimizations (no memo, no dep arrays)
- You need built-in forms, animation, virtual scrolling
- Bundle size matters

**Choose React when:**

- You have an existing React codebase
- Your team knows React and needs familiar patterns
- You depend on React-specific libraries (Material UI, etc.)
- You're embedding aio state into an existing React app

**Migrating between them?** See [AIR vs React](air-vs-react.md) for a
side-by-side comparison and step-by-step migration guide in both directions.

## Detailed Guides

- **[AIR Renderer](air.md)** — signals, components, lifecycle, forms, animation,
  virtual scrolling, SSR, architecture
- **[React Renderer](react.md)** — React hooks, routing, components over aio
  state
- **[AIR vs React](air-vs-react.md)** — API comparison, migration tables, compat
  hooks

## Adapter Architecture

Both renderers sit on top of a shared `state-core` layer:

```
state-core.ts (framework-agnostic signals + state)
  ├── adapters/air.ts    → AIR hooks (direct signal reads)
  ├── adapters/react.ts  → React hooks (useSyncExternalStore bridge)
  ├── browser-air.ts     → AIR full client (WS/IPC + hooks + routing)
  └── browser.ts         → React full client (WS/IPC + hooks + routing)
```

The adapters export the same API: `useFeature`, `useAio`, `useLocal`,
`useConnected`. State-core owns signal creation, tracking proxy, send proxy,
subscription filtering, and offline queue.

For custom framework adapters (Vue, Svelte, etc.), import directly from
`aio/state-core`. See [AIR Renderer — Custom Adapters](air.md#custom-adapters)
for the contract.

## Quick Start

### AIR

```tsx
// deno.json: "jsx": "react-jsx", "jsxImportSource": "aio"
import { mount, signal, useFeature } from "aio/air";
import { counter } from "./features/counter.ts";

const count = signal(0);

const App = () => {
  const { state, send } = useFeature(counter);
  return (
    <div>
      <span>Server count: {state.count}</span>
      <button onClick={() => send.increment()}>+</button>
      <span>Local count: {count.value}</span>
      <button onClick={() => count.set(count.peek() + 1)}>+</button>
    </div>
  );
};

mount(document.getElementById("root")!, App);
```

### React

```tsx
// deno.json: "jsx": "react-jsx", "jsxImportSource": "react"
import { useFeature } from "aio/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { counter } from "./features/counter.ts";

function App() {
  const { state, send } = useFeature(counter);
  const [localCount, setLocalCount] = useState(0);
  return (
    <div>
      <span>Server count: {state.count}</span>
      <button onClick={() => send.increment()}>+</button>
      <span>Local count: {localCount}</span>
      <button onClick={() => setLocalCount((c) => c + 1)}>+</button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
```
