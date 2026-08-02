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
    const max = opts.max ?? Number.MAX_SAFE_INTEGER;
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
   *  rate-limit foot-guns come from. `backoff` defaults to 1 (constant polling).
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
    const max = opts.max ?? Number.MAX_SAFE_INTEGER;
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

/** Compute the next UTC time matching the given cron fields, starting from the minute after `after`. */
// NOTE: cron fields are matched against UTC time (getUTCHours, getUTCDay, etc.).
// A pattern like "0 9 * * 1-5" fires at 09:00 UTC, not local time.
// If local-time cron is needed, offset the hour field by your UTC offset.
export function nextCronTime(fields: CronFields, after: Date): Date {
  const d = new Date(after.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1); // start from next minute

  const maxIterations = 366 * 24 * 60; // ~1 year of minutes
  for (let i = 0; i < maxIterations; i++) {
    // POSIX cron: when both DOM and DOW are restricted, use OR (AIO-133)
    const domRestricted = fields.dom.length < 31;
    const dowRestricted = fields.dow.length < 7;
    const domMatch = fields.dom.includes(d.getUTCDate());
    const dowMatch = fields.dow.includes(d.getUTCDay());
    const dayMatch = (domRestricted && dowRestricted)
      ? (domMatch || dowMatch)
      : (domMatch && dowMatch);

    if (
      fields.month.includes(d.getUTCMonth() + 1) &&
      dayMatch &&
      fields.hour.includes(d.getUTCHours()) &&
      fields.minute.includes(d.getUTCMinutes())
    ) {
      return d;
    }
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new Error(
    'no matching cron time within 366 days — check the day-of-month/month combination (e.g. "0 0 30 2 *" never fires: Feb 30 does not exist)',
  );
}

// ── Schedule manager ────────────────────────────────────────────────

type Log = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};
type TimerEntry = { timerId: ReturnType<typeof setTimeout>; kind: string };

/**
 * Create a schedule manager that handles after/every/at/cron effects and
 * config-level schedule definitions.
 * @internal Runtime wiring — not public API, stripped from the snapshot.
 */
