// memory-ledger.ts — the registry that gives every growing byte a NAME.
//
// `memory-monitor.ts` can only speak about the numbers it samples, and until
// now it sampled `heapUsed` alone: the app's own JS heap. A leak in NATIVE
// memory — the runtime's outgoing buffers, SQLite's page cache, a replay that
// never returns — lived entirely outside that number, so the monitor reported a
// healthy app while it climbed past every ceiling and froze the machine for
// real (the crashed-sync-listeners boot: ~10 GB and climbing at ~2.7 cores,
// with a 540-byte journal and a 64 KB database — nothing the heap watcher, the
// per-cell breakdown, or `/__aio/health` could see). Watching the right number
// is half the fix; the other half is knowing WHICH series it was.
//
// Two kinds of series live here, and they are not the same shape:
//
//   • a LEVEL gauge is a CURRENT size — `broadcast.bufferedBytes`. It rises and
//     falls, so a sustained rise is a leak, and the monitor trends it.
//   • a COUNTER is CUMULATIVE work — `journal.replay.entries`. It only ever
//     grows, so trending it says nothing; what it needs is a CEILING. That is
//     `budget()`: spend past the ceiling and the caller throws, by name. A
//     series that can run away is a series that must be named when it does.
//
// Every gauge is O(1) to read — the monitor samples all of them on its timer,
// and `am heap` reads them on demand. Nothing here walks state; a ledger that
// made the leak worse would be the same joke one level up.

import { teachableError } from "./error.ts";
import { log } from "./logger-api.ts";

/** A gauge's unit — what its number counts. `bytes` and `count` are the two
 *  an aio subsystem ever produces; a third would be a new question to answer
 *  in the report, not a formality. */
export type GaugeUnit = "bytes" | "count";

/** A named series the monitor can sample. `kind` decides what may be asked of
 *  it: a `level` is trended for growth, a `counter` only for its ceiling. */
export type Gauge = {
  /** Stable, dotted, owner-prefixed — `broadcast.bufferedBytes`. Stable
   *  because the report and `/__aio/metrics` key on it; dotted because
   *  `budget()` reads the owner from the prefix. */
  name: string;
  /** Who owns the series — the SOURCE in "which subsystem is leaking". */
  owner: string;
  unit: GaugeUnit;
  kind: "level" | "counter";
  /** When set, a reading above this is a breach, said out loud (see
   *  `budget()`). A `level` may carry one too; the monitor only grows-trends
   *  what it can trust to come back down. */
  bound?: number;
  read: () => number;
};

/** One sampled gauge — what a surface (`am heap`, `/__aio/metrics`) renders. */
export type GaugeReading = {
  name: string;
  owner: string;
  unit: GaugeUnit;
  kind: "level" | "counter";
  value: number;
  bound?: number;
};

/** How many distinct series may be watched at once. The registry is wired by
 *  aio itself, not by app code, so this is a guard against a future bug —
 *  a gauge built per room/connection/resource — and not a limit an app can
 *  reach. Said once, because a cap that evicts silently is the defect this
 *  whole module exists to refuse. */
const GAUGE_CAP = 64;

const _gauges = new Map<string, Gauge>();
let _capWarned = false;

/** Watch a named series. Same name ⇒ first registration wins: a second owner
 *  claiming a name has NOT been wired to this series, and re-pointing the name
 *  at it would make `am heap` report a number that belongs to someone else. */
export function registerGauge(g: Gauge): void {
  if (_gauges.has(g.name)) return;
  if (_gauges.size >= GAUGE_CAP) {
    if (!_capWarned) {
      _capWarned = true;
      log.warn(
        "memory",
        `memory-ledger: more than ${GAUGE_CAP} gauges are registered — ` +
          `ignoring "${g.name}". A gauge per resource is a leak with a name; ` +
          `register stable, bounded series only.`,
      );
    }
    return;
  }
  _gauges.set(g.name, g);
}

/** Read every registered gauge once — a snapshot, not a subscription. This is
 *  the single call the monitor, `am heap`, and `/__aio/metrics` share, so all
 *  three answer from the same numbers and cannot disagree. */
export function readGauges(): GaugeReading[] {
  const out: GaugeReading[] = [];
  for (const g of _gauges.values()) {
    let value: number;
    try {
      value = g.read();
    } catch {
      // A reader that throws (a subsystem mid-teardown) is reported as
      // unknown, not allowed to take down the report that exists to show
      // what is wrong.
      out.push({ ...g, value: -1 });
      continue;
    }
    out.push({
      name: g.name,
      owner: g.owner,
      unit: g.unit,
      kind: g.kind,
      value,
      ...(g.bound !== undefined ? { bound: g.bound } : {}),
    });
  }
  return out;
}

/** A named counter with a hard ceiling. `spend()` past the ceiling throws —
 *  by name — so a loop that would run forever stops at a stated bound instead
 *  of eating the machine in silence. The running value is registered as a
 *  `counter` gauge, so a breach is also visible on `am heap` and metrics. */
export type Budget = {
  /** Add to the counter. Throws `MEMORY_UNBOUNDED` (a teachable error naming
   *  the series and its ceiling) the moment the ceiling is passed. */
  spend(n?: number): void;
  /** The current value, without spending. */
  value(): number;
  /** The ceiling this budget was created with. */
  readonly max: number;
  /** Back to zero. For a per-boot or per-session series; not a concealment —
   *  the ceiling is unchanged. */
  reset(): number;
};

/** Create (or return) the budget for a series. One budget per name: a second
 *  `budget()` call for a name that already exists shares the first's counter
 *  and ceiling, so two call sites cannot silently halve a ceiling by racing. */
const _budgets = new Map<string, Budget>();

export function budget(
  name: string,
  max: number,
  opts: { unit?: GaugeUnit; owner?: string } = {},
): Budget {
  if (!(typeof max === "number" && Number.isFinite(max) && max > 0)) {
    throw teachableError(
      `memory-ledger: budget("${name}") needs a finite, positive ceiling ` +
        `(got ${max}). A ceiling of 0/NaN/Infinity is no ceiling at all — ` +
        `the exact bug the budget exists to catch.`,
      'Pass the real maximum for the series, e.g. budget("x", 1_000_000).',
    );
  }
  const existing = _budgets.get(name);
  if (existing) return existing;

  const unit: GaugeUnit = opts.unit ?? "count";
  const owner = opts.owner ?? name.split(".")[0] ?? name;
  let used = 0;
  const b: Budget = {
    spend(n = 1): void {
      used += n;
      if (used > max) {
        throw teachableError(
          `memory: "${name}" passed its ceiling — ${used} > ${max} ${unit}. ` +
            `This series is meant to reset between boots/jobs and has not, so ` +
            `whatever feeds it is looping. It is a COUNTER (cumulative work), ` +
            `not a heap size, so this is a control-flow bug, not a memory ` +
            `setting to raise.`,
          `Find the loop that keeps calling into "${name}" — the counter's ` +
            `owner ("${owner}") and the stack trace name the site. ` +
            `\`am heap\` and /__aio/metrics show every watched series.`,
          "docs/debugging/performance.md",
        );
      }
    },
    value: () => used,
    max,
    reset: () => (used = 0),
  };
  _budgets.set(name, b);
  registerGauge({
    name,
    owner,
    unit,
    kind: "counter",
    bound: max,
    read: () => used,
  });
  return b;
}

/** Test isolation — drop every gauge and budget so a case cannot inherit a
 *  series (or a spent counter) from the one before it. */
export function _resetMemoryLedger(): void {
  _gauges.clear();
  _budgets.clear();
  _capWarned = false;
}
