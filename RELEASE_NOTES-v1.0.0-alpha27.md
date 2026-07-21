# v1.0.0-alpha27 — aio v2 begins: methods is the ONE style

The biggest breaking change in aio's history, and the biggest simplification:
the redux-era layer (`actions:` / `reduce:` / `execute:` / `machine:` /
`generators:` / middleware) is **gone**. One style remains — the one every
example and every field app already used:

```ts
const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
  },
});
```

## Migrating

- **Read docs/upgrade/to-v2.md** — before → after recipes for every removed
  pattern.
- **Run `deno task lint`** — aiol statically detects removed config keys in your
  app and prints the exact per-cell fix.
- Booting an old cell fails loudly with the same guidance (never silently).

## Every capability survives, method-native

| you had                  | you now write                                                    |
| ------------------------ | ---------------------------------------------------------------- |
| generator workflows      | plain `async` methods + `until()` / `race()` / `sleep()`         |
| `cancelOn` on generators | `cancelOn: { method: [triggers] }` + `s.$signal`                 |
| machine guards           | `if (s.status !== "idle") return;`                               |
| cross-cell reaction      | `listensTo: { onCleared: cart.clear }` — runs a real handler now |
| execute/effects          | do the work inside the (async) method                            |

## Also in alpha27

- **Headless `am surface`** — inspect the semantic UI surface with ZERO
  connected clients (server renders against live cell state; auto-fallback).
- **testCell full inference** — state, sender args AND sender return types all
  flow from the cell ref.
- **Zero `@experimental`** — every exported symbol is tested and supported.
- **Security fix** — `strictOrigin`/`allowedOrigins` were validated but silently
  dropped en route to the WS origin check; now wired + regression- tested.
- **Electron reload is Ctrl+F5** — plain F5 is free for your app's shortcuts.
- **perfect-aio.md** — the full v2 plan (decisions D1–D12) lives in the repo.

## Gates

Suite **2439/0** · onboard e2e **10/10** · preflight **7/7** · coverage
**74.6%** (floor 73) · fmt / lint / check / api / docs / boundaries green. Net
**−4,000+ LOC**.
