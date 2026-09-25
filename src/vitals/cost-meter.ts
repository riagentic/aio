/**
 * @module
 * Cost meter — what does aio move on your behalf, and where does it come from.
 *
 * THE HOLE THIS FILLS. aio tells every app its state might be too big, in three
 * places: `aiol` flags a large typed array, `aiol`'s summary counts state keys
 * across cells, and the pressure monitor says to "reduce state size, raise
 * syncIntervalMs, or use cell-level ui filters". It ships all three remedies —
 * and no way to find out whether you have the condition. A hint you cannot
 * triage gets skipped, every round, until it is noise (one app's `am cost`
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
  /** Which broadcast ROUND produced this sample. A cell's "pushes" is the count
   *  of distinct rounds it appeared in, and the round has to be told to the
   *  meter rather than inferred: rounds were previously distinguished by their
   *  millisecond timestamp, so two rounds landing in the same millisecond
   *  collapsed into one — under-counting pushes and over-reporting mean
   *  bytes/push by the same factor, exactly under the load where the number
   *  matters. `beginRound()` mints it. */
  round: number;
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
  /** True when a ring dropped samples from INSIDE the window — the window is
   *  then a floor, not the whole story. A ring that wrapped long before the
   *  window began has lost nothing from it. */
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
  /** OLDEST FIRST — always. `report()` takes the measured window from
   *  `rows[0].at`, so physical order was not an implementation detail: once the
   *  ring wrapped, `#items[0]` was the NEWEST-but-one element, the measured
   *  span collapsed to near zero, and every per-second figure in `am cost` was
   *  inflated by it (worst case the divisor hit the 0.001s floor and the report
   *  claimed thousands of times the real rate). Rotating on read costs one copy
   *  of a bounded buffer, on a command a human typed. */
  all(): T[] {
    if (!this.#wrapped) return this.#items;
    // After a wrap `#head` is the slot due to be overwritten next — i.e. the
    // OLDEST element still held.
    return [
      ...this.#items.slice(this.#head),
      ...this.#items.slice(0, this.#head),
    ];
  }
  get wrapped(): boolean {
    return this.#wrapped;
  }
  /** The oldest element still held, without copying the buffer. */
  oldest(): T | undefined {
    return this.#wrapped ? this.#items[this.#head] : this.#items[0];
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
  /** Mint the id for one broadcast round. Every attribution for that round
   *  passes it back, so "pushes" counts ROUNDS rather than timestamps. */
  beginRound(): number;
  recordAttribution(
    cell: string,
    key: string,
    bytes: number,
    round: number,
  ): void;
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
  let round = 0;
  /** When this meter started watching (creation, or the last `reset()`). */
  let observedSince = now();

  const p95 = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.max(0, Math.ceil(s.length * 0.95) - 1)]!;
  };

  return {
    recordSend(bytes, clientId, kind) {
      sends.push({ at: now(), bytes, clientId, kind });
    },
    beginRound() {
      return ++round;
    },
    recordAttribution(cell, key, bytes, round) {
      attribs.push({ at: now(), cell, key, bytes, round });
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
      observedSince = now();
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

      // THE MEASURED SPAN, PER SERIES. A meter younger than the requested
      // window has not watched that long, and dividing by a window that never
      // happened would under-report every number.
      //
      // It used to be ONE span, `Math.min` across all three rings — which
      // divided each numerator by somebody else's denominator. Two measured
      // consequences, both silent:
      //
      //  • the rings fill at different rates (sends far faster than reduces,
      //    which is the normal state of a busy server), so a WRAPPED send
      //    ring covering 1s was divided by the reduce ring's 10s:
      //    `wire.bytesPerSec` read 1000 where the truth was 10000. A 10x
      //    under-report, with only `truncated: true` to hint at it.
      //  • `attribRows`/`reduceRows` are filtered by `--cell` and `sendRows`
      //    are not, so narrowing to one cell shrank the denominator of a
      //    numerator that still covered every cell: the SAME traffic reported
      //    1000 B/s unfiltered and 10000 B/s with `--cell=b`.
      //
      // So each rate divides by the span of the series it came from, and by
      // the UNFILTERED span — `--cell` selects which rows to total, never how
      // long we were watching. This module's header says a
      // plausible-but-wrong number is worse than no number.
      //
      // And the span STARTS where observation started, not at the oldest
      // sample. A ring that never dropped anything has seen every event since
      // the meter began, so a quiet stretch before a burst is part of the
      // window: dividing by `t - oldest` instead turned one 500 B send on a
      // long-running server into "500000 B/s" (the span collapsed to the 1ms
      // floor), and a single send read half a second later into 200 B/s over
      // a 10 s window whose truth was 10. Only a WRAPPED ring has a later
      // start — its oldest retained sample, since everything before it is gone.
      const allAttribRows = inWindow(attribs.all());
      const allReduceRows = inWindow(reduces.all());
      const spanOf = <T extends { at: number }>(ring: Ring<T>) => {
        const start = ring.wrapped
          ? (ring.oldest()?.at ?? observedSince)
          : observedSince;
        return Math.min(windowSec, Math.max((t - start) / 1000, 0.001));
      };
      // A WRAPPED ring still estimates: N samples spanning `t - oldest`
      // over-states the rate by N/(N-1), because the oldest sample marks
      // where observation began rather than an event inside the span. Under
      // 1% at the hundreds of frames a busy server produces, and `truncated`
      // says the window was cut — but it is an estimate, not a measurement,
      // and worth knowing before anyone treats the last digit as exact.
      /** Denominator for everything counted out of the SEND ring. */
      const sendSec = spanOf(sends);
      /** …and for everything counted out of the ATTRIBUTION ring. */
      const attribSec = spanOf(attribs);
      // Reported as the window this answer covers: the widest series that has
      // something in it. An EMPTY series has watched since the meter started
      // and would always be the widest, so the report would claim the
      // meter's whole uptime while its every number came from a wrapped ring
      // covering a second.
      const withRows = [
        [sendRows, sendSec],
        [allAttribRows, attribSec],
        [allReduceRows, spanOf(reduces)],
      ] as const;
      const effectiveSec = withRows.some(([rows]) => rows.length > 0)
        ? Math.max(
          ...withRows.filter(([rows]) => rows.length > 0).map(([, sec]) => sec),
        )
        : Math.min(windowSec, Math.max((t - observedSince) / 1000, 0.001));

      const byCell = new Map<string, {
        bytes: number;
        pushes: Set<number>;
        keys: Map<string, { bytes: number; pushes: number }>;
        full: number;
      }>();
      // One broadcast round attributes several keys, so a cell's PUSHES is the
      // number of distinct ROUNDS it appeared in — not the number of
      // key-writes, and not the number of distinct millisecond timestamps
      // (which merged any two rounds that landed inside the same millisecond).
      for (const a of attribRows) {
        let e = byCell.get(a.cell);
        if (!e) {
          e = { bytes: 0, pushes: new Set(), keys: new Map(), full: 0 };
          byCell.set(a.cell, e);
        }
        e.bytes += a.bytes;
        e.pushes.add(a.round);
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
          pushesPerSec: pushes / attribSec,
          bytesPerSec: (e?.bytes ?? 0) / attribSec,
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
              bytesPerSec: v.bytes / attribSec,
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
        // A ring that wrapped only lost samples INSIDE this window when what
        // it still holds starts at or after the window's start. "Has ever
        // wrapped" is the normal state of any long-running app, so that alone
        // told every `am cost --window=10s` on a busy server that "older
        // samples dropped" out of a window its rings covered many times over.
        truncated: [sends, attribs, reduces].some((ring) =>
          ring.wrapped && (ring.oldest()?.at ?? Infinity) >= from
        ),
        cells,
        wire: {
          bytesPerSec: totalBytes / sendSec,
          bytesPerSecPerClient: clients > 0
            ? totalBytes / sendSec / clients
            : totalBytes / sendSec,
          framesPerSec: sendRows.length / sendSec,
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
