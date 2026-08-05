// schedule.ts — declarative timers/delays/cron as effects
// Two use cases: config-level always-on schedules, dynamic effects from reducer

import { blocking } from "./blocking.ts";

// ── Types ────────────────────────────────────────────────────────────

/** Effect union for scheduled actions — returned from reducers, handled by the runtime */
export type ScheduleEffect =
  | {
    type: "__schedule";
    kind: "after";
    id: string;
    ms: number;
    action: { type: string; payload?: unknown };
  }
  | {
    type: "__schedule";
    kind: "every";
    id: string;
    ms: number;
    action: { type: string; payload?: unknown };
    /** Skip a tick while the previous one is still running. */
    skipIfRunning?: boolean;
  }
  | {
    type: "__schedule";
    kind: "at";
    id: string;
    time: string;
    action: { type: string; payload?: unknown };
  }
  | {
    type: "__schedule";
    kind: "cron";
    id: string;
    pattern: string;
    action: { type: string; payload?: unknown };
  }
  | { type: "__schedule"; kind: "cancel"; id: string };

/** Config-level schedule definition — passed to aio.run({ schedules: [...] }) */
export type ScheduleDef =
  & { id: string; action: { type: string; payload?: unknown } }
  & {
    /** Skip a tick while the previous one is still running (`every` only).
     *
     *  Declared here as well as on `schedule.every()` because THIS is the shape
     *  apps actually use: `aio.run({ schedules: [...] })` is what `am create`
     *  scaffolds and what the docs show. Shipping the option only on the
     *  imperative form meant every declarative poller kept the hand-rolled
     *  `if (s.refreshing) return` the feature exists to delete — the fix landed
     *  on the API nobody was using. */
    skipIfRunning?: boolean;
  }
  & (
    | { every: number }
    | { after: number }
    | { at: string }
    | { cron: string }
  );

// ── The timer ceiling — ONE decider ─────────────────────────────────

/** The largest delay `setTimeout` can represent: its delay is stored in an
 *  int32, and V8 TRUNCATES anything past this — a 35-day delay becomes
 *  "Timeout duration was set to 1" and fires on the next tick.
 *
 *  So this number is not a nicety: without a clamp, a long timer does the
 *  opposite of what it says. `schedule.at` and `schedule.cron` each carried
 *  their own private copy of the guard and `schedule.after` never got one, so
 *  `after('reminder', 35 days)` and `backoff('rpc', 22, { base: 1000 })` both
 *  dispatched IMMEDIATELY — the second turning a rate-limit backoff into a hot
 *  loop aimed at the very API it was backing off from. One constant, one
 *  arming path (`armDeadline` below), used by after/at/cron alike.
 *  @internal */
export const MAX_TIMER_DELAY = 2_147_483_647; // 2^31-1 ms ≈ 24.85 days

/** How often a beyond-ceiling timer re-checks how far away its deadline is. */
const RECHECK_MS = 86_400_000; // 24h

// ── Effect creators (pure) ──────────────────────────────────────────

/** The action a schedule fires — a plain `{ type, payload }` object.
 *  `SA<A>` rejects the RESULT of calling a method (a Promise) at compile
 *  time with a teaching message: writing
 *  `schedule.after('t', 5000, cell.tick())` calls the method NOW and passes
 *  its Promise; the fix is `{ type: "cell:tick" }`. */
type ScheduleAction = { type: string; payload?: unknown };
type SA<A> = A extends PromiseLike<unknown> ? {
    "⚠️ you CALLED the method — schedule takes an action OBJECT":
      "use cell.method.action(...) (or { type: 'cell:method', payload }) instead of cell.method()";
  }
  : ScheduleAction;

/** Effect creators for declarative scheduling — use in reducers to schedule/cancel timers.
 * @example
 * ```ts
 * return [schedule.after('save-timeout', 3000, A.save())]
 * return [schedule.cron('daily-report', '0 8 * * *', A.report())]
 * return [schedule.cancel('save-timeout')]
 * ``` */
