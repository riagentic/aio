# Upgrade: alpha41 → alpha42

**No code changes required.** Nothing was removed and no behavior an app depends
on changed. One thing now happens to your `deno.json` that did not before — read
the first section.

## `am fix` will pin your app

If your app has no `"aioVersion"` in its `deno.json`, the next `am fix` (or the
next `run.sh`, which calls it) records one:

```jsonc
{
  "aioVersion": "v1.0.0-alpha42", // ← added for you, and reported
  "name": "my-app"
}
```

Why: an unpinned app links to whatever aio happens to be installed on the
machine, so a framework release it never asked for can break it. With a pin, a
clone rebuilds against that exact framework — provisioned as a git worktree —
however far ahead aio has moved.

What to do: **commit it.** That one string is what makes the app reproducible.

If you would rather choose the version yourself:

```sh
am pin v1.0.0-alpha42   # any released tag
am pin --latest         # newest within your major — never crosses to 2.0
am pin main             # follow the tip; recorded RESOLVED as main-<sha>
am pin                  # report only: what the app asks for vs what it links
```

An existing pin is never overridden, and `am fix --dry-run` (alias `--check`)
reports the seal without writing it.

## The one-liner honors that pin

`run.sh` / `run.ps1` used to fall back to the **installed** framework's builder
when an app had no scaffolded `compile` task. They now prefer the app's own
`dep/aio` — the pinned version — and only fall back to the installed aio when
there is no link at all, saying so when they do. If you hand-rolled an app
without the standard tasks, its builds now match its pin.

## Removed-API messages tell you both ways out

The framework's "that spelling is gone" errors now name the version that still
ran it, next to the migration:

```
[mdview] cell config key 'machine:' was removed in alpha27 — guards are a guard
line — `if (s.status !== "idle") return;`. Migrate: docs/upgrade/restructure.md
— or run it unchanged on the version it was written for:
`am pin v1.0.0-alpha26 && am fix`.
```

Nothing new was removed in alpha42 — this only changes the wording of errors for
removals that happened in alpha27. `deno task lint` (aiol) reports the same text
statically, before the app boots.

Migrating an old app is still the recommended path: pinning an old framework
freezes you there, and every doc and example you read describes the current one.
See [the restructure guide](restructure.md).

## `am pin` checks before it moves

Changing a pin now reads your source first and refuses a move that would break
the app, naming `file:line` and both ways out:

```
✗ v1.0.0-alpha42 would break this app — 1 removed API(s) still in use:
  src/cell/mdview.ts:61
    cell config key 'machine:' was removed in alpha27 — ...
```

`--force` pins anyway. Moving backward to a version that still runs the old
spelling is silent. `am pin` / `am fix` additionally report how far behind a pin
is — advisory only, nothing changes.

## `--version` identifies the artifact

An app used to print `aio 1.0.0-alpha42`. It now prints
`<appId> <appVersion> (aio <version>)`, so a binary found on a server says what
it is and what built it. A running app already exposed the framework version at
`/__aio/health`.

## Gates

Nothing to do, but if you build tooling on aio: a removal is now recorded in one
place (`src/state/removals.ts`) and the suite refuses any surface that describes
one in its own words.
