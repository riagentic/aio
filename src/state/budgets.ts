/**
 * @module
 * `budgets` — the limits an APP declares, in the units a person writes them in.
 *
 * ```ts
 * aio.run({ budgets: { cellState: "1MB", broadcastRate: "20/s" } })
 * ```
 *
 * A field report asked for this and said why it is strictly better than aio
 * picking a number for everyone (report 2 §9.3). A dashboard that pushes a 4 MB
 * table once a minute and a game loop that pushes 200 bytes at 60 Hz are both
 * healthy, and no single threshold calls them both correctly.
 *
 * NOT A SECOND MECHANISM. Every limit here already existed and was reachable —
 * `vitals.pressure.rateThreshold`, `vitals.pressure.payloadThreshold`, and a
 * hard-coded 1 MiB inside the broadcaster. That is the round's own
 * meta-finding, again: "aio's features are consistently better than aio's
 * discoverability." So `budgets` is one obvious door onto the machinery that
 * was already there, in human units, and an explicit `vitals.pressure` still
 * wins — the more specific instruction always does.
 *
 * `perfBudget` remains the TIMES (per-dispatch milliseconds). `budgets` is the
 * SIZES and RATES. Two blocks, each coherent, rather than one that means both.
 */

/** What an app may declare. Values are human strings or plain numbers.
 *
 *  A number means the base unit — bytes for a size, per-second for a rate — so
 *  `cellState: 1_048_576` and `cellState: "1MB"` are the same budget. */
export type Budgets = {
  /** Largest a single cell's serialized state may get before aio says so.
   *  `"1MB"`, `"512KB"`, or bytes. Cell state is pushed to every client on
   *  change, so this is the number that decides what a page costs. */
  cellState?: string | number;
  /** Broadcast rounds per second before aio says so. `"20/s"` or `20`. */
  broadcastRate?: string | number;
  /** Largest single broadcast payload to one client. `"500KB"` or bytes. */
  payload?: string | number;
};

/** Resolved budgets — every value in its base unit, absent when undeclared. */
export type ResolvedBudgets = {
  cellState?: number;
  broadcastRate?: number;
  payload?: number;
};

const SIZE_UNITS: Record<string, number> = {
  "": 1,
  b: 1,
  kb: 1024,
  k: 1024,
  mb: 1024 * 1024,
  m: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  g: 1024 * 1024 * 1024,
};

/** `"1MB"` / `"512kb"` / `1048576` → bytes. Throws on anything else.
 *
 *  THROWS, rather than falling back to a default. A budget is a number the app
 *  chose on purpose; silently substituting aio's own for a typo produces a
 *  limit nobody declared and nobody can see, which is worse than having none.
 *  `KB` here is 1024 bytes — the unit the rest of aio's output prints. */
export function parseSize(v: string | number, where: string): number {
  if (typeof v === "number") {
    if (Number.isFinite(v) && v > 0) return Math.floor(v);
    throw new Error(
      `budgets.${where}: ${v} is not a size — pass bytes as a positive ` +
        `number, or a string like "1MB" / "512KB".`,
    );
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|k|mb|m|gb|g)?\s*$/i.exec(v);
  const unit = SIZE_UNITS[(m?.[2] ?? "").toLowerCase()];
  if (!m || unit === undefined) {
    throw new Error(
      `budgets.${where}: ${JSON.stringify(v)} is not a size — write it as ` +
        `"1MB", "512KB", "2048" or a number of bytes.`,
    );
  }
  const n = Math.floor(Number(m[1]) * unit);
  if (!(n > 0)) {
    throw new Error(
      `budgets.${where}: ${JSON.stringify(v)} resolves to ${n} bytes — a ` +
        `budget of zero would refuse everything, including an empty cell.`,
    );
  }
  return n;
}

/** `"20/s"` / `"20 per second"` / `20` → per-second. Throws on anything else. */
export function parseRate(v: string | number, where: string): number {
  if (typeof v === "number") {
    if (Number.isFinite(v) && v > 0) return v;
    throw new Error(
      `budgets.${where}: ${v} is not a rate — pass a positive number, or a ` +
        `string like "20/s".`,
    );
  }
  const m =
    /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*s(?:ec(?:ond)?)?|\s*per\s+second)?\s*$/i
      .exec(v);
  if (!m) {
    throw new Error(
      `budgets.${where}: ${JSON.stringify(v)} is not a rate — write it as ` +
        `"20/s" or a number of events per second.`,
    );
  }
  const n = Number(m[1]);
  if (!(n > 0)) {
    throw new Error(
      `budgets.${where}: ${JSON.stringify(v)} resolves to ${n}/s — a budget ` +
        `of zero would refuse every broadcast, including the first.`,
    );
  }
  return n;
}

/** Parse a declared block. Throws at BOOT on anything unreadable, naming the
 *  key — a budget that failed to parse is a limit nobody can see. */
export function resolveBudgets(b: Budgets | undefined): ResolvedBudgets {
  if (!b) return {};
  const out: ResolvedBudgets = {};
  if (b.cellState !== undefined) {
    out.cellState = parseSize(b.cellState, "cellState");
  }
  if (b.payload !== undefined) out.payload = parseSize(b.payload, "payload");
  if (b.broadcastRate !== undefined) {
    out.broadcastRate = parseRate(b.broadcastRate, "broadcastRate");
  }
  return out;
}