export const schedule = {
  after: <A>(
    id: string,
    ms: number,
    action: ScheduleAction & SA<A> | A & SA<A>,
  ): ScheduleEffect => ({
    type: "__schedule",
    kind: "after",
    id,
    ms,
    action: action as ScheduleAction,
  }),
  /** Repeat `action` every `ms`.
   *
   *  `{ skipIfRunning: true }` drops a tick while the previous one is still in
   *  flight — the guard every polling cell otherwise opens with
   *  (`if (s.refreshing) return`). Hand-rolled, that guard needs a state field,
   *  a reset in a `finally`, and it leaks a stuck `true` if the method throws
   *  between them; the scheduler already knows when the dispatch settles, so it
   *  can own the whole thing.
   *
   *  Opt-in, not the default: silently skipping a tick that used to fire would
   *  be a behaviour change for existing apps, and a schedule that overlaps ON
   *  PURPOSE (independent one-shot work per tick) is legitimate. */
  every: <A>(
    id: string,
    ms: number,
    action: ScheduleAction & SA<A> | A & SA<A>,
    opts?: { skipIfRunning?: boolean },
  ): ScheduleEffect => ({
    type: "__schedule",
    kind: "every",
    id,
    ms,
    action: action as ScheduleAction,
    ...(opts?.skipIfRunning ? { skipIfRunning: true } : {}),
  }),
  at: <A>(
    id: string,
    time: string,
    action: ScheduleAction & SA<A> | A & SA<A>,
  ): ScheduleEffect => ({
    type: "__schedule",
    kind: "at",
    id,
    time,
    action: action as ScheduleAction,
  }),
  cron: <A>(
    id: string,
    pattern: string,
    action: ScheduleAction & SA<A> | A & SA<A>,
  ): ScheduleEffect => ({
    type: "__schedule",
    kind: "cron",
    id,
    pattern,
    action: action as ScheduleAction,
  }),
  /** Exponential backoff — a one-shot `after` whose delay grows
   *  with `attempt`: `min(base * factor^attempt, max)` ms. Track `attempt` in
   *  cell state (bump on failure, reset to 0 on success) and re-issue this each
   *  cycle. Owns the retry arithmetic so pollers stop re-deriving the backoff
   *  dance by hand.
   *
   *  `max` is optional and defaults to the timer ceiling (`MAX_TIMER_DELAY`,
   *  ~24.85 days) — an unbounded `base * factor^attempt` reaches 10^15 ms by
   *  attempt 40, which is not a delay anyone means. Pass an explicit `max`
   *  (60_000 is the usual one) for a real ceiling.
   * @example
   * ```ts
   * // reducer, on tick: poll; on failure bump attempt and reschedule
   * return [schedule.backoff('rpc', s.attempt, { base: 1000, max: 60000 }, A.poll())]
   * ``` */
  backoff: (
    id: string,
    attempt: number,
    opts: { base: number; max?: number; factor?: number },
    action: ScheduleAction,
  ): ScheduleEffect => {
    const factor = opts.factor ?? 2;
    const max = opts.max ?? MAX_TIMER_DELAY;
    const ms = Math.min(
      opts.base * Math.pow(factor, Math.max(0, attempt)),
      max,
    );
    return {
      type: "__schedule",
      kind: "after",
      id,
      ms: Math.max(1, Math.round(ms)),
      action,
    };
  },
  /** A self-pacing poller. Re-issue each cycle with the current
   *  `attempt` — 0 while healthy, bumped on failure. It polls every `every` ms,
   *  and on repeated failures backs off by `backoff`^attempt up to `max`. A
   *  first-class replacement for the hand-rolled after-chain that RPC
   *  rate-limit foot-guns come from. `backoff` defaults to 1 (constant polling),
   *  and `max` to the timer ceiling (`MAX_TIMER_DELAY`, ~24.85 days) so a
   *  runaway `attempt` cannot compute a delay no timer can hold.
   * @example
   * ```ts
   * // on tick: do the poll; on success set attempt=0, on failure attempt+1,
   * // then reschedule — the delay self-adjusts.
   * return [schedule.poll('rpc', s.attempt, { every: 5000, backoff: 2, max: 60000 }, A.tick())]
   * ``` */
  poll: (
    id: string,
    attempt: number,
    opts: { every: number; backoff?: number; max?: number },
    action: { type: string; payload?: unknown },
  ): ScheduleEffect => {
    const factor = opts.backoff ?? 1;
    const max = opts.max ?? MAX_TIMER_DELAY;
    const ms = attempt <= 0
      ? opts.every
      : Math.min(opts.every * Math.pow(factor, attempt), max);
    return {
      type: "__schedule",
      kind: "after",
      id,
      ms: Math.max(1, Math.round(ms)),
      action,
    };
  },
  /** Defer an action to the next tick — the honest primitive for "run this
   *  right after the current method returns" (a field report: apps were writing
   *  `schedule.after(id, 1, …)` as a sentinel because a 0ms delay is rejected).
   *  Same-id replace still applies, so it dedups. */
  next: (
    id: string,
    action: { type: string; payload?: unknown },
  ): ScheduleEffect => ({
    type: "__schedule",
    kind: "after",
    id,
    ms: 1,
    action,
  }),
  cancel: (id: string): ScheduleEffect => ({
    type: "__schedule",
    kind: "cancel",
    id,
  }),
  /** Run a SELF-CONTAINED function OFF the main isolate on a named, cancellable,
   *  backpressured worker pool — for FFI/CPU/sync work that would otherwise
   *  freeze rendering. Imperative (returns a Promise), unlike the
   *  effect creators above. The fn is serialized to source: no closures; `arg`
   *  and the result must be structured-cloneable; do `Deno.dlopen` inside it.
   *  `schedule.blocking.cancel(id)` stops it; `schedule.blocking.dispose()`
   *  tears the pool down. See src/state/blocking.ts. */
  blocking,
};

