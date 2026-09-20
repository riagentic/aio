// journal.ts — durable action journal + replay.
// The persistence layer snapshots full state on a debounce; a SIGKILL / power
// cut in that window loses the tail. An append-only JOURNAL closes it: every
// committed action is appended (one line), and on the NEXT boot the actions
// after the last snapshot are replayed on top of it — exact state, no loss.
//
// Durability: each append is a synchronous write, so it survives PROCESS death
// (SIGKILL). Set `sync: true` to fsync every append for power-cut durability
// (slower). Replay is by re-reducing — state transitions only, effects dropped —
// so it never re-runs I/O.
import {
  isRedactedAction,
  noRedaction,
  REDACTED,
} from "../diagnostics/redact.ts";
import type { Redactor } from "../diagnostics/redact.ts";
import { runWithUser } from "./auth-context.ts";
import type { AioUser } from "./aio-types.ts";
import { log } from "../diagnostics/logger-api.ts";
import { stringifyWithIssues } from "./persist-guard.ts";
import type { PersistIssue } from "./persist-guard.ts";
import { WORKER_PATCH_ACTION } from "../state/cell-compose-reduce.ts";

/** The cell a `worker: true` cell's patch batch belongs to, when `type` is one.
 *
 *  A worker cell's method runs in its own isolate and never reaches the main
 *  dispatch; only the patches it commits do, as `__aioWorkerPatch` with the
 *  cell in the PAYLOAD. Every sink that decides by the `cell:` prefix of the
 *  type — the journal filter, the timeline, the redactor — therefore saw a
 *  type that belongs to no cell and dropped it as framework noise: a
 *  `journal: true` app with a worker cell never even created its journal, and
 *  a SIGKILL lost that cell's acked writes. This is the one place that reads
 *  the owner off such an entry. */
export function workerPatchCell(
  type: string,
  payload: unknown,
): string | undefined {
  if (type !== WORKER_PATCH_ACTION) return undefined;
  const cell = (payload as { cell?: unknown } | null | undefined)?.cell;
  return typeof cell === "string" && cell !== "" ? cell : undefined;
}

/** Must a worker patch batch lose its payload? Its ops ARE the values the
 *  method stored, and no method name rides with them (the worker streams
 *  patches, not calls) — so an exact `redactActions: ["vault:unlockWith"]`
 *  cannot be matched against the batch. The redactor's CELL half answers it
 *  instead: a cell with any redacted action has its state withheld, which is
 *  the safe direction (a withheld batch is skipped at replay, and said). */
function redactsWorkerPatch(
  redact: Redactor,
  type: string,
  payload: unknown,
): boolean {
  const cell = workerPatchCell(type, payload);
  return cell !== undefined && redact.redactsCell(cell);
}

/** The store row that holds a SYNC cell's journal watermark.
 *
 *  A `sync: true` cell is not in the KV snapshot — its durable record is the
 *  CRDT snapshot a server-origin write is folded into, on its own clock (up to
 *  500 ms after the write). So the app-wide watermark cannot say whether a sync
 *  cell's journalled write is on disk: it is written with the KV snapshot, not
 *  with the fold. Each sync cell keeps its own, written INSIDE the fold's
 *  transaction (`ServerSyncHandler.setFoldWatermark`), so "the snapshot holds
 *  up to seq N" is true exactly when that snapshot is. */
export const syncJournalWatermarkKey = (appId: string, cell: string): string =>
  `${appId}:__journal_wm:${cell}`;

/** What a compaction dropped, recorded beside the journal (`<journal>.base`).
 *
 *  The store's watermark says what the DATABASE holds; the journal file alone
 *  cannot say what it no longer holds. The two only disagree when the database
 *  went BACK in time — `checkIntegrityOnBoot` restored `state.db.snapshot`, or a
 *  file was copied over it — and then the tail after a hole was replayed onto
 *  the older state as if nothing were missing: `withdrawAll()` re-reduced on a
 *  balance of 50 recorded a withdrawal of 50 that never happened. `wm` is the
 *  app-wide watermark the last compaction dropped up to, `cells` each sync
 *  cell's. Written BEFORE the compacted journal replaces the old one, so it
 *  never claims less was dropped than really was. */
export type JournalBase = { wm: number; cells: Record<string, number> };

/** The replay refusal a rolled-back database earns — see {@linkcode JournalBase}. */
export type JournalGap = {
  /** `"actions"` for the app-wide stream, else the sync cell's id. */
  stream: string;
  /** The journal no longer holds entries up to this seq. */
  droppedThrough: number;
  /** …while the database says it holds only up to this one. */
  storeAt: number;
};

/** The store row that holds a journal's watermark.
 *
 *  The watermark used to live in a `<journal>.wm` side file written AFTER the
 *  snapshot transaction committed — so a kill in between replayed actions that
 *  were already in the snapshot (replay RE-REDUCES; it is not idempotent, and a
 *  `deposit` applied twice is money), and a failed `.wm` write was swallowed by
 *  a bare `catch {}`, after which every later boot replayed a growing
 *  already-applied tail, silently, forever. Both were reproduced.
 *
 *  As a row in the same SQLite file, the watermark is written INSIDE the
 *  transaction that writes the snapshot it describes: the two are true at the
 *  same instant or neither is. */
export const journalWatermarkKey = (appId: string): string =>
  `${appId}:__journal_wm`;

