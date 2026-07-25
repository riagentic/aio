# Upgrade: 1.0.0-alpha35 → 1.0.0-alpha36

Purely additive. **No code changes are required** — nothing was removed or
renamed, and the wire protocol is unchanged (alpha35 and alpha36 interoperate).
Two behaviours change on their own, both in your favour; everything else is
opt-in.

## 1. Bump the pin

```jsonc
// deno.json
{
  "imports": {
    "aio": "https://raw.githubusercontent.com/riagentic/aio/v1.0.0-alpha36/mod.ts"
  }
}
```

## 2. What changes without you doing anything

- **Dev warns at one frame.** The default reduce budget is now 16ms in dev (prod
  stays 100ms). If a method takes longer, you'll see `BUDGET_REDUCE` named by
  cell and action — throttled to one report per action type per 10s. That's
  information, not a failure; the app behaves exactly as before. Override with
  `perfBudget: { reduce: 100 }` if you'd rather not hear about it yet.
- **A client action's broadcast no longer waits out the throttle window.** Your
  own actions round-trip faster (a keystroke used to pay up to
  `syncIntervalMs`); background churn still coalesces as before. Nothing to
  configure.
- **Editing a cell file restarts the dev app** instead of warning you to. Set
  `AIO_NO_DEV_RESTART=1` to keep the old behaviour.

## 3. Optional: pay the upgrade tax with a command

```sh
deno task lint:aio            # report every deprecated spelling
deno run -A aiol/mod.ts --safe-fix   # rewrite the pure renames
```

Fixes `call({ timeout })` → `timeoutMs`, `--cert`/`--key` → `--tls-cert`/
`--tls-key`, and a build-only `--headless` on a task that _runs_ the app →
`--client=server-only`. Nothing renamed is ever removed inside a major, so this
is ergonomics, not an emergency.

## 4. Optional: give a heavy cell its own thread

If a cell's methods can take seconds — report building, image/document
processing, parsing untrusted input, FFI, crypto loops — flag it:

```ts
export const reports = cell("reports", {
  worker: true, // ← runs this cell's methods on their own thread
  state: { status: "idle", rows: [] as Row[] },
  methods: {
    async build(s, raw: number[]) {
      s.status = "building";
      s.rows = crunch(raw); // seconds of CPU — everyone else keeps running
    },
  },
});
```

Before flagging one, check the constraints — they fail loudly at boot, but it's
cheaper to know now:

- no `scope: "client"`, `sync`, `listensTo`, `machine` or `selectors` on that
  cell (and `own()` inside its methods is refused at runtime)
- args and return values must be structured-cloneable
- module singletons are per-worker — a module-scope DB connection gets a second
  instance in that thread
- **don't flag a small cell**: you'd pay a clone per action to isolate something
  that can't block

Full guide: [state/cell-workers](../state/cell-workers.md).

## 5. Optional: fix an import map that predates this release

If your app was scaffolded before alpha36, its `deno.json` probably maps only
`aio`, `aio/air`, `aio/jsx-runtime` and `aio/testing` — so
`import { createDB } from "aio/db"` fails with "not in import map". `aiol` now
reports that as an error and `--safe-fix` adds the mapping.

## 6. Heads-up: `aiol` no longer counts documented cells

Extraction reads real code only, so a `cell("x")` inside a doc comment or a code
generator's template literal is no longer counted (and no longer produces a
phantom `duplicate cell name` error). Your cell count may drop; that number is
now the true one.

## 7. Two behaviours you may have worked around

- **Method return values reach browser clients** (since alpha34's ack transport,
  verified again here). If you built "report the outcome from the server via a
  toast/state field" workarounds, `const r = await cell.method()` now just works
  — and a new lint flags the older habit of reading `cell.field` right after the
  await.
- **A cell-dependent inline `style={{}}` is reactive.** It froze at mount in an
  early version, and the warning outlived the fix; if your app converted working
  inline styles to classes "because aio freezes them", that constraint is gone
  (pinned by tests on both read paths).

## New in the public API

`worker` (cell config), plus everything already listed in the alpha35 guide.