/** One budget that was exceeded, with the worst reading seen. */
export type BudgetBreach = {
  budget: keyof ResolvedBudgets;
  limit: number;
  worst: number;
  detail?: string;
};

/** ONE APP's declared budgets and the breaches recorded against them.
 *
 *  A process can host several apps (library mode, `testApps`), and this was one
 *  module-level object: the last boot's `setBudgets` replaced everyone's limits
 *  and every app recorded into, and reported from, the same ledger. So app B's
 *  `cellState: "1KB"` made app A's `/health` "degraded" over A's own cell — a
 *  budget A never declared — and B reported a breach on a cell B did not have.
 *  Each boot now takes its own: `setBudgets` returns it. */
export type BudgetLedger = {
  /** The declared budgets, or an empty object when the app declared none. */
  declared(): ResolvedBudgets;
  /** Record that a declared budget was exceeded.
   *
   *  WHY THIS IS KEPT AND NOT ONLY LOGGED. A warning is for a person watching
   *  a dev server; a budget is a limit an app committed to, and the report
   *  asked for one that FAILS (report 2 §9.3). A log line cannot fail
   *  anything. This ledger is what `/health` reports, so a test or a CI step
   *  can assert on it — and it keeps the WORST reading rather than the latest,
   *  because "it went over once" is the fact, and a later healthy sample must
   *  not erase it.
   *
   *  Silently ignored when nothing was declared: aio's own defaults are hints,
   *  not commitments, and reporting them as breaches would make `/health`
   *  degraded on apps that never opted in. */
  record(
    budget: keyof ResolvedBudgets,
    measured: number,
    detail?: string,
  ): void;
  /** The budget verdict for `/health`, or `null` when the app declared none.
   *
   *  `null` rather than `{ ok: true }`: an app with no budgets has not passed
   *  them, it has not made any, and a green field for a promise nobody made
   *  reads as assurance. */
  report(): { ok: boolean; breaches: BudgetBreach[] } | null;
  /** Measure every cell's serialized size against a declared `cellState`
   *  budget.
   *
   *  Called from `/health`, because that is where the question is asked and
   *  the cost is therefore opt-in — zero when no budget is declared, and one
   *  `JSON.stringify` per cell when someone actually asks.
   *
   *  The broadcaster samples the same fact on its own path, and that is not
   *  two deciders: the LIMIT and the verdict live here, and those are two
   *  sampling points feeding one ledger. It matters that both exist — the
   *  broadcaster sees the cost that is actually paid (state is pushed to every
   *  client on change), and this one sees an app with no client connected,
   *  which would otherwise report a budget it had never once measured. */
  measureCellStates(state: unknown): void;
};

/** A ledger for `budgets` — a fresh, empty breach record. @internal */
export function createBudgetLedger(budgets: ResolvedBudgets): BudgetLedger {
  const breaches = new Map<string, BudgetBreach>();
  const record: BudgetLedger["record"] = (budget, measured, detail) => {
    const limit = budgets[budget];
    if (limit === undefined || measured <= limit) return;
    const prev = breaches.get(budget);
    if (prev && prev.worst >= measured) return;
    breaches.set(budget, { budget, limit, worst: measured, detail });
  };
  return {
    declared: () => budgets,
    record,
    report: () =>
      Object.keys(budgets).length === 0
        ? null
        : { ok: breaches.size === 0, breaches: [...breaches.values()] },
    measureCellStates: (state) => {
      if (budgets.cellState === undefined) return;
      if (state === null || typeof state !== "object") return;
      for (
        const [name, slice] of Object.entries(state as Record<string, unknown>)
      ) {
        let n = 0;
        try {
          n = JSON.stringify(slice)?.length ?? 0;
        } catch {
          continue; // aio-ok: an unserializable slice is never broadcast either
        }
        record("cellState", n, `cell "${name}"`);
      }
    },
  };
}

let _current: BudgetLedger = createBudgetLedger({});

/** The ledger an app's server hands its broadcaster, keyed by the same
 *  identity `warnBigFullState` already latches on (the app's `getUIState`). */
const _byOwner = new WeakMap<object, BudgetLedger>();

/** Tie `owner` (an app's `getUIState`) to that app's ledger. @internal */
export function _bindBudgetOwner(owner: object, ledger: BudgetLedger): void {
  _byOwner.set(owner, ledger);
}

/** `owner`'s ledger; the latest boot's when `owner` is absent or unbound —
 *  read synchronously inside a boot, right after its `setBudgets`, that is the
 *  booting app's. @internal */
export function budgetsFor(owner?: object): BudgetLedger {
  return (owner && _byOwner.get(owner)) ?? _current;
}

/** Set the declared budgets for the app booting now, and return ITS ledger —
 *  the one that app's health, broadcaster and pressure monitor must hold. */
export function setBudgets(b: ResolvedBudgets): BudgetLedger {
  return _current = createBudgetLedger(b);
}

/** Clear them — teardown, and between tests. A running app keeps the ledger
 *  its boot took. */
export function resetBudgets(): void {
  _current = createBudgetLedger({});
}