/** The journal line a time-travel jump writes (`goto`/`undo`/`redo`).
 *
 *  A jump assigns live state directly — no action runs — so it used to reach
 *  NO durable sink: the journal tail after it described actions taken on the
 *  jumped-to state, and boot replayed them onto the PRE-jump snapshot.
 *  Measured: eight `inc(1)` (22, snapshotted), `goto` after the third (17),
 *  `resume`, `inc(100)` (117), SIGKILL — the restart came back at 122, a state
 *  the app never had. The line carries the persisted fields of every cell as
 *  they are after the jump, so replay restores them in seq order exactly where
 *  the jump happened. Journal lines are appended in commit order on one
 *  thread, so no action can land between the jump and its line.
 *
 *  The method half starts with `__`, so every reader that skips
 *  framework-internal actions (replay-test generation, `am replay`) skips it
 *  without being taught a new type. */
export const TT_RESTORE_TYPE = "aio:__timeTravel";

/** The payload of a {@linkcode TT_RESTORE_TYPE} line. */
export type TimeTravelRestore = {
  /** The command that moved state (`goto`, `undo`, `redo`). */
  cmd: string;
  /** The history id, for `goto`. */
  arg?: number;
  /** Cell id → the persisted top-level fields after the jump. A field the cell
   *  keeps out of the store (`persist: { exclude }`, `persist: "none"`) is not
   *  written here either — the journal must not hold what the store refuses to. */
  cells: Record<string, Record<string, unknown>>;
};

/** Where an action came from, as the journal records it.
 *
 *  `input` — dispatched from OUTSIDE the dispatch loop: a client, the trojan
 *  API, server code, a schedule declared at boot. `effect` — dispatched while
 *  an earlier action's effects were running, or later by something those
 *  effects started: a timer it set, its async body, a `$do` — and what a
 *  cell's `onInit` dispatches, which boot re-creates the same way. Replaying the
 *  cause produces an `effect` action again, so `am replay` must not send it a
 *  second time (a `later(4)` that schedules `inc(4)` replayed as +9, not +5).
 *  Boot recovery re-REDUCES every line with effects dropped, so it needs both.
 *  Absent on journals written before this field existed. */
export type ActionCause = "input" | "effect";

export type JournalEntry = {
  seq: number;
  type: string;
  payload?: unknown;
  ts: number;
  /** See {@linkcode ActionCause}. */
  cause?: ActionCause;
  /** The `_callId` of the async call whose run dispatched this entry — see
   *  `TimelineEntry.call`. What `am record --from` needs to tell overlapping
   *  calls from sequential ones. */
  call?: string;
  /** The originating action type, for a write-set commit (`cell:__setFoo`
   *  written by the async method `cell:foo`). Recorded so a reader — and the
   *  redactor — can attribute the entry to the method that produced it. */
  origin?: string;
  /** Set when `redactActions` dropped this entry's payload.
   *
   *  It is a REFUSAL MARKER, not a note. The payload of a `cell:method` entry
   *  IS its arguments, so an entry without one cannot be re-reduced: replay ran
   *  the method with no arguments, which for the documented wallet example
   *  (`redactActions: ["vault:*"]`) threw inside the reducer and made
   *  `aio.run()` REJECT — and since the journal tail persists, every subsequent
   *  restart failed identically until a human deleted the file. A tolerant
   *  reducer got the quiet version of the same thing: a wrong recovered state,
   *  silently. `replayJournal` therefore skips these and REPORTS them. */
  redacted?: true;
  /** WHO dispatched it. A method that reads `serverUser()` — an authorization
   *  check, an "own rows only" filter, a per-caller quota — is a different
   *  function under a different caller, and replay ran them all as nobody.
   *  Recorded so replay can restore the ambient identity the action really
   *  had; absent for server-origin actions (schedules, effects), which is
   *  exactly the `undefined` they ran under. */
  user?: AioUser;
  /** The `version` of each cell this entry writes, as the build that ran it
   *  declared it (0 for a cell with none). A method is only its build's: a
   *  v1 `add(5)` meaning "+5 units" re-run through the v2 `add` of a cell
   *  that migrated to cents recovered `cents: 5` where a clean restart gave
   *  500. Replay refuses an entry whose stamp is not the running build's —
   *  see `replayJournal`. Absent on journals written before this field
   *  existed, which replay as they always did. */
  v?: Record<string, number>;
};

