// schedule.ts — declarative timers/delays/cron as effects
// Two use cases: config-level always-on schedules, dynamic effects from reducer

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
  & (
    | { every: number }
    | { after: number }
    | { at: string }
    | { cron: string }
  );

// ── Effect creators (pure) ──────────────────────────────────────────

/** Effect creators for declarative scheduling — use in reducers to schedule/cancel timers.
 * @example
 * ```ts
 * return [schedule.after('save-timeout', 3000, A.save())]
 * return [schedule.cron('daily-report', '0 8 * * *', A.report())]
 * return [schedule.cancel('save-timeout')]
 * ``` */
export const schedule = {
  after: (
    id: string,
    ms: number,
    action: { type: string; payload?: unknown },
  ): ScheduleEffect => ({ type: "__schedule", kind: "after", id, ms, action }),
  every: (
    id: string,
    ms: number,
    action: { type: string; payload?: unknown },
  ): ScheduleEffect => ({ type: "__schedule", kind: "every", id, ms, action }),
  at: (
    id: string,
    time: string,
    action: { type: string; payload?: unknown },
  ): ScheduleEffect => ({ type: "__schedule", kind: "at", id, time, action }),
  cron: (
    id: string,
    pattern: string,
    action: { type: string; payload?: unknown },
  ): ScheduleEffect => ({
    type: "__schedule",
    kind: "cron",
    id,
    pattern,
    action,
  }),
  /** Exponential backoff (risoto #4) — a one-shot `after` whose delay grows
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
    action: { type: string; payload?: unknown },
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
  cancel: (id: string): ScheduleEffect => ({
    type: "__schedule",
    kind: "cancel",
    id,
  }),
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
    cancelTimer(id); // re-schedule: cancel previous
    timers.set(id, { timerId, kind });
  }

  /** Safe dispatch — cleans up timer entry on error to prevent leaks.
   *  One-shot timers (after/at): retry up to 3 times with 5s backoff.
   *  Repeating timers (every/cron): cancel on failure. */
  function safeDispatch(
    id: string,
    action: { type: string; payload?: unknown },
    kind: "after" | "every" | "at" | "cron",
    retryCount = 0,
  ): void {
    try {
      dispatch(action);
    } catch (e) {
      log.error(`schedule: dispatch '${id}' failed: ${e}`);
      if (kind === "every" || kind === "cron") {
        cancelTimer(id);
      } else if (retryCount < 3) {
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
  ): void {
    if (ms < 10) {
      throw new Error(`schedule.every '${id}': ms must be >= 10, got ${ms}`); // AIO-252
    }
    const timerId = setInterval(() => {
      log.debug(`schedule: every '${id}' fired`);
      safeDispatch(id, action, "every");
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
    // risoto #5: a dynamic schedule reusing a static id silently replaces it
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
        handleEvery(effect.id, effect.ms, effect.action);
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
      if ("every" in def) handleEvery(def.id, def.every, def.action);
      else if ("after" in def) handleAfter(def.id, def.after, def.action);
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
