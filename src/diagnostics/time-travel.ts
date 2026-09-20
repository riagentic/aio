// Time-travel debugger — pure functions (one exception: `record` says ONCE,
// through the logger, when it starts dropping history for size)
// Active in dev mode, zero cost in prod

import { approxDeltaBytes } from "./retained-bytes.ts";
import { log } from "./logger-api.ts";

/** Phase-level timing breakdown inside a single reduce cycle (ms) */
export type ReduceBreakdown = {
  produce: number; // Immer produce() — reducer execution
  clone: number; // structuredClone() — effect detachment
  spread: number; // state object construction
  routing: number; // owner cell lookup + reduce
  listeners: number; // foreign action listener fan-out
};

/** Performance timing for a single action (dev mode only) */
export type PerfMetric = {
  reduce: number; // ms
  effects: number; // ms (sync portion only)
  budget: { reduce: number; effect: number };
  breakdown?: ReduceBreakdown; // populated when perfCheck is on
};

/** Single history entry — an immutable state reference per action */
export type HistoryEntry<S, A> = {
  id: number;
  action: A;
  state: S;
  ts: number;
  /** Estimated bytes this entry's state keeps alive that its predecessor did
   *  not (`approxDeltaBytes`) — what the history pays to hold it. Written by
   *  `record`; the byte budget is the sum over the entries. */
  bytes?: number;
  perf?: PerfMetric; // only populated in dev mode
  error?: {
    code: string;
    message: string;
    cellName?: string;
  };
};

/** Server-side time-travel state */
export type TTState<S, A> = {
  entries: HistoryEntry<S, A>[];
  index: number;
  paused: boolean;
  nextId: number;
  /** How many entries have been dropped because the history passed
   *  {@linkcode TT_MAX_BYTES} — 0/absent means the window really is "the last
   *  {@linkcode MAX_ENTRIES} actions". A reader that says "the whole history"
   *  has to be able to tell. */
  droppedForBytes?: number;
};

/** Wire format — no state snapshots, action type only */
export type TTBroadcast = {
  entries: {
    id: number;
    type: string;
    ts: number;
    perf?: PerfMetric;
    error?: { code: string; message: string };
  }[];
  index: number;
  paused: boolean;
};

/** Parsed TT command from client */
export type TTCommand =
  | { cmd: "undo" }
  | { cmd: "redo" }
  | { cmd: "goto"; arg: number }
  | { cmd: "pause" }
  | { cmd: "resume" };

// Committed state is IMMUTABLE (Immer produces a fresh frozen tree per
// commit), so an entry stores the state REFERENCE: a free snapshot with
// structural sharing across entries — memory grows with the DELTAS between
// actions plus one full tree, not entries × state. This replaced a
// structuredClone per dispatch that a 60 fps field report measured at
// ~1 MB/s, plus a JSON.stringify size-sampling guard the
// clone made necessary. With entries this cheap the window is deep: history
// is a dev inspector with a BOUNDED window, not a replay mechanism — apps
// that need replay should record inputs (see docs/debugging/time-travel.md).
export const MAX_ENTRIES = 2_000;

/** Retained-bytes budget for the history, beside the count cap.
 *
 *  Structural sharing makes an entry free for what an action did NOT change,
 *  and full price for what it replaced: a method writing a fresh 1 MB value
 *  leaves a whole new 1 MB tree per entry, so {@linkcode MAX_ENTRIES} of them
 *  is ~2 GB held by a dev inspector nobody has opened — the same trap the
 *  always-on timeline's ring had (`TIMELINE_MAX_BYTES`, timeline.ts), on a
 *  history that retains far more per entry. Dev-only, and observe-only in the
 *  sense that matters: it changes how far BACK the inspector can travel,
 *  never what the app does.
 *
 *  Larger than the timeline's 64 MiB because this history is the deeper
 *  window (2 000 entries against 500) and its owner is a developer with a
 *  debugger open, not a production server. */
