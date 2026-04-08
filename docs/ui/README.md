# Rendering & UI

AIO ships two renderers — AIR (recommended, ~8KB) and React (compatibility).

**Which one?**

- **Use AIR** if starting fresh — smaller bundle, built-in signals, forms,
  routing, animations
- **Use React** if you have an existing React codebase or team with React
  expertise
- Both use the same `useCell()` / `useAio()` hooks — switching later is
  straightforward

## AIR Renderer

- [Setup](air-setup.md) — connecting to AIO server state
- [Signals](air-signals.md) — signal, computed, effect, batch, watch
- [Components](air-components.md) — props, lists, refs, events
- [Lifecycle](air-lifecycle.md) — hooks, context, errors, devtools
- [Forms](air-forms.md) — form handling and validation
- [Routing](air-routing.md) — Route, Link, NavLink, patterns
- [Animation](air-animation.md) — transitions and springs
- [Advanced](air-advanced.md) — SSR, portals, islands, code splitting
- [API Reference](air-reference.md) — cheat sheet

## React

- [React Adapter](react.md) — hooks, routing, setup

## Both

- [AIR vs React](comparison.md) — comparison and migration paths