export function createScheduleManager(
  dispatch: (action: { type: string; payload?: unknown }) => void,
  log: Log,
): {
  handle: (effect: ScheduleEffect) => void;
  start: (defs: ScheduleDef[]) => void;
  cancelAll: () => void;
  cancelByPrefix: (prefix: string) => void;
  active: () => string[];
} {
  const timers = new Map<string, TimerEntry>();
  const staticIds = new Set<string>(); // ids from start() — aio.run({ schedules })
  const warnedCollisions = new Set<string>();
  // Schedules whose latest tick has not settled — see `skipIfRunning`.
  const inFlight = new Set<string>();
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
      if (entry.kind === "every") clearInterval(entry.timerId);
      else clearTimeout(entry.timerId);
      timers.delete(id);
    }
  }

  function setTimer(
    id: string,
    kind: string,
    timerId: ReturnType<typeof setTimeout>,
  ): void {
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
      if (retryCount < 3) {
        const timerId = setTimeout(
          () => safeDispatch(id, action, kind, retryCount + 1),
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
    const timerId = setTimeout(() => {
      timers.delete(id);
      log.debug(`schedule: after '${id}' fired`);
      safeDispatch(id, action, "after");
    }, ms);
    setTimer(id, "after", timerId);
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
    const timerId = setInterval(() => {
      // The previous tick is still working: drop this one rather than stacking
      // a second copy of the same poll on top of it. `inFlight` is cleared in a
      // `finally`, so a tick that THROWS cannot wedge the schedule off — the
      // failure mode of the hand-rolled `s.refreshing` guard.
      if (skipIfRunning && inFlight.has(id)) {
        log.debug(
          `schedule: every '${id}' skipped — previous tick still running`,
        );
        return;
      }
      log.debug(`schedule: every '${id}' fired`);
      const r = safeDispatch(id, action, "every");
      if (
        skipIfRunning && r && typeof (r as Promise<unknown>).then === "function"
      ) {
        inFlight.add(id);
        // Settle on BOTH outcomes, and swallow here: a rejected tick is already
        // reported by the dispatch layer, and attaching a bare `.finally()` to
        // someone else's promise re-raises it as an unhandled rejection that
        // kills the process. Clearing the guard is this code's only job.
        (r as Promise<unknown>)
          .then(() => {}, () => {})
          .finally(() => inFlight.delete(id));
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
    // AIO-236: skip if target time is in the past
    if (target <= Date.now()) {
      log.debug(`schedule: at '${id}' time is in the past — skipping`);
      return;
    }
    const MAX_DELAY = 2_147_483_647; // 2^31-1 ms — setTimeout max safe value
    function scheduleCheck(): void {
      const delay = Math.max(0, target - Date.now());
      if (delay > MAX_DELAY) {
        // Re-check in 24h (AIO-134)
        const timerId = setTimeout(scheduleCheck, 86_400_000);
        setTimer(id, "at", timerId);
        log.debug(`schedule: at '${id}' re-check in 24h (${delay}ms > max)`);
        return;
      }
      const timerId = setTimeout(() => {
        timers.delete(id);
        log.debug(`schedule: at '${id}' fired`);
        safeDispatch(id, action, "at");
      }, delay);
      setTimer(id, "at", timerId);
      log.debug(`schedule: at '${id}' set for ${delay}ms (${time})`);
    }
    scheduleCheck();
  }

  function handleCron(
    id: string,
    pattern: string,
    action: { type: string; payload?: unknown },
  ): void {
    const fields = parseCron(pattern);
    const MAX_DELAY = 2_147_483_647; // 2^31-1 ms — setTimeout max safe value
    function scheduleNext(): void {
      let next: Date;
      try {
        next = nextCronTime(fields, new Date());
      } catch (e) {
        log.error(
          `schedule: cron '${id}' — ${
            e instanceof Error ? e.message : e
          } — removing schedule`,
        );
        timers.delete(id);
        return;
      }
      const delay = Math.max(0, next.getTime() - Date.now());
      if (delay > MAX_DELAY) {
        // Re-check after 24 hours — avoids setTimeout overflow for far-future cron times
        const timerId = setTimeout(scheduleNext, 86_400_000);
        setTimer(id, "cron", timerId);
        log.debug(
          `schedule: cron '${id}' next at ${next.toISOString()} (${delay}ms > max, re-check in 24h)`,
        );
        return;
      }
      const timerId = setTimeout(() => {
        log.debug(`schedule: cron '${id}' fired`);
        // AIO-265: log error but continue rescheduling on dispatch failure
        try {
          dispatch(action);
        } catch (e) {
          log.error(`schedule: cron '${id}' dispatch failed: ${e}`);
        }
        // Only reschedule if action didn't cancel this cron (AIO-142)
        if (timers.has(id)) scheduleNext();
      }, delay);
      setTimer(id, "cron", timerId);
      log.debug(
        `schedule: cron '${id}' next at ${next.toISOString()} (${delay}ms)`,
      );
    }
    scheduleNext();
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
      case "cancel":
        if (timers.has(effect.id)) {
          cancelTimer(effect.id);
          log.debug(`schedule: cancelled '${effect.id}'`);
        }
        break;
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
    for (const [id] of timers) cancelTimer(id);
    timers.clear();
  }

  /** Cancel all timers whose ID starts with prefix + ":" (e.g. cell name).
   *  AIO-198: match delimiter to avoid "user" cancelling "userProfile" timers. */
  function cancelByPrefix(prefix: string): void {
    const match = prefix + ":";
    for (const [id] of timers) {
      if (id === prefix || id.startsWith(match)) cancelTimer(id);
    }
  }

  function active(): string[] {
    return [...timers.keys()];
  }

  return { handle, start, cancelAll, cancelByPrefix, active };
}