/** Type guard — returns true if the value is a ScheduleEffect (type === "__schedule"). */
export function isScheduleEffect(e: unknown): e is ScheduleEffect {
  return !!e && typeof e === "object" &&
    (e as Record<string, unknown>).type === "__schedule";
}

// ── Cron parser ─────────────────────────────────────────────────────

/** Parsed cron expression — expanded arrays of valid minute, hour, day-of-month, month, and day-of-week values. */
export type CronFields = {
  minute: number[]; // 0-59
  hour: number[]; // 0-23
  dom: number[]; // 1-31
  month: number[]; // 1-12
  dow: number[]; // 0-6 (Sun=0)
};

function parseField(field: string, min: number, max: number): number[] {
  const values: number[] = [];
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "*") {
      for (let i = min; i <= max; i++) values.push(i);
    } else if (trimmed.startsWith("*/")) {
      const step = Number(trimmed.slice(2));
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(
          `invalid cron step: ${trimmed} — step must be a positive integer, e.g. "*/5"`,
        );
      }
      for (let i = min; i <= max; i += step) values.push(i);
    } else if (trimmed.includes("-")) {
      // Range: "1-5" or "1-5/2"
      const [rangePart, stepPart] = trimmed.split("/");
      const [startStr, endStr] = (rangePart ?? "").split("-");
      if (!startStr || !endStr) {
        throw new Error(`invalid cron range: ${trimmed} (${min}-${max})`);
      }
      const start = Number(startStr), end = Number(endStr);
      const step = stepPart ? Number(stepPart) : 1;
      if (
        !Number.isInteger(start) || !Number.isInteger(end) || start < min ||
        end > max || start > end
      ) {
        throw new Error(`invalid cron range: ${trimmed} (${min}-${max})`);
      }
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(
          `invalid cron step: ${trimmed} — step must be a positive integer, e.g. "1-5/2"`,
        );
      }
      for (let i = start; i <= end; i += step) values.push(i);
    } else {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(`invalid cron value: ${trimmed} (${min}-${max})`);
      }
      values.push(n);
    }
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Parse a 5-field cron pattern string into expanded CronFields arrays. */
export function parseCron(pattern: string): CronFields {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `cron pattern must have 5 fields, got ${parts.length}: "${pattern}"`,
    );
  }
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dom: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dow: parseField(parts[4]!, 0, 6),
  };
}

/** Longest calendar days in each month (Feb counted as a leap February). */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** How far ahead `nextCronTime` searches.
 *
 *  It was 366 days, which is one day short of the only pattern that needs
 *  more: `29 2` (Feb 29) can be FOUR years out — and eight across a
 *  century boundary (2096 → 2104, since 2100 is not a leap year). Searching a
 *  year and giving up made a leap-day cron throw, and `handleCron` deleted the
 *  schedule permanently while blaming a pattern that is perfectly valid. Nine
 *  years covers the widest real gap with room to spare; the search is
 *  day-stepped (below), so the wider window costs iterations only when the
 *  pattern really is that sparse. */
const CRON_SEARCH_DAYS = 366 * 9;

/** Does this pattern match any calendar day that can ever exist?
 *
 *  O(months × doms) and exact, so the "never fires" message is only shown when
 *  it is TRUE — the old code printed the Feb-30 hint whenever the search
 *  window ran out, which is exactly what a valid leap-day cron does.
 *
 *  Only one shape can be impossible: a restricted day-of-month with an
 *  unrestricted day-of-week. When BOTH are restricted, POSIX OR semantics
 *  (AIO-133) mean any matching weekday fires, and every weekday occurs in
 *  every month; when DOM is unrestricted, every day matches it.
 *  @internal */
export function cronDayReachable(fields: CronFields): boolean {
  const domRestricted = fields.dom.length < 31;
  const dowRestricted = fields.dow.length < 7;
  if (!domRestricted || dowRestricted) return true;
  return fields.month.some((m) =>
    fields.dom.some((day) => day <= MONTH_DAYS[m - 1]!)
  );
}

/** Compute the next UTC time matching the given cron fields, starting from the minute after `after`. */
// NOTE: cron fields are matched against UTC time (getUTCHours, getUTCDay, etc.).
// A pattern like "0 9 * * 1-5" fires at 09:00 UTC, not local time.
// If local-time cron is needed, offset the hour field by your UTC offset.
export function nextCronTime(fields: CronFields, after: Date): Date {
  const d = new Date(after.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1); // start from next minute

  // POSIX cron: when both DOM and DOW are restricted, use OR (AIO-133)
  const domRestricted = fields.dom.length < 31;
  const dowRestricted = fields.dow.length < 7;
  const dayMatches = (): boolean => {
    if (!fields.month.includes(d.getUTCMonth() + 1)) return false;
    const domMatch = fields.dom.includes(d.getUTCDate());
    const dowMatch = fields.dow.includes(d.getUTCDay());
    return (domRestricted && dowRestricted)
      ? (domMatch || dowMatch)
      : (domMatch && dowMatch);
  };

  // Day-stepped, not minute-stepped: a non-matching day is skipped whole
  // instead of costing 1440 iterations, which is what makes a nine-year
  // window (`29 2 *`) cheaper than the old one-year minute walk.
  for (let day = 0; day <= CRON_SEARCH_DAYS; day++) {
    if (dayMatches()) {
      const fromH = d.getUTCHours(), fromM = d.getUTCMinutes();
      for (const h of fields.hour) { // parseField returns them sorted
        if (h < fromH) continue;
        for (const m of fields.minute) {
          if (h === fromH && m < fromM) continue;
          d.setUTCHours(h, m, 0, 0);
          return d;
        }
      }
    }
    d.setUTCHours(0, 0, 0, 0); // every later day starts at midnight
    d.setUTCDate(d.getUTCDate() + 1);
  }
  throw new Error(
    `no matching cron time within ${CRON_SEARCH_DAYS} days`,
  );
}

