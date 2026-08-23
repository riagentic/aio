# Upgrading from alpha63 to alpha64

Nothing in your app code changes. Two behaviours change, and both change toward
what the words already said.

## `am` learned that a project can be more than one app

If your repo declares several runnable things — labelled build targets with
their own entries — `am` now treats them as **components of one project**:

```jsonc
// deno.json
"build": {
  "targets": {
    "relay":   { "kind": "server",   "entry": "src/relay/app.ts" },
    "agent":   { "kind": "electron", "entry": "src/agent/app.ts" },
    "control": { "kind": "electron", "entry": "src/control/app.ts" }
  }
}
```

```sh
am start                 # starts all three
am start agent           # …just that one
am stop                  # stops the project
am status                # one line each; exit 0 only when every one is up
am state --app=agent     # every other command takes the label through --app
```

**If your repo is a single app, nothing changes** — including a repo whose
targets are the array form (`["server", "electron"]`) or whose object-form
targets share one entry. That is one app built for several shells, and it
behaves exactly as before. Components require **distinct entries**.

Two things are new for multi-entry repos:

- **A command that acts on ONE app now refuses to guess.** `am state`,
  `am logs`, `am metrics` and friends used to resolve the _project's_ inferred
  id — which is not any component's id and never runs — and then reported "no
  app named … is running". They now name the components and the flag that picks
  one.
- **Each component needs its own identity.** `aio.run({ appId: "relay" })` in
  each entry. If two resolve to the same id, `am` refuses and says which: they
  would share one lock file, one data directory and one port. A component that
  declares no `port` gets a free one from the runtime, exactly as
  `deno task dev` does; `am status` lists what each one bound.

## `ui.theme: "none"` now means none

It documented "nothing at all, not even the variables" and still shipped aio's
two-rule box-model baseline (`*{box-sizing:border-box}`, `body{margin:0}`). Now
it ships nothing: no look, no variables, no baseline.

- **If you set `theme: "none"`**, you inherit the browser's own defaults again,
  including `body{margin:8px}` — the white frame the baseline removes. That is
  the correct trade when you are bringing an existing stylesheet (`border-box`
  on `*` silently re-lays-out a sheet written against `content-box`), and the
  wrong one otherwise. To keep the baseline and drop only the look, use the
  default (`"tokens"`) instead.
- **Every other setting is unchanged**, including the default.

## Also in this release

- `renderBudget` now says at boot that it is **not honoured yet** — client
  render vitals lost their wiring in alpha48 and have not been reconnected. The
  key is still accepted and its shape is stable; nothing about your app changes
  except that the framework stops letting a dead key look live. Server-side
  vitals are unaffected.
- A refused build no longer leaves its artifact behind: re-running a command
  that just refused re-runs the guard instead of reporting `dist/app.js cached`
  and packaging the unvalidated bundle.
- `deno task fmt` exists (it was the one gate without a task), `check:matrix` is
  the new name for `validate:matrix`, and `update:api-ref` for `docs`. The old
  names still work.
