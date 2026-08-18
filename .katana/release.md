# Pre-release katana

Gates (must pass):

- `deno fmt` shows no issues
- `deno check` shows no issues
- `deno lint` shows no issues
- `deno test` shows no issues
- `deno task test:onboard` passes — real install→create→dev→compile E2E
- `deno task test:build` passes — real artifact E2E: every compile target's
  binary boots from a FOREIGN cwd and serves, the fleet `dist/` + manifest
  describe real working files, and data assets (.wasm) load inside the binary. A
  build that "succeeds" while shipping a broken artifact must fail here
- `deno task check:api` passes — public surface unchanged or deliberately
  regenerated
- `deno task check:docs` passes
- `deno task check:boundaries` passes — src/ module dependency matrix respected
- `deno publish --dry-run` succeeds
- `deno task lab` passes — the onboarding lab: the REAL one-liners
  (`install.sh`, `run.sh`) on a fresh ubuntu container with no deno, no unzip
  and a non-root user, ending in an app whose UI actually renders. Every other
  onboarding test runs on THIS machine, where deno is current and the framework
  is already checked out, so none of them can fail the way a stranger fails.
  Needs docker/podman; `check:release` reports it as SKIPPED when absent rather
  than passing quietly
- all tests and UI tests pass without isssues
- all errors and warnings in logs are resolved (not hidden but trully resolved)

Release surfaces (must be updated, not just the code — checked, not assumed):

- the version string is identical in `deno.json`, `src/server/aio-cli.ts`
  (`VERSION`), and the README badge — none left on the previous version
- `CHANGELOG.md` has a dated entry for this exact version
- an upgrade guide `docs/upgrade/from-<prev>-to-<this>.md` exists and is listed
  in `docs/upgrade/README.md`
- `docs/content.md` is regenerated (`deno task update:docs` leaves no diff) so
  new docs/examples are indexed
- `docs/api-snapshot.json` is regenerated when the public surface or VERSION
  changed (`deno task update:api`)
- any new example/app is listed AND described in `examples/README.md` (one
  README covers all examples — per-dir READMEs are deliberately not the
  convention)
