# perfect-aio.md — the brave version

Written 2026-07-21 (v2 — you asked for the truly high-level pass: question
everything, tear down what deserves it). Every claim is backed by numbers from
our own repo and the 8 field reports. Simple language on purpose.

**The short answer: no, we are not "good."** The engineering is increasingly
excellent, but two of aio's five foundational bets are working against the
aspiration, and one whole layer of the framework is dead weight our own examples
don't use. Alpha is the only time to fix foundations. Here is the honest
examination.

---

## ✅ DECIDED — 2026-07-21 (reviewed together, one by one)

| #   | Decision                                                                                                                                                                                                                                                                       | Gate that must hold                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Delete the redux layer**; its 5 capabilities rebuilt method-native (listensTo, cancelOn+AbortSignal, until/race helpers, step breadcrumbs; machine → plain ifs)                                                                                                              | **Test-port gate**: every Style-B test ported to methods and green BEFORE deletion; any test that can't be expressed stops the deletion             |
| D2  | **Instance-scoped runtime** (default instance keeps the 4-line DX); binding one cell def to two instances throws loudly                                                                                                                                                        | **Parity gate**: full suite + all examples + field-app patterns behave identically                                                                  |
| D3  | **LOCAL-FIRST is the default model** — methods run locally everywhere; changes sync as patches; server = the authority that VALIDATES; server-only work = explicit typed `serverFns`                                                                                           | Auth design (patch validation) is the core work item                                                                                                |
| D4  | **SQLite-only persistence** (op-log + snapshots for all cells); KV path removed; auto-migration on first boot                                                                                                                                                                  | **Perf gate**: persist-write, boot-restore, size limits measured — ship only if equal-or-better on every metric                                     |
| D5  | **Core ~60 symbols + `aio/extras/*`** (nothing deleted; batteries included; looser stability label on extras)                                                                                                                                                                  | Core list MEASURED from real example/field-app imports; aiol prints the new path for old imports; examples+apps must compile with path updates only |
| D6  | **NO target tiers — full support matrix**: local browser/electron/android/cli/service + remote server/{browser, electron, unified-aio-client, android, cli, service}; platforms Linux/Windows/macOS/Android exactly; bar = small apps (counter/todo-class) flawless everywhere | Validation becomes MANDATORY release gates: off-box remote test, Windows+macOS smoke, one real-device android run                                   |
| D7  | **One typed, versioned wire envelope** for every message on every transport                                                                                                                                                                                                    | Version-gated by the `__proto` handshake                                                                                                            |
| D8  | **Keeps locked**: AIR renderer (feature-frozen, invariant-guarded) · Deno-only                                                                                                                                                                                                 | —                                                                                                                                                   |
| D9  | **One options object** — config validated once, passed by reference (no field-copying between layers); the dead 2-arg `aio.run(initialState, config)` overload deleted                                                                                                         | Every option gets a "does it arrive?" threading test (pattern: config-threading.test.ts)                                                            |
| D10 | **Migration is a product feature** — every breaking change ships with an `aiol` auto-fix where mechanical, a migration doc where not                                                                                                                                           | A breaking change without its fix/doc does not merge                                                                                                |
| D11 | **Rejected patches are always explainable** (D3 corollary) — reason surfaced to the developer (devtools/console) AND available to the app for UI feedback; silent rejection is a bug of the blank-screen class                                                                 | Part of the D3 design doc's hard requirements                                                                                                       |
| D12 | **Benchmark suite as CI infrastructure** — boot time, render, sync throughput, memory tracked across the restructure                                                                                                                                                           | "Correct but slower" fails the gate like a broken test                                                                                              |

Note: D6 **overrides** the "Trim 3 — target tiers" proposal below (rejected —
full matrix stays first-class; the validation debt becomes required work instead
of a tier label).

**D6 amendment (2026-07-21): the matrix is ONE SPINE, not 11 targets.**
Measured: the local browser/electron/android/service examples are an IDENTICAL 7
lines of app code (only the build flag differs); remote variants add 1–7 lines;
the browser↔browser-remote diff is 16 lines total. Binding rule: **every target
is a thin customization of one shared pipeline — duplicated per-target code is a
bug, not a target.** Known duplications to fold under this rule: AppImage
packaging (build-electron vs build-client), the electron cert-error block (×3),
UDS wire constants (server vs generated client). The full matrix is affordable
exactly because of this rule.

