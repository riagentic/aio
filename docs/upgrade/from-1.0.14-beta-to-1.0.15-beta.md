# Upgrading from 1.0.14-beta to 1.0.15-beta

Nothing is removed and nothing changes shape. No app needs a code change.

```sh
am pin --latest
```

This is the audit round: 46 confirmed defects fixed across four hunt rounds,
each with a test that is red before the fix. One of them could hand a client
another caller's filtered view; the rest are narrower. None is a migration step.

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
  across those callers. A `Date` field is unaffected — it stays a cache key. If
  you keep user records as plain data, nothing changes at all.
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
- **`AIO_CDP` on a browser/CLI client is refused** like `--cdp` (it used to boot
  and advertise a debugger port nothing listened on). **`AIO_PORT=0`** means
  "pick a free one" everywhere — it no longer opts a local Electron app out of
  zero TCP ports. A hex/exponent/signed `AIO_PORT` is refused, as `--port=`
  already was.
- **`--host=LOCALHOST`** is treated as loopback; the boot report and share-link
  note match `localhost`.
- **The aio client's certificate PIN works again** — it is keyed by `host:port`
  like the lookup, so an imported `.aioapp` / paired app on a non-default port
  is trusted by its pin rather than by the looser first-fetch check.
- **An in-app rollback updates `installed.json`**, so `am installed` reports the
  version that is actually running.
- **`am start` / `am status` print the URL to open** (`http://localhost:<port>`,
  or `https://…` for a TLS app), and their `--json` output gains a `url` field.

## Retire

- Nothing. No workaround in this guide's scope is retired by 1.0.15-beta.
