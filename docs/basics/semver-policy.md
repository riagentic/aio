# Versioning & Deprecation Policy

aio follows [semver](https://semver.org) from `1.0.0` on. This document is the
contract (roadmap B1): what counts as breaking, how deprecations work, and what
each release phase may change.

## What counts as the public API

The public surface is exactly what the CI-enforced snapshot locks
(`docs/api-snapshot.json`, `deno task check:api`):

- every export of every `deno.json` entry point — names, kinds, and signatures.
  The entries, in the order `src/entries.ts` lists them (the ONE list; the
  `exports` map, this document and the snapshot are all checked against it):

  | specifier              | what it carries                                    |
  | ---------------------- | -------------------------------------------------- |
  | `aio`                  | the framework core — `aio.run`, `cell`, `route`, … |
  | `aio/air`              | the renderer (signals, JSX, router, hydration)     |
  | `aio/air/compat`       | the React-shaped alias layer over `aio/air`        |
  | `aio/ui`               | the component library                              |
  | `aio/jsx-runtime`      | the JSX factory the compiler imports               |
  | `aio/server`           | the server-only values (SQLite, CLI/UDS transport) |
  | `aio/state-core`       | the cell registry / send / sync routing            |
  | `aio/db`               | database types + pure schema helpers               |
  | `aio/extras`           | deep detail types, `checkCells`, `parseCli`        |
  | `aio/sync`             | the CRDT sync types and engine                     |
  | `aio/testing`          | `testCell` / `testUI` / `testServer` and friends   |
  | `aio/updates`          | the built-in updates cell (opt-in by import)       |
  | `aio/cli`              | the CLI toolkit (args, prompt, table, spinner)     |
  | `aio/feedback`         | the built-in feedback cell (opt-in by import)      |
  | `aio/build`            | build helpers — also runnable                      |
  | `aio/ship`             | release signing + verification — also runnable     |
  | `aio/build-all`        | run-only                                           |
  | `aio/dev-android`      | run-only                                           |
  | `aio/android-install`  | run-only                                           |
  | `aio/electron-install` | run-only                                           |
  | `aio/am`               | run-only (the app manager CLI)                     |
  | `aio/amui`             | run-only (the visual app manager)                  |
  | `aio/doctor`           | run-only                                           |
  | `aio/aiol`             | run-only (the project linter)                      |

  Per-entry symbol counts are not repeated here — `docs/api-snapshot.json` is
  the count, and a number copied into prose goes stale the first time anything
  is added. (`aio/schedule` and `aio/selectors` were listed here for six alphas
  after being DELETED in alpha52, while thirteen real entries — `aio/ui` among
  them, the whole component library — were missing. A contract document that
  names the wrong surface governs nothing; `tests/semver-policy-entries.test.ts`
  now compares this table against `src/entries.ts`.)
- the wire protocol as negotiated by the `proto` `{v,min}` handshake
- the persistence schema as stamped by `<appId>:__schema`
- documented CLI flags (`am create`, `--expose`, `--port`, …) and the six
  scaffolded `deno.json` lines `deno task doctor` validates

**Not** public API: `_`-prefixed or `@internal` symbols, `src/` folder layout,
log/error message wording (error _codes_ are stable), and undocumented behavior

### `@experimental` — surface that carries no promise

A symbol whose shape is not settled yet can ship tagged `@experimental` in its
JSDoc. The snapshot records the tag per symbol, and `check:api` treats that
symbol's removal or reshaping as **additive**, not as a break:

```ts
/** Shape still being learned from real apps.
 * @experimental */
export function somethingNew(): void {}
```

This is what makes additive-only survivable. Without it the only two options for
an unsettled API are to ship it as stable and be stuck with it, or not ship it
at all — and the first is how a framework accumulates surface it cannot change.
Promoting a symbol OUT of `@experimental` is additive (the promise gets
stronger); moving a stable symbol INTO it is a break, because it withdraws a
promise callers already had.

`check:api` says which of the two a diff is. A removal or a signature change on
a stable symbol is reported as **BREAKING** and needs the decision an aio compat
break needs — approval, an upgrade guide, a `removals.ts` row — before the
snapshot is regenerated. Additive changes just say "regenerate and commit". of
internal modules.

## What counts as breaking (major bump after 1.0)

- removing/renaming a public export or entry point, or changing a signature so
  existing typed code fails to compile or behaves differently
- raising the minimum wire-protocol version (`min` in the hello) so an older
  client is refused
- a persistence schema change without an automatic migration
- changing a default (`persist`, `ui`, `transport`, …) in a way that alters
  behavior of existing apps

Additive changes (new exports, new optional config, new protocol messages
negotiated above the floor, new error codes) are minor. Fixes that make behavior
match documented behavior are patch — even when someone depended on the bug.

## Deprecation lifecycle

1. Mark: `@deprecated` JSDoc + a one-time dev-mode runtime warning naming the
   replacement.
2. Document: CHANGELOG entry + upgrade note with a mechanical migration.
   Mechanical means mechanical: `deno task lint:aio` reports every deprecated
   spelling your app still uses, and `aiol --safe-fix` rewrites the ones that
   are pure renames (`call({ timeout })` → `timeoutMs`, `--cert`/`--key` →
   `--tls-cert`/`--tls-key`, a build-only `--headless` on a run task →
   `--client=server-only`). Upgrading is a command, not a diff review.
3. Keep: deprecated APIs stay functional for at least the rest of the current
   major — removal happens at the next major, never in a minor/patch.
4. Exception: `aio/air/compat` is **permanent** (decision 2026-07-06) — the
   React-compat shims are not scheduled for removal.

## Release phases

| Phase  | May break                                                                                                                        | Gate                                           |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| alpha  | anything, flagged BREAKING in the CHANGELOG                                                                                      | all CI gates green                             |
| beta   | very rarely — an isolated break when quality demands it (upgrade guide + `am fix`/codemod mandatory); never a broad API refactor | api-snapshot diff reviewed per release         |
| 1.0.0  | —                                                                                                                                | exit criteria in todo.md (field reports, soak) |
| 1.x    | additive only (1.1.0) / fixes only (1.0.1)                                                                                       | api:check + this policy                        |
| 2.0.0+ | breaking allowed, with upgrade guide + deprecation cycle honored                                                                 | docs/upgrade/ guide mandatory                  |

Beta is a **quality** statement, not a stability freeze (decision 2026-08-07):
it means the physical gates passed and adversarial hunts come back clean — not
that the API stopped moving. But the moving is bounded: **one or two isolated
breaks across the whole beta phase is the budget** — wild API refactoring is
alpha behaviour and stays there.

**The beta promise: an app that worked will work — or will work after
`am fix`.** Every beta-phase break ships with its migration, in this order of
preference: (1) `aiol --safe-fix`/`am fix` rewrites it automatically — the
default expectation; (2) where automation genuinely can't, a precise
step-by-step upgrade-guide recipe. In BOTH cases the running app must say what
is going on: a loud, actionable message at the old spelling naming the change
and pointing at the fix — a break a developer discovers by debugging is a broken
promise regardless of what the guide says. Stability hardens progressively: the
last two betas before 1.0.0 must be break-free (that is C1), and from 1.0.0 the
table above is a promise.

## Experimental surface

There is none. Every exported symbol — including the `aio/state-core` entry, the
`aio/sync` engine internals, and `useTimeTravel` — is tested and covered by this
policy. (Historic `@experimental` tags graduated by test coverage, never by
silent stabilization.)
