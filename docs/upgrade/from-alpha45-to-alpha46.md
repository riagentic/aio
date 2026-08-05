# Upgrade: alpha45 → alpha46

alpha46 is a **bug-hunt release**: no new capability, 27 real defects closed.
Three adversarial passes over persistence, the state core, and the server/auth
surface — each finding reproduced before it was fixed — plus the framework's own
fuzzers swept far wider than CI runs them.

**Most apps need no changes.** Five behaviours change observably. Four of them
only affect code that was already broken; the fifth affects your dev tooling.

## 1. `am` and amui need the local control credential (dev tooling)

`/__aio/trojan/*` — the endpoint `am state`, `am dispatch`, `am sql`,
`am surface`, `am stop` and all of amui use — was reachable with **no
credentials at all** on an app running `auth: true`. Anonymous local callers
could read raw unfiltered state, dispatch actions, run SQL and replace the whole
state. In `users:` mode, any non-admin token could do the same.

It is now gated in every auth mode. So that this does not lock you out of your
own app, a dev app mints `<data>/control.key` at boot — 256 bits, mode `0600`
inside the `0700` data dir, fresh each boot, deleted at shutdown. `am` reads it
automatically.

**You do nothing.** If `am` cannot read it you get a refusal naming the file and
distinguishing "no credential" from "a stale one". The authority is owning the
machine, not membership in the app — which is why it is deliberately not the
shareable app key.

New: **`am pair`** issues a fresh single-use pairing PIN without restarting the
app. (The docs told you to run it; it did not exist.)

## 2. `ui.forUser` fails CLOSED

A filter that throws — or returns a non-object — used to fall back to "the
structural filter result". With `ui: { forUser }` alone there is no structural
filter, so that fallback was **the whole cell**. One missing field on a user
record leaked every row to every client.

The cell is now **omitted** from that client's state instead, and the error is
logged loudly. Omission can never expose more than the filter would have
returned. If a cell silently disappears from your UI, check the log — you have a
bug in your filter that was previously leaking.

This also applies to user-less channels (UDS, `am state`, amui).

## 3. `sync` + a hiding `ui` filter is refused at boot

A cell with `sync` (or adopted by `localFirst`) whose `ui` hides anything —
`forUser`, `include`, `exclude`, `"none"` — now **throws at compose time**,
naming the cell and the conflict.

It was silently replicating every op's payload to every peer, so the filter
applied to state frames and not to the data itself. This is not a missing
feature: convergence requires every replica to see every op, so a per-user view
cannot survive replication. Choose one — drop the filter, set `sync: false` for
that cell, or move the private fields into a server-only cell. `localFirst` now
declines to adopt a filtered cell instead of enrolling it silently.

## 4. `key:` + `auth:` + `--expose` refuses at boot

The two gates were irreconcilable and the app booted anyway with the key gating
nothing: the login flows require a public shell, and a key presentable only as
`?token=` never reaches `/App.tsx` or your bundle. Pick one auth model.

## 5. A broken migration refuses to boot (instead of deleting your data)

An `onMigrate` that throws used to reset the cell to defaults — and the
debounced persist then wrote that empty slice **over your stored data**, so a
fixed build found nothing left to migrate. Boot now refuses, nothing is written,
and the error reaches your `onError` (it previously could not, due to an
initialization-order bug that threw inside the error path itself).

Related, all silent before:

- A **rollback** no longer re-stamps versions downward, so rolling forward no
  longer re-runs `onMigrate` over already-migrated data. A verbatim copy of a
  downgraded slice is parked at `__downgraded:<cell>`.
- `onMigrate` now receives the stored fields a rename migration needs to read.
- Switching `persistMode` **migrates** the stored document instead of booting
  empty and stranding it.

## `db:` now binds to a cell's field

`db:` table names addressed the root state namespace, which under the cells API
is the cell-id namespace — so a `db:` key either collided with a cell (hard boot
error) or silently did nothing forever. `examples/contacts`, the shipped CRUD
example, did not boot.

A `db:` key now names the array it stores:

| key          | binds to                                                           |
| ------------ | ------------------------------------------------------------------ |
| `contacts`   | the array field of the one cell declaring it (`contacts.contacts`) |
| `nfts.items` | that cell and field, explicitly                                    |
| ambiguous    | boot error naming both cells and the dotted fix                    |
| no match     | SQL-only table, with a warning naming the candidates               |

## Quieter, safer

- Dictionary keys that name `Object.prototype` members (`toString`, `valueOf`,
  `constructor`, …) survive a restart. They were silently dropped — user-keyed
  records lost exactly those entries on every boot.
- A cancelled `transaction: true` method no longer commits its stale write-set
  **after** the winner, and `s.$commit()` no longer phantom-conflicts with its
  own publish (it was unusable on any cell holding arrays or objects).
- `cancelOn` now reaches calls queued behind `serialize: true` — "Stop" stops.
- A `listensTo` handler's single effect return is no longer dropped.
- A `BigInt` in state no longer kills the process from an observe-only
  diagnostics hook.
- Revoking a session now **closes** its live WebSocket; a stale session cookie
  no longer locks the real user out of login for five minutes; a submitted
  `Origin` can no longer self-certify by claiming to be localhost.
- `db.execute()` rejects a multi-statement string instead of silently running
  only the first; a table row beyond 2^53 names the table and column.
- The journal keeps mode `0600` across compaction.
