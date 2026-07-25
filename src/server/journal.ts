// journal.ts — durable action journal + replay (risoto #3, the crash-only piece).
// The persistence layer snapshots full state on a debounce; a SIGKILL / power
// cut in that window loses the tail. An append-only JOURNAL closes it: every
// committed action is appended (one line), and on the NEXT boot the actions
// after the last snapshot are replayed on top of it — exact state, no loss.
//
// Durability: each append is a synchronous write, so it survives PROCESS death
// (SIGKILL). Set `sync: true` to fsync every append for power-cut durability
// (slower). Replay is by re-reducing — state transitions only, effects dropped —
// so it never re-runs I/O.
export type JournalEntry = {
  seq: number;
  type: string;
  payload?: unknown;
  ts: number;
};

export type Journal = {
  /** Append a committed action; returns its monotonic seq. */
  append(action: { type: string; payload?: unknown }, ts: number): number;
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

/** Replay journalled actions on top of a restored snapshot — pure. Re-reduces
 *  each action for its STATE transition only (effects are discarded), so I/O is
 *  never repeated. Entries are applied in seq order. */
export function replayJournal<S, A>(
  state: S,
  entries: JournalEntry[],
  reduce: (state: S, action: A) => { state: S },
): S {
  let s = state;
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    s = reduce(s, { type: e.type, payload: e.payload } as A).state;
  }
  return s;
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
  opts: { sync?: boolean } = {},
): Journal {
  const wmPath = path + ".wm";
  let seq = 0;
  let wm = 0;
  // Recover prior state on open.
  try {
    wm = parseInt(Deno.readTextFileSync(wmPath), 10) || 0;
  } catch { /* no watermark yet */ }
  try {
    const existing = parseJournal(Deno.readTextFileSync(path));
    for (const e of existing) if (e.seq > seq) seq = e.seq;
  } catch { /* no journal yet */ }
  if (wm > seq) seq = wm;

  const enc = new TextEncoder();
  const mode: Deno.WriteFileOptions = { append: true, create: true };

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
      writeLine(
        JSON.stringify({
          seq: s,
          type: action.type,
          payload: action.payload,
          ts,
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
      try {
        Deno.writeTextFileSync(wmPath, String(s));
      } catch { /* best-effort */ }
      // Compact: keep only the unpersisted tail (seq > wm). Atomic via rename.
      try {
        const keep = parseJournal(Deno.readTextFileSync(path)).filter((e) =>
          e.seq > s
        );
        const tmp = path + ".tmp";
        Deno.writeTextFileSync(
          tmp,
          keep.map((e) => JSON.stringify(e)).join("\n") +
            (keep.length ? "\n" : ""),
        );
        Deno.renameSync(tmp, path);
      } catch { /* compaction is an optimization — safe to skip */ }
    },
    currentSeq: () => seq,
    close() {/* writes are synchronous — nothing buffered */},
  };
}
