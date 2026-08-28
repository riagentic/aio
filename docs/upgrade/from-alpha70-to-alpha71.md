# Upgrading from alpha70 to alpha71

**Nothing in your app code breaks.** alpha70 was the last compatibility break;
this release is what alpha70's own promise looks like when it is checked: every
artifact says which build it is, the installer stops carrying that version into
the file it installs, and the field report against alpha70 is worked to zero.

```sh
am pin --latest && am fix   # or: deno task upgrade
```

## What changes without you doing anything

### Your app has a version, and it is derived

`deno.json` `"version": "1.2"` is the one place a version lives; the build
number is the repository's commit count, so the same commit always builds
`1.2.345`, a dirty tree builds `1.2.345-dirty.<hash8>`, and no repository builds
`1.2.0-nogit.<hash8>` with a loud note. `--version`, the boot line,
`/__aio/health`, the WS hello and the update manifests all print that one
string. See [versioning](../build/versioning.md).

- A three-part `"version": "1.0.0"` is treated as a PIN and used verbatim — the
  build says so once. Write `"1.0"` to let aio number the builds.
- `aio.run({ appVersion })` was retired in alpha70; the registry names the fix.

### Artifacts carry the version; the installed file does not

```
dist/notes-1.2.345-x86_64.AppImage          what the build writes
~/app/notes/versions/1.2.345/notes.AppImage what the installer writes
~/app/notes/notes.AppImage → versions/…     the stable name (menu entry, alias)
```

The installed file keeps the app's own name because a compiled binary derives
its identity — and therefore its data directory `~/.notes/` — from the name it
runs under. If you have a script that copies an artifact out of `dist/` by hand,
copy it as `<app><ext>` and put the version in a directory; the one-liner
(`run.sh` / `run.ps1`) already does.

- **Windows**: the installer moves from a flat `<app>-<version>.exe` to the same
  `versions/<version>/<app>.exe` layout the updater and the pruner read. An app
  installed by an older `run.ps1` keeps working; re-run the one-liner to move it
  onto the layout that can roll back.
- `deno run -A src/build.ts --print-install-name=<file>` answers the naming rule
  if you script around it — do not re-derive it.

### The build refuses less, and catches more

- A CommonJS dependency in the client graph no longer fails the build:
  `require`/`module` in a `"cjs"` input are esbuild's to supply. A module-scope
  Node global (`Buffer`, `process`, …) that a shim defines first is a note; a
  bundle that actually throws at load is refused, naming the module and line.
- Dev bundles, audits AND evaluates the prod client graph on boot (~80 ms,
  cached), so a blank-page-at-load is a dev refusal rather than a shipped
  artifact.
- `deno task build` and `deno task check` share one decider; the escape hatch
  for a server-only import is a dynamic import **of a `*.server.ts` module**,
  which is what the builder always enforced.

### Electron: a renderer that throws is in the log

Every renderer `console.error`, `render-process-gone`, `preload-error`,
`unresponsive`, `did-fail-load` and a 15 s empty-`#root` watchdog reach the
framework log at error level. `AIO_ELECTRON_PROTOCOL=1` runs dev through the
packaged `aio://` shell.

## Known and deliberate

- `renderBudget` is accepted and not read; it says so.
- `am surface` / `am trigger` on a **production** build answer that the control
  API is dev-only — they no longer report "no UI client connected" for a window
  that is rendering.

## Retire

| workaround you may have                                                    | fixed in    | what to do now                                                                    |
| -------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| A hand-written version constant kept in step with `deno.json`              | **alpha71** | delete it — read the derived version (`appVersion()` on `aio/server`)             |
| A script that renames a built artifact before installing it                | **alpha71** | drop it — `run.sh` / `run.ps1` install `<app><ext>` under `versions/<version>/`   |
| `am installed` ignored because the "versions kept" count was always absent | **alpha71** | trust it — the rollbacks are counted where they live                              |
| `// aio-ok: node-global` sprinkled to get a CommonJS dependency to build   | **alpha71** | remove it if the bundle loads — the evaluation decides, and it cannot be silenced |
| A parallel error channel for renderer failures in a packaged Electron app  | **alpha71** | drop it — the renderer's errors are in the framework log                          |
