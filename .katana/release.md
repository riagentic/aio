## Pre-release katana

- `deno fmt` shows no issues
- `deno check` shows no issues
- `deno lint` shows no issues
- `deno test` shows no issues
- `deno task api:check` passes — public surface unchanged or deliberately
  regenerated
- `deno task docs:check` passes
- `deno task boundaries` passes — src/ module dependency matrix respected
- `deno publish --dry-run` succeeds
