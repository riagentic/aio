/**
 * @module
 * Cost meter — what does aio move on your behalf, and where does it come from.
 *
 * THE HOLE THIS FILLS. aio tells every app its state might be too big, in three
 * places: `aiol` flags a large typed array, `aiol`'s summary counts state keys
 * across cells, and the pressure monitor says to "reduce state size, raise
 * syncIntervalMs, or use cell-level ui filters". It ships all three remedies —
 * and no way to find out whether you have the condition. A hint you cannot
 * triage gets skipped, every round, until it is noise (llama.md's `am cost`
 * proposal, argued from aio's own code rather than from one app).
 *
 * WHAT IT MEASURES, AND HOW EXACTLY.
 *
 *  • **wire bytes** — the exact byte length of every frame handed to a socket.
 *    Not an estimate: the same string `ws.send()` receives. This is the number a
 *    correctness test can hold against a real client counting inbound bytes.
 *  • **attribution** — for a patch, the serialized size of each changed key's
 *    value, per cell. This is the half no app can compute for itself: which cell
 *    caused a push, and which keys were in the diff, exists only inside the
 *    broadcast path. "You push 24 KB/s" makes you worry; "19 KB of it is
 *    hw.cpuHistory" tells you what to do.
 *  • **reduce time** — per cell, from the timings the dispatch loop already
 *    produces.
 *
 * Attribution counts payload CONTENT; wire bytes include the envelope and the
 * JSON-Patch paths around it. The two are reported separately and never added
 * together, because a plausible-but-wrong number is worse than no number: people
 * act on it.
 *
 * ALWAYS ON, BOUNDED. A counter increment and a ring buffer on a path that is
 * already serializing. A diagnostic you must remember to enable is one you do not
 * have when you need it — and this question gets asked *after* something feels
 * slow. Memory is a fixed-size ring per stream, like `loop-probe`; this answers
 * "what is happening now", while the journal and time-travel own "what happened
 * then".
 *
 * NOT: a profiler, render timing (`render-meter` owns that), historical storage,
 * or advice. `aiol` owns the opinions; this makes them checkable.
 */

/** One frame that actually went to a socket. */
export type SendSample = {
  at: number;
  /** Exact byte length of the frame handed to `ws.send()`. */
  bytes: number;
  /** Client this went to — the same id `am clients` shows. */
  clientId: string;
  /** What the frame WAS. `other` is acks, diagnostics and time-travel frames:
   *  they cost wire bytes but are not state pushes, and counting them as full
   *  resends would report "most frames send the whole state" about traffic that
   *  is mostly 40-byte acknowledgements. */
  kind: "patch" | "full" | "other";
};

/** Per-key attribution for one broadcast round (computed once, not per client). */
export type AttributionSample = {
  at: number;
  cell: string;
  /** Top-level key within the cell, or "*" when a whole slice was resent. */
  key: string;
  /** Serialized size of that key's value in the payload. */
  bytes: number;
};

/** Reduce timing for one action. */
export type ReduceSample = { at: number; cell: string; ms: number };

export type CellCost = {
  cell: string;
  /** Frames per second attributable to this cell's changes. */
  pushesPerSec: number;
  /** Payload content bytes per second from this cell (attribution). */
  bytesPerSec: number;
  /** Mean content bytes per push. */
  meanBytes: number;
  /** p95 reduce time (ms) for this cell's actions in the window. */
  p95ReduceMs: number;
  /** Mean reduce time (ms). */
  meanReduceMs: number;
  /** Keys ordered by bytes contributed, biggest first. */
  keys: { key: string; bytes: number; bytesPerSec: number; pushes: number }[];
  /** How many of this cell's pushes were whole-slice resends. */
  fullResends: number;
};

export type CostReport = {
  /** Window actually covered, in seconds (never longer than the ring holds). */
  windowSec: number;
  /** True when the ring wrapped — the window is a floor, not the whole story. */
  truncated: boolean;
  cells: CellCost[];
  /** EXACT wire totals — the bytes that crossed sockets in the window. */
  wire: {
    bytesPerSec: number;
    /** Per connected client, i.e. what one surface costs. */
    bytesPerSecPerClient: number;
    framesPerSec: number;
    /** Share of STATE PUSHES (patch + full) that resent the whole state.
     *  Acks and diagnostics are excluded — they are not pushes. */
    fullResendShare: number;
    /** Frame counts by kind, so the split is inspectable rather than implied. */
    byKind: { patch: number; full: number; other: number };
    /** Bytes per kind — `other` is the share no cell accounts for. */
    bytesByKind: { patch: number; full: number; other: number };
    totalBytes: number;
    frames: number;
  };
  clients: number;
  /** Cells that produced nothing in the window — "nothing here" is a result. */
  idleCells: string[];
};

