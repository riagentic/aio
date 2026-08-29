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
- **CORS** — there are no `Access-Control-*` headers. Cross-origin is _refused_
  by the `Origin` and `Host` checks rather than negotiated; an embedder or a
  cross-origin caller is named in `allowedOrigins` or it is a 403. (Security
  headers are NOT a non-goal since alpha72 — every response carries
  `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` and a
  Content-Security-Policy, with `Strict-Transport-Security` behind an operator's
  own certificate. See
  [Response security headers](../auth/auth.md#response-security-headers).)
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

**What is checked rather than claimed.** Every gate `check:release` runs is a CI
step, and a test reads both lists so one cannot drift from the other. Beyond the
usual (types, lint, the suite, the module boundary matrix), the ones worth
knowing about because they catch what review does not:

| gate                    | what it refuses                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check:audit`           | 30 randomized adversarial rounds, seeded so a finding replays. Every other gate asks whether the code matches a decision someone wrote down; these ask what happens on an input nobody chose |
| `check:mutations`       | breaks 59 load-bearing invariants on purpose and requires the named test to go red — a green suite that would stay green is not a suite                                                      |
| `check:vacuous`         | a test that passes while proving nothing (an assertion inside a loop that may not run, both sides of a comparison the same expression)                                                       |
| `check:dead-wiring`     | an export nothing reaches — a feature that was declared and never connected                                                                                                                  |
| `check:silent-catch`    | a `catch` that swallows without saying why it may                                                                                                                                            |
| `check:bundle-size`     | the bytes a page downloads, AND whether the docs still quote the measured number                                                                                                             |
| `check:orphans`         | processes and directories a test run left behind                                                                                                                                             |
| `check:docs` + snippets | every fenced `ts` example type-checks against the real repo; every `am` verb and config key the docs name exists                                                                             |

**What is NOT checked here, and needs hardware this side does not have**: a real
Windows pass (the named-pipe transport is proven under Wine and by inspection),
a real macOS pass, a real Android device pass, and a 72-hour soak. Those are
named in `todo.md` rather than assumed.
