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

## Trusted environments, by default

aio's security model targets **trusted environments**: localhost tools, LAN
dashboards, small teams, desktop apps. The server binds `127.0.0.1` unless you
pass `--expose`, and every app is public until you ask for a key or users. That
is a deliberate default, not an oversight — for anything internet-facing, put a
TLS-terminating reverse proxy in front and name the domain in `allowedOrigins`.
The full posture, the known limitations, and the nginx/Caddy recipes are in
[Authentication & Security](../auth/auth.md#security-model).

## Deliberately not for

- **Content/marketing sites & SEO** — AIR is client-rendered with basic SSR;
  there are no server components. Use a content framework.
- **Planet-scale public APIs** — the embedded model (SQLite, one process) is the
  point, not a limitation to engineer around. Multi-region distributed state,
  horizontal fleets → use a distributed stack.
- **Native iOS apps** — there is no Deno on iOS, so an aio app cannot RUN there.
  A thin client can: `ios-client` is a WKWebView shell (an Xcode project on any
  host, an `.app` on macOS) that connects to your server — the same shape as
  `android-client`. Native APIs (push, biometrics) are out of a WebView's reach;
  the camera is not.
- **Other runtimes** — aio is Deno-native (compile, workers). No Node/Bun.
- **Renderer pluralism** — AIR is the renderer. React compat exists as shims
  (`aio/air/compat`) for migration, not as a parallel first-class path.

## Non-goals

Things aio does not do, and what to do instead. Each is a scope decision, not a
gap waiting on a patch.

- **i18n / localization** — there is not one `Intl.*` call in `src/`, and every
  framework-emitted string (CLI output, boot lines, error overlay, `<SignIn/>`,
  auth mail subjects) is hardcoded English. Nothing constrains your app: format
  with `Intl` and keep the locale in a cell like any other state.
- **Outbound notifications** — no mail, webhook, push, or desktop-notification
  transport ships with the framework. `auth.sendMail` is a hook _shape_ only
  (`{ to, subject, text }`); with none supplied, the verify and reset routes
  answer `501 mail_not_configured` instead of pretending. Send from a method or
  effect with whatever client you already use.
- **ACME / Let's Encrypt, and containers** — `--expose` issues its own
  certificate: one name-constrained root CA per user (`~/.aio/ca`, valid only
  for loopback, `.local`, and RFC1918), and a leaf re-issued whenever the
  machine's addresses change. Clients pin the root once (`am trust`,
  `am profile`). Public-CA issuance is not implemented — pass `--tls-cert` /
  `--tls-key`, or terminate at Caddy/nginx. No Dockerfile, image, or
  orchestration either: a compiled binary plus a data directory is the unit of
  deployment.
- **CORS and security headers** — the server sends
  `X-Content-Type-Options:
  nosniff` and nothing else. No `Access-Control-*`,
  no `Content-Security-Policy`, `Strict-Transport-Security`, or
  `X-Frame-Options`. Cross-origin is _refused_ by the `Origin` and `Host` checks
  rather than negotiated; a proxy in front is where a public deployment adds the
  rest.
- **End-user password recovery** — the framework mints and burns the reset
  tokens, but it cannot deliver them without a `sendMail` transport you write.
  Until then, recovery is an operator action (`am auth passwd <id>`). See
  [password recovery](../auth/auth.md#email-verification--password-reset).

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
