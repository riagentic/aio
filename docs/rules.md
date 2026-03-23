# AIO Framework Rules

Mandatory rules for correct AIO framework usage. Format: `AIO[N]` — one rule per
line, compact and enforceable.

---

AIO1 All app logic MUST live in features created via feature('name', {...}) — no
loose state, no ad-hoc logic outside features

<!-- Feature is the atomic unit of AIO. Everything flows through it — state, methods, machines, persistence. Bypassing it breaks composition, persistence, time-travel, and UI sync. -->

AIO2 State MUST only be mutated inside methods (sync/async) or reduce handlers —
never directly from outside

<!-- The dispatch loop (beforeReduce → machine guard → reduce → execute → broadcast → persist) is what makes state observable, persistable, and UI-synced. Direct mutation breaks all of it. -->

AIO3 Single entry point: aio.run({ appId, features: [...] }) — no manual store
creation, no manual server setup

<!-- aio.run() wires everything — composition, dependency resolution, persistence, UI server, IPC. Manual setup skips critical initialization steps. appId is mandatory and must be in aio.run(), not deno.json — compiled builds don't have deno.json at runtime. -->

AIO4 UI components MUST access state via useFeature(ref) or useAio() hooks —
never import or read state directly

<!-- These hooks subscribe to the reactive broadcast loop. Direct state reads get stale instantly — no re-renders, no sync, no delta updates. -->

AIO5 Cross-feature communication MUST use direct method calls or listensTo —
never raw dispatch with string action types

<!-- Direct calls are typed, observable, and routed through the dispatch loop. String-based dispatch bypasses type safety and is invisible to machines/middleware. -->

AIO6 All bound feature methods return Promise — use await for synchronization
outside of sync methods

<!-- Sync methods (reducers) can call other methods fire-and-forget (queued, FIFO order guaranteed). Async methods, effect handlers, and external callers can await any method for synchronized execution. Sync methods cannot await (JS language constraint) — this is correct: reducers should be fast and non-blocking. See ISSUE-2. -->

AIO7 Sync methods (reducers) MUST NOT contain side effects — only state
mutations and fire-and-forget dispatches

<!-- Sync methods run inside Immer produce(). State mutations (s.x = y) are immediate on the draft. Cross-feature calls (other.reset()) are queued, FIFO order guaranteed, but state NOT updated inline. No fetch, file I/O, or timers in sync methods — use async methods or execute handlers for those. -->
