// Time-travel debugger — pure functions, no side effects
// Active in dev mode, zero cost in prod

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

/** Single history entry — full state snapshot per action */
export type HistoryEntry<S, A> = {
  id: number;
  action: A;
  state: S;
  ts: number;
  perf?: PerfMetric; // only populated in dev mode
  error?: {
    code: string;
    message: string;
    cellName?: string;
    flowStep?: number;
  };
};

/** Server-side time-travel state */
export type TTState<S, A> = {
  entries: HistoryEntry<S, A>[];
  index: number;
  paused: boolean;
  nextId: number;
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

const MAX_ENTRIES = 200;
const MAX_STATE_BYTES = 100_000; // Skip clone above 100KB to protect dev-mode memory

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

  // Skip expensive clone for very large state to protect dev-mode memory
  let clonedState: S;
  try {
    const estimated = JSON.stringify(state as Record<string, unknown>).length;
    if (estimated > MAX_STATE_BYTES) {
      console.warn(
        `[aio:tt] state is ${
          (estimated / 1024).toFixed(1)
        }KB — skipping time-travel snapshot for performance. Consider persistMode:'multi' or cell-level persist filters.`,
      );
      clonedState = state;
    } else {
      clonedState = structuredClone(state);
    }
  } catch {
    // Degraded fallback: JSON-round-trip so we never store the live mutable
    // reference. If JSON also fails (circular ref), warn and store state as
    // last resort — undo history may share the reference, but we've tried.
    try {
      clonedState = JSON.parse(JSON.stringify(state)) as S;
    } catch {
      console.warn(
        "[aio:tt] state is not cloneable — undo history may share references with live state",
      );
      clonedState = state;
    }
  }

  const entry: HistoryEntry<S, A> = {
    id: tt.nextId,
    action,
    state: clonedState,
    ts: Date.now(),
    perf,
  };
  entries.push(entry);

  // Cap at MAX_ENTRIES — evict oldest
  if (entries.length > MAX_ENTRIES) entries.shift();

  return {
    entries,
    index: entries.length - 1,
    paused: false,
    nextId: tt.nextId + 1,
  };
}

/** Marks the current entry with an error — mutates in place (called right after record) */
export function markError<S, A>(
  tt: TTState<S, A>,
  err: {
    code: string;
    message: string;
    cellName?: string;
    flowStep?: number;
  },
): void {
  const entry = tt.entries[tt.index];
  if (entry) entry.error = err;
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

/** Parses "__tt:undo" → { cmd:'undo' }, "__tt:goto:5" → { cmd:'goto', arg:5 } */
export function parseTTCommand(raw: string): TTCommand | null {
  if (!raw.startsWith("__tt:")) return null;
  const body = raw.slice(5); // strip "__tt:"
  if (body === "undo") return { cmd: "undo" };
  if (body === "redo") return { cmd: "redo" };
  if (body === "pause") return { cmd: "pause" };
  if (body === "resume") return { cmd: "resume" };
  if (body.startsWith("goto:")) {
    const s = body.slice(5);
    if (s === "") return null;
    const n = Number(s);
    if (Number.isInteger(n) && n >= 0) return { cmd: "goto", arg: n };
  }
  return null;
}
