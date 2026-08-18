# Review sweep — refused, and why

Items from the six field reports that were **not** implemented. Two kinds:
findings that did not survive verification, and asks that were declined on the
merits. Everything else is in [`resolved.md`](resolved.md).

A report being wrong about a cause is not a report being wrong about a problem.
Where a refuted finding still points at real pain, the entry says where that
pain was actually fixed.

---

## Refuted on verification

### `--port` was silently ignored (`impactnews` IN-2)

> *"Launched as `--client=server-only --port=8199`. The app started, reported
> healthy, and `am instances` showed it on port 63881."*

Not reproducible on alpha60. Measured:

- `parseCli(["--client=server-only", "--port=8199"])` → `{ port: 8199 }`.
- A real boot logs `port 8199 (flag)` and serves on 8199.
- A port **collision** is fatal and loud (`AddrInUse` → refuse to start), not a
  silent rebind. Confirmed by starting a second app on a taken port.

63881 is in the ephemeral range `findFreePort()` picks from, which runs only
when no port was resolved — so the flag never reached that process, or the
reading was of a *different* instance. Which is exactly IN-2's real neighbour:
`am` guessed an appId from the cwd and answered about the wrong app. **That is
fixed** — see `resolved.md`, "Runtime and CLI".

The space-separated form `--port 8199` does not parse, and warns
("unknown flag ignored: --port"). If that was the invocation, the warning was
correct and the report's example was reconstructed.

### The dev server served stale bytes (`impactnews` IN-3)

> *"`curl …/style.css | grep map-wave` returned 0 against a file that contained
> it. Only a restart picked up the change."*

Not reproducible in dev. The dev path reads from disk **on every request**
(`serveFile` → `Deno.readTextFile`), and the transpile cache is keyed on the
file's *contents*, so it cannot serve a stale body. Measured: edited
`style.css` under a running server, `curl` returned the new bytes immediately.