// ── Schedule manager ────────────────────────────────────────────────

type Log = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};
type TimerHandle = ReturnType<typeof setTimeout>;
type TimerEntry = { timerId: TimerHandle; kind: string };

/** The timer + clock surface the manager runs on.
 *
 *  Injectable for ONE reason: so a harness can run the REAL manager on a
 *  virtual clock. Before this, the in-process runtime (testCell/testUI/
 *  bootCells, `src/standalone-air.ts`) re-implemented scheduling to get
 *  determinism — and the copy clamped `ms` instead of validating it, skipped
 *  id validation, ignored `skipIfRunning` and dropped `at`/`cron`. So
 *  an `every` with a 5ms period and a spaced id was GREEN in a test and refused twice
 *  over in production: a test environment more permissive than production,
 *  which is the one thing this project's doctrine forbids. Swapping the clock
 *  keeps every rule; re-implementing the manager kept none.
 *  @internal */
export type ScheduleTimers = {
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (h: TimerHandle) => void;
  setInterval: (fn: () => void, ms: number) => TimerHandle;
  clearInterval: (h: TimerHandle) => void;
  /** Wall clock, in ms — used by `at`/`cron` and by every delay computation. */
  now: () => number;
};

const realTimers: ScheduleTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
  now: () => Date.now(),
};

/** Consecutive `skipIfRunning` skips before the scheduler says so out loud. */
const SKIP_WARN_AT = 10;

/**
 * Create a schedule manager that handles after/every/at/cron effects and
 * config-level schedule definitions.
 * @internal Runtime wiring — not public API, stripped from the snapshot.
 */