export type Journal = {
  /** Append a committed action; returns its monotonic seq. */
  append(
    action: {
      type: string;
      payload?: unknown;
      origin?: string;
      user?: AioUser;
      cause?: ActionCause;
      call?: string;
      v?: Record<string, number>;
    },
    ts: number,
  ): number;
  /** All entries with seq > `after` (the persisted watermark), in order. */
  readSince(after: number): JournalEntry[];
  /** What boot must replay: every entry past the watermark that GOVERNS it —
   *  a tracked (sync) cell's own, else the app-wide one. */
  readTail(): JournalEntry[];
  /** The persisted watermark — replay starts strictly after this seq. */
  watermark(): number;
  /** The watermark that governs a top-level state key: a tracked cell's own,
   *  else the app-wide one. Replay takes an entry's change to a key only past
   *  it (see `replayJournal`). */
  watermarkFor(key: string): number;
  /** Record that state up to `seq` is durably persisted; compacts the journal. */
  setWatermark(seq: number): void;
  /** Declare the cells that carry their OWN watermark (sync cells — see
   *  {@linkcode syncJournalWatermarkKey}), with what the store holds for each.
   *  Their entries are compacted and replayed by that watermark only. */
  trackCells(stored: Record<string, number>): void;
  /** Record that `cell`'s own durable record holds its entries up to `seq`
   *  (called after the fold that wrote it committed); compacts the journal. */
  setCellWatermark(cell: string, seq: number): void;
  /** The hole between this journal and a store that went back in time, or
   *  null. Only meaningful once `trackCells` has run. */
  gap(): JournalGap | null;
  /** Move the journal (and its base) to `to`, and start a fresh one at the
   *  store's watermarks. Throws when the journal cannot be moved. */
  quarantine(to: string): void;
  /** Accept the store's watermarks as the journal's base — for a gap with
   *  nothing past it to replay. Throws when the base cannot be written. */
  rebase(): void;
  /** Where the journal lives. */
  readonly path: string;
  /** The highest seq appended so far. */
  currentSeq(): number;
  /** Flush + release. */
  close(): void;
};

/** An entry replay REFUSED, and why — so the caller can say so out loud.
 *
 *  `threw` is the one that is not a policy decision: the reducer rejected the
 *  entry (a guard that no longer holds, a caller the entry could not restore,
 *  a shape from an older build). Skipping it costs whatever that one action
 *  wrote; NOT skipping it cost the whole app — an entry that throws is still
 *  in the file on the next boot, so the same crash repeats forever and the
 *  watermark never advances. Recovery must never be the reason a process
 *  cannot start. */
export type SkippedEntry = {
  seq: number;
  type: string;
  reason: "redacted" | "threw" | "version";
  /** The reducer's message, for `threw`; the version mismatch, for
   *  `version`. */
  error?: string;
};

/** What a replay reconstructed, and what it could not. */
export type ReplayResult<S> = {
  state: S;
  /** Entries actually re-reduced. */
  replayed: number;
  /** Entries deliberately not replayed. Never empty silently — `aio.run` warns
   *  with the exact types and seq range, because the recovered state is missing
   *  whatever they wrote and only the operator can judge what that costs. */
  skipped: SkippedEntry[];
};

/** True when this entry's payload was replaced by the redactor, so its
 *  arguments are gone and re-reducing it would run the method with none.
 *
 *  Both the explicit marker and the bare sentinel are treated as refusals: the
 *  marker is what current journals write, the sentinel covers a file written
 *  before the marker existed. An app whose real payload is literally the string
 *  `"[redacted]"` is skipped too — that direction is the safe one. */
export function isUnreplayable(e: JournalEntry): boolean {
  return e.redacted === true || e.payload === REDACTED;
}

/** The cells whose version stamp on a journal line refuses it, as
 *  `[cell, stamped version]` — the ONE rule both boot recovery
 *  ({@linkcode replayJournal}) and `am replay` apply.
 *
 *  A stamp equal to the running build's version replays. A NEWER one (a
 *  downgrade) is always refused. An OLDER one is refused only for a cell that
 *  converts its state across versions (`cellMigrates`, i.e. it declares an
 *  `onMigrate`): a cell that converts nothing keeps its stored shape, so the
 *  tail on top of it is in that shape too. Absent `cellMigrates` ⇒ every
 *  mismatch is refused. An unstamped line (a journal written before `v`
 *  existed) is never refused here. Pure. */
export function staleStamps(
  v: unknown,
  cellVersion: (cell: string) => number,
  cellMigrates?: (cell: string) => boolean,
): [string, number][] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  const out: [string, number][] = [];
  for (const [c, stamped] of Object.entries(v as Record<string, unknown>)) {
    const now = cellVersion(c);
    if (now === stamped) continue;
    const older = typeof stamped === "number" && stamped < now;
    if (!cellMigrates || !older || cellMigrates(c)) {
      out.push([c, stamped as number]);
    }
  }
  return out;
}

/** Replay journalled actions on top of a restored snapshot — pure. Re-reduces
 *  each action for its STATE transition only (effects are discarded), so I/O is
 *  never repeated. Entries are applied in seq order.
 *
 *  A redacted entry is SKIPPED rather than replayed, and returned in `skipped`.
 *  Replaying one is not a degraded reconstruction, it is a wrong one — see
 *  `JournalEntry.redacted`. */