The reproducible version of this complaint is a **prod** server, which serves
`dist/` — a build artifact — while the developer edits `src/`. That is correct
and it was invisible, which is the part worth fixing: the server now says so
when the source is newer than the artifact it is serving. The reporter's
sentence stands as the reason ("the file you edited is not the file being
served" is a silent failure with a long debugging tail).

### `testUI` is not exported (`quant`)

> *"quant's 3 UI test files deep-import `src/testing/ui-test.ts` and
> `src/air/vdom-types.ts` past the API lock."*

All four symbols are on the locked public surface and are in
`docs/api-snapshot.json`:

| Symbol | Entry |
| --- | --- |
| `testUI`, `TestUIOptions` | `aio/testing` |
| `ComponentFn`, `VNode` | `aio/air` |

The deep imports are unnecessary and can be replaced without any change to aio.

---

## Declined on the merits

### Ship `JSX` as a global namespace (`modelinfo` M-2)

Implemented, measured, reverted. `declare global` in a published module fails
JSR's fast-check ("global augmentations are not supported"), and
`deno publish --dry-run` is a release gate — so the ambient version trades a
convenience for the ability to publish. A `.d.ts` outside the exports map
passes the gate but is then unresolvable for consumers, which is worse than
the import it replaces.

Taken instead: the reporter's own alternative. `JSX` is re-exported from `aio`
(so it autocompletes off the specifier every app already has), and every
scaffold template annotates its component so a new app carries the line from
line one. The 23-errors-on-first-check experience is gone; the import is not.

### Per-field / selector-level cell subscriptions (`atomic`)

> *"One cell = one signal. Reading any field subscribes to the whole cell, so
> panning re-rendered the board on every mousemove."*

Real, correctly diagnosed, and too large for this sweep — it is a change to the
reactivity model, not a fix. Recorded rather than half-done: a partial
implementation of subscription granularity is how the "why did this re-render?"
class of bug gets *harder* to reason about, not easier.

The documented remedy (split cells) does fight wanting one coherent undoable
state, and that tension is real. It belongs on the roadmap with a design, not
in a review pass.

### "Cut before 1.0, don't add" (`quant` #6)

> *"Park sync/CRDT (zero consumers), the never-executed OS targets, and
> possibly the ui-kit… A 1.0 smaller than alpha60 would be the most credible
> release note the changelog could carry."*

The argument is strong and the observation behind it is correct: quant imports
~3% of 464 public symbols, and surface without demand is real maintenance drag.
It is also a **product decision about scope**, not a defect — the kind that
should be made deliberately with the whole roadmap in view, not folded into a
sweep whose other 40 items are bug fixes. Left standing as the strongest
open question for the beta cut.

Note that this sweep moved the number the wrong way (474 public symbols now).
Most of the additions replace something an app had to hand-roll — `onGlobalKey`,
`useAio().ready`, `onRestore`, `$commit(ms)` — which is the argument *for*
them, and exactly the argument quant is warning about. Worth weighing when the
cut happens.

### A specifier-level server boundary — `import { io } from "server:./io.ts"` (`fixable`)

> *"`.server.ts` is a naming convention doing load-bearing work… rename a file
> and the browser bundle silently gains Deno APIs until `aiol` runs."*

The diagnosis is right and the fix is now covered from the other end: the
**bundler** fails the build on a static server-only import in the client graph,
naming the file. That closes the "silent until a separate tool runs" gap
without inventing a specifier scheme, which would be a new vocabulary for every
app to learn and every editor to not understand.

### Prove big-state performance — 72h soak, many-client load (`quant` #4)

Correct, and genuinely not addressed here. A soak is infrastructure and time,
not a code change, and claiming it without running it would be exactly the
"claim without a test" pattern the project treats as disqualifying. Unresolved,
honestly.

---

## Noted, no action needed

- **`am snapshot save/load` is not mentioned near the `access` docs**
  (`impactnews`) — it is the wrong tool for "call one method" anyway, and
  `am dispatch --as-server` is now the right one. The denial message names it.
- **A `describe()` / intent string on `cell()`** (`impactnews`) — cheap and in
  the spirit of `t`, but it is a new public field whose only consumer is a
  human reading `am state`. Held against the inclusion razor; worth doing if a
  second use appears.
- **`testgen(App)` typed clients as the documented default** (`t2v`) — already
  documented (`docs/testing/ui-testing.md` § "Typed clients"); the string-proxy
  form stays because it needs no build step.

---

# Late addendum — Risoto (deferred with reasons, not refused lightly)

- **RIS-3 prod-parity test mode** — the report's own #1, and the right call:
  five of its six multi-day bugs were the harness being wired differently from
  production (worker pool off, no serialization hop, no client-context replay).
  This is a real harness architecture project — a mode where values must
  round-trip a structured-clone boundary even in-process — not a sweep item.
  Roadmapped in todo.md as the top testing item. What alpha61 already moved:
  real `document`/`window`, and the per-target export-parity gate.
- **RIS-4 first-class async-I/O shape** (`io:` methods / `$job`) — API design
  with real alternatives (method kinds vs a primitive vs a lint). The lint
  half has a start (the `$live` hazard rule); the API belongs in a design
  round with `transaction`/`long`/`cancelOn` on the table together.
- **RIS-1 heartbeat** ("still running (slow)" pings) — wants the method runner
  to own a timer per in-flight call; deferred with the honest-message fix in
  place. Releasing the serialize mutex on timeout is REFUSED outright: the
  mutex holder is still writing, and a second writer is the corruption the
  mode exists to prevent.
- **RIS-5a/6 db:/persist granularity** (object-shaped `db:` mapping,
  row/field-level dirty tracking) — the "quant big-state" item again, now with
  a second consumer paying it. Genuinely the largest open design debt;
  roadmapped, and saying otherwise in a release note would be a claim without
  a test.
- **RIS-7b shape-drift root cause** — the dedup half is fixed; the drift
  itself ("a key from the initial full state disappears from the merged view")
  needs the wallet's repro. With subscription filtering, an unsubscribed
  cell's absence is expected and would look exactly like this — root-causing
  without the session is guesswork. Flagged for pairing with the reporter.
- **RIS-10a `am trigger` timeout on one machine** — second report of the
  IN-4 shape; still not reproducible here. Needs that machine.