**Execution order:** B1 redux deletion → B2 instances → B3 local-first flip → B4
envelope + SQLite + surface diet → B5 full-matrix validation gates → beta.

---

## Part 0 — The verdict in one page

| Foundational bet                                                       | Verdict                                     | Why                                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1. Server-runs-your-methods (RPC) as THE default model                 | 🔨 **tear down** → local-first + sync       | 7 of 8 field reports hit the server/client boundary; a whole subsystem (graph validator) exists just to police it |
| 2. The redux-era layer under methods (actions/reduce/flows/middleware) | 🔨 **tear down** → methods + patches only   | 2,943 LOC; **0 of our 12 examples use it**                                                                        |
| 3. Cells as global singletons (module registry)                        | 🔨 **tear down** → instance-scoped runtime  | test-reset machinery everywhere; one app per process; `libraryMode` is a patch over it                            |
| 4. Custom renderer (AIR)                                               | ✅ keep — with eyes open                    | hardened through ~30 real bugs; a rewrite would discard exactly that history                                      |
| 5. Deno-only                                                           | ✅ keep                                     | it's _why_ the DX is clean                                                                                        |
| — 390 public symbols                                                   | ✂️ trim to a small core + extras tier       | perfection over 390 symbols is impossible; over ~60 it's a habit                                                  |
| — KV + SQLite dual persistence                                         | ✂️ reopen: SQLite-only                      | one engine, one mental model (risoto asked for exactly this)                                                      |
| — 10-target matrix                                                     | ✂️ tier it: 2 first-class, rest best-effort | focus is a feature                                                                                                |

Tearing down bets 1–3 is one coherent restructure, not three separate ones —
they fall together, and what remains is a smaller, simpler, harder-to-break
framework. Details below.

---

## Part 1 — The five bets, re-examined

### Bet 1 — "Your methods run on the server" (the RPC model) 🔨 TEAR DOWN

**The bet as made.** A cell's methods execute on the server; the browser sends
an action over WebSocket and renders the broadcast state. Optimistic UI hides
the latency.

**What the evidence says.** This created an invisible seam that our users trip
over more than everything else combined:

- **7 of 8 field reports** hit some form of it: `Deno is not defined` blank
  screens, server-only imports in the browser bundle, the `.server.ts`
  convention, "green locally ≠ works in browser" (machine U1 called it "the #1
  aio gotcha… inherent to the architecture").
- We built an **entire subsystem to police the seam** (graph-validator,
  server-dev-checks, the diagnostic page, aiol rules). Great engineering — in
  service of a boundary the model itself creates.
- The escape hatches multiplied: `scope: "client"` cells, `sync: true` cells,
  the standalone runtime (android/testUI). We effectively run **three
  consistency models at once**: RPC-dispatch (default), CRDT-sync (opt-in), and
  local-loop (standalone). Three models = three behaviors to keep equal — our
  dev==prod doctrine is a constant fight against this architecture.

**The brave alternative: local-first, sync-always.** Flip the default:

- Every runtime (browser, server, standalone) runs the SAME cell runtime, and
  methods **always execute locally** against local state.
- Changes propagate as **sync ops** (the CRDT engine we just hardened — it
  already works). The server is still the **authority**: it validates ops,
  rejects illegal ones, owns persistence, and is the arbiter of truth —
  server-authoritative stays, but as a _sync policy_, not a different execution
  model.
- Server-only work (DB, secrets, integrations) becomes an **explicit, named
  surface**: server functions the cell calls (`await server.charge(…)`) — the
  seam still exists, but it's _visible in the code_ instead of being an
  invisible property of imports. No more graph-validator guessing; the type
  system enforces it.

**What we gain:** the whole "blank screen" class dies structurally · offline is
free for every app · dev==prod becomes true by construction (there's only one
execution model) · the three runtimes collapse at the MODEL level (much deeper
than sharing code) · testCell/testUI test the real thing.

**What it costs:** the sync engine becomes load-bearing for everything (good
news: it's now our best-tested subsystem) · authorization moves from "server ran
the method" to "server validates the op" — a real design task · migration for
the RPC-style apps in feedback/.

This is the single decision that most determines whether aio can be "the best."
Every framework users love in this decade (Linear's sync engine, Figma,
Automerge apps) landed here. We already built 80% of it — we just haven't made
it _the_ model.

### Bet 2 — The redux-era layer 🔨 TEAR DOWN

**The bet as made.** Under the `methods:` sugar lives a full 2019-style
architecture: `actions:`/`reduce:`/`execute:` split, action creators, effect
creators, `machine:` guards, `listensTo`, generator flows
(`ctx.call/race/
all`), middleware.

**What the evidence says (measured today):**

- The layer is **2,943 LOC** (cell-compose-\*, flow-\*, factories, middleware).
- **Zero of our 12 examples** use actions-style, `machine:`, or `generators:`.
  All 12 are methods-only.
- No field report ever asked for it; several asked for _less_ wiring.
- It's why `cell()` needs two overloads, two payload shapes, dual catalogs —
  half of the duplication the complexity audit found exists to serve both
  styles.

**The brave alternative.** Methods + patches are the model. Period.

- A method mutates a draft → Immer patches → committed, broadcast, synced,
  persisted, time-traveled — **one currency of change** everywhere.
- Delete the public actions/reduce/execute/machine/flows/middleware surface.
  (Internals that earn their place — the scheduler, `listensTo` as a
  method-subscription — get re-expressed in method terms.)
- `cell()` becomes ONE shape. The docs table "which style to use" disappears
  because there is one style.

This deletes ~3,000 LOC of source, hundreds of tests that test the deleted
layer, several doc pages, and — most valuably — half of the _concepts_ a new
developer must hold. Breaking change, zero known users of the broken surface.

### Bet 3 — Global singleton cells 🔨 TEAR DOWN

**The bet as made.** `cell("counter", …)` registers itself in a module-global
registry; `aio.run()` binds whatever registered. Magic-feeling, and the magic is
real DX.

**What the evidence says.** Module-global state is why we have
`_resetCellRegistry()` + `_resetBrowserSync()` + `resetFlows()` +
`resetPending()` sprinkled through every test file; why two apps can't share a
process; why `libraryMode` had to be invented (tbd report B5) as a patch; why
test isolation is a discipline instead of a property.

**The brave alternative.** Keep the magic, scope the state:

- `cell()` returns a pure **definition** (it already mostly is one).
- An **app instance** owns the registry/runtime: `const app = await aio.run()`
  binds every imported cell to _that instance_ (the default instance keeps
  today's 4-line app working — zero DX change).
- Tests create throwaway instances; two apps in one process just work;
  SSR/workers stop sharing hidden state.

Mostly mechanical once Bet 2 shrinks the surface; the payoff is "hermetic by
construction" instead of "hermetic by reset discipline."

### Bet 4 — Custom renderer (AIR) ✅ KEEP — with eyes open

Honest accounting: if we started today, Preact + signals (3KB, decade-tested)
would have saved us the AIO-395..427 saga plus this week's surface-staleness
bug. That's the real cost of "own vdom," and it never fully ends.

**But tearing it down now would be the wrong kind of brave.** AIR is small, now
battle-hardened by exactly those bugs, and it's load-bearing for our best
differentiator — the semantic UI surface (testUI / `am surface` / `am trigger`
reach _into_ the renderer; doing that through a foreign vdom is strictly
harder). Verdict: keep, freeze its feature surface, and let the child-alignment
invariant + regression suite keep it honest. Revisit only if maintenance cost
trends up instead of down (it's currently down).

### Bet 5 — Deno-only ✅ KEEP

Single runtime = single install story, permissions model, std lib, compile
target. Every "support Node too" path leads to the compatibility swamp that
makes other frameworks miserable. The 4-line onboard exists _because_ of this
bet. Not negotiable until well past 1.0.

---

## Part 2 — Three trims (not tear-downs, but real decisions)

### Trim 1 — The 390-symbol public surface ✂️

Today: `.` exports **131 symbols**, `./air` **106**, total **390** across 16
entries. "Best framework" means every symbol is perfect, documented, and tested
forever. Over 390 symbols that's not a goal, it's a wish.

Proposal: define the **core** (realistically ~50–60 symbols: cell, aio.run,
signals, h/JSX, router, testCell/testUI, sync config, schedule) and move the
periphery (react-island, compat, virtual-list, transitions, time-travel panel,
vitals internals…) to a clearly-labeled `extras` tier with a looser stability
promise. Bet 2's deletion gets us a third of the way for free.

### Trim 2 — Persistence: SQLite only ✂️ (reopens a locked decision — deliberately)

Today plain cells persist to Deno KV, sync cells to SQLite — two engines, two
mental models, and KV's API is still unstable upstream. With patches as the one
currency (Bet 2) the natural store is **one SQLite op-log + snapshots for
everything** — which is also exactly what the local-first model (Bet 1) wants,
and what risoto asked for ("SQLite as first-class default"). I know Deno.Kv was
a locked decision; the local-first pivot is the new fact that justifies
reopening it.

### Trim 3 — Target tiers ✂️

Ten targets are built and CI-smoked, but only browser + electron have field
mileage. Naming **browser + desktop as tier-1** and android/cli/remote as tier-2
("built, CI-tested, best-effort until field-validated") is honesty that focuses
effort — not a retreat. The off-box remote test (one afternoon, two machines)
can promote remote whenever we choose.

---

## Part 3 — What "perfect aio" looks like (if we're brave)

**One sentence:** _Cells that run everywhere, syncing patches through a server
that validates them — nothing else to learn._

```
   your cells (methods only — ONE style)
        │  mutate a draft
        ▼
   Immer patches            ← the ONE currency of change
        │
        ├─ apply locally    → UI updates instantly (no round-trip)
        ├─ sync op          → server validates → peers converge
        ├─ persist          → SQLite op-log + snapshots (ONE store)
        └─ time-travel      → same patches, replayed

   server functions (explicit, typed)  ← the ONLY server/client seam,
                                          visible in code, enforced by types
   app instance (no globals)           ← hermetic tests, multi-app, SSR
   one wire envelope (typed, versioned)
   ~60-symbol core + extras tier
```

What a new developer must learn: **cell, method, selector, server function,
sync**. Five concepts. Today it's roughly fifteen.

And the doctrine stays: fail loud · dev==prod (now structural, not enforced) ·
surface earns its LOC · field reports drive quality.

## Part 4 — Two roadmaps, one recommendation

**Conservative (v1 of this doc):** unify the three binding paths, patches as
currency, one envelope, config collapse — all _inside_ the current model. Solid,
low-drama, and it leaves Bet 1's seam (our users' #1 pain) in place forever.

**Brave (this doc):**

| Step | What                                                   | Includes from v1                   |
| ---- | ------------------------------------------------------ | ---------------------------------- |
| B1   | Methods + patches only; delete the redux layer (Bet 2) | "patches as currency"              |
| B2   | Instance-scoped runtime (Bet 3)                        | "one runtime core" — falls out     |
| B3   | Local-first default + server functions (Bet 1)         | dev==prod, offline, kills the seam |
| B4   | One wire envelope; SQLite-only store; surface diet     | v1's #3/#4 + trims                 |
| B5   | Off-box remote validation; then beta gate              | —                                  |

**My recommendation: the brave path, in that order.** B1 and B2 are almost pure
deletion + scoping (weeks, not months, with our gate suite). B3 is the big one —
but it's the difference between "a very good framework with a famous gotcha" and
the actual aspiration. We have 80% of B3's machinery already built and freshly
hardened (the sync engine). Zero external users means the breaking-change cost
is as low as it will ever be. It only gets more expensive from here.

If you veto B3, do B1+B2+B4 anyway — they're right under either model.

## Part 5 — What survives every re-examination

Cells as the unit · server as the authority (whatever the execution model) ·
fail-loud + dev==prod doctrine · the semantic test surface (testCell/testUI/ am)
· the 4-line onboard + source-first distribution · the gate suite · the
field-report loop · Deno-only · AIR (eyes open).

That list is the actual identity of aio. Everything else is implementation — and
implementation is allowed to die for the aspiration.

---

_The engineering-level findings (binding triple, wire sprawl, config threading,
server-ws split, sync legacy cursor) from v1 remain valid; under the brave path
they become sub-steps of B1–B4 instead of standalone projects. Evidence trail:
session memories `aio-complexity-audit`, `aio-feedback-closure`,
`aio-sync-cursor-audit`; numbers measured 2026-07-21: legacy layer 2,943 LOC ·
0/12 examples use it · 390 public symbols (131 in `.`, 106 in `./air`) · 7/8
field reports hit the server/client seam._