export function createScheduleManager(
  dispatch: (action: { type: string; payload?: unknown }) => void,
  log: Log,
  opts: { timers?: ScheduleTimers } = {},
): {
  handle: (effect: ScheduleEffect) => void;
  start: (defs: ScheduleDef[]) => void;
  cancelAll: () => void;
  cancelByPrefix: (prefix: string) => void;
  active: () => string[];
} {
  const clock = opts.timers ?? realTimers;
  const timers = new Map<string, TimerEntry>();
  const staticIds = new Set<string>(); // ids from start() — aio.run({ schedules })
  const warnedCollisions = new Set<string>();
  // Schedules whose latest tick has not settled — see `skipIfRunning`.
  const inFlight = new Set<string>();
  // Consecutive skipped ticks per id — a wedged poller has to be audible.
  const skips = new Map<string, number>();
  // Liveness generation per id. A one-shot deletes its timer entry when it
  // FIRES, so "cancelled" and "already fired" were indistinguishable and the
  // failed-dispatch retry re-armed either one — resurrecting a schedule
  // `cancelAll()` had just cleared (shutdown Phase 7 does exactly that) and
  // clobbering a same-id replacement. The epoch survives the fire and is
  // dropped by every cancel/replace, so a pending retry can tell.
  const epochs = new Map<string, number>();
  let epochSeq = 0;
  const VALID_ID = /^[\w\-:.]+$/;

  function validateId(id: string): void {
    if (!id || !VALID_ID.test(id)) {
      throw new Error(
        `invalid schedule id: ${
          JSON.stringify(id)
        } — use alphanumeric, hyphens, colons, dots`,
      );
    }
  }

  function cancelTimer(id: string): void {
    const entry = timers.get(id);
    if (entry) {
      if (entry.kind === "every") clock.clearInterval(entry.timerId);
      else clock.clearTimeout(entry.timerId);
      timers.delete(id);
    }
    // A cancelled or replaced schedule keeps NONE of its bookkeeping. The
    // epoch is what tells an in-flight retry it is stale; `inFlight` is what
    // `skipIfRunning` consults, and it used to be keyed by id independently of
    // the timer — so a tick that never settled (a hung fetch inside a poll)
    // wedged the id forever, and cancelling and re-creating the SAME id still
    // skipped every tick, because the guard belonged to a schedule that no
    // longer existed.
    epochs.delete(id);
    inFlight.delete(id);
    skips.delete(id);
  }

  function setTimer(
    id: string,
    kind: string,
    timerId: TimerHandle,
    /** True for a schedule re-arming ITSELF (a cron's next fire, a beyond-
     *  ceiling timer's 24h re-check). Those are not two sources colliding on
     *  one id, and warning about them taught people to ignore the warning that
     *  matters — every cron in the app printed it once. */
    internal = false,
  ): void {
    if (internal) {
      cancelTimer(id);
      timers.set(id, { timerId, kind });
      epochs.set(id, ++epochSeq);
      return;
    }
    // Warn on dynamic+dynamic same-id replacement — two reducers
    // independently issuing `schedule.every('cleanup', …)` would otherwise
    // race invisibly: one cancels the other with no log. Static+dynamic
    // collisions are warned in handle(); this covers the dynamic+dynamic
    // case. One-shot timers (after/at) legitimately re-use ids (re-schedule
    // semantics), so only warn for repeating kinds (every/cron).
    const existing = timers.get(id);
    if (
      existing && (existing.kind === "every" || existing.kind === "cron") &&
      (kind === "every" || kind === "cron") &&
      !warnedCollisions.has(id)
    ) {
      warnedCollisions.add(id);
      log.warn(
        `schedule '${id}' is set dynamically twice (existing ${existing.kind} ` +
          `replaced by new ${kind}) — same id, replace semantics. If two ` +
          `reducers independently schedule the same id, one will cancel the ` +
          `other. Use unique ids per schedule source.`,
      );
    }
    cancelTimer(id); // re-schedule: cancel previous
    timers.set(id, { timerId, kind });
    epochs.set(id, ++epochSeq);
  }

  /** Arm a one-shot timer that fires at absolute time `deadline` — THE one
   *  place a delay meets the platform ceiling.
   *
   *  `setTimeout` stores its delay in an int32, so V8 truncates anything past
   *  `MAX_TIMER_DELAY` and fires on the next tick instead of in 35 days.
   *  `at` and `cron` each carried a private copy of this guard; `after` never
   *  got one, so a long reminder — and every `backoff`/`poll` whose optional
   *  `max` let the delay grow past 24.85 days — dispatched IMMEDIATELY,
   *  turning a retry backoff into a hot loop. One decider, three callers. */
  function armDeadline(
    id: string,
    kind: string,
    deadline: number,
    onDue: () => void,
    /** This arming is the schedule renewing itself, not a new registration. */
    internal = false,
  ): void {
    let warned = false;
    let first = true;
    const arm = (): void => {
      const quiet = internal || !first; // a 24h re-check is never a collision
      first = false;
      const delay = Math.max(0, deadline - clock.now());
      if (delay > MAX_TIMER_DELAY) {
        if (!warned) {
          warned = true;
          log.warn(
            `schedule: ${kind} '${id}' is ${
              Math.round(delay / 86_400_000)
            } days out — past the ${
              Math.floor(MAX_TIMER_DELAY / 86_400_000)
            }-day setTimeout ceiling, so it is armed with 24h re-checks. ` +
              `Timers do not survive a restart: persist the deadline if it ` +
              `must outlive the process.`,
          );
        }
        setTimer(id, kind, clock.setTimeout(arm, RECHECK_MS), quiet);
        log.debug(`schedule: ${kind} '${id}' re-check in 24h (${delay}ms)`);
        return;
      }
      setTimer(id, kind, clock.setTimeout(onDue, delay), quiet);
    };
    arm();
  }

  /** Safe dispatch — cleans up timer entry on error to prevent leaks.
   *  One-shot timers (after/at): retry up to 3 times with 5s backoff.
   *  Repeating timers (every/cron): cancel on failure. */
  async function safeDispatch(
    id: string,
    action: { type: string; payload?: unknown },
    kind: "after" | "every" | "at" | "cron",
    retryCount = 0,
  ): Promise<unknown> {
    // Captured BEFORE the await: everything below runs in a microtask, long
    // after the tick that started it (a rejection arrives at least one turn
    // later, a 5s retry much later than that). See `epochs`.
    const epoch = epochs.get(id);
    try {
      // AWAITED, not just returned. `dispatch` reports every failure by
      // REJECTING its promise (DISPATCH_CLOSED, QUEUE_OVERFLOW, REDUCE_ERROR)
      // — it does not throw synchronously. So a bare `return dispatch(action)`
      // inside try/catch caught nothing that actually happens: the retry, the
      // cancel-on-failure for every/cron, and the "giving up" log below were
      // all unreachable, while the rejection escaped as an unhandled one
      //. Awaiting is what routes a real failure into the handler.
      // Returned so `skipIfRunning` can await the tick it just started.
      return await dispatch(action);
    } catch (e) {
      log.error(`schedule: dispatch '${id}' failed: ${e}`);
      // The dispatch loop is gone (shutdown): there is nothing to retry into,
      // and re-arming a timer here would resurrect one `cancelAll()` just
      // cleared.
      const closed = (e as { code?: string })?.code === "DISPATCH_CLOSED";
      if (closed) {
        cancelTimer(id);
        return;
      }
      if (kind === "every" || kind === "cron") {
        // A REPEATING schedule survives a failed tick. One transient failure —
        // a network blip inside a poll, a momentary queue overflow — must not
        // silently switch a recurring job off for the life of the process;
        // the next tick gets its own chance (pinned by
        // tests/schedule-skip-if-running.test.ts). Cancelling here was
        // unreachable until this handler started catching real failures, and
        // making it live exposed it as the wrong policy, not a lost feature.
        return;
      }
      // Cancelled — or replaced by a newer schedule under the same id — while
      // this tick was in flight. Re-arming here would undo a `cancelAll()`
      // (shutdown Phase 7 runs one) or an app's own `schedule.cancel(id)`, and
      // the resurrected timer then dispatched into a teardown for another 15s.
      if (epochs.get(id) !== epoch) {
        log.debug(
          `schedule: '${id}' was cancelled or replaced while its failed tick ` +
            `was in flight — not retrying`,
        );
        return;
      }
      if (retryCount < 3) {
        const timerId = clock.setTimeout(
          () => {
            timers.delete(id); // fired: the entry is spent, the epoch is not
            safeDispatch(id, action, kind, retryCount + 1);
          },
          5000,
        );
        setTimer(id, kind, timerId);
      } else {
        log.error(
          `schedule: dispatch '${id}' failed after 3 retries — giving up`,
        );
        cancelTimer(id);
      }
    }
  }

  function handleAfter(
    id: string,
    ms: number,
    action: { type: string; payload?: unknown },
  ): void {
    if (ms < 1) {
      throw new Error(`schedule.after '${id}': ms must be >= 1, got ${ms}`); // AIO-252
    }
    if (!Number.isFinite(ms)) {
      throw new Error(`schedule.after '${id}': ms must be finite, got ${ms}`);
    }
    armDeadline(id, "after", clock.now() + ms, () => {
      timers.delete(id);
      log.debug(`schedule: after '${id}' fired`);
      safeDispatch(id, action, "after");
    });
    log.debug(`schedule: after '${id}' set for ${ms}ms`);
  }

  function handleEvery(
    id: string,
    ms: number,
    action: { type: string; payload?: unknown },
    skipIfRunning = false,
  ): void {
    if (ms < 10) {
      throw new Error(`schedule.every '${id}': ms must be >= 10, got ${ms}`); // AIO-252
    }
    // NaN passes every comparison above ("NaN < 10" is false) and setInterval
    // coerces it to a 1ms hot loop; Infinity never fires. Both are a caller
    // bug, and both are silent without this.
    if (!Number.isFinite(ms)) {
      throw new Error(`schedule.every '${id}': ms must be finite, got ${ms}`);
    }
    const timerId = clock.setInterval(() => {
      // The previous tick is still working: drop this one rather than stacking
      // a second copy of the same poll on top of it. `inFlight` is cleared in a
      // `finally`, so a tick that THROWS cannot wedge the schedule off — the
      // failure mode of the hand-rolled `s.refreshing` guard.
      if (skipIfRunning && inFlight.has(id)) {
        // …but a tick that HANGS (an await that never settles — the other
        // failure mode of `s.refreshing`) skips every tick after it, forever,
        // and the old code said so only at debug level: a poller that stopped
        // firing with zero warnings, which is the exact class this project
        // treats as the worst outcome. Cancel/replace now clears the guard
        // (cancelTimer), and a wedge this long is audible.
        const n = (skips.get(id) ?? 0) + 1;
        skips.set(id, n);
        if (n === SKIP_WARN_AT || n % (SKIP_WARN_AT * 10) === 0) {
          log.warn(
            `schedule: every '${id}' has skipped ${n} consecutive ticks — ` +
              `the previous tick has not settled (an await inside the action ` +
              `that never resolves?). skipIfRunning is dropping every tick ` +
              `until it does, so this schedule is effectively stopped.`,
          );
        }
        log.debug(
          `schedule: every '${id}' skipped — previous tick still running`,
        );
        return;
      }
      skips.delete(id);
      log.debug(`schedule: every '${id}' fired`);
      const r = safeDispatch(id, action, "every");
      if (
        skipIfRunning && r && typeof (r as Promise<unknown>).then === "function"
      ) {
        inFlight.add(id);
        // The guard belongs to THIS arming of the schedule, so the epoch rides
        // along with it. Without that, an orphaned tick — one whose schedule
        // was cancelled or replaced while it was still running — cleared the
        // guard of the schedule that took its place, letting a poll overlap
        // with itself exactly once per replacement. (Found by
        // tests/schedule-program-fuzz.ts: 250ms replace, 600ms tick.)
        const epoch = epochs.get(id);
        // Settle on BOTH outcomes, and swallow here: a rejected tick is already
        // reported by the dispatch layer, and attaching a bare `.finally()` to
        // someone else's promise re-raises it as an unhandled rejection that
        // kills the process. Clearing the guard is this code's only job.
        (r as Promise<unknown>)
          .then(() => {}, () => {})
          .finally(() => {
            if (epochs.get(id) === epoch) inFlight.delete(id);
          });
      }
    }, ms);
    setTimer(id, "every", timerId);
    log.debug(`schedule: every '${id}' set for ${ms}ms`);
  }

  function handleAt(
    id: string,
    time: string,
    action: { type: string; payload?: unknown },
  ): void {
    const target = new Date(time).getTime();
    if (Number.isNaN(target)) {
      throw new Error(
        `invalid schedule.at time: ${
          JSON.stringify(time)
        } — use an ISO 8601 string (e.g. "2026-07-08T12:00:00Z") or a Date`,
      );
    }
    // AIO-236: a target in the past never fires. Said out loud, not at debug:
    // the id also never shows up in `active()`, so "my 09:00 job did nothing"
    // had no observable trace anywhere — and the usual cause is a UTC/local
    // mix-up or a restored deadline, both of which the author wants to know
    // about the moment it happens.
    if (target <= clock.now()) {
      log.warn(
        `schedule: at '${id}' is in the past (${time}, ${
          Math.round((clock.now() - target) / 1000)
        }s ago) — it will never fire and is not registered. Times are UTC.`,
      );
      return;
    }
    armDeadline(id, "at", target, () => {
      timers.delete(id);
      log.debug(`schedule: at '${id}' fired`);
      safeDispatch(id, action, "at");
    });
    log.debug(
      `schedule: at '${id}' set for ${target - clock.now()}ms (${time})`,
    );
  }

  function handleCron(
    id: string,
    pattern: string,
    action: { type: string; payload?: unknown },
  ): void {
    const fields = parseCron(pattern);
    // A pattern that can NEVER match is a typo, and it is knowable here, in
    // O(months × doms) — so it fails at the call site like every other invalid
    // schedule instead of being discovered at the first fire attempt and
    // silently deleted. (`cronDayReachable` is exact: the old code printed
    // this hint whenever the one-year search window ran out, which is what a
    // perfectly valid leap-day cron does.)
    if (!cronDayReachable(fields)) {
      throw new Error(
        `schedule.cron '${id}': "${pattern}" can never fire — day-of-month ` +
          `${fields.dom.join(",")} does not exist in month ${
            fields.month.join(",")
          } (e.g. "0 0 30 2 *": February has no 30th).`,
      );
    }
    function scheduleNext(first = false): void {
      let next: Date;
      try {
        next = nextCronTime(fields, new Date(clock.now()));
      } catch (e) {
        // Unreachable for a reachable pattern (the window is nine years and
        // the impossible shapes threw above) — so this is a defect, not a
        // misconfiguration, and it must not masquerade as one.
        log.error(
          `schedule: cron '${id}' ("${pattern}") — ${
            e instanceof Error ? e.message : e
          } — removing schedule. This is an aio bug: the pattern is valid and ` +
            `should have a next fire time.`,
        );
        cancelTimer(id);
        return;
      }
      armDeadline(id, "cron", next.getTime(), () => {
        log.debug(`schedule: cron '${id}' fired`);
        // safeDispatch, not a raw `dispatch` in a try/catch that could never
        // catch anything: dispatch reports failure by REJECTING (see the note
        // in safeDispatch), so a failing cron tick used to produce ZERO
        // scheduler logs, ignored DISPATCH_CLOSED, and re-armed itself right
        // through the shutdown drain. Repeating kinds survive a failed tick;
        // a closed dispatch loop cancels the schedule from inside safeDispatch.
        safeDispatch(id, action, "cron");
        // Only reschedule if action didn't cancel this cron (AIO-142)
        if (timers.has(id)) scheduleNext();
      }, !first);
      log.debug(
        `schedule: cron '${id}' next at ${next.toISOString()} (${
          next.getTime() - clock.now()
        }ms)`,
      );
    }
    scheduleNext(true);
  }

  function handle(effect: ScheduleEffect): void {
    validateId(effect.id);
    // a dynamic schedule reusing a static id silently replaces it
    if (
      effect.kind !== "cancel" && staticIds.has(effect.id) &&
      !warnedCollisions.has(effect.id)
    ) {
      warnedCollisions.add(effect.id);
      log.warn(
        `schedule '${effect.id}' is registered both statically ` +
          `(aio.run({ schedules })) and dynamically (schedule.${effect.kind}) — ` +
          `same id, replace semantics; keep just one to avoid a confusing cadence.`,
      );
    }
    switch (effect.kind) {
      case "after":
        handleAfter(effect.id, effect.ms, effect.action);
        break;
      case "every":
        handleEvery(
          effect.id,
          effect.ms,
          effect.action,
          effect.skipIfRunning === true,
        );
        break;
      case "at":
        handleAt(effect.id, effect.time, effect.action);
        break;
      case "cron":
        handleCron(effect.id, effect.pattern, effect.action);
        break;
      case "cancel": {
        // Unconditional: a one-shot whose tick is in flight is no longer in
        // `timers`, but it still holds a retry that must not survive an
        // explicit cancel (cancelTimer drops the epoch, which is what stops
        // it). `had` is only about what to log.
        const had = timers.has(effect.id) || epochs.has(effect.id);
        cancelTimer(effect.id);
        if (had) log.debug(`schedule: cancelled '${effect.id}'`);
        break;
      }
    }
  }

  function start(defs: ScheduleDef[]): void {
    for (const def of defs) {
      validateId(def.id); // AIO-251: validate config-level schedule IDs
      staticIds.add(def.id);
      if ("every" in def) {
        handleEvery(def.id, def.every, def.action, def.skipIfRunning === true);
      } else if ("after" in def) handleAfter(def.id, def.after, def.action);
      else if ("at" in def) handleAt(def.id, def.at, def.action);
      else if ("cron" in def) handleCron(def.id, def.cron, def.action);
    }
  }

  function cancelAll(): void {
    for (const id of [...timers.keys()]) cancelTimer(id);
    timers.clear();
    // A one-shot whose tick is in flight has no timer entry left, only an
    // epoch — clearing the epochs is what makes "cancelled" stick for the
    // retry that has not been scheduled yet. Shutdown Phase 7 calls this.
    epochs.clear();
    inFlight.clear();
    skips.clear();
  }

  /** Cancel all timers whose ID starts with prefix + ":" (e.g. cell name).
   *  AIO-198: match delimiter to avoid "user" cancelling "userProfile" timers. */
  function cancelByPrefix(prefix: string): void {
    const match = prefix + ":";
    // Epoch keys as well as timer keys: an in-flight one-shot is only in the
    // former, and a disabled cell must not have a retry come back to life.
    for (const id of new Set([...timers.keys(), ...epochs.keys()])) {
      if (id === prefix || id.startsWith(match)) cancelTimer(id);
    }
  }

  function active(): string[] {
    return [...timers.keys()];
  }

  return { handle, start, cancelAll, cancelByPrefix, active };
}