export function replayJournal<S, A>(
  state: S,
  entries: JournalEntry[],
  reduce: (state: S, action: A) => { state: S },
  /** The watermark that governs each top-level state key (`Journal.
   *  watermarkFor`). An entry's change to a key is taken only when its seq is
   *  past that key's watermark — the key's durable record already holds it
   *  otherwise. It matters once two watermarks exist: a sync cell folds on its
   *  own clock, so one entry can be in the KV snapshot and not in the sync
   *  snapshot (or the reverse), and re-reducing it whole applied the part
   *  already on disk twice. Absent ⇒ every change is taken. */
  keyWatermark?: (key: string) => number,
  /** The running build's `version` of a cell (0 for none). An entry stamped
   *  with a different version for any cell it writes is SKIPPED as
   *  `version`: it ran through a method this build no longer has, and
   *  re-running it through the new one on migrated state is a guess, not a
   *  recovery (see `JournalEntry.v`). Absent ⇒ no entry is refused for it. */
  cellVersion?: (cell: string) => number,
  /** Whether this build CONVERTS the cell's state across a version change
   *  (it declares an `onMigrate`). An older stamp on a cell that converts
   *  nothing is replayed: boot keeps that cell's snapshot as stored (a first
   *  `version:` is only stamped), so the tail on top of it is in the same
   *  shape, and refusing it lost acked writes for nothing. A NEWER stamp (a
   *  downgrade) is always refused. Absent ⇒ every mismatch is refused. */
  cellMigrates?: (cell: string) => boolean,
): ReplayResult<S> {
  let s = state;
  let replayed = 0;
  const skipped: SkippedEntry[] = [];
  /** `next` with every key whose watermark already covers `seq` put back. */
  const admit = (prev: S, next: S, seq: number): S => {
    if (!keyWatermark || prev === next) return next;
    const p = prev as Record<string, unknown>;
    const n = next as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const k of new Set([...Object.keys(p), ...Object.keys(n)])) {
      if (p[k] === n[k] || seq > keyWatermark(k)) continue;
      out ??= { ...n };
      if (k in p) out[k] = p[k];
      else delete out[k];
    }
    return (out ?? next) as S;
  };
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    if (isUnreplayable(e)) {
      skipped.push({ seq: e.seq, type: e.type, reason: "redacted" });
      continue;
    }
    const stale = cellVersion
      ? staleStamps(e.v, cellVersion, cellMigrates)
      : [];
    const versionSkip = (cells: [string, number][]): SkippedEntry => ({
      seq: e.seq,
      type: e.type,
      reason: "version",
      error: cells.map(([c, v]) => `"${c}" v${v} → v${cellVersion!(c)}`)
        .join(", "),
    });
    // A time-travel line carries EVERY cell's state, so a stamp stale for one
    // cell refuses that cell's fields only — the rest are the jump the other
    // cells really made, under their own (matching) versions.
    if (stale.length > 0 && e.type !== TT_RESTORE_TYPE) {
      skipped.push(versionSkip(stale));
      continue;
    }
    if (e.type === TT_RESTORE_TYPE) {
      // Not an action: the state a time-travel jump put in place. Applied as
      // the store applies a snapshot — each persisted field replaced, fields
      // the store does not hold left as they are.
      const cells = (e.payload as Partial<TimeTravelRestore> | undefined)
        ?.cells;
      if (!cells || typeof cells !== "object") {
        skipped.push({
          seq: e.seq,
          type: e.type,
          reason: "threw",
          error: "time-travel line carries no state",
        });
        continue;
      }
      const refused = new Set(stale.map(([c]) => c));
      if (stale.length > 0) {
        skipped.push(versionSkip(stale));
        if (Object.keys(cells).every((c) => refused.has(c))) continue;
      }
      const next = { ...(s as Record<string, unknown>) };
      for (const [cell, fields] of Object.entries(cells)) {
        if (refused.has(cell)) continue;
        const cur = next[cell];
        // A cell this build does not declare has no slice to restore into —
        // inventing one would put an undeclared key into live state.
        if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
          continue;
        }
        next[cell] = { ...(cur as Record<string, unknown>), ...fields };
      }
      s = admit(s, next as S, e.seq);
      replayed++;
      continue;
    }
    try {
      // Under the caller it really had. A user-scoped method (`serverUser()`
      // for authorization, for "my rows only", for a per-caller quota) throws
      // or reduces WRONGLY when replayed as nobody — and a throw here used to
      // reject `aio.run()`, leaving an app that could never boot again.
      const prev = s;
      s = admit(
        prev,
        runWithUser(
          e.user,
          () => reduce(prev, { type: e.type, payload: e.payload } as A),
        ).state,
        e.seq,
      );
      replayed++;
    } catch (err) {
      skipped.push({
        seq: e.seq,
        type: e.type,
        reason: "threw",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { state: s, replayed, skipped };
}

/** Parse a journal file's lines into entries, skipping any corrupt line —
 *  durability over strictness.
 *
 *  A corrupt line is a torn write: a crash mid-append. This used to STOP the
 *  parse there, on the reasoning that a torn line is the last line. It is the
 *  last line only until the next boot appends after it — the file is
 *  append-only, and the compaction that would drop the tear runs at the first
 *  persist, not at boot. A crash inside that window left every entry after
 *  the tear, all of them intact, unread and unreplayed. Skipping the line and
 *  continuing loses exactly the torn entry (and, when the next append landed
 *  on its line with no newline between, the one fused to it) — never the
 *  tail. */
export function parseJournal(
  text: string,
  /** Internal: a second read of text a first read already reported on. */
  opts: { quiet?: boolean } = {},
): JournalEntry[] {
  const { entries, torn } = parseJournalLines(text);
  if (torn.lines > 0 && !opts.quiet) log.warn("journal", tornSummary(torn));
  return entries;
}

/** What a read could not parse: how many LINES, how many ENTRIES they held
 *  (a fused line holds two or more — see {@linkcode createJournal}'s seal),
 *  and every seq scraped out of them, so a torn entry's seq is never handed
 *  to a new one. */
type TornLines = {
  lines: number;
  entries: number;
  seqs: number[];
  fused: number;
};

/** The parse itself, plus what it skipped. `parseJournal` is the reporting
 *  face; the journal instance reads through here so it can say the tear ONCE
 *  per boot (open, `readSince` and compaction all parse the same file). */
function parseJournalLines(
  text: string,
): { entries: JournalEntry[]; torn: TornLines } {
  const torn: TornLines = { lines: 0, entries: 0, seqs: [], fused: 0 };
  const entries: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as JournalEntry;
      if (typeof e.seq === "number" && typeof e.type === "string") {
        entries.push(e);
      }
    } catch {
      torn.lines++;
      // Every `"seq":N` on the line: one for a plain tear, two or more when
      // an earlier build appended onto an unterminated line. Each is an
      // entry that is gone, and each is a seq that must not be re-issued.
      const seqs = [...line.matchAll(/"seq":(\d+)/g)].map((m) => Number(m[1]));
      if (seqs.length >= 2) torn.fused++;
      torn.entries += Math.max(1, seqs.length);
      torn.seqs.push(...seqs);
    }
  }
  return { entries, torn };
}

