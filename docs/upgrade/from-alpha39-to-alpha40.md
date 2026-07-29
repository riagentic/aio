# Upgrade: 1.0.0-alpha39 → 1.0.0-alpha40

**No code changes required, but this release makes several previously silent
situations loud.** Nothing was renamed and nothing was removed; the wire
protocol is unchanged (alpha39 and alpha40 interoperate). What changed is that
bugs which used to pass quietly now stop you — in dev and in tests first, which
is the point.

Read section 1 if you use `transaction: true`, section 2 if you use
`ui.exclude`, and section 3 before you run your suite.

## 1. A transactional method aborts on a conflicting commit

Only affects cells with `transaction: true`.

`transaction` pins reads at method entry — that is the feature. The consequence
was invisible: a field a SYNC method wrote during your `await` stayed invisible
to the running async method, so a guard on it could never fire and a
read-modify-write committed over the newer value with nothing said.

Every commit now validates the method's write-set against live state:

| setting                            | isolation    | what is checked                            |
| ---------------------------------- | ------------ | ------------------------------------------ |
| `transaction: true`                | snapshot     | read-modify-writes (read a path, write it) |
| `transaction: { serialize: true }` | serializable | every path the method read                 |

A blind write (`s.loading = false` — written without reading it) is
last-writer-wins by intent and never conflicts.

On conflict the call is **rejected** with a message naming the path, and nothing
commits:

```ts
cell("wallet", {
  state: { balance: 0 },
  transaction: true, // conflict: "abort" is the default
  methods: {
    async transfer(s, amt: number) {
      const from = s.balance; // read…
      await bank.send(amt);
      s.balance = from - amt; // …then write ⇒ checked at commit
    },
  },
});
```

Two ways to keep the old outcome, both explicit:

- `transaction: { conflict: "warn" }` — commits anyway, and says so loudly.
  There is no option to do neither.
- `s.$live` — read current state on purpose, outside the pinned snapshot. Writes
  through it still join the atomic commit.

```ts
async refresh(s) {
  const fresh = await api.balance();
  if (s.$live.balance !== s.balance) return; // someone else moved it
  s.balance = fresh;
}
```

**If your app is a wallet, a ledger, a counter or a queue, expect to see this
fire.** That is the update it was silently losing.

## 2. Reading a `ui.exclude`d field from the client throws in dev

A field hidden from the browser used to read back as `undefined`, which
type-checks as the field's declared type — so a lock screen asking "does a vault
exist?" got `undefined` forever and behaved as if none did.

- **dev and every test harness**: the read throws at the site.
- **production**: unchanged — `undefined`, with the same one-time warning.

The fix is to expose what the UI actually needs as a derived, non-secret field:

```ts
state: { vaultKey: "", hasVault: false },
ui: { exclude: ["vaultKey"] },   // hasVault is derived server-side and safe
```

## 3. The dev browser is now dev-strict

`__aioDev` — frozen state so a component mutation throws at the site, the
readonly hint, the hidden-field guard — used to be set only by the test
harnesses. The dev page shell sets it now (never production).

Nothing about your app changed; the tripwires that already fired in tests now
fire in the browser you develop in. If a component mutates cell state directly,
you will see it immediately instead of in a later, stranger form. Production is
untouched.

## 4. One timeout for `await cell.method()`, and an honest message

`effectTimeoutMs` bounded the effect tracker while a **second, hardcoded 30s**
bounded the caller — so raising it left the caller giving up on schedule, a
setting that looked like it worked. Both sides now resolve from the same
numbers:

```ts
await aio.run({ cells, effectTimeoutMs: 60_000 }); // caller waits 60s too
await aio.run({ cells, effectTimeoutMs: 0 }); // wait indefinitely
// per method:
perfBudget: { methods: { "import:run": { timeout: 300_000 } } }
```

The error also stopped inventing a cause. It no longer claims the executor
crashed; it says what is true — the **call** gave up, the **method** did not, it
is still running and its writes will still commit, only the return value is
lost.

## 5. New: `localFirst` (opt-in)

```ts
await aio.run({ cells, localFirst: true });
```

Every server cell then runs its methods where the caller is and travels as CRDT
ops; the server re-runs each op and stays the authority, so guards, `access` and
`validate:` decide exactly what they decide today. `sync: false` is the per-cell
opt-out for anything whose optimistic preview would be a lie (auth, a ledger).
Boot logs exactly which cells were adopted.

The default is still server-authoritative round-trips. It stays opt-in until a
real local-first app reports back.

## 6. New: `degraded()` — best-effort subsystems can't fail forever in private

```ts
import { degraded, degradedReport } from "aio";

const cache = degraded("nft-cache"); // module-level; same name ⇒ same tracker
const hit = await cache.guard(() => db.query(sql)); // undefined on failure
```

After N consecutive failures (5 by default, `{ after }` to change it) it
escalates **once** — one structured event, not per-occurrence spam — and once
more on recovery. `/__aio/health` reports `status: "degraded"` and names them,
because an app claiming to be healthy while a feature is dead is exactly the
failure that endpoint invites.

aio's own sync layer was the first user: every browser CRDT sync frame was a
`.catch(() => {})`.

## 7. Also worth knowing

- **A restore that erases seeded state says so.** A persisted empty list
  replacing a declared non-empty one (a curated registry wiped by an old
  profile) is now reported at boot with the fix, by the same shape-drift
  detector. Silent for the cases where nothing is lost.
- **Offline-queue honesty.** A write that will not survive a reload says so, and
  a queue that replays but fails to clear says it will replay again.
- **The cell-binding triple is gated.** Any `__aio` key client code reads must
  be produced by the browser stub too, or carry a written exemption — the
  fix-one-forget-the-others bug that shipped twice (`asyncMethods`, sync config
  without its reducer) now fails the suite instead.
- **Binding a cell no longer reads your state.** All three binding paths asked
  "does a method own this name?" with `typeof def[key] === "function"`, which
  invokes the installed accessor — so binding read `ui.exclude`d fields and
  subscribed whatever reactive context happened to be current. The question is
  about shape, and is now answered from the property descriptor.