// ── Virtual clock ───────────────────────────────────────────────────

/** A deterministic {@linkcode ScheduleTimers}: nothing fires until `advance()`.
 *
 *  This is how the in-process runtime (`standalone-air.ts`, and therefore
 *  testCell/testUI/bootCells) drives the REAL manager — same validation, same
 *  `skipIfRunning`, same `at`/`cron`, same long-delay clamp — without waiting
 *  on the wall clock. It replaces a second, hand-written scheduler that had
 *  none of those rules.
 *  @internal */
export function createVirtualTimers(
  start = Date.now(),
): ScheduleTimers & {
  /** Move time forward, firing everything that comes due, in order. */
  advance: (ms: number) => void;
  /** Number of armed timers — a leak check for a harness teardown. */
  pending: () => number;
} {
  type VTimer = { id: number; due: number; fn: () => void; every: number };
  let now = start;
  let seq = 0;
  const q = new Map<number, VTimer>();
  const arm = (fn: () => void, ms: number, every: number): TimerHandle => {
    const id = ++seq;
    // FAITHFUL to the platform, deliberately: V8 stores a timeout's delay in an
    // int32 and fires on the next tick when it overflows ("Timeout duration was
    // set to 1"). A virtual clock that quietly honoured a 35-day delay would
    // hide the exact defect it exists to expose, and every test written on it
    // would be green about a timer that fires 35 days early in production.
    const delay = ms > MAX_TIMER_DELAY ? 1 : Math.max(0, ms);
    q.set(id, { id, due: now + delay, fn, every });
    return id as unknown as TimerHandle;
  };
  const clear = (h: TimerHandle): void => {
    q.delete(h as unknown as number);
  };
  return {
    setTimeout: (fn, ms) => arm(fn, ms, 0),
    clearTimeout: clear,
    setInterval: (fn, ms) => arm(fn, ms, Math.max(1, ms)),
    clearInterval: clear,
    now: () => now,
    pending: () => q.size,
    advance(ms: number): void {
      const target = now + Math.max(0, ms);
      // A guard, but a LOUD one: a runaway re-arming schedule (an interval of
      // 0, an `after` that re-schedules itself with no delay) would otherwise
      // make advance() return quietly having done a million dispatches.
      for (let guard = 0;; guard++) {
        if (guard > 1_000_000) {
          throw new Error(
            `virtual clock: over 1e6 timer fires while advancing ${ms}ms — a ` +
              `schedule is re-arming itself with no delay`,
          );
        }
        let next: VTimer | null = null;
        for (const t of q.values()) {
          if (t.due <= target && (!next || t.due < next.due)) next = t;
        }
        if (!next) break;
        now = next.due;
        if (next.every > 0) next.due = now + next.every;
        else q.delete(next.id);
        next.fn();
      }
      now = target;
    },
  };
}
