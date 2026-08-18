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
