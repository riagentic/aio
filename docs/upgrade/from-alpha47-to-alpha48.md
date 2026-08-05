# Upgrade: alpha47 → alpha48

A third bug-hunt release: 19 defects across **observability** and the **client
transports**. No new capability, nothing removed from the public surface.

**No code changes required.** Four behaviours change observably; each fixes
something that was already wrong.

## 1. A client with a skewed clock is no longer cut off

The server measured a client's liveness by subtracting a timestamp the
**browser** produced from its **own** clock. Any offset past 2 seconds
classified the client "frozen" — and frozen clients are skipped in _every_
broadcast. The offset is constant, so it never recovered; the socket stayed open
and pings kept being answered, so nothing looked wrong from either side. A clock
running _ahead_ made the gap negative and silently disabled the freeze watchdog
altogether.

Liveness is now stamped from one clock, structurally: the functions that record
it take no timestamp at all. Your client still computes RTT on its own clock
from the echoed ping.

## 2. A rejected call is no longer delivered anyway

All three clients settled a call as **failed** while its frame was still sitting
in the offline queue — a queue that survives the disconnect and flushes on
reconnect. One user intent produced one rejection _and_ one application, and the
rejection message actively said "the action is not resent automatically",
inviting a retry that applied the write twice.

Now: a disconnect rejects only calls whose frame was actually written; a
discarded queue rejects its callers and says so. The message matches reality in
both cases.

If your app retries on rejection, that retry is now correct rather than a
double-apply.

## 3. Async and transactional writes are recorded

An async method commits through an internal action type that every observability
sink filtered as noise — but it is the only record of what the method actually
did. Consequences, all fixed:

- **Journal replay lost them.** After a crash, recovery reconstructed the state
  as of the method's _call_, while logging "recovered N action(s)".
- **`am timeline` reported `"diff": []`** for actions that changed everything.
- **Time travel landed on states the app never had**, and an undo/redo pair
  could permanently destroy a committed write.

If you use `journal: true`, `am timeline`, or time travel with async or
transactional methods, they now tell the truth.

## 4. `redactActions` + `journal: true` no longer bricks a restart

A redacted action was journalled with its payload replaced, then re-reduced at
boot — so the method ran with no arguments. With the documented config this made
`aio.run` **reject**, and the journal tail persisted, so every restart failed
identically until someone deleted the file by hand.

A redacted entry is now a refusal marker: replay skips it and reports exactly
which types and sequence range could not be reconstructed. Boot never fails.
`am replay` refuses those rows, and `am record` emits a commented gap instead of
an unreproducible line.

## The offline queue is in memory (the docs said IndexedDB)

The browser client's durable offline queue was **never wired** — roughly 1 050
lines implementing it were unreachable from every client entry point, while four
doc pages promised IndexedDB persistence with a 24-hour TTL. An offline edit was
lost on reload, silently.

The dead code is removed and the docs now say what is true: the queue is **in
memory and lost on reload**, capped at 1000 actions. Queueing while offline logs
it once and every discard rejects its callers with a count, so the loss is
visible rather than silent.

Making the docs true instead would require server-side de-duplication of
replayed actions — without it, durable replay trades a known loss for a silent
double-apply. That is a larger change and belongs in its own release.

Two subsystems that _were_ reachable have been reconnected: `ui.showStatus`
toggles a real connection widget again, and client-side `degraded()` escalations
now reach `/__aio/health`.

## Smaller, all previously silent

- A return value that survives the wire **lossily** is now reported per path —
  `Date`→string, `Map`/`Set`→`{}`, `NaN`→`null`, `-0`→`0`, dropped `undefined`
  members. It warns rather than rejects: the method already ran and committed.
- A **sync** method returning `null` resolved `undefined` while the async one
  resolved `null`. Both now resolve `null`.
- `connectCliUDS` asks for a resync when a patch fails to apply (it previously
  froze silently and forever), reports over-cap discards immediately with the
  real reason, and works when `bind` is destructured off the handle.
- `am cost` no longer inflates every per-second figure once its ring buffer
  wraps.
- The diagnostic checkpoint is `0600` and honours `redactActions` — it was
  world-readable in the log directory people attach to bug reports.
- The action log enforces `max` while the app runs, not only at shutdown.
- A `Date` field changing is visible in the timeline diff.
