# Common Pitfalls

The traps people actually hit — each with the rule that avoids it. Honest by
design: if something here bites you and isn't listed, that's a bug in this page
— report it.

Many of the entries below are one question read wrong: **which context is this
code in?** aio has one syntax and six places it executes.
[Where does this code run?](where-code-runs.md) is that map, in one table.

## State & cells

**Inferred appId follows your project name.** Zero-config apps derive their
identity (locks, `state.db` path) from `deno.json` `appId`/`title`/`name` or the
directory name — rename any of those and the app starts with FRESH state (the
old data files still exist under the old id). Pin `appId` in `deno.json` (or
`aio.run({ appId })`) before you have data you care about.

The chain is the same one the build names the binary with, so `deno run` and the
compiled artifact resolve the **same** id — compiling never moves your data
directory. (It used to: the build read `title` and ignored `appId`, so an app
that pinned `appId` got one id in dev and another once compiled.)

**Cell names are wire/persistence identity.** `cell("counter", …)` — the string,
not the variable, keys the persisted state, the action prefix
(`counter:increment`), and the registry. Renaming it orphans persisted state
(bump `version` + `onMigrate` instead).

**One cell definition binds to one app.** A `cell()` def can't be shared by two
running apps in one process (tests boot/reset the runtime for you). Need the
same shape twice? Use a factory returning `cell(name, …)`.

**Sync methods mutate the draft; the return value is for effects.** Returning
data from a sync method doesn't "set state" — mutate `s`. Return values are
reserved for schedule/own effects (`return schedule.after(…)`).

**Async methods batch writes — but reads are read-your-writes.** `s.count++`
inside an async method dispatches at the next microtask, and reads through `s`
see your pending writes (`s.history.push({cpu: s.cpu})` pushes the value you
just set). What you read is exactly what commits.

**Don't hold state snapshots across `await`.** `const items = s.items` then
`await …` then `items.push(…)` mutates a stale copy. Re-read from `s` after
every await — it's always current.

**Guard lines silently no-op.** A method starting with
`if (s.status !== "idle") return` does nothing in any other state — by design.
If a method "randomly doesn't work", check its guard against the current
`status` field first (`t.expect.state((s) => s.status === …)`).

## Persistence

**Everything persists by default.** `persist: "all"` is the default — caches,
derived data, session junk included. Opt out per field
(`persist: { exclude: ["cache"] }`) or per cell (`persist: "none"`).

**Everything broadcasts by default.** Same for `visible: "all"` — every
connected client sees the whole cell. Secrets need `visible: { exclude: […] }`
(dot-paths reach into arrays: `"accounts.encSecKey"`), `forUser`, or
`visible: "none"`. Boot warnings flag secret-looking exposed fields — don't
ignore them.

**`include` is top-level only.** `include: ["a.b"]` warns and matches nothing.
Deep paths are for `exclude`.

**Schema changes need a version bump.** Changed the state shape? Persisted state
deep-merges with defaults, which covers additions — but renames and type changes
need `version: N` + `onMigrate`. Bumping `version` without an `onMigrate` boots
with a loud warning (the old shape is kept as-is). Running an **older** build
against data a **newer** build wrote (stored version > code version) is a
downgrade: boot warns loudly and keeps the state untouched rather than silently
misreading moved/renamed fields — re-deploy the newer build, or add an
`onMigrate` that down-converts.

Boot also detects **shape drift** without any version machinery: if stored data
holds a field your cell's `initialState` no longer declares (a rename/removal
you forgot to bump `version` for), boot warns and `deno task am migrations`
lists it — `deepMerge` would otherwise keep the stale value and you'd read it
forever. `initialState` is the declared shape; the drift check diffs storage
against it.

## Scheduling & effects

**Schedule ids replace.** Two schedules with the same `id` — the later one wins.
That's the feature (self-rescheduling pollers); it bites when you reuse an id
accidentally. Boot warns on static/dynamic id collisions.

**Self-referencing methods need a return annotation.**
`poll(s): Promise<CellEffect>` when the method schedules itself
(`metrics.poll.action()`) — otherwise TypeScript's self-inference guard (TS7022)
fires.

## Sync (`sync: true`)

**The server converges; the client view is provisional.** Merge strategies
(`counter`, `set-add`, …) shape what the _local user sees during the conflict
window_; the next ack/snapshot rebase replaces it with the server outcome.

**Set items need stable ids.** `set-add`/`set-remove` throw on items missing the
identity field (default `"id"`, per-field override via `identity`).

## UI & testing

**The harnesses are as strict as production, deliberately.** `testCell`,
`testUI`, `bootCells` and `testServer` all run dev-strict: an illegal in-place
mutation throws, a refused write rejects the method that made it, `own` effects
really acquire and dispose, and app directories are redirected into a temp
sandbox so no test can write into your real `~/.<appId>`. A green test means
what production means. If you find a case where a harness is more permissive
than `deno task dev`, that is a bug — report it.

**The state is right and the DOM is stale.** A read subscribes only while a
component body, a `computed()` or an `effect()` is running — so a read you
deferred (inside `onMount`, a timer, a `.then()`, after an `await`) tracks
nothing and nothing warns. Nesting is never the cause: a read inside a ternary,
a fragment, a `.map()` or a helper you call is still inside the body. The full
rule, and the checklist for a stale UI, is
[Reactivity — what is tracked, and where](../ui/reactivity-tracking.md).

**Content-derived names change with copy.** `SubmitButton` came from the text
"Submit" — reword the button and long-lived `am` scripts break. Pin stable
handles with `t="save"` or `data-testid`.

**One `t` can name two things.** `t` on an element names that element; `t` on a
component is a rename-proof handle for the component — and aio's own kit
forwards `t` down (`<Button t="Home">`), so the same string often addresses
both. `present`/`absent` resolve the element first and take a kind when you need
to be explicit: `ui.absent("image-negative", "element")`.

**Actions queue; observations await.** In `testUI`, actions need no `await`
(ordered queue), but reads (`.text`, `.value`) are instant snapshots — after
un-awaited actions, observe through `await ui.settle()` / `expectCell` /
`waitFor` first.

**Forms don't navigate.** AIR auto-prevents the default on handled submits. If
you _want_ native form submission, add `data-native-submit`.

**A green test suite does not check the bundle boundary.** Cells run server-side
under `deno task test`, where a server-only import (`@std/path`, `Deno.*`) is
legal — the suite stays green while the browser bundle is broken. That class is
`deno task lint`'s (aiol's) job: it reports the whole transitive chain
(`App.tsx → cell.ts → disk.ts:5`) with the fix. Run **both** before shipping;
neither alone is the "means what production means" gate for this.

## Config

**Unknown config keys are boot-fatal.** `validateConfig` exits with the full key
table rather than silently ignoring typos — a misspelled key is a stopped app,
not a mystery. (The allowlists are gate-tested against the typed config, so
documented keys always validate.)

**`deno.json` needs the magic lines.** `jsx`/`jsxImportSource`,
`nodeModulesDir: "auto"` — `deno task doctor` checks all of them; run it first
when anything is weird.
