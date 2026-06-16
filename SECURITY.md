# Security Policy

## Supported versions

`aio` is pre-1.0. Security fixes land on the latest published version on
[JSR](https://jsr.io/@riagentic/aio); there is no back-port window until 1.0.
Always run the latest release.

| Version          | Supported         |
| ---------------- | ----------------- |
| latest `1.0.0-*` | ✅ security fixes |
| older pre-1.0    | ❌ upgrade to fix |

## Reporting a vulnerability

Report privately — **do not** open a public issue for an unpatched flaw.

- Email **riagentic@proton.me** with `aio security` in the subject, or
- Use GitHub's private **"Report a vulnerability"** (Security → Advisories) on
  [github.com/riagentic/aio](https://github.com/riagentic/aio).

Please include: affected version, a minimal reproduction, and the impact you
observed. Expect an acknowledgement within **72 hours** and a fix or mitigation
plan within **7 days** for confirmed issues. Coordinated disclosure is
appreciated — we will credit reporters who want it.

## Threat model — what `--expose` is and isn't

`aio` ships hardened for its intended posture; deploying outside it is the
operator's risk.

- **Designed for:** local/LAN/tailnet tools and trusted-network deployments
  behind your own TLS-terminating reverse proxy.
- **Every authenticated client is a writer.** Auth gates _connection_, not
  _capability_: an authenticated client may dispatch any non-internal
  (`__`-prefixed) action. There is no per-action authorization. Multi-user
  isolation is limited to the `ui.forUser` view filter — treat all authenticated
  users as mutually trusted writers.
- **Not designed for:** exposing an unauthenticated or multi-tenant-hostile
  surface directly to the public internet.

## Hardening already in place

- Timing-safe token comparison (`src/server-auth.ts`).
- WS origin validation incl. `strictOrigin`; per-client and global rate limits,
  per-client bandwidth caps, and an abuse denylist that survives reconnects
  (`src/server-ws.ts`; limits tunable via `wsLimits` / `maxConnections`).
- Prototype-pollution and cycle guards on the snapshot-restore merge path.
- `no-referrer` meta on generated HTML; `X-Content-Type-Options: nosniff`.

## Operator guidance

- Prefer the `Authorization: Bearer` header over `?token=` in URLs — tokens in
  URLs leak via history, proxy logs, and `Referer`. The query-param path remains
  a fallback for header-less contexts and emits a one-time startup warning when
  used (see `src/server.ts`).
- Terminate TLS at a trusted proxy for internet-adjacent deployments; the
  built-in self-signed cert is for LAN convenience, not public trust.
- Tune `wsLimits` and `maxConnections` to your expected traffic before exposing.
