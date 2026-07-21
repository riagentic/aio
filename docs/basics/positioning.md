# Positioning & non-goals

What aio is for, what it deliberately is not, and the trade-offs behind that —
so you can decide fit in two minutes.

## Built for

**Apps where shared reactive state is the product**: dashboards, trading and ops
tooling, control panels, internal utilities, local-first desktop/mobile tools.
One codebase → browser, Electron, Android WebView, CLI, systemd service, single
binary. Persistence, real-time sync, auth, scheduling, UI, and build targets are
one system — the integration work between those layers is the product's job, not
yours.

## Deliberately not for

- **Content/marketing sites & SEO** — AIR is client-rendered with basic SSR;
  there are no server components. Use a content framework.
- **Planet-scale public APIs** — the embedded model (Deno.Kv/SQLite, one
  process) is the point, not a limitation to engineer around. Multi-region
  distributed state, horizontal fleets → use a distributed stack.
- **Native iOS** — Android ships via WebView; iOS is not targeted.
- **Other runtimes** — aio is Deno-native (Kv, compile, workers). No Node/Bun.
- **Renderer pluralism** — AIR is the renderer. React compat exists as shims
  (`aio/air/compat`) for migration, not as a parallel first-class path.

## Trade-offs we chose

- **Opinionated cells over flexibility** — everything is a cell so every app
  reads the same. If your domain fights the model, aio will feel restrictive.
- **Server-owned state over client state** — the browser holds a synced view.
  This kills a class of sync bugs and costs a mental-model shift.
- **Embedded storage over external DBs** — zero-config persistence and
  single-binary deploys, bounded by one machine's capacity. A pluggable storage
  seam is reserved (see `docs/specs/2026-07-11-storage-backend-interface.md`).

## Current maturity (alpha)

All ten targets (five local + five `remote`/thin-client) are exercised by CI
end-to-end. The API surface is snapshot-locked in CI; breaking changes ship only
in alphas. See [semver policy](semver-policy.md) and the
[changelog](../../CHANGELOG.md).
