# Targets

> Scope: these are the tasks a **scaffolded aio app** exposes (what `am create`
> generates into the app's `deno.json` — see `src/am/am-cmd-create.ts`), NOT the
> framework repo's own `deno.json` (which has no app to build). Test the task
> list against the scaffold generator's task map.

One vocabulary (alpha52): the scaffold ships ONE `dev` task (runtime flags pass
through) and ONE build pipeline (`build` = every target in deno.json
`build.targets`; `compile` = the same pipeline narrowed to the default target,
recorded in deno.json `"client"`). There is no per-target task matrix — a target
name (`server`, `server-app`, `browser`, `electron`, `android`, `cli`,
`electron-client`, `android-client`, `ios-client`, `cli-client`) is the one
spelling, shared
by `build.targets`, `--targets=`, and the manifest. The headless role is spelled
`server` (never `service`); `server-app` is its twin that also serves its own
page (both emit a systemd unit beside the binary).

- you can build server application
- you can build electron application
- you can build browser application
- you can build android application
- you can build cli application
- you can build remote application (server + thin clients)
- you can build unified aio client

## Dev

  - default dev, whatever the default target is: `deno task dev`
  - any other shell is a FLAG, not a task: `deno task dev --client=browser`,
  `--client=electron`, `--client=cli`, `--client=server-only`
  - exposed (LAN/remote server side): `deno task dev --expose`
  - electron thin client / connect page: `deno task dev --connect`
  - cli thin client against a running server: `deno run -A src/client.ts`
  - android dev in an emulator: the android-default app's `deno task dev` (the
  emulator orchestrator); other apps run `deno run -A <aio>/dev-android`

## Production builds

  - default production build: `deno task compile` (→ `dist/` + manifest.json)
  - the declared fleet: `deno task build` (deno.json
  `"build": { "targets": [...] }`)
  - any one-off target: `deno task build --targets=<name>` — names: `server` ·
  `server-app` · `browser` · `electron` · `android` · `cli` ·
  `electron-client` · `android-client` · `cli-client`
  (`deno task build --list`)

## Migration

  - the pre-alpha52 matrix (`dev:<target>`, `compile:<target>`, `dev:remote:*`,
  `compile:remote:*`, `*:service` spellings) is retired;
  `am fix --migrate-tasks` converts an app and never deletes a user-customized
  task
  - deno.json `target` (the default-shell key) is spelled `client`; the old key
  still works with a boot hint, and `am fix` / `aiol --safe-fix` rewrite it
