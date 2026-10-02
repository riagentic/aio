# Upgrading from 1.0.14-beta to 1.0.15-beta

Nothing is removed and nothing changes shape. No app needs a code change.

```sh
am pin --latest
```

This is the audit round: 46 confirmed defects fixed across four hunt rounds. One
of them could hand a client another caller's filtered view; the rest are
narrower. None is a migration step.

> **Go straight to 1.0.17-beta** (`am pin --latest` does). 1.0.15-beta itself
> introduced regressions — it refused a boot over `AIO_CDP` and over a
> hex/exponent/signed `AIO_PORT`, made `"x" in s` differ between sync and async
> methods, and stopped `testUI({ persist: true })` writing while mounted — which
> 1.0.17-beta repairs. This page describes what you get on 1.0.17-beta; the
> three items that changed since it was first published are marked.

## What you may notice

- **A controlled `<input type="checkbox">` whose `value` is `"true"` or
  `"false"`** no longer has a `checked` write swallowed as a stale keystroke
  echo. The DOM used to keep the old value while the model held the new one.
- **A versioned install on Windows** is recognised as versioned again, so the
  first self-update adds a version and re-points the stable name instead of
  replacing the symlink with a file (which lost rollback).
- **`am pin --no-download`** (the documented offline path) runs again, and
  **`am start <label>`** works from a subdirectory of a multi-component project
  instead of refusing with "this project declares no components".
- **`am` with `--out=<dir>`** no longer marks every later build dirty: the
  version used to churn `-dirty.<hash>` forever and block publish with no source
  change. A directory artifact (`web`, `ios-client`) also moves correctly when
  the staging area is on another filesystem.
- **`am create` / `am pin` / `am link`** work on a stock Windows box without
  Developer Mode (a junction, not a privileged symlink), and `am fix` no longer
  reports every `*.sh` as needing manual repair there. `install.sh` persists
  PATH correctly when `$HOME` contains a space.
- **A `persist: "none"` cell named after an `Object.prototype` member** no
  longer has its action payload written to `logs/actions.jsonl` in cleartext.
- **`aiol`** sees what it documents again: a relative project directory, a
  comment above an expression-bodied member, block-bodied timer callbacks, and
  deep-excluded reads in `.tsx` are all handled, and `--safe-fix` no longer
  rewrites a user's own method named `call`.

- **A `Map`/`Set`/class field in a `resolveUser` record no longer shares a
  per-user cache slot with a different one.** A per-user view is recalculated
  for callers whose user records differ only inside such a field (a `Set` of
  scopes, a `Map` of tenant claims) instead of the second caller being served
  the first's slice, and a `ttl` / `first` method result is no longer reused
  across those callers. A `Date` or `bigint` field is unaffected — it stays part
  of the cache key. A record that is itself a class instance or a `Proxy` has no
  key, so its view is recomputed per client. If you keep user records as plain
  data, nothing changes at all.
- **A cell whose name is an `Object.prototype` member** (`valueOf`, `toString`,
  `hasOwnProperty`, … — always legal) **receives its full state again.** A
  subscription to such a cell used to yield an empty frame, so the client's base
  never held it and patches could not repair it.
- **`am shot --check` refuses an unreadable `--threshold` / `--max-diff`** (a
  typo such as `--threshold=abc`). Before, `NaN` disabled the comparison and the
  check reported "matches" for a frame that had changed — it failed open. Pass a
  number, or drop the flag for the default (`--threshold=2`, `--max-diff=0`).
- **A path-pinned app in a directory whose path contains a space** (or any
  Windows checkout) **no longer re-executes `am` a second time per command**,
  and no longer prints the "using the pinned checkout's am" note when it was
  already running that checkout's `am`.
- **A TOTP secret re-staged under a different spelling** (lower-cased, or with
  `=` padding — base32 accepts both) is the same secret: it no longer resets the
  one-code-one-use record and reopens a code already spent in its 90-second
  window.
- **`deepFreeze` no longer runs a getter** in state that declares an accessor
  (which dev already warns about). Before, a throwing getter left the declared
  `state:` **unfrozen** in dev without saying so.
- **An ambient `AIO_CDP` on a browser/CLI client is ignored, with one warning**
  (changed in 1.0.17-beta). Through 1.0.14 it booted and advertised a debugger
  port nothing listened on; 1.0.15 and 1.0.16 refused the boot. Now no port is
  opened or advertised and the app starts. `--cdp` typed on such an app is still
  refused. To do: unset it for that app if the warning bothers you.
- **`AIO_PORT=0`** means "pick a free one" everywhere — it no longer opts a
  local Electron app out of zero TCP ports.
- **`AIO_PORT` / `AIO_DEFAULT_PORT` written `0x1F90`, `1e3` or `+3000` bind the
  port they always did, with one warning** (changed in 1.0.17-beta; 1.0.15 and
  1.0.16 refused the boot). Only a value that is not a port (`abc`, `70000`) is
  refused. To do: write the port in decimal digits.
- **`--host=LOCALHOST`** is treated as loopback; the boot report and share-link
  note match `localhost`.
- **The aio client's certificate pin matches, and warns when it changes**
  (changed in 1.0.17-beta). It is keyed by `host:port` like the lookup, and is
  met by the pinned certificate or by one signed by the pinned root. A pinned
  host that presents anything else gets a warning in the client's log and on its
  connect page — `The certificate pinned for <host> has CHANGED` — and the
  client still connects; it is not a refusal. To do: after reinstalling a server
  or regenerating its certificate, pair again (or import a fresh `.aioapp`).
- **An in-app rollback updates `installed.json`**, so `am installed` reports the
  version that is actually running.
- **`am start` / `am status` print the URL to open** (`http://localhost:<port>`,
  or `https://…` for a TLS app), and their `--json` output gains a `url` field.

## Retire

- Nothing. No workaround in this guide's scope is retired by 1.0.15-beta.
