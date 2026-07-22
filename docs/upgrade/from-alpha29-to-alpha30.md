# Upgrade: 1.0.0-alpha29 → 1.0.0-alpha30

alpha30's headline is **built-in enterprise auth** — everything is opt-in, so
existing apps upgrade with **no code changes**. No wire-protocol change: alpha29
clients and alpha30 servers interoperate.

## New (opt-in)

- `auth: true` — full login system: signup/login/logout endpoints
  (`/__aio/auth/*`), PBKDF2 passwords, session cookies, `<SignIn/>` +
  `useUser()` (from `aio/air`), email verify/reset, TOTP 2FA, OIDC, account
  lockout, `am auth` operator CLI. See [auth](../auth/auth.md).
- `sessions: true` — the session store alone (issue/refresh/revoke bearer
  tokens) without password flows.
- Declarative `access` on cells and `serverFns(ns, fns, { access })` — who may
  act over the network; `serverUser()` gives the caller anywhere server-side.
- Scaffolds now emit the **full dev/compile target matrix** (`dev:cli`,
  `dev:service`, `compile:remote:*`, …) plus `src/client.ts` (thin CLI client).
  Existing apps: copy the tasks you want from a fresh `am create` scaffold —
  nothing else moved.

## Behavioral changes (security hardening — most apps unaffected)

- `/__aio/snapshot` in **shared-token and public modes** is now
  same-machine-only (it dumps unfiltered state). Per-user mode keeps the
  admin-role gate. If you scripted remote snapshots over a shared key, run them
  on the host or switch to per-user auth with an admin account.
- The trojan control plane no longer answers in service mode (dev-only +
  same-machine + auth + CSRF header, defense in depth).
- Client-supplied `_user` on any network action is stripped (identity spoofing
  fix). Only affects callers that were forging identity.
- Failed auth attempts are budgeted per IP (10 per 5 min → `429`).

## Checklist

1. Update: `am update` (or `git pull` in your aio checkout).
2. Nothing else — recompile binaries whenever convenient.
