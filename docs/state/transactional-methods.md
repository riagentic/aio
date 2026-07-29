# Spec: Transactional cell methods (risoto #2)

Status: **SHIPPED** — opt-in `transaction: true`; this page is the contract, not
a proposal. Conflict detection (§4) is the part that makes it safe rather than
merely stable. Tests: `tests/transactional-methods.test.ts`.

## 1. The problem

Today a **sync** cell method is already atomic: it runs entirely on one Immer
draft and Immer finalizes it as a single commit. An **async** method is not.
Under the hood an async method runs against a **live proxy** (`createLiveProxy`)
whose reads resolve `getState()` — the _current committed_ state — plus a
read-your-writes overlay of its own pending writes, and whose writes are
**batched and dispatched incrementally**.

Consequences risoto hit repeatedly (all real, all silent):

- **Every `await` is a commit point.** A read after an `await` sees whatever
  other actions committed while the method was suspended — not the state the
  method started from.
- **The gather-then-merge dance is folklore.** The documented workaround is
  "capture what you need before the first `await`, then merge fetched data into
  the _latest_ `s.*` after it" — enforced by an aiol hint and littered with
  `// aiol-ok` markers.
- **Interleaving corrupts derived writes.** `s.total = s.items.length * price`
  computed after an `await` can be based on an `items` another action changed.

## 2. Goals

1. Inside a transactional method, **reads see a stable snapshot** taken at
   method entry — no `await` ever changes what a read returns.
2. **Writes commit atomically at method return** — one batch, all-or-nothing —
   never interleaved with other actions mid-flight.
3. Provide **`s.$commit()`** for the rare deliberate mid-method publish.
4. **Kill the read-after-await class**: the aiol `reads s.* after an await` hint
   and every `// aiol-ok: commit-point` marker become unnecessary for
   transactional cells.

## 3. Non-goals / constraints

- **Opt-in.** Existing async methods keep today's live-read semantics unless the
  cell (or method) opts in. No behavior change for anyone who doesn't ask.
- **Sync methods are unchanged** — already atomic.
- Must compose with: schedule/own effects returned from methods, cancellation
  (`s.$signal` / `cancelOn`), sync cells (CRDT op-log), persistence + the #3
  journal (a transactional commit is one action → one journal entry).

## 4. Semantics (snapshot isolation)

A transactional method executes at **snapshot isolation**:

- **Snapshot.** On entry, capture an immutable snapshot `Σ` of the state the
  method can read. Every read (`s.x`, cross-cell selector reads) resolves
  against `Σ` + the method's own pending writes (read-your-writes). `getState()`
  is **not** consulted again until commit.
- **Writes.** Mutations accumulate in a private write-set `W` (the batcher).
  Nothing is visible to other actions until commit.
- **Commit.** On normal return, `W` is applied as **one** atomic `__set` batch —
  a single reducer action, a single broadcast, a single journal entry.
- **`s.$commit()`.** Flushes `W` now (atomic), then continues with a _fresh_
  snapshot `Σ'` for subsequent reads. Rare; for methods that must publish
  progress mid-flight.
- **Abort.** If the method throws or is cancelled (`s.$signal`), `W` is
  **discarded** — no partial commit (matches the sync-method doctrine already in
  cell-methods-internals.ts).

### Concurrency

Two transactional methods on the **same cell** must not lose writes. A commit
applies the write-set on top of the _latest committed_ state, but the method
_read_ from `Σ`. Rules:

