# Upgrading from alpha73 to alpha74

**Nothing in your app code breaks.** This release is two field reports closed
end to end plus the hunt that followed them: fixes to what aio _serves_, what it
_measures_ and what it _tells you_, three additions to the public surface, and
three new lint rules.

```sh
am pin --latest && am fix   # or: deno task upgrade
```

## What changes without you doing anything

### A compiled binary serves the assets it embedded

Before this release, a compiled binary resolved every app asset that is not the
bundle against `<cwd>/src` — the directory the operator happened to be standing
in. `<img src="/assets/logo.svg">` therefore worked in `deno task dev` and was a
broken image in the artifact.

If you worked around this — inlining SVGs, a test that forbids `/assets/` in
your UI — you can stop. Declare the directory and the binary serves it:

```jsonc
// deno.json
{ "compile": { "include": ["src/assets"] } }
```

The build now reads the bundle it is about to embed and names any asset URL the
binary will not be able to answer, with the `compile.include` line to paste.

### `am cost`, `am status`, `/__aio/metrics` and the pressure alarm see UDS

A local desktop app opens **zero TCP ports** — every client is on the socket.
All four of those surfaces counted WebSocket clients only, so on the default
Electron target `am cost` reported an idle app, `am status` said
`connections: 0` while `am clients` listed a live client, and the broadcasts/sec
alarm could not fire. Nothing to change; the numbers are now about your app
rather than about its transport.

### `least-privilege run flags` describes a binary that boots

`deno task doctor` and the signed `ship` manifest used to derive run flags from
your sources alone, so an app that touches no permissioned API itself was told
it needed `(none)`. The flags now start from what aio itself requires
(`--allow-net --allow-read --allow-write --allow-env`) and add yours on top.

**If you pinned `runFlags` from a previous manifest, re-run `aio ship`** — the
old list is short by aio's own baseline.

### The systemd unit no longer picks an account for you

`writeServiceFile` wrote `User=$USER`, falling back to `root`. A build in a
container or CI (no `$USER`) therefore emitted `User=root`, and the unit ran
your app as root on the installing host.

The value is now labelled in the file as a build-machine value, and a build with
no `$USER` writes `User=REPLACE-ME`, which systemd refuses until you set it.
**If you install a generated `.service`, set `User=` before enabling it.**

### Smaller

- An app's `onStop` can log again — the logger used to be detached before the
  hook ran.
- A UDS client that stops reading its socket is reported at `/__aio/health`
  instead of silently accumulating frames in memory.
- A list key containing `/` is percent-encoded in surface paths, so a row keyed
  by an absolute path is addressable from `am` and from a UI test. Keys without
  `/`, `]` or `%` are byte-identical to before — no existing address changes.
- The "client did not respond" timeout names **window visibility** first: a
  minimised or occluded Electron window is throttled by Chromium and stops
  answering, which used to be reported as a busy main thread.

## New, if you want it

### `onStopping` — stop your own producers before dispatch closes

Shutdown closes dispatch first and runs user hooks last, so anything of yours
that dispatches on its own schedule — a timer, a poller, a promise `finally` —
landed in the drain window and was refused. `onStop` could not prevent it.

```ts
await aio.run({
  cells: [sync],
  onStart: () => {
    poll = setInterval(() => sync.pull(), 5_000);
  },
  onStopping: async () => {
    clearInterval(poll); // nothing of mine dispatches from here on
    await sync.flush(); // …and this write IS persisted
  },
});
```

### `trackedMemo` — a cache whose hits still subscribe

One cell is one signal, so any list large enough to matter pushes you toward a
memo — and a plain cache that returns a hit without touching the cell subscribes
to nothing, permanently, for that component instance.

```tsx
import { trackedMemo } from "aio/air";

const rows = trackedMemo((filter: string) =>
  accounts.list.filter((a) => a.name.includes(filter))
);
```

See
[reactivity tracking](../ui/reactivity-tracking.md#a-cache-hit-skips-the-read--so-it-skips-the-subscription).

### `am where <file>` — which context does this code run in

```sh
am where src/ui/Panel.tsx
```

The verdict, the import chain from the UI entry that put it there, and the rules
that follow. The map it renders from is
[Where does this code run?](../basics/where-code-runs.md).

## Three new lint rules

`aiol` refuses three shapes that used to surface at runtime, if at all:

| Rule                                                                            | Why                                                                                                               |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| a reducer of a `sync`/`localFirst` cell that dispatches to another cell or logs | it replays on the client, so both happen twice                                                                    |
| a `.tsx` file reading a `visible.exclude` field                                 | `.tsx` is client context by construction; the read throws when the component renders                              |
| a cell method called from `setTimeout`/`setInterval`                            | it escapes the action log, time-travel and cancellation — use `onInit`+`app.dispatch`, `onStart`, or `schedules:` |

If one fires on code that is deliberate, `// aiol-ok: <reason>` on the line
above suppresses it, as with every other rule.

## Retire

Nothing. No option, flag, export or spelling was removed in this release.
