# Versioning & Deprecation Policy

aio follows [semver](https://semver.org) from `1.0.0` on. This document is the
contract (roadmap B1): what counts as breaking, how deprecations work, and what
each release phase may change.

## What counts as the public API

The public surface is exactly what the CI-enforced snapshot locks
(`docs/api-snapshot.json`, `deno task check:api`):

- every export of every `deno.json` entry point (`aio`, `aio/air`,
  `aio/air/compat`, `aio/jsx-runtime`, `aio/state-core`, `aio/db`, `aio/sync`,
  `aio/testing`, `aio/schedule`, `aio/selectors`, `aio/build`, `aio/am`,
  `aio/aiol`) — names, kinds, and signatures
- the wire protocol as negotiated by the `proto` `{v,min}` handshake
- the persistence schema as stamped by `<appId>:__schema`
- documented CLI flags (`aio create`, `--expose`, `--port`, …) and the six
  scaffolded `deno.json` lines `aio doctor` validates

**Not** public API: `_`-prefixed or `@internal` symbols, `src/` folder layout,
log/error message wording (error _codes_ are stable), and undocumented behavior
of internal modules.

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