- Writes are **key-level last-writer-wins at commit time** (the batch applies
  mutations to current state, like today's `__set`), so disjoint writes from two
  concurrent methods both land.
- A method that computes a new value **from a snapshot read** and writes it back
  (read-modify-write) would lose a concurrent update — the classic lost update.
  **It is detected at commit and refused** (see below), never applied quietly.
- Default: **no implicit serialization** (keeps throughput); opt in per cell
  with `transaction: { serialize: true }` to run this cell's transactional
  **async** methods one at a time (a per-cell mutex) when RMW correctness
  matters. The mutex does **not** hold off sync methods — those are reducers and
  commit whenever they are dispatched, including mid-`await`.

### Conflict detection — what makes the isolation honest

Pinned reads are the feature; committing a value _derived_ from a pinned read
that someone else has since changed is a bug. So the write-set is validated
against live state at every commit point, exactly as an optimistic-concurrency
store does. Two levels, matching what the cell asked for:

| config                             | isolation          | validated at commit                                                                 |
| ---------------------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `transaction: true`                | snapshot isolation | **read-modify-writes**: a write whose path was also read, and has moved since entry |
| `transaction: { serialize: true }` | serializable       | the above **plus every read** — so a guard can never be silently inert              |

A **blind write** (`s.loading = false` — written, never read) is
last-writer-wins by intent and never conflicts.

On conflict the whole write-set is discarded and the call **rejects** with a
message naming the path. Set `transaction: { conflict: "warn" }` to report and
commit anyway; there is no option to do neither.

```
[wallet] refresh(): s.adjustedAt was changed by another action while this
transactional method awaited, and its reads are pinned to entry — committing
would overwrite that change with a value computed from stale state. Read
through s.$live to work from current state, retry the call, or set
transaction: { conflict: "warn" } to commit anyway.
```

This is the risoto 2026-07-28 bug, verbatim: a balance `refresh()` guarded on a
field that the synchronous `adjust()` writes during the fetch. The guard read a
pinned value, so it could never fire; the refresh committed pre-send balances
over the user's transfer and stamped them confirmed. Same code today rejects the
refresh and leaves the transfer intact.

### `s.$live` — reading current state on purpose

The one sanctioned way out of the snapshot. `s.$live.balance` reads state as it
is **now**; writes through it still join the transaction's atomic commit, and
its reads never count as stale (they are current by construction).

```ts
async refresh(s) {
  const quote = await fetchQuote();
  if (s.$live.adjustedAt !== s.adjustedAt) return; // a transfer landed — stand down
  s.balances = quote.balances;
}
```

Use it for a deliberate re-read after an `await`. If you find yourself reaching
for it everywhere, the cell probably wants `transaction` off.

## 5. API surface

```ts
cell("wallet", {
  state: { ... },
  // (a) whole-cell opt-in — all async methods are transactional:
  transaction: true,
  // (b) or tuned:
  transaction: { serialize: true, conflict: "abort" }, // conflict defaults to "abort"
  methods: {
    async transfer(s, to, amount) {
      const from = s.balances[me];      // reads Σ
      if (from < amount) throw new Error("insufficient"); // W discarded
      const quote = await fetchQuote();  // Σ unchanged across the await
      s.balances[me] = from - amount;    // writes W
      s.balances[to] = (s.balances[to] ?? 0) + amount;
      // commit here, atomically, on return
    },
  },
});
```

`s.$commit()` and `s.$live` are available on the method state proxy in a
transactional cell.

## 6. Implementation plan (phased, each independently shippable + tested)

1. **Snapshot source.** Capture `Σ` = a frozen deep copy (via the existing
   `snapshotForRead`) of the **full** state at method entry, cached for the
   call. Reads resolve `Σ` + pending `W` instead of `getState()` + `W`. (A later
   optimization can make `Σ` copy-on-read/structurally-shared to avoid cloning a
   large store per call; correctness first.)
   - Change: `createLiveProxy` gains a `mode: "live" | "snapshot"`; in snapshot
     mode `effectiveRoot()` overlays `W` on the captured `Σ` instead of
     `getState()`. Everything else (nested proxies, iteration, read-your-writes
     memo) is unchanged.
2. **Deferred commit.** In `buildMethodsExecutor`'s `__exec` path, a
   transactional method's batcher **buffers** instead of dispatching per flush;
   on the method's promise resolving, flush **once**. On reject/abort, drop the
   buffer. (`createBatcher` gains a `deferred` flag; the executor flushes on
   settle.)
3. **`s.$commit()`.** A method-visible function that flushes the buffer now and
   re-captures `Σ`. Exposed on the proxy like `$signal`.
4. **`serialize`.** A per-cell async mutex around `__exec` for transactional
   cells that set it; methods queue.
5. **aiol.** For a `transaction: true` cell, suppress the
   `reads s.* after an
   await` hint (it's the point) and flag stray
   `// aiol-ok: commit-point` markers as removable.
6. **Docs + migration.** This page + `docs/state/methods.md`; the
   read-after-await section notes the transactional alternative.

## 7. Testing plan

- **Snapshot isolation:** method A reads `s.x`, `await`s while action B commits
  a new `s.x`, reads `s.x` again → **same value** (Σ), and A's write lands on
  top of B's at commit (disjoint keys preserved).
- **Atomic commit:** other clients/actions observe **zero** intermediate states
  — exactly one broadcast/patch for the whole method (assert one `__set`).
- **Abort:** throw mid-method → no committed change. Cancel via `s.$signal` → no
  committed change.
- **`s.$commit()`:** intermediate publish is visible; post-commit reads see Σ'.
- **`serialize`:** two concurrent RMW increments → no lost update.
- **Conflict:** without `serialize`, two concurrent RMW increments → exactly one
  rejects and the winner's value stands (never a quiet `n === 1`); a blind write
  from two overlapping calls never conflicts; under `serialize`, a guard reading
  a field a sync method wrote mid-`await` rejects the transaction; `s.$live`
  reads are exempt; `conflict: "warn"` commits and logs.
- **Compat:** a non-transactional async method is byte-identical to today (the
  full existing suite stays green — the whole feature is behind the flag).
- **Journal (#3):** a transactional commit is exactly one journalled action;
  boot replay reconstructs it.

## 8. Risks + rollout

- **Cost:** full-state snapshot per transactional call clones the store.
  Mitigate with copy-on-read later; document that `transaction: true` suits
  correctness-critical cells (a wallet's balances), not hot high-frequency
  cells.
- **Lost updates** on concurrent RMW without `serialize` — documented, with
  `serialize: true` as the fix.
- **Rollout:** ship phases 1–4 behind `transaction`, default off. Only after the
  full suite is green under the flag do we recommend it. No default flip until
  it has soaked in a real app (risoto's `unlock`/`transfer` cells).

---

_This is the design contract. Implementation lands in phases against it, each
with the tests in §7; nothing changes for non-opt-in cells until then._
