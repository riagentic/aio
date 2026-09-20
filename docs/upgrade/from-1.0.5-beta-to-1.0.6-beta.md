# Upgrading from 1.0.5-beta to 1.0.6-beta

**The public surface is additive only** — no code change is needed.

```sh
am pin --latest
```

Nothing was removed and no signature changed. What is new is that a handful of
mistakes that used to pass in SILENCE now say so, and a few of them refuse the
boot. Every one of them was already giving your app the opposite of what it
asked for — a `"false"` that exposed the server, a misspelled `ttlMS` that left
a 5-minute session at 30 days. If your app boots, nothing here applies to it.

The full account is `CHANGELOG.md`.

## If a boot now refuses

| the refusal names                                                     | what it means                                                                                                        | what to do                                                                 |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| a value of the wrong shape (`expose: "false"`, `allowedOrigins: "…"`) | a boolean written as a string is TRUTHY, and a single origin written as a string was iterated character by character | write the boolean, or wrap the origin in an array — the message shows both |
| an unknown key inside `auth`, `sessions`, `tls` or `updates`          | a typo there used to be dropped, leaving the control absent                                                          | take the did-you-mean the message prints                                   |
| a persist filter naming neither `include` nor `exclude`               | that cell was persisting `{}` on every flush                                                                         | name one of them, or drop the object                                       |
| an `async onRestore`                                                  | the hook's result became a Promise, which read as "0 keys" and then overwrote your data                              | make it sync, or do the async work in `onStart`                            |
| a snapshot that cannot be copied, or a quarantine that cannot finish  | the boot used to continue and start EMPTY beside your data                                                           | fix the disk or permissions the message names; your data is untouched      |

## `visible.exclude` / `persist.exclude` now fail closed

A security fix, and the one part of this release that can change what your
clients see. A dot path (`exclude: ["accounts.encSecKey"]`) used to descend into
the records of `accounts` **only when `accounts` had no key of that name
itself** — so one record id equal to the field name (a username, a slug) sent
every other record's secret to every client. Excluding `a.constructor`,
`a.__proto__`, `a.toString` or `a.valueOf` removed nothing at all, because the
check walked the prototype chain.

The rule is now: at every level, drop the literal path **and** walk every
remaining key as a record. An ambiguous name loses both readings.

| what changes                                                                                                    | what to do                                                                        |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `exclude: ["a.b"]` also removes `b` under every record of `a`, at any depth                                     | intended. A sibling BRANCH is untouched — `other.b` still reaches the client      |
| a live update whose path starts with a record id, or carries a numeric-string key, no longer reaches the client | intended — the full frame already stripped it, so the two now agree               |
| `persist.exclude` keeps more out of the store; those fields come back from boot                                 | intended. A nested field the old rule still wrote is dropped on the next write    |
| excluding `a.constructor` / `__proto__` / `toString` / `valueOf` now works                                      | if something read one of those client-side, it throws now instead of reading data |
| a `Date`/`Map`/`Set`/typed array under an exclude path reads as itself again                                    | it used to read as `{}` on the client seam                                        |

## What you may notice

| behaviour                                                                           | what to do if you hit it                                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| a Windows desktop app that used to freeze on a page of broken images no longer does | expected — rebuild it                                                                      |
| an async method that writes in a loop is dramatically faster                        | expected — 19.2 s → 46 ms at 10 000 keys                                                   |
| a client-visible list is the SAME object between reads again                        | expected — identity memoization works again                                                |
| a negative `backoff`/`poll` duration now throws in dev and tests                    | it was silently a 1 ms hot loop; fix the sign (prod still clamps, and says so once)        |
| an hourly cron no longer re-runs a slot after the clock steps back                  | expected — only minute-starred patterns catch up, so a billing job cannot run twice        |
| `press("Enter")` in a test throws where a browser would refuse the submit           | your form was failing in the app and passing in the test — the message names the field     |
| a refused call on a `worker: true` cell answers like a main-isolate cell            | expected — adding `worker: true` no longer changes what callers see                        |
| `am state a b` is refused instead of answering for `a`                              | pass one path (`am state a.b`), or quote a brace pick                                      |
| `am --app=` with an empty value is refused instead of guessing                      | an unset shell variable used to target a different app — quote or drop the flag            |
| `am migrate` outside an app refuses instead of printing a clean bill                | run it in the app's directory                                                              |
| a second instance under a different home opens its own Electron profile             | expected — it used to share the first's cache and could render blank. It starts fresh once |
| `deno task install:electron` says what it changed in your `deno.json`               | expected — it always rewrote the pin; now it tells you, with `am fix`                      |
| a journal line written by an older cell version is skipped, out loud, after a crash | declare `onMigrate` if those actions should be converted                                   |
| the re-render warning now names a component, a hook, or nothing                     | expected — it used to blame "a render writing state" when nothing did                      |
| a page bundle is 1.1 KB (gz) larger                                                 | expected — the renderer fixes; the measured ceiling moved with it                          |

## Retire

| workaround                                                                                               | fixed in   |
| -------------------------------------------------------------------------------------------------------- | ---------- |
| limiting how many images or `aio://` requests a desktop page may load at once so the app does not freeze | 1.0.6-beta |
| answering error routes with an empty body to keep a Windows desktop app alive                            | 1.0.6-beta |
| fetching in a plain async function and writing through one sync method to avoid a slow loop              | 1.0.6-beta |
| caching a client-visible list by hand because its identity changed on every read                         | 1.0.6-beta |
| `if (s.peek() !== v)` guards, `display: contents` slots, or `am restart` after every cell edit           | 1.0.6-beta |
| moving a form's shortcut handler onto a `<div>` so tests would see it                                    | 1.0.5-beta |
| a redundant `aria-label` on an input already wrapped in a `<label>`                                      | 1.0.4-beta |
