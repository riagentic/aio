# Versioning & Deprecation Policy

aio follows [semver](https://semver.org) from `1.0.0` on. This document is the
contract (roadmap B1): what counts as breaking, how deprecations work, and what
each release phase may change.

## What counts as the public API

The public surface is exactly what the CI-enforced snapshot locks
(`docs/api-snapshot.json`, `deno task api:check`):

- every export of every `deno.json` entry point (`aio`, `aio/air`,
  `aio/air/compat`, `aio/jsx-runtime`, `aio/state-core`, `aio/db`, `aio/sync`,
  `aio/testing`, `aio/schedule`, `aio/selectors`, `aio/build`, `aio/am`,
  `aio/aiol`) — names, kinds, and signatures
- the wire protocol as negotiated by the `__proto:{v,min}` handshake
- the persistence schema as stamped by `<appId>:__schema`
- documented CLI flags (`aio create`, `--expose`, `--port`, …) and the six
  scaffolded `deno.json` lines `aio doctor` validates

**Not** public API: `_`-prefixed or `@internal` symbols, anything tagged
`@experimental`, `src/` folder layout, log/error message wording (error _codes_
are stable), and undocumented behavior of internal modules.

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
3. Keep: deprecated APIs stay functional for at least the rest of the current
   major — removal happens at the next major, never in a minor/patch.
4. Exception: `aio/air/compat` is **permanent** (decision 2026-07-06) — the
   React-compat shims are not scheduled for removal.

## Release phases

| Phase  | May break                                                        | Gate                                           |
| ------ | ---------------------------------------------------------------- | ---------------------------------------------- |
| alpha  | anything, flagged BREAKING in the CHANGELOG                      | all CI gates green                             |
| beta   | nothing — API frozen at beta1; bugfixes only                     | api-snapshot diff = additive-or-empty          |
| 1.0.0  | —                                                                | exit criteria in todo.md (field reports, soak) |
| 1.x    | additive only                                                    | api:check + this policy                        |
| 2.0.0+ | breaking allowed, with upgrade guide + deprecation cycle honored | docs/upgrade/ guide mandatory                  |

## Experimental surface

`@experimental` symbols (`aio/state-core` entry, `aio/sync` engine internals,
`useTimeTravel`) may change in any release. They graduate by removing the tag —
a minor bump; they are never silently stabilized.