/** Ring buffer that keeps the newest `cap` items with O(1) push. */
class Ring<T> {
  #items: T[] = [];
  #head = 0;
  #wrapped = false;
  constructor(private cap: number) {}
  push(item: T): void {
    if (this.#items.length < this.cap) {
      this.#items.push(item);
      return;
    }
    this.#items[this.#head] = item;
    this.#head = (this.#head + 1) % this.cap;
    this.#wrapped = true;
  }
  /** Newest-first is irrelevant here; callers filter by timestamp. */
  all(): T[] {
    return this.#items;
  }
  get wrapped(): boolean {
    return this.#wrapped;
  }
  clear(): void {
    this.#items = [];
    this.#head = 0;
    this.#wrapped = false;
  }
}

const DEFAULT_SENDS = 4096;
const DEFAULT_ATTRIBUTIONS = 8192;
const DEFAULT_REDUCES = 2048;

export interface CostMeter {
  recordSend(bytes: number, clientId: string, kind: SendSample["kind"]): void;
  recordAttribution(cell: string, key: string, bytes: number): void;
  recordReduce(cell: string, ms: number): void;
  /** Cells that exist, so idle ones can be shown as idle rather than missing. */
  setKnownCells(cells: string[]): void;
  setClientCount(n: number): void;
  report(
    opts?: { windowSec?: number; cell?: string; now?: number },
  ): CostReport;
  reset(): void;
}