function tornSummary(t: TornLines): string {
  const n = (k: number, one: string, many: string) =>
    `${k} ${k === 1 ? one : many}`;
  const why = t.fused > 0
    ? `(${
      n(t.fused, "line holds", "lines hold")
    } entries fused together — an earlier boot appended to an unterminated ` +
      `line, which this build seals at open)`
    : "(a crash mid-write)";
  const seqs = t.seqs.length > 0 ? ` (seq ${t.seqs.join(", ")})` : "";
  return `journal: ${n(t.lines, "torn line", "torn lines")} skipped ${why} ` +
    `— ${n(t.entries, "entry", "entries")} lost${seqs}; the intact ` +
    `entries replay`;
}

/** An `undefined` JSON drops that nevertheless comes back as the SAME value
 *  wherever replay reads it — so warning about it trains the reader to skip
 *  the warning that is real (wallet report §7).
 *
 *  - `payload` itself: a missing key reads back `undefined`, which is what the
 *    method got live.
 *  - a write-set record's own `value` (`payload.mutations.N.value`): aio's
 *    record of `delete s.x` carries `value: undefined`, and `applyMutations`
 *    reads `m.value` — `undefined` whether the key was there or not.
 *
 *  An `undefined` object property ANYWHERE ELSE stays reported: `{k:
 *  undefined}` and `{}` differ to `in`, `Object.keys` and a spread over
 *  defaults (`{ ...defaults, ...opts }` keeps the default only when the key
 *  is absent), so a replay can genuinely rebuild a different state. */
function replaysIdentically(i: PersistIssue): boolean {
  return i.kind === "undefined" &&
    (i.path === "payload" || /^payload\.mutations\.\d+\.value$/.test(i.path));
}

/** Action types already reported by {@linkcode warnLossyEntry} — once per
 *  type per process: the same call shape repeats on every call. */
const _lossyWarned = new Set<string>();

/** Say — once per action type — that a journalled entry will not replay as
 *  it ran.
 *
 *  Replay re-reduces the entry's payload as parsed back from JSON, so a
 *  server-side call with arguments JSON cannot round-trip rebuilt a DIFFERENT
 *  state from the one that was live: an `undefined` argument came back as
 *  `null` (so the parameter's default did not apply), a Date as a string,
 *  NaN as null, an undefined key vanished. Recovery reported only "recovered
 *  6 actions". (A call arriving over the wire is unaffected — its arguments
 *  were already JSON when the method ran.)
 *
 *  Observe-only, identical in dev and prod: refusing the append would turn a
 *  mangled replay into a missing one. */
function warnLossyEntry(type: string, issues: PersistIssue[]): void {
  if (_lossyWarned.has(type)) return;
  _lossyWarned.add(type);
  const shown = issues.slice(0, 6).map((i) => {
    const arg = /^payload\.args\.(\d+)(.*)$/.exec(i.path);
    const where = arg
      ? `argument ${Number(arg[1]) + 1}${arg[2] ? ` (${arg[2].slice(1)})` : ""}`
      : i.path;
    const becomes = arg && !arg[2] && i.kind === "undefined"
      ? "null — so the parameter's default does NOT apply"
      : i.becomes;
    return `  • ${where}: ${i.kind} — on replay: ${becomes}`;
  });
  const more = issues.length > 6 ? `\n  …and ${issues.length - 6} more` : "";
  log.warn(
    "journal",
    `journal: "${type}" was journalled with values JSON cannot round-trip, ` +
      `so a crash-recovery replay would re-run it with DIFFERENT input and ` +
      `rebuild a different state:\n${shown.join("\n")}${more}\n` +
      `  fix: call it with JSON-shaped arguments — a Date as ` +
      `\`.toISOString()\` or epoch ms, null (not undefined) for "no value", ` +
      `an explicit value where a default was relied on, a Map/Set as an ` +
      `object/array. Said once per action type.`,
  );
}