export const TT_MAX_BYTES = 128 * 1024 * 1024;

/** Creates empty TT state */
export function createTT<S, A>(): TTState<S, A> {
  return { entries: [], index: -1, paused: false, nextId: 0 };
}

/** Appends entry, caps at MAX_ENTRIES (evicts oldest), truncates forward if resumed mid-history */
export function record<S, A>(
  tt: TTState<S, A>,
  action: A,
  state: S,
  perf?: PerfMetric,
): TTState<S, A> {
  // Truncate forward entries (standard undo/redo: branch, not tree)
  const entries = tt.entries.slice(0, tt.index + 1);

  // The reference IS the snapshot — committed state is a fresh immutable tree
  // per action (Immer; frozen in dev, where TT runs). Zero copies, zero
  // serialization on the dispatch path; retention is bounded by MAX_ENTRIES
  // and costs only the deltas thanks to structural sharing.
  const entry: HistoryEntry<S, A> = {
    id: tt.nextId,
    action,
    state,
    ts: Date.now(),
    perf,
    // What holding this entry COSTS: only what it keeps alive that its
    // predecessor did not. Cheap — the walk prunes at the first shared
    // reference and samples large containers (retained-bytes.ts).
    bytes: approxDeltaBytes(
      entries[entries.length - 1]?.state,
      state,
      TT_MAX_BYTES,
    ),
  };
  entries.push(entry);

  // Cap at MAX_ENTRIES — evict oldest
  if (entries.length > MAX_ENTRIES) entries.shift();

  // …and by retained BYTES, because a count cap alone let one replaced 1 MB
  // value cost 2 GB. Oldest first, and the newest entry always stays: it is
  // the one a jump lands on, however big it is.
  let held = 0;
  for (const e of entries) held += e.bytes ?? 0;
  let dropped = 0;
  while (held > TT_MAX_BYTES && entries.length > 1) {
    held -= entries.shift()!.bytes ?? 0;
    dropped++;
  }
  const droppedForBytes = (tt.droppedForBytes ?? 0) + dropped;
  // ONCE per history, and loud: a debugger silently shortening its own window
  // is a debugger that lies about what happened. (The only side effect in this
  // module, and it is a dev inspector's own log line.)
  if (dropped > 0 && (tt.droppedForBytes ?? 0) === 0) {
    log.warn(
      "time travel",
      `the dev history passed its ${
        Math.round(TT_MAX_BYTES / (1024 * 1024))
      }MB budget and is dropping its OLDEST actions — an action here replaces ` +
        `a big value, so each one retains a whole new copy of it. The window ` +
        `is shorter than the ${MAX_ENTRIES} actions it advertises; move bulk ` +
        `rows to db: tables (docs/persistence/big-data.md) to get it back.`,
    );
  }

  return {
    entries,
    index: entries.length - 1,
    paused: false,
    nextId: tt.nextId + 1,
    ...(droppedForBytes > 0 ? { droppedForBytes } : {}),
  };
}

/** The action type an entry was recorded for (`""` when it has none). */
function typeOf<S, A>(e: HistoryEntry<S, A> | undefined): string {
  return (e?.action as { type?: string } | undefined)?.type ?? "";
}

/** Attach an action's measured timing to the entry that IS that action.
 *
 *  The timing arrives after the action's effects have run, by which point the
 *  entry has already been recorded — so it is back-filled here rather than
 *  passed to `record()`. It is matched by ACTION TYPE and dropped when it does
 *  not match: an action time travel skipped (`:__exec`, a `skipActions` entry,
 *  anything dispatched while paused) has no entry of its own, and writing its
 *  numbers onto whatever happens to sit at `index` is a measurement printed
 *  against a different action. Which is what happened for every action in the
 *  history: the timing all landed on `__init`. */
export function attachPerf<S, A>(
  tt: TTState<S, A>,
  actionType: string,
  perf: PerfMetric,
): void {
  const entry = tt.entries[tt.index];
  if (entry && typeOf(entry) === actionType) entry.perf = perf;
}

