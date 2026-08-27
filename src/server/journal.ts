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

export type JournalEntry = {
  seq: number;
  type: string;
  payload?: unknown;
  ts: number;
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
};

export type Journal = {
  /** Append a committed action; returns its monotonic seq. */
  append(
    action: {
      type: string;
      payload?: unknown;
      origin?: string;
      user?: AioUser;
    },
    ts: number,
  ): number;
  /** All entries with seq > `after` (the persisted watermark), in order. */
  readSince(after: number): JournalEntry[];
  /** The persisted watermark — replay starts strictly after this seq. */
  watermark(): number;
  /** Record that state up to `seq` is durably persisted; compacts the journal. */
  setWatermark(seq: number): void;
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
  reason: "redacted" | "threw";
  /** The reducer's message, for `threw`. */
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
): ReplayResult<S> {
  let s = state;
  let replayed = 0;
  const skipped: SkippedEntry[] = [];
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    if (isUnreplayable(e)) {
      skipped.push({ seq: e.seq, type: e.type, reason: "redacted" });
      continue;
    }
    try {
      // Under the caller it really had. A user-scoped method (`serverUser()`
      // for authorization, for "my rows only", for a per-caller quota) throws
      // or reduces WRONGLY when replayed as nobody — and a throw here used to
      // reject `aio.run()`, leaving an app that could never boot again.
      s = runWithUser(
        e.user,
        () => reduce(s, { type: e.type, payload: e.payload } as A),
      ).state;
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

/** Parse a journal file's lines into entries, skipping any corrupt tail line
 *  (a torn last write from a crash) — durability over strictness. */
export function parseJournal(text: string): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as JournalEntry;
      if (typeof e.seq === "number" && typeof e.type === "string") out.push(e);
    } catch {
      // torn/partial line (crash mid-write) — stop; nothing after it is trusted.
      break;
    }
  }
  return out;
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
  try {
    wm = Math.max(wm, parseInt(Deno.readTextFileSync(wmPath), 10) || 0);
  } catch { /* no watermark yet */ }
  try {
    const existing = parseJournal(Deno.readTextFileSync(path));
    for (const e of existing) if (e.seq > seq) seq = e.seq;
  } catch { /* no journal yet */ }
  if (wm > seq) seq = wm;

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

  return {
    append(action, ts) {
      const s = ++seq;
      // The write-set of a redacted method carries the same secret as its
      // arguments, under a DIFFERENT type — `isRedactedAction` checks the
      // origin too so an exact pattern cannot plug one and leave the other.
      const hide = isRedactedAction(redacted, action.type, action.origin);
      writeLine(
        JSON.stringify({
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
          // The marker travels WITH the entry: replay must be able to refuse it
          // without pattern-matching a sentinel string, and the file outlives
          // the config that redacted it (a journal written under
          // `redactActions` is still there after the option is removed).
          ...(hide ? { redacted: true as const } : {}),
        }) +
          "\n",
      );
      return s;
    },
    readSince(after) {
      try {
        return parseJournal(Deno.readTextFileSync(path)).filter((e) =>
          e.seq > after
        );
      } catch {
        return [];
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
        const keep = parseJournal(Deno.readTextFileSync(path)).filter((e) =>
          e.seq > s
        );
        const tmp = path + ".tmp";
        // A leftover tmp from an earlier crash may exist with looser
        // permissions; `mode` only applies at CREATE time, so remove it first.
        try {
          Deno.removeSync(tmp);
        } catch { /* nothing to clear */ }
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
    currentSeq: () => seq,
    close() {/* writes are synchronous — nothing buffered */},
  };
}
