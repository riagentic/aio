# Upgrade: 1.0.0-alpha30 → 1.0.0-alpha31

A sanity & cleanup release — no new features. It hardens the alpha30 auth stack,
fixes two data-loss/DX bugs, and cleans up a few inconsistent parameters. Most
apps upgrade with **no code changes**. No wire-protocol change: alpha30 and
alpha31 interoperate.

## Security (no action needed — hardening only)

Three adversarial passes over the auth stack; all findings fixed. If you use
`auth: true` / `sessions:` / cell `access` / OIDC, you get the fixes for free
(open-redirect, sync-op access bypass, account enumeration, reset timing oracle,
OIDC login-CSRF, lockout bypass). Two notes:

- **Behind a reverse proxy**, set `trustProxyHeader: "x-forwarded-for"` (or your
  proxy's header) so the per-IP auth-fail budget and account lockout bucket per
  real client instead of collapsing every request into the proxy's IP. Leave it
  unset when there is no trusted proxy in front (a client-settable header must
  not be honored directly).
- Cell `access: "none"` (and `"all"`, `"true"`, …) now **throws at definition**
  — a string is a role name, so `"none"` silently granted a nonexistent role.
  Use `access: false` (deny all network access) or `access: true` (any
  authenticated user).

## Bug fixes you may have hit

- **Persistence:** on shutdown, if any one cell exceeded the ~64KB Deno KV limit
  in `persistMode: "multi"`, the whole commit failed and **every** cell's data
  was lost. Now the healthy cells persist and only the oversized cell is skipped
  (and named in the log). If you saw empty state after a restart with a large
  cell, this was it.
- **Dev console:** `console.error(someError)` now forwards the error message to
  the dev-server console instead of `"{}"`.

## Minor breaking (parameter cleanup)

Old forms still work via deprecated aliases, but update at your leisure:

| old                           | new                             | note                                        |
| ----------------------------- | ------------------------------- | ------------------------------------------- |
| `call({ timeout })`           | `call({ timeoutMs })`           | `timeout` still honored (alias)             |
| `--cert` / `--key` (CLI, TLS) | `--tls-cert` / `--tls-key`      | old flags still accepted                    |
| `onEffect(effect, user)`      | `onEffect(effect, state, user)` | extra `state` arg — old callbacks ignore it |

New (additive, non-breaking): `diagnostics: true` and `dispatchStorm: true` now
type-check (previously only `false` / an object).

## Checklist

1. Update: `am update` (or `git pull` in your aio checkout).
2. If you run behind a reverse proxy with auth, set `trustProxyHeader`.
3. Nothing else — recompile binaries whenever convenient.