/** Marks an entry with an error — mutates in place.
 *
 *  `actionType` (when the error carries one) picks the entry that action was
 *  recorded as, newest first, instead of assuming the error belongs to whatever
 *  is at `index`. An async effect fails LATER — often several actions later —
 *  and a reduce that threw was never recorded at all, so "the current entry" is
 *  routinely an innocent bystander. No match, no mark: an error badge on the
 *  wrong action sends a debugging session somewhere real. */
export function markError<S, A>(
  tt: TTState<S, A>,
  err: {
    code: string;
    message: string;
    cellName?: string;
    actionType?: string;
  },
): void {
  const { actionType, ...mark } = err;
  if (actionType === undefined) {
    // No attribution available (memory pressure, boot failures): the newest
    // entry is the only honest anchor — "this is where we were".
    const entry = tt.entries[tt.index];
    if (entry) entry.error = mark;
    return;
  }
  for (let i = tt.entries.length - 1; i >= 0; i--) {
    if (typeOf(tt.entries[i]) === actionType) {
      tt.entries[i]!.error = mark;
      return;
    }
  }
}

/** Move back one step, auto-pause */
export function undo<S, A>(tt: TTState<S, A>): TTState<S, A> {
  if (tt.index <= 0) return tt; // at start — no-op
  return { ...tt, index: tt.index - 1, paused: true };
}

/** Move forward one step, stay paused */
export function redo<S, A>(tt: TTState<S, A>): TTState<S, A> {
  if (tt.index >= tt.entries.length - 1) return tt; // at end — no-op
  return { ...tt, index: tt.index + 1, paused: true };
}

/** Jump to entry by id, auto-pause */
export function travelTo<S, A>(tt: TTState<S, A>, id: number): TTState<S, A> {
  const idx = tt.entries.findIndex((e) => e.id === id);
  if (idx === -1) return tt; // invalid id — no-op
  return { ...tt, index: idx, paused: true };
}

/** Pause — freeze state, drop incoming actions */
export function pause<S, A>(tt: TTState<S, A>): TTState<S, A> {
  return { ...tt, paused: true };
}

/** Resume — unpause, truncate entries after current index */
export function resume<S, A>(tt: TTState<S, A>): TTState<S, A> {
  return {
    ...tt,
    paused: false,
    entries: tt.entries.slice(0, tt.index + 1),
  };
}

/** Returns state at current index, or null if empty */
export function stateAt<S, A>(tt: TTState<S, A>): S | null {
  const entry = tt.entries[tt.index];
  return entry ? entry.state : null;
}

/** Wire-safe summary — action.type only, no state snapshots */
export function toBroadcast<S, A>(tt: TTState<S, A>): TTBroadcast {
  return {
    entries: tt.entries.map((e) => ({
      id: e.id,
      type: (e.action as { type?: string })?.type ?? "?",
      ts: e.ts,
      perf: e.perf,
      ...(e.error
        ? { error: { code: e.error.code, message: e.error.message } }
        : {}),
    })),
    index: tt.index,
    paused: tt.paused,
  };
}

/** Parses a "tt-cmd" body: "undo" → { cmd:'undo' }, "goto:5" → { cmd:'goto', arg:5 } */
export function parseTTCommand(body: string): TTCommand | null {
  if (body === "undo") return { cmd: "undo" };
  if (body === "redo") return { cmd: "redo" };
  if (body === "pause") return { cmd: "pause" };
  if (body === "resume") return { cmd: "resume" };
  if (body.startsWith("goto:")) {
    const s = body.slice(5);
    if (s === "") return null;
    const n = Number(s);
    // Upper bound: network-facing input; history ids never approach 1e6.
    if (Number.isInteger(n) && n >= 0 && n < 1_000_000) {
      return { cmd: "goto", arg: n };
    }
  }
  return null;
}
