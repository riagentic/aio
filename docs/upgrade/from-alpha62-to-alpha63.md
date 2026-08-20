# Upgrading from alpha62 to alpha63

One default flips, and it flips **towards** your app: aio's stylesheet no longer
arrives unless you ask for it. Nothing else in your code changes.

## The default look is opt-in

alpha61 shipped a default theme. alpha62 made it step aside for apps with a
`style.css`. That still keyed a whole visual stage off one probe — and an app
brings CSS in more ways than a shell can see: a `<style>` in `ui.head`, a sheet
the component itself renders, a CSS-in-JS runtime, a design system it imports.
Every one of those got aio's typography, spacing and page shell on top of it,
and a cascade layer does not help where your CSS is simply silent.

**Now**: an app that never mentions `ui.theme` renders with the browser's own
defaults plus aio's two-rule baseline (`box-sizing`, `body{margin:0}`, which
predates the theme and is not part of it), and the inert `--aio-*` custom
properties, which paint nothing until something references them.

If your app looked right on alpha60 and wrong on alpha61/62, **do nothing** —
this release is the fix.

If you liked the default look, ask for it by name:

```ts
await aio.run({ cells: [app], ui: { theme: "auto" } });
```

That is the line `am create` now writes into every new app.

| `ui.theme`           | With no `style.css`      | With your own `style.css`      |
| -------------------- | ------------------------ | ------------------------------ |
| `"tokens"` (default) | `--aio-*` variables only | `--aio-*` variables only       |
| `"auto"`             | the full default look    | variables only (steps aside)   |
| `"full"`             | the full default look    | the full look, alongside yours |
| `"none"`             | box-model baseline only  | box-model baseline only        |

Boot says which way it landed, once, when you have opted in.

## `ui.theme: "full"` now actually boots

It was documented from the day it shipped and refused at startup: the runtime
value allowlist listed only `["auto", "none"]`, so `"full"` exited with
`CONFIG ERROR`. Fixed, and the allowlist is now compared against the type's own
union by a test, so a documented value cannot be missing from it again.

## Android bundles: `log`, and a module that killed the whole bundle

Two fixes from a field report, neither of which needs anything from you:

- `import { log } from "aio"` compiled for server, browser and electron and
  failed to BUNDLE for android — the standalone entry never re-exported it. It
  does now, and a ledger test enumerates every remaining `aio` export the
  android entry lacks, so the next one is a failing gate rather than a user's
  afternoon.
- `src/state/blocking.ts` resolved its worker module at module scope with
  `new URL(…, import.meta.url)`. In a bundle that throws while the module is
  still evaluating — before any app code runs — so an app that merely LINKED it
  came up as a blank screen. It resolves on first use now, with an error that
  names `schedule.blocking()`, and a gate refuses the pattern anywhere a client
  bundle can reach.
