# Upgrading from alpha60 to alpha61

Nothing breaks. Every change is additive or a bug becoming the documented
behaviour — but three of them can make an existing app LOOK different or LINT
differently, so they are worth 60 seconds each.

## Your app is styled now (and how to opt out)

alpha61 ships a default stylesheet: typography, colour (light and dark), form
controls, tables, code, cards — keyed to your app's identity, so its accent
matches its (also new) default icon. If your app has its own `style.css`, **your
rules win**: the default lives in `@layer aio`, and any unlayered rule beats
every layered one, no `!important` needed.

Still, an app that deliberately styled _nothing_ will look different. To get the
old bare-HTML look back:

```ts
await aio.run({ ui: { theme: "none" } });
```

Rebranding needs no switch — set `--aio-accent`, `--aio-font`, `--aio-page`, …
in your own CSS and every derived tone follows. See `docs/ui/theme.md`.

The same identity hash now draws a monogram **icon** (favicon, Electron window,
AppImage, Android launcher) wherever you did not ship an `icon.png`. Ship one
and it wins everywhere, unchanged.

## Async methods: writes through `map()`/`filter()` results now LAND

Previously, in an async method:

```ts
const rows = s.items.filter((r) => r.on);
for (const r of rows) r.q = 0; //  alpha60: silently dropped. alpha61: lands.
```

If you worked around the old behaviour by re-reading and reassigning whole
arrays, that code is still correct — this change only makes the direct spelling
work like its sync twin. If you relied on a read method's result being a
_detached snapshot_ (rare, and it was never the documented contract), snapshot
explicitly: `structuredClone(…)` or `[...s.items].map(…)` on a field you do not
write through.

`return s.items.filter(…)` from a method now crosses to the caller as plain data
(it used to be a detached clone by accident; same shape, now guaranteed).

## aiol has three new rules (and lost one)

- A transactional method that reads a field before an `await` and writes it
  after now **warns** (the `$live` hazard) — read through `s.$live`, gather
  results first, or set `transaction: { conflict: "warn" }`.
- `[t="…"]` in `querySelector`/CSS is an **error**: `t` never reaches the DOM.
  Query a class or `data-` attribute instead.
- `perfBudget.methods["cell:method"].timeout` on a local method warns — write
  `long: ["method"]` on the cell.
- The "throw in cell code" hint is gone; throwing to refuse is the documented
  mechanism and stays.

A client **build** now fails on a static `node:*`/`@std/*` import reachable from
the browser bundle, naming the file. The fix it names — `await import("node:…")`
inside the method — is the pattern the docs always taught.

## Smaller things you may notice

- The heap-ceiling warning prints **once per machine**, not every boot
  (`--verbose` brings it back).
- `deno task install:electron` in a scaffolded app now actually installs the
  runtime; regenerate the task from `am create`, or point it at
  `deno run -A <dep>/src/electron-install.ts`.
- New app scaffolds put the starter test in `tests/` (was `src/`). Existing
  apps: nothing moves unless you move it.
- `useAio()` returns `{ state, send, ready }` — `ready` replaces the hand-rolled
  `if (!state.someCell) return <Spinner/>` gate.
- Signals are callable: `count()` reads like `count.value`. Nothing existing
  changes meaning.
- `cancelOn` keys are now typed against your cell's methods — a typo that
  previously no-op'd at runtime is now a compile error (it was already a runtime
  throw since alpha52; the cast `as never` escape exists for generated code).
