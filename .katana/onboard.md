# Onboard experience

- there is just one good perfect onboard experience, `am` (aio manager) should
  be used for it, see further points
- one curl command should download and install am (and deno 2.9 if needed), put
  am in path and make it universally accessible
- one curl command (`run.sh`) should take ANY aio app source — the cwd or a
  `--git`/`owner/repo` link — to a RUNNING production build with zero questions:
  install whatever is missing, clone, `am fix` the checkout, build the default
  target, run the artifact (`--dev` for the dev server). The artifact is found
  by timestamp, never by name, so the script cannot drift from the framework's
  naming rules. Pinned by `tests/run-sh-e2e.test.ts` in
  `deno task test:onboard`.
- to create new aio project, there should be just `am create my-new-project,
  which should create simple counter app, basically (almost) empty app to start
  building aio framework

## am create

  - `am create` crates minimial counter aio app, that is executable (deno task
  dev) and buildable into binary (deno compile)
  - `am create` build that can be be built also as android or electron app without
  any issues (just one deno task line)
  - ``am uninstall` gracefully uninstalls am as if it has never been there (it
  will not touch existing aio applications, though)
  - `am update` updates am to latest version

## The agent benchmark (every release)

"Intuitive" is measured, not claimed (feedback F3): a FRESH agent that has
never seen aio gets one fixed task and the framework checkout, nothing else.

- The task, verbatim: *"Build a small notes app with aio: add a note, list the
  notes, delete a note, and the notes survive a restart. Then run it and show
  me it works."*
- Safe by construction: a `git clone` of the release commit in a scratch dir
  (never the working tree), `AIO_APPS_DIR` isolated, the browser target with no
  `--open` (no window on the maintainer's desktop), `taskset` to ≤14 cores.
- It must build against the commit under test: `am create` pins the INSTALLED
  release, so either run after the release is installed (`am update`), or tell
  the agent to create with `--mirror=<the clone>`. (The first run, 2026-09-19,
  measured v1.0.5-beta for exactly this reason.)
- Measured from its own command log (`HH:MM:SS <cmd>` per command), not from
  its memory of what it did.
- **Pass:** app running and reachable ≤ 3 min after the first command ·
  `deno task check` green in ≤ 2 tries · zero reads of the framework's `src/`
  · all four behaviours verified by driving the app.
- Every friction point it reports (exact error text) is a finding, fixed or
  written down — that list is the valuable output, the numbers are the trend.
- The numbers go in the release notes. Three releases in a row passing with no
  new feature added is F3's "done".

| date       | framework   | running | check tries | src reads | behaviours | notes                                               |
| ---------- | ----------- | ------- | ----------- | --------- | ---------- | --------------------------------------------------- |
| 2026-09-19 | v1.0.5-beta | 56 s    | 1           | 0         | 4/4        | pass; 3 findings fixed (lint appId, create, README) |
| 2026-09-20 | v1.0.6-beta | 68 s    | 1           | 0         | 4/4        | pass; 5 findings, the real one: no headless UI client, so `am trigger` is unreachable when a window may not open (todo.md) |