export function createCostMeter(opts: {
  sends?: number;
  attributions?: number;
  reduces?: number;
  now?: () => number;
} = {}): CostMeter {
  const now = opts.now ?? (() => Date.now());
  const sends = new Ring<SendSample>(opts.sends ?? DEFAULT_SENDS);
  const attribs = new Ring<AttributionSample>(
    opts.attributions ?? DEFAULT_ATTRIBUTIONS,
  );
  const reduces = new Ring<ReduceSample>(opts.reduces ?? DEFAULT_REDUCES);
  let knownCells: string[] = [];
  let clients = 0;

  const p95 = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.max(0, Math.ceil(s.length * 0.95) - 1)]!;
  };

  return {
    recordSend(bytes, clientId, kind) {
      sends.push({ at: now(), bytes, clientId, kind });
    },
    recordAttribution(cell, key, bytes) {
      attribs.push({ at: now(), cell, key, bytes });
    },
    recordReduce(cell, ms) {
      reduces.push({ at: now(), cell, ms });
    },
    setKnownCells(cells) {
      knownCells = [...cells];
    },
    setClientCount(n) {
      clients = n;
    },
    reset() {
      sends.clear();
      attribs.clear();
      reduces.clear();
    },
    report(o = {}) {
      const t = o.now ?? now();
      const windowSec = o.windowSec ?? 60;
      const from = t - windowSec * 1000;
      const inWindow = <T extends { at: number }>(xs: T[]) =>
        xs.filter((x) => x.at >= from);

      const sendRows = inWindow(sends.all());
      const attribRows = inWindow(attribs.all()).filter((a) =>
        !o.cell || a.cell === o.cell
      );
      const reduceRows = inWindow(reduces.all()).filter((r) =>
        !o.cell || r.cell === o.cell
      );

      // The measured span: with a partly-filled ring the true window is the
      // age of the oldest sample, and reporting per-second rates over a window
      // that never happened would inflate every number.
      const oldest = Math.min(
        ...[sendRows, attribRows, reduceRows]
          .flatMap((rows) => (rows.length > 0 ? [rows[0]!.at] : [])),
        t,
      );
      const spanSec = Math.max((t - oldest) / 1000, 0.001);
      const effectiveSec = Math.min(windowSec, Math.max(spanSec, 0.001));

      const byCell = new Map<string, {
        bytes: number;
        pushes: Set<number>;
        keys: Map<string, { bytes: number; pushes: number }>;
        full: number;
      }>();
      // One broadcast round can attribute several keys at the same instant;
      // counting distinct timestamps per cell counts PUSHES, not key-writes.
      for (const a of attribRows) {
        let e = byCell.get(a.cell);
        if (!e) {
          e = { bytes: 0, pushes: new Set(), keys: new Map(), full: 0 };
          byCell.set(a.cell, e);
        }
        e.bytes += a.bytes;
        e.pushes.add(a.at);
        if (a.key === "*") e.full++;
        const k = e.keys.get(a.key) ?? { bytes: 0, pushes: 0 };
        k.bytes += a.bytes;
        k.pushes++;
        e.keys.set(a.key, k);
      }

      const reduceByCell = new Map<string, number[]>();
      for (const r of reduceRows) {
        const arr = reduceByCell.get(r.cell) ?? [];
        arr.push(r.ms);
        reduceByCell.set(r.cell, arr);
      }

      const names = new Set<string>([
        ...byCell.keys(),
        ...reduceByCell.keys(),
        ...(o.cell
          ? (knownCells.includes(o.cell) ? [o.cell] : [])
          : knownCells),
      ]);

      const cells: CellCost[] = [...names].map((cell) => {
        const e = byCell.get(cell);
        const ms = reduceByCell.get(cell) ?? [];
        const pushes = e ? e.pushes.size : 0;
        return {
          cell,
          pushesPerSec: pushes / effectiveSec,
          bytesPerSec: (e?.bytes ?? 0) / effectiveSec,
          meanBytes: pushes > 0 ? (e!.bytes / pushes) : 0,
          p95ReduceMs: p95(ms),
          meanReduceMs: ms.length > 0
            ? ms.reduce((a, b) => a + b, 0) / ms.length
            : 0,
          fullResends: e?.full ?? 0,
          keys: [...(e?.keys ?? new Map())]
            .map(([key, v]) => ({
              key,
              bytes: v.bytes,
              bytesPerSec: v.bytes / effectiveSec,
              pushes: v.pushes,
            }))
            .sort((a, b) => b.bytes - a.bytes),
        };
      }).sort((a, b) =>
        b.bytesPerSec - a.bytesPerSec || (a.cell < b.cell ? -1 : 1)
      );

      const totalBytes = sendRows.reduce((s, x) => s + x.bytes, 0);
      const byKind = {
        patch: sendRows.filter((s) => s.kind === "patch").length,
        full: sendRows.filter((s) => s.kind === "full").length,
        other: sendRows.filter((s) => s.kind === "other").length,
      };
      // BYTES per kind, not only counts. Counting alone hid the thing this
      // whole command exists to reveal: a report can show every cell costing
      // a few hundred B/s while the socket carries a hundred KB/s, and with
      // only "(+302 acks/diagnostics)" to explain the gap the natural reading
      // is "my cells are cheap, all good". The unattributed share has to be a
      // number in the same units as the rest.
      const bytesByKind = {
        patch: sendRows.filter((s) => s.kind === "patch")
          .reduce((n, s) => n + s.bytes, 0),
        full: sendRows.filter((s) => s.kind === "full")
          .reduce((n, s) => n + s.bytes, 0),
        other: sendRows.filter((s) => s.kind === "other")
          .reduce((n, s) => n + s.bytes, 0),
      };
      const pushes = byKind.patch + byKind.full;

      return {
        windowSec: Math.round(effectiveSec * 100) / 100,
        truncated: sends.wrapped || attribs.wrapped || reduces.wrapped,
        cells,
        wire: {
          bytesPerSec: totalBytes / effectiveSec,
          bytesPerSecPerClient: clients > 0
            ? totalBytes / effectiveSec / clients
            : totalBytes / effectiveSec,
          framesPerSec: sendRows.length / effectiveSec,
          fullResendShare: pushes > 0 ? byKind.full / pushes : 0,
          byKind,
          bytesByKind,
          totalBytes,
          frames: sendRows.length,
        },
        clients,
        // Idle = it PUSHED nothing. Reduce time does not disqualify: a cell can
        // burn 3ms reducing and still cost the wire nothing, and that
        // combination ("busy but free") is one of the more useful things this
        // report can say. The proposal's own sketch marks such a cell idle.
        idleCells: cells.filter((c) =>
          c.pushesPerSec === 0 && c.bytesPerSec === 0
        ).map((c) => c.cell),
      };
    },
  };
}
