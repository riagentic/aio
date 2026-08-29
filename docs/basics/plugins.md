# Plugins

A plugin is a **reusable piece of app**: its cells, its routes, its schedules
and the hooks that watch it, packaged as one value.

```ts
import { aio, cell, definePlugin } from "aio";

const auditLog = cell("audit", {
  state: { entries: [] as string[] },
  methods: {
    record(s, type: string) {
      s.entries.push(type);
      if (s.entries.length > 500) s.entries.shift();
    },
  },
});

export const audit = definePlugin({
  name: "audit",
  cells: [auditLog],
  routes: { "/audit.json": () => Response.json(auditLog.entries) },
  onAction: (a) => auditLog.record((a as { type: string }).type),
});
```

```ts
// app.ts
await aio.run({ cells: [myCell], plugins: [audit] });
```

That is the whole feature. There is no resolver, no lifecycle protocol, no
capability negotiation — those would buy exactly the indirection aio exists to
remove.

## What a plugin can contribute

Every field is the same key, with the same type, that `aio.run()` already has:

| Field                                                               | Same as                       |
| ------------------------------------------------------------------- | ----------------------------- |
| `cells`                                                             | `aio.run({ cells })`          |
| `routes`                                                            | `aio.run({ routes })`         |
| `schedules`                                                         | `aio.run({ schedules })`      |
| `allowedOrigins`                                                    | `aio.run({ allowedOrigins })` |
| `onAction` `onEffect` `onConnect` `onDisconnect` `onStart` `onStop` | the lifecycle hooks           |

**A plugin can only do what the app could have written itself.** There is no
private API, so a plugin is never more powerful than its host, and reading the
config still tells you what is wired. The boot report names them:

```
plugins   2 (audit, metrics)
```

## The four rules

**1. The app always wins.** An app's own `routes`, hooks and cells are applied
over the plugins'. Adding a plugin can never take a behaviour away.

```ts
// The app's /health is served; the plugin's is not.
await aio.run({
  cells,
  plugins: [metrics], // contributes /health
  routes: { "/health": () => new Response("mine") },
});
```

**2. A collision between two plugins is loud, at boot, naming both.**

```
plugin collision: route "/health" is claimed by both "metrics" and "probes".
  Two plugins cannot own the same route — whichever loaded second would
  silently shadow the other, and you would find out from a behaviour, not an
  error.
  Fix: drop one of the plugins, or wrap the one you control so it contributes
  a different route.
```

Cells, routes and named schedules are all checked this way.

**3. Hooks compose, they never replace.** Every `onAction` runs — plugins in
declaration order, the app last. One throwing never stops the next: lifecycle
hooks are observe-only and error-guarded, and a plugin does not get to weaken
that. `onStop` unwinds in reverse (app first, then plugins backwards), so a
plugin that opened something in `onStart` closes it after the app code using it
has finished.

**4. A plugin that cannot set itself up refuses the boot.**

```ts
definePlugin({
  name: "stripe",
  setup() {
    const key = Deno.env.get("STRIPE_KEY");
    if (!key) throw new Error("STRIPE_KEY is not set");
    return { routes: { "/webhook/stripe": webhookFor(key) } };
  },
});
```

```
plugin "stripe" failed to set up: STRIPE_KEY is not set
```

Half-existing is the failure this prevents — cells composed, routes absent, and
nothing said.

## `setup()`

Optional, runs **once** at boot, before cells compose. Return more contributions
and they merge under the same rules. It receives:

```ts
setup(ctx) {
  ctx.appId    // the app's id
  ctx.dev      // true in dev — for logging more, never for behaving differently
  ctx.plugins  // every plugin name, in order, so you can refuse to run beside one
}
```

## Writing one

A plugin is a plain object, so a package exports it directly:

```ts
// @acme/aio-metrics/mod.ts
import { cell, definePlugin } from "aio";

const stats = cell("metrics", {
  state: { actions: 0, errors: 0 },
  methods: {
    action(s) {
      s.actions++;
    },
    error(s) {
      s.errors++;
    },
  },
});

export default definePlugin({
  name: "metrics",
  cells: [stats],
  routes: {
    "/metrics": () =>
      new Response(
        `aio_actions_total ${stats.actions}\naio_errors_total ${stats.errors}\n`,
        { headers: { "Content-Type": "text/plain; version=0.0.4" } },
      ),
  },
  onAction: () => stats.action(),
});
```

Two rules for a plugin author:

- **Namespace what you own.** A cell called `state` or a route called `/api`
  will collide with somebody. `metrics`, `/metrics` — say your own name.
- **Do not surprise.** A plugin's hooks are observe-only by contract. If yours
  needs to change behaviour, contribute a cell with methods the app calls, so
  the app stays the thing that decides.

## When NOT to use one

If the code is only used by this app, it is not a plugin — it is your app.
`plugins` earns its place when the same piece is added to more than one app, or
comes from a package. A single-app "plugin" is one more layer between
`aio.run()` and what actually runs.

## See also

- [API reference](api-reference.md) — every `aio.run()` key
- [Cells](../state/cells.md) — the unit a plugin contributes
- [Concepts](concepts.md) — what a cell, a route and a hook are
