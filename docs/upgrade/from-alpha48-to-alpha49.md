# Upgrade: alpha48 → alpha49

**A security release.** Two critical auth findings, plus a production bug that
stopped every scheduled task on Android from ever firing.

**Take this one if you use `auth: true`, `users:` or `resolveUser`.**

## 1. An unauthenticated attacker could take your whole app offline

The per-IP failure budget gated **service**, not just authentication. Ten wrong
login attempts against any username — no valid account needed — and that client
key was refused for five minutes: valid sessions, authenticated API calls and
WebSocket handshakes alike. Renewable indefinitely at about two requests a
minute.

Worse, behind the reverse-proxy configuration **the auth docs themselves
recommended**, every client collapsed into a single bucket, so one attacker took
the app off the air for everyone.

Now: the credential is resolved first, and only a **presented-and-wrong** one
meets the budget. A valid credential is served regardless. The bucket collapse
is no longer silent either — you get a boot warning when an exposed app uses
per-user auth without `trustProxyHeader`, and a one-shot runtime warning the
first time a request arrives carrying a forwarded-for header you are not
trusting.

**Action:** if you run behind a proxy, set `trustProxyHeader` and forward the
client address. The doc snippet now shows both.

## 2. A stolen session was a permanent, unrecoverable account takeover

Enabling 2FA required only a session; disabling it required the password. An
attacker with a borrowed session enrolled their own authenticator — and nothing
cleared it. Not a password reset, not `am auth passwd`, no `am` command at all.
The only recovery was deleting the account.

Now: **enabling a factor requires the account password**, exactly as disabling
always did, and there is a real operator recovery path:

```sh
am auth totp <id> off     # clears the secret, the flag, and pending tokens
```

The operator's credential is being able to read the app's data directory —
strictly stronger than any in-app account.

A password reset still does **not** clear an enabled factor (that would make
mailbox compromise a full 2FA bypass), but it does drop a secret that was staged
and never enabled, so a planted secret cannot outlive the rescue.

There are no user-held recovery codes. That is a real gap; the operator command
above is the answer for now.

## 3. OIDC could take over a local account

An SSO login matched local accounts by `sub` alone — so an IdP identity whose
`sub` equalled a local username received a session for that account, bypassing
any 2FA it had enrolled, and then **rewrote its email** to the IdP-supplied one,
permanently capturing the password-reset channel.

External identities are now namespaced: `oidc:<issuer>:<sub>`. Since `sub` is
unique only within an issuer, the namespaces cannot overlap, and an OIDC login
can never reach, create or modify a local account.

**Action if you already use OIDC:** existing rows keyed on a bare `sub` are
orphaned by this change — the user gets a new account under the namespaced id.
The old row is left intact and the collision is logged at login with the new id,
so you can migrate or merge deliberately. Verified SSO↔local linking is not
implemented.

## 4. A password reset left the account locked out

Five wrong guesses locked an account; completing an emailed reset returned `200`
and the correct new password still got `423 account_locked` for another fifteen
minutes — renewable forever by the attacker.

The unlock now lives **inside** `setPassword`, together with burning outstanding
one-shot tokens and revoking every session. One decider, so every caller
inherits all three: `POST /auth/password`, `POST /auth/reset`, and
`am auth passwd` — which previously cleared the lock but left the attacker's
session alive.

And `<SignIn/>` now has a **"Forgot password?"** affordance when the server can
send mail. It never did, so the reset flow was unreachable from the shipped UI.

## 5. A demoted admin stayed an admin

Session rows stored the role copied at issue time, so `am auth role x user` did
not reach a live session — for up to the 30-day TTL, across `/__aio/snapshot`,
`/__aio/trojan/*` and every `access:` rule. The role is now read live from the
users row, and a demotion lands on the next request and on open WebSockets.

## 6. Scheduled tasks never fired on Android

`schedule.after`, `every`, `at` and `cron` were registered against a clock
nothing in a shipped APK ever advanced — so they simply never ran, with no error
anywhere. The standalone runtime now uses real timers; virtual time is an
explicit test-only opt-in.

This was invisible because the test harness drove the clock by hand _and_
re-implemented the scheduler more permissively than production. The harness now
runs the real scheduler; only the clock is swapped. **Your schedule tests may
newly fail** if they used an invalid id or a sub-threshold interval — production
always refused those.

## Also fixed

- **`schedule.after` with a delay over ~24.8 days fired immediately** (`at` and
  `cron` had the clamp; `after` never did). So `backoff` without an explicit
  `max` became a 1 ms hot loop at attempt 22 — aimed at exactly the rate-limited
  API its own docs describe. All timer paths now share one clamp, and
  `backoff`/`poll` default to a delay a timer can actually hold.
- **`own.set` from a `worker: true` cell silently did nothing** — the documented
  way to hold a subprocess or FFI handle. It now runs in the worker isolate,
  which is the only one that can create _and_ dispose the resource.
- A leap-day cron (`0 0 29 2 *`) was silently deleted forever.
- A failed one-shot's retry could resurrect a schedule that `cancelAll()` had
  just cancelled — including during shutdown.
- `skipIfRunning` wedged permanently on a tick that never settled, with no
  warning and no escape; cancel now clears it and repeated skips warn.
- `auth: { totp: false }` silently stopped **verifying** the second factor for
  already-enrolled accounts, not just enrollment.
- Unauthenticated `/__aio/auth/*` and `/__aio/pair` bodies are bounded (16 KiB)
  — a 48 MB login body was buffered before.
- Confusable usernames (`Neighbour` / `neighbour` / NFC vs NFD) can no longer
  become separate accounts. **Ids containing spaces are now refused at
  creation**; existing rows are unaffected.
- Auth responses carry `Cache-Control: no-store`.