export function createJournal(
  path: string,
  opts: {
    /** The watermark the STORE holds for this journal, when the store owns it
     *  (see {@linkcode journalWatermarkKey}). Present ⇒ `setWatermark` records
     *  nothing on its own: the persistence transaction already did, atomically.
     *  Absent ⇒ the legacy `<journal>.wm` side file, which is what a journal
     *  used outside an app (the unit tests) still uses. */
    storedWatermark?: number;
    sync?: boolean;
    /** Action types whose PAYLOAD must never be written to disk.
     *
     *  The journal exists to replay the debounce-window tail after a hard
     *  kill, and to do that it only needs to know that the action happened —
     *  but it records the arguments too, and for an action like a wallet's
     *  `unlock:unlockWith` those arguments ARE the secret that protects
     *  everything else in the same directory. Listed types keep their
     *  sequence and timestamp; the payload is replaced.
     *
     *  Built once at boot (`makeRedactor`) and shared with the timeline and
     *  action log, so the three sinks cannot disagree about what is secret. */
    redact?: Redactor;
  } = {},
): Journal {
  const redacted = opts.redact ?? noRedaction;
  const wmPath = path + ".wm";
  const storeOwnsWatermark = opts.storedWatermark !== undefined;
  let seq = 0;
  let wm = 0;
  // Recover prior state on open. When the store owns the watermark a `.wm`
  // file may still exist — written by a build from before the move — so take
  // the HIGHER of the two: replaying what is already in the snapshot is the
  // failure this whole file is about.
  if (storeOwnsWatermark) wm = opts.storedWatermark!;
  // NotFound is the one honest "nothing yet". Any other refusal (EACCES on
  // a file another user created, an I/O error) used to read as "no journal"
  // — and a journal that exists but cannot be read is exactly the state this
  // file is meant to recover from, so it throws by name instead.
  const readOr = (file: string, what: string): string | null => {
    try {
      return Deno.readTextFileSync(file);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw new Error(
        `journal: could not read the ${what} at ${file} — ${
          e instanceof Error ? e.message : String(e)
        }. It exists, so recovery cannot be skipped: fix its permissions ` +
          `(owner-only, like the data dir) or move it aside deliberately.`,
        { cause: e },
      );
    }
  };
  const wmText = readOr(wmPath, "watermark");
  if (wmText !== null) wm = Math.max(wm, parseInt(wmText, 10) || 0);
  const journalText = readOr(path, "journal");
  if (journalText !== null) {
    const { entries, torn } = parseJournalLines(journalText);
    for (const e of entries) if (e.seq > seq) seq = e.seq;
    // A torn entry's seq is still ITS seq: re-issuing it to the next append
    // made the acked entry read as the lost one on the following boot.
    for (const s of torn.seqs) if (s > seq) seq = s;
    // Said here, ONCE. `readSince` and the compaction parse the same bytes
    // and used to say it again each time — three times per boot.
    if (torn.lines > 0) log.warn("journal", tornSummary(torn));
  }
  if (wm > seq) seq = wm;

  // ── Per-cell watermarks and the compaction base ─────────────────────────
  const basePath = path + ".base";
  /** Tracked (sync) cell → the seq its own durable record holds. */
  const cellWm = new Map<string, number>();
  const cellOf = (e: JournalEntry): string | undefined => {
    const i = e.type.indexOf(":");
    return i > 0 ? e.type.slice(0, i) : undefined;
  };
  /** The watermark an entry is compacted and replayed by. */
  const governing = (e: JournalEntry): number => {
    const c = cellOf(e);
    return c !== undefined && cellWm.has(c) ? cellWm.get(c)! : wm;
  };
  /** The base on disk; null when there is none (a journal from before it
   *  existed, or one never compacted), and null — said — when it is torn. */
  const readBase = (): JournalBase | null => {
    const text = readOr(basePath, "journal base");
    if (text === null) return null;
    try {
      const b = JSON.parse(text) as Partial<JournalBase>;
      const cells: Record<string, number> = {};
      for (const [c, v] of Object.entries(b.cells ?? {})) {
        if (typeof v === "number") cells[c] = v;
      }
      return { wm: typeof b.wm === "number" ? b.wm : 0, cells };
    } catch (e) {
      log.warn(
        "journal",
        `journal: the compaction base at ${basePath} is unreadable (${e}) — ` +
          `a rolled-back database is checked by the journal's first seq instead`,
      );
      return null;
    }
  };
  /** Record what the journal is about to stop holding. Atomic (tmp + rename)
   *  and owner-only like the journal. Throws — the caller decides how loud. */
  const writeBase = (): void => {
    const tmp = basePath + ".tmp";
    Deno.writeTextFileSync(
      tmp,
      JSON.stringify({ wm, cells: Object.fromEntries(cellWm) }),
      { mode: 0o600 },
    );
    Deno.renameSync(tmp, basePath);
  };
  const openBase = readBase();
  if (openBase) {
    seq = Math.max(seq, openBase.wm, ...Object.values(openBase.cells));
  }
  // A journal starting from nothing drops nothing — its first append says so
  // on disk, so the first-seq fallback (for journals written before the base
  // existed) is never asked about a journal this build started. Only where a
  // store owns the watermark: without one there is no rollback to detect.
  let baseOwed = storeOwnsWatermark && openBase === null &&
    !journalText?.trim();
  /** The base, where the store can be rolled back; a no-op otherwise. */
  const recordBase = (): void => {
    if (!storeOwnsWatermark) return;
    writeBase();
    baseOwed = false;
  };

  const enc = new TextEncoder();
  // Owner-only: the journal sits next to the database it recovers, and a
  // world-readable copy of recent action payloads is a leak in its own right.
  const mode: Deno.WriteFileOptions = {
    append: true,
    create: true,
    mode: 0o600,
  };

  function writeLine(line: string): void {
    if (opts.sync) {
      const f = Deno.openSync(path, { write: true, ...mode });
      try {
        f.writeSync(enc.encode(line));
        f.syncSync(); // fdatasync — power-cut durability
      } finally {
        f.close();
      }
    } else {
      Deno.writeTextFileSync(path, line, mode);
    }
  }

  // SEAL an unterminated tail before anything is appended after it. A kill
  // between a line and its "\n" (or mid-line) leaves the file without one;
  // `append` writes `json + "\n"` after whatever the file ends with, so the
  // next entry FUSED onto the old line — one unparseable line holding an
  // entry this boot had just recovered AND the one it was acking, both
  // skipped as "torn" by the boot after. One "\n" is the whole repair; the
  // torn line itself stays (skipped and said above) until compaction drops
  // it. The file format is unchanged.
  if (
    journalText !== null && journalText.length > 0 &&
    !journalText.endsWith("\n")
  ) {
    try {
      writeLine("\n");
    } catch (e) {
      // Not swallowed: the first append meets the same refusal and reports
      // PERSIST_ERROR, but by then it has fused with the tail — say why.
      log.error(
        "journal",
        `journal: could not seal the unterminated last line of ${path} — ${e}` +
          `. The next append lands on that line and BOTH entries are skipped ` +
          `on the following boot. fix: make the journal writable (check disk ` +
          `space and permissions).`,
      );
    }
  }

  const api: Journal = {
    append(action, ts) {
      const s = ++seq;
      // The write-set of a redacted method carries the same secret as its
      // arguments, under a DIFFERENT type — `isRedactedAction` checks the
      // origin too so an exact pattern cannot plug one and leave the other.
      const hide = isRedactedAction(redacted, action.type, action.origin) ||
        redactsWorkerPatch(redacted, action.type, action.payload);
      // One pass that both serializes the line and names every value JSON
      // would bring back different (see `warnLossyEntry`). A value JSON
      // refuses outright (a BigInt, a cycle) throws here with its path, as it
      // always threw — the caller reports a refused append.
      const { json, issues } = stringifyWithIssues({
        seq: s,
        type: action.type,
        payload: hide ? REDACTED : action.payload,
        ts,
        ...(action.origin !== undefined ? { origin: action.origin } : {}),
        // The caller, so replay re-reduces under the identity the action
        // actually had. Never a credential: `AioUser` is the resolved id and
        // role, which the app's own state already holds. An app that hangs
        // extra fields off it (a public key, a tenant) pays for them here in
        // bytes — bounded, because the journal is compacted at every
        // watermark and therefore only ever holds the persist debounce
        // window.
        ...(action.user !== undefined ? { user: action.user } : {}),
        ...(action.cause !== undefined ? { cause: action.cause } : {}),
        ...(action.call !== undefined ? { call: action.call } : {}),
        ...(action.v !== undefined ? { v: action.v } : {}),
        // The marker travels WITH the entry: replay must be able to refuse it
        // without pattern-matching a sentinel string, and the file outlives
        // the config that redacted it (a journal written under
        // `redactActions` is still there after the option is removed).
        ...(hide ? { redacted: true as const } : {}),
      });
      // A time-travel line is STATE, not call arguments: the persist path
      // already names every value in it that JSON would change, and the
      // advice below ("call it with JSON-shaped arguments") would be false.
      const lossy = issues.filter((i) => !replaysIdentically(i));
      if (lossy.length > 0 && action.type !== TT_RESTORE_TYPE) {
        warnLossyEntry(action.type, lossy);
      }
      if (baseOwed) {
        try {
          recordBase();
        } catch {
          // aio-ok: the append below meets the same directory and reports a
          // refusal loudly (PERSIST_ERROR); the next compaction writes it.
        }
      }
      writeLine(json + "\n");
      return s;
    },
    readSince(after) {
      try {
        // Quiet: a tear was said at open, once per boot.
        return parseJournal(Deno.readTextFileSync(path), { quiet: true })
          .filter((e) => e.seq > after);
      } catch (e) {
        // A journal that cannot be READ is not an empty journal: replaying
        // nothing over a store that has entries is the silent data loss this
        // file exists to prevent. NotFound is the one honest "nothing yet".
        if (e instanceof Deno.errors.NotFound) return [];
        throw new Error(`journal: cannot read ${path} — ${e}`, { cause: e });
      }
    },
    watermark: () => wm,
    setWatermark(s) {
      wm = s;
      // The store already recorded this seq, in the same transaction as the
      // snapshot — writing it again here would only re-open the window.
      if (!storeOwnsWatermark) {
        try {
          Deno.writeTextFileSync(wmPath, String(s));
        } catch (e) {
          // NEVER swallowed. A watermark that cannot be written means every
          // later boot replays an already-applied tail — silently, and growing.
          log.error(
            "journal",
            `could not record the journal watermark at ${wmPath} — ${e}. ` +
              `Until this succeeds, every restart REPLAYS actions that are ` +
              `already in the persisted snapshot (replay re-reduces; it is ` +
              `not idempotent). fix: make ${wmPath} writable (check disk ` +
              `space and permissions), or run the journal under an app, ` +
              `where the watermark is a row in state.db written inside the ` +
              `snapshot transaction.`,
          );
        }
      }
      // Compact: keep only the unpersisted tail (seq > wm). Atomic via rename.
      // The temp file carries the SAME 0600 mode as the journal it replaces:
      // it holds the same action payloads, and the rename makes it the
      // journal. Written without a mode, the first compaction silently reset
      // the file to the process umask (0644/0664) — permanently, and for every
      // later append — so the owner-only guarantee held only until the first
      // snapshot. It matters wherever `dbPath` puts the journal outside the
      // 0700 app directory.
      try {
        let text: string;
        try {
          text = Deno.readTextFileSync(path);
        } catch (e) {
          // NOT A FAILURE. A journal that has never been appended to has no
          // file, and "compact nothing" is already done — but this fell into
          // the catch below and warned `could not compact … the file keeps
          // growing until this succeeds` about a file that does not exist and
          // is not growing. It fired TWICE on the first boot of every
          // journaling app, so a developer's first sight of the feature was a
          // durability warning about data they did not have. A warning that
          // fires when nothing is wrong is how the ones that matter come to be
          // ignored, and this one lives in the durability path.
          if (e instanceof Deno.errors.NotFound) return;
          throw e;
        }
        // Quiet (said at open): the compaction is what DROPS the torn line,
        // and it used to blame "a crash mid-write" on the way out.
        const parsed = parseJournal(text, { quiet: true });
        const keep = parsed.filter((e) => e.seq > s);
        // A tracked (sync) cell's entries go by ITS watermark: the KV snapshot
        // that advanced `s` does not hold them, and dropping them here lost
        // exactly the writes the fold had not reached yet.
        if (cellWm.size > 0) {
          keep.push(
            ...parseJournal(text, { quiet: true }).filter((e) =>
              e.seq <= s && e.seq > governing(e)
            ),
          );
          keep.sort((a, b) => a.seq - b.seq);
        }
        // What is dropped is recorded BEFORE it is gone (see JournalBase).
        recordBase();
        const tmp = path + ".tmp";
        // A leftover tmp from an earlier crash may exist with looser
        // permissions; `mode` only applies at CREATE time, so remove it first.
        try {
          Deno.removeSync(tmp);
        } catch (e) {
          // NotFound: nothing to clear. Anything else means the leftover —
          // and its looser mode — would be REUSED by the write below.
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
        Deno.writeTextFileSync(
          tmp,
          keep.map((e) => JSON.stringify(e)).join("\n") +
            (keep.length ? "\n" : ""),
          { mode: 0o600 },
        );
        Deno.renameSync(tmp, path);
      } catch (e) {
        // Compaction is an optimization — the watermark alone decides what is
        // replayed — but a journal that can never be compacted grows without
        // bound, so it is said once rather than never.
        log.warn(
          "journal",
          `could not compact ${path} — ${e}. Nothing is replayed twice ` +
            `(the watermark decides that), but the file keeps growing until ` +
            `this succeeds.`,
        );
      }
    },
    readTail() {
      return api.readSince(Math.min(wm, ...cellWm.values())).filter((e) =>
        e.seq > governing(e)
      );
    },
    watermarkFor: (key) => cellWm.get(key) ?? wm,
    trackCells(stored) {
      for (const [cell, at] of Object.entries(stored)) {
        cellWm.set(cell, Math.max(cellWm.get(cell) ?? 0, at));
        // Never re-issue a seq a fold already claims: a compacted journal can
        // hold nothing that high, so its lines alone would restart below it
        // and the next boot would read the new writes as already folded.
        if (at > seq) seq = at;
      }
    },
    setCellWatermark(cell, at) {
      cellWm.set(cell, Math.max(cellWm.get(cell) ?? 0, at));
      // Same compaction, same base — the app-wide watermark is unchanged.
      api.setWatermark(wm);
    },
    gap() {
      // Without a store there is nothing to roll back: the `.wm` side file
      // lives beside the journal, not in the database.
      if (!storeOwnsWatermark) return null;
      const base = readBase();
      if (base) {
        if (base.wm > wm) {
          return { stream: "actions", droppedThrough: base.wm, storeAt: wm };
        }
        for (const [cell, at] of Object.entries(base.cells)) {
          // A cell this build no longer tracks (removed, or no longer
          // `sync: true`) has no watermark to be behind.
          const storeAt = cellWm.get(cell);
          if (storeAt !== undefined && at > storeAt) {
            return { stream: cell, droppedThrough: at, storeAt };
          }
        }
        return null;
      }
      // No base: a journal written before it existed, where seqs are
      // contiguous and only the app-wide stream exists. The first line it
      // still holds is where its last compaction stopped.
      const first = api.readSince(-Infinity)
        .filter((e) => {
          const c = cellOf(e);
          return e.seq > 0 && (c === undefined || !cellWm.has(c));
        })
        .reduce((m, e) => Math.min(m, e.seq), Infinity);
      return first !== Infinity && first > wm + 1
        ? { stream: "actions", droppedThrough: first - 1, storeAt: wm }
        : null;
    },
    quarantine(to) {
      try {
        Deno.renameSync(path, to);
      } catch (e) {
        // A base whose journal was compacted away entirely still names the
        // hole; there is simply no journal to keep.
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
      try {
        Deno.renameSync(basePath, to + ".base");
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
      // The next journal starts at what the store holds — so the hole just
      // moved aside is not found again in a file that never had it.
      recordBase();
    },
    rebase: () => recordBase(),
    path,
    currentSeq: () => seq,
    close() {/* writes are synchronous — nothing buffered */},
  };
  return api;
}
