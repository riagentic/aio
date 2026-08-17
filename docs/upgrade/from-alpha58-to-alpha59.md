# alpha58 → alpha59

**Nothing to migrate in your app's code.** Everything here is either additive or
a change to what aio _prints_ and _where the one-liner puts things_. Two things
you might notice: log lines now carry a level on the matching console channel,
and the one-line installer installs the app into `~/app/<name>/` instead of
running it out of the checkout.

## Log output: every line has info / warn / error

Framework runtime code writes through the logger now, so a line that used to
look like this:

```
[aio:vitals] PRESSURE — 40 broadcasts/sec (threshold: 30/sec)
```

looks like this:

```
14:22:07  WARN  vitals  broadcast rate 40/sec is above the 30/sec advisory
                        threshold — the app is working, this is about cost
```

Three consequences:

- **The level picks the console method.** Errors go to `console.error`, warnings
  to `console.warn`, info to `console.info`. Everything used to go through
  `console.log`, so `2>` captured nothing and a devtools level filter showed one
  undifferentiated stream. If you pipe an app's output and split on streams,
  that split now works — and stderr will have content it did not have before.
- **Those lines reach `app.log` / `warning.log` / `error.log`.** Console output
  only ever reached a file when something happened to be capturing stdout.
- **If you assert on framework output in your own tests, capture every
  channel**, not just `console.log`. A stub of `console.log` alone now sees
  nothing when a warning fires — which reads as "nothing warned".

The vitals pressure line also changed shape: it says in words that it is
advisory ("Nothing is broken and no data is at risk"), and it fires once when
the condition starts and once when it clears instead of every second.

## The one-liner installs the app

`curl -fsSL …/run.sh | sh -s <repo-or-path>` used to build and run the artifact
inside the checkout. It now installs:

```
~/app/<name>/versions/<version>/<name>.AppImage   the artifact
~/app/<name>/<name>.AppImage                      stable name → the current version
~/app/<name>/installed.json                       repo/commit/version/target/aio
~/.local/share/applications/<name>.desktop        a menu entry (headless: ~/.local/bin/<name>)
```

- `AIO_INSTALL_ROOT` overrides the location; `--no-install` keeps the old
  run-from-`dist/` behaviour; `AIO_KEEP_VERSIONS` (default 3) bounds how many
  versions are kept.
- Your app's **data** is unchanged and still lives in `~/.<appId>/`. The split
  is deliberate: one is the program, the other is everything it owns.

New commands for what that creates:

```sh
am installed              # what is in ~/app, with version counts
am remove <app>           # the program (data is KEPT)
am remove <app> --data    # …and ~/.<appId>/ too
am upgrade <app>          # re-run the recorded source
```

`am remove` refuses while the app is running and names `am stop`. `uninstall`
still means "remove am itself" — `remove` is the app.

## If you renamed a compiled binary, check your data directory

A deno-compiled binary took its identity from **the executable's file name**, so
`mv myapp myapp.bak` (or any install step that renamed the artifact) silently
moved the app to a fresh, empty `~/.myapp-bak/` and orphaned the real data.

A binary built with alpha59 reads its identity from the deno.json embedded in
itself, so renaming the file no longer renames the app. **Rebuild to get the
fix** — an already-compiled artifact still behaves the old way. If you have a
data directory that looks like a file name (`~/.myapp-1-0-0/`, `~/.myapp-bak/`),
that is where your data went; move it back onto `~/.<appId>/` before starting
the new build.

## Windows scripts caught up — and still unverified

`install.ps1` and `run.ps1` now do what their POSIX twins do (deno version
check, PATH written to the User scope, install to
`%LOCALAPPDATA%\Programs\<name>\`, install record, pruning, Start Menu
shortcut). One fix matters even if you never upgrade: `run.ps1` used `??`, which
is PowerShell 7 only, so it was a parse error on a stock Windows box before a
single line ran.

Both files now state at the top that **Windows is best-effort until there is a
Windows runner**: the gate runs them in Microsoft's PowerShell image on Linux,
which proves they parse and that their decisions are right, and proves nothing
about the registry, shortcuts, `.exe` artifacts or a winget deno.

## Testing your own onboarding

If you want the fresh-machine check for your app:

```sh
deno task lab <owner>/<repo>     # or a local path
```

It runs the whole first-contact path in a fresh `ubuntu:24.04` container (no
deno, no node, no unzip, non-root) and verifies the UI is actually there —
distinguishing a blank mount point, a stuck loader, a dead socket and the
framework's module-error page — with no errors in the app's logs. Requires
Docker or Podman.
