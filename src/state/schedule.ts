// schedule.ts — declarative timers/delays/cron as effects
// Two use cases: config-level always-on schedules, dynamic effects from reducer

// No `blocking.ts` import: that module is the Deno worker pool, and this one
// is ISOMORPHIC — the browser bundle and the android/standalone runtime carry
// it verbatim (`schedule.blocking` went out in alpha70; `blocking` is its own
// top-level export, server-only — see src/state/removals.ts).
import { selfMethodOf } from "./self.ts";
import { removalOf, retiredSpellingLine } from "./removals.ts";
import { teachableError } from "../diagnostics/error.ts";
import { nearestOf } from "./cell-helpers.ts";

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
  & (
    | {
      every: number;
      /** Skip a tick while the previous one is still running (`every` only —
       *  alpha52 narrowed the type to say so: a one-shot `after`/`at`/`cron`
       *  has no "previous tick", so the option was dead weight there).
       *
       *  Declared here as well as on `schedule.every()` because THIS is the
       *  shape apps actually use: `aio.run({ schedules: [...] })` is what
       *  `am create` scaffolds and what the docs show. Shipping the option
       *  only on the imperative form meant every declarative poller kept the
       *  hand-rolled `if (s.refreshing) return` the feature exists to delete. */
      skipIfRunning?: boolean;
    }
    | { after: number }
    | { at: string }
    | { cron: string }
  );

// ── Static `schedules:` validation — at CONFIG time, not fire time ──

const SCHEDULE_DOC = "docs/state/scheduling.md";
const TRIGGERS = ["every", "after", "at", "cron"] as const;
/** Exported ONLY so tests/callable-config-completeness.test.ts can prove this
 *  still matches `ScheduleDef` — a key added to the type but not here would be
 *  refused as unknown, turning a legitimate config into a boot failure, which
 *  is precisely the class tests/config-allowlist.test.ts exists to kill.
 *  @internal */
export const SCHEDULE_KEYS = new Set<string>([
  ...TRIGGERS,
  "id",
  "action",
  "skipIfRunning",
]);

function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "missing";
  if (Array.isArray(v)) return "an array";
  return `${typeof v} ${JSON.stringify(v)}`;
}

/** Refuse a malformed `aio.run({ schedules })` entry while it is still config.
 *
 *  Every field checked here is statically knowable, and every one of them used
 *  to be discovered late. `every: "5m"` threw out of `scheduleManager.start()`
 *  AFTER the app had opened persistence, bound a port, run cell init and
 *  logged `started` — a half-started app under a restart supervisor. A string
 *  `action:` was not caught at all: it detonated at FIRE time, one internal
 *  `HOOK_ERROR` per tick, blaming `action-kind.ts` and an `onAction` hook the
 *  app never wrote, naming neither the schedule nor the real mistake. For an
 *  `at`/`cron` entry that first tick can be days after the deploy that broke
 *  it. The `ScheduleDef` type catches none of this for the app that ships it,
 *  because the dev server transpiles without type-checking — the type protects
 *  this repo, not the user. So the check exists at runtime, and it runs first. */
export function validateSchedules(defs: readonly unknown[]): void {
  // Not an array: `schedules: {}` has no `length`, so a call site guarding on
  // `schedules?.length` skips it and the whole config is silently ignored,
  // and `schedules: "1s"` DOES have one, so it arrives here and dies on
  // `.forEach`. Both are the class this validator exists to close, so the
  // shape of the container is checked before its contents.
  if (!Array.isArray(defs)) {
    throw teachableError(
      `schedules is ${describeValue(defs)}, not an array`,
      "schedules is a LIST of entries: [{ id, action, every: 300_000 }]",
      SCHEDULE_DOC,
    );
  }
  const seen = new Set<string>();
  defs.forEach((raw, i) => {
    const at = (id?: unknown) =>
      typeof id === "string" && id ? `schedules '${id}'` : `schedules[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw teachableError(
        `${at()} is ${describeValue(raw)}, not an object`,
        "each entry is { id, action, and exactly one of every/after/at/cron }",
        SCHEDULE_DOC,
      );
    }
    const d = raw as Record<string, unknown>;
    if (typeof d.id !== "string" || !d.id) {
      throw teachableError(
        `${at()}.id is ${describeValue(d.id)}, not a non-empty string`,
        "give the schedule an id — it is the handle schedule.cancel(id) uses",
        SCHEDULE_DOC,
      );
    }
    if (seen.has(d.id)) {
      throw teachableError(
        `${at(d.id)} is declared twice`,
        "ids are the schedule's identity: the second entry would silently " +
          "replace the first and leak its timer — rename one",
        SCHEDULE_DOC,
      );
    }
    seen.add(d.id);
    for (const key of Object.keys(d)) {
      if (SCHEDULE_KEYS.has(key)) continue;
      const near = nearestOf(key, SCHEDULE_KEYS);
      throw teachableError(
        `${at(d.id)}: unknown key "${key}"` +
          (near ? ` (did you mean "${near}"?)` : ""),
        `remove it, or use one of ${[...SCHEDULE_KEYS].join(", ")}`,
        SCHEDULE_DOC,
      );
    }
    const action = d.action as { type?: unknown } | undefined;
    if (
      typeof action !== "object" || action === null ||
      typeof action.type !== "string" || !action.type
    ) {
      throw teachableError(
        `${at(d.id)}.action is ${
          describeValue(d.action)
        }, not an action object`,
        'use cell.method.action() (or { type: "cell:method", payload }) — a ' +
          "bare string is dispatched as an action with no type and fails on " +
          "the first tick, not here",
        SCHEDULE_DOC,
      );
    }
    const triggers = TRIGGERS.filter((k) => d[k] !== undefined);
    if (triggers.length !== 1) {
      throw teachableError(
        `${at(d.id)} declares ${
          triggers.length === 0
            ? "no trigger"
            : `${triggers.length} triggers (${triggers.join(", ")})`
        }`,
        "each schedule fires one way: every (repeating ms), after (once, ms), " +
          "at (an ISO time) or cron (a cron expression)",
        SCHEDULE_DOC,
      );
    }
    const trigger = triggers[0]!;
    const value = d[trigger];
    if (trigger === "every" || trigger === "after") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw teachableError(
          `${at(d.id)}.${trigger} is ${
            describeValue(value)
          }, not a number of milliseconds`,
          'durations are plain numbers: write 300_000, not "5m" — aio\'s CLI ' +
            "takes 60s spellings, the config does not",
          SCHEDULE_DOC,
        );
      }
      if (trigger === "every" && value < 10) {
        throw teachableError(
          `${at(d.id)}.every is ${value}ms`,
          "the floor is 10ms — a faster interval is a hot loop, not a schedule",
          SCHEDULE_DOC,
        );
      }
      if (trigger === "after" && value < 0) {
        throw teachableError(
          `${at(d.id)}.after is ${value}ms`,
          "a delay cannot be negative — 0 means the next tick",
          SCHEDULE_DOC,
        );
      }
    } else if (typeof value !== "string" || !value) {
      throw teachableError(
        `${at(d.id)}.${trigger} is ${describeValue(value)}, not a string`,
        trigger === "at"
          ? 'at takes an ISO timestamp, e.g. "2026-01-01T09:00:00Z"'
          : 'cron takes an expression, e.g. "0 9 * * *"',
        SCHEDULE_DOC,
      );
    }
    if (d.skipIfRunning !== undefined) {
      if (trigger !== "every") {
        throw teachableError(
          `${at(d.id)} sets skipIfRunning on an "${trigger}" schedule`,
          "skipIfRunning is every-only — a one-shot schedule has no previous " +
            "tick to skip",
          SCHEDULE_DOC,
        );
      }
      if (typeof d.skipIfRunning !== "boolean") {
        throw teachableError(
          `${at(d.id)}.skipIfRunning is ${
            describeValue(d.skipIfRunning)
          }, not a boolean`,
          "skipIfRunning: true drops a tick while the previous one is running",
          SCHEDULE_DOC,
        );
      }
    }
  });
}

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

/** Options for {@linkcode schedule.backoff}. */
export type BackoffOpts = {
  base: number;
  max?: number;
  factor?: number;
};
/** Options for {@linkcode schedule.poll}. `factor` is the backoff multiplier
 *  (its pre-alpha70 spelling `backoff` is refused by name). */
export type PollOpts = {
  every: number;
  factor?: number;
  max?: number;
};

/** Is this positional arg the ACTION (has a string `.type`) rather than an
 *  options object? The alpha52 order puts the action third; the order it
 *  replaced put the options there — an opts object never carries `.type`, an
 *  action always does. Still checked so the refusal can NAME the old order
 *  instead of failing on `opts.base` being undefined. */
function _isAction(v: unknown): v is ScheduleAction {
  return !!v && typeof v === "object" &&
    typeof (v as { type?: unknown }).type === "string";
}

/** The refusal for the pre-alpha52 argument order — same words on the server
 *  and in the browser, both read from the registry. Throws in dev AND prod:
 *  this is code, not config, and the type-checker refuses it first. */
function _refuseOldOrder(fn: "backoff" | "poll", id: string): never {
  throw new Error(
    retiredSpellingLine(
      removalOf("schedule.backoff/poll(id, attempt, opts, action)"),
      `schedule.${fn} '${id}'`,
    ),
  );
}

function _backoffEffect(
  id: string,
  attempt: number,
  opts: BackoffOpts,
  action: ScheduleAction,
): ScheduleEffect {
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
}

function _pollEffect(
  id: string,
  attempt: number,
  opts: PollOpts,
  action: ScheduleAction,
): ScheduleEffect {
  if ((opts as { backoff?: unknown }).backoff !== undefined) {
    throw new Error(
      retiredSpellingLine(
        removalOf("schedule.poll({ backoff })"),
        `schedule.poll '${id}'`,
      ),
    );
  }
  const factor = opts.factor ?? 1;
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
}

/** backoff — `(id, attempt, action, opts)` (see {@linkcode schedule.backoff}). */
export interface BackoffFn {
  <A>(
    id: string,
    attempt: number,
    action: ScheduleAction & SA<A> | A & SA<A>,
    opts: BackoffOpts,
  ): ScheduleEffect;
}

/** poll — `(id, attempt, action, opts)` (see {@linkcode schedule.poll}). */
export interface PollFn {
  <A>(
    id: string,
    attempt: number,
    action: ScheduleAction & SA<A> | A & SA<A>,
    opts: PollOpts,
  ): ScheduleEffect;
}

const _backoff: BackoffFn = ((
  id: string,
  attempt: number,
  a3: unknown,
  a4: unknown,
): ScheduleEffect => {
  if (!_isAction(a3)) _refuseOldOrder("backoff", id);
  return _backoffEffect(id, attempt, a4 as BackoffOpts, a3);
}) as BackoffFn;

const _poll: PollFn = ((
  id: string,
  attempt: number,
  a3: unknown,
  a4: unknown,
): ScheduleEffect => {
  if (!_isAction(a3)) _refuseOldOrder("poll", id);
  return _pollEffect(id, attempt, a4 as PollOpts, a3);
}) as PollFn;

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
   *  The action is the 3rd argument, same as after/every/at/cron (alpha52;
   *  the order it replaced is refused by name since alpha70).
   *
   *  `max` is optional and defaults to the timer ceiling (`MAX_TIMER_DELAY`,
   *  ~24.85 days) — an unbounded `base * factor^attempt` reaches 10^15 ms by
   *  attempt 40, which is not a delay anyone means. Pass an explicit `max`
   *  (60_000 is the usual one) for a real ceiling.
   * @example
   * ```ts
   * // on tick: poll; on failure bump attempt and reschedule
   * s.$do(schedule.backoff('rpc', s.attempt, A.poll(), { base: 1000, max: 60000 }))
   * ``` */
  backoff: _backoff,
  /** A self-pacing poller. Re-issue each cycle with the current
   *  `attempt` — 0 while healthy, bumped on failure. It polls every `every` ms,
   *  and on repeated failures backs off by `factor`^attempt up to `max`. A
   *  first-class replacement for the hand-rolled after-chain that RPC
   *  rate-limit foot-guns come from. `factor` defaults to 1 (constant polling;
   *  its pre-alpha70 spelling `backoff` is refused by name), and `max` to the
   *  timer ceiling (`MAX_TIMER_DELAY`, ~24.85 days) so a runaway `attempt`
   *  cannot compute a delay no timer can hold.
   *
   *  The action is the 3rd argument, same as after/every/at/cron (alpha52;
   *  the order it replaced is refused by name since alpha70).
   * @example
   * ```ts
   * // on tick: do the poll; on success set attempt=0, on failure attempt+1,
   * // then reschedule — the delay self-adjusts.
   * s.$do(schedule.poll('rpc', s.attempt, A.tick(), { every: 5000, factor: 2, max: 60000 }))
   * ``` */
  poll: _poll,
  /** Defer an action to the next tick — the honest primitive for "run this
   *  right after the current method returns". A true 0ms timer (alpha52 —
   *  it used to arm 1ms because `after` rejected 0; `after` now takes 0
   *  properly). Same-id replace still applies, so it dedups. */
  next: (
    id: string,
    action: { type: string; payload?: unknown },
  ): ScheduleEffect => ({
    type: "__schedule",
    kind: "after",
    id,
    ms: 0,
    action,
  }),
  cancel: (id: string): ScheduleEffect => ({
    type: "__schedule",
    kind: "cancel",
    id,
  }),
  // Off-thread work is `blocking(id, fn, arg)` — a top-level export of `aio`
  // and server-only. It is deliberately NOT a member here: `schedule` ships to
  // every runtime (browser bundle, android), and a member that throws
  // "server-only" on two of three targets is a trap, not an API.
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

/** One cron field, expanded.
 *
 *  `name` and `pattern` exist only for the error messages. The old text was
 *  `invalid cron range: 1-70 (0-59)` — it never said WHICH of the five fields
 *  was wrong and never echoed the pattern it came from, so a reader with
 *  `"0 1-70 * * *"` in a config file had to work out that `(0-59)` meant
 *  minutes. Its sibling branch (`invalid cron step`) already named the fix; the
 *  range branch simply had not caught up. */
function parseField(
  field: string,
  min: number,
  max: number,
  name: string,
  pattern: string,
): number[] {
  const where = `${name} field of cron pattern "${pattern}"`;
  const values: number[] = [];
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "*") {
      for (let i = min; i <= max; i++) values.push(i);
    } else if (trimmed.startsWith("*/")) {
      const step = Number(trimmed.slice(2));
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(
          `invalid step "${trimmed}" in the ${where} — a step must be a ` +
            `positive integer, e.g. "*/5" (every 5th value from ${min}).`,
        );
      }
      for (let i = min; i <= max; i += step) values.push(i);
    } else if (trimmed.includes("-")) {
      // Range: "1-5" or "1-5/2"
      const [rangePart, stepPart] = trimmed.split("/");
      const [startStr, endStr] = (rangePart ?? "").split("-");
      if (!startStr || !endStr) {
        throw new Error(
          `invalid range "${trimmed}" in the ${where} — a range needs both ` +
            `ends, written low-high within ${min}-${max}, e.g. "${min}-${max}".`,
        );
      }
      const start = Number(startStr), end = Number(endStr);
      const step = stepPart ? Number(stepPart) : 1;
      if (
        !Number.isInteger(start) || !Number.isInteger(end) || start < min ||
        end > max || start > end
      ) {
        throw new Error(
          `invalid range "${trimmed}" in the ${where} — ${name} accepts ` +
            `${min}-${max}, low end first. Got ${startStr}-${endStr}.`,
        );
      }
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(
          `invalid step "${trimmed}" in the ${where} — a step must be a ` +
            `positive integer, e.g. "1-5/2" (every 2nd value from 1 to 5).`,
        );
      }
      for (let i = start; i <= end; i += step) values.push(i);
    } else {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(
          `invalid value "${trimmed}" in the ${where} — ${name} accepts a ` +
            `whole number ${min}-${max}, "*", a list ("1,15"), a range ` +
            `("1-5") or a step ("*/5").`,
        );
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
      `cron pattern must have 5 space-separated fields ` +
        `(minute hour day-of-month month day-of-week), got ${parts.length}: ` +
        `"${pattern}". Example: "0 3 * * *" — 03:00 every day.`,
    );
  }
  return {
    minute: parseField(parts[0]!, 0, 59, "minute", pattern),
    hour: parseField(parts[1]!, 0, 23, "hour", pattern),
    dom: parseField(parts[2]!, 1, 31, "day-of-month", pattern),
    month: parseField(parts[3]!, 1, 12, "month", pattern),
    dow: parseField(parts[4]!, 0, 6, "day-of-week", pattern),
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
  /** @internal Total per-id bookkeeping entries, across every map. Exists so
   *  "the registry does not grow without bound" can be ASSERTED (a leak that
   *  `active()` cannot see is a leak nothing can catch). */
  _bookkeepingSize: () => number;
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
    // Not the collision warning: that is "once per id, ever", and a replace is
    // exactly what it warns about — clearing it here would make it warn on
    // every replace. It is bounded by `spentId()` and `cancelAll()` instead.
  }

  /** Every per-id bookkeeping map, for an id that no longer exists at all. */
  function forgetId(id: string): void {
    cancelTimer(id);
    warnedCollisions.delete(id);
    staticIds.delete(id);
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
          `other. Use unique ids per schedule source.` +
          // Name the REMEDY, not only the mechanism. `every` and the
          // self-scheduling `after` chain are taught next to each other, and
          // combining them wrongly is easy: a field report shipped the wrong
          // shape in two cells before this warning taught them the rule, and
          // said the message described what happened without saying what to do.
          (existing.kind === "every" && kind === "every"
            ? ` An \`every\` re-armed from inside its OWN tick restarts the ` +
              `interval on every pass: arm it ONCE (from \`onStart\` or a ` +
              `static \`schedules:\` entry) and let it repeat. A tick that ` +
              `re-schedules itself wants \`after\`, not \`every\`.`
            : ""),
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
      const result = await dispatch(action);
      // A one-shot is SPENT the moment its dispatch lands: the timer entry is
      // already gone and the epoch only had to outlive the retry window, which
      // just closed. Leaving it behind grew `epochs` by one entry per unique
      // id for the life of the process — and one-shot ids are routinely unique
      // (`toast:<uuid>`, `retry:<jobId>`), so a long-running app's registry
      // grew without bound while `active()` reported nothing.
      if (
        (kind === "after" || kind === "at") && !timers.has(id) &&
        epochs.get(id) === epoch
      ) {
        epochs.delete(id);
        skips.delete(id);
      }
      return result;
    } catch (e) {
      // CLASSIFY BEFORE REPORTING. The dispatch loop being gone is a normal
      // shutdown race, not a failure: `dispatch()` already reports it, at warn,
      // once per action type, with the rest suppressed. Logging at error above
      // this check meant every clean exit printed one ERROR per live schedule —
      // measured at seven lines in a real app, immediately above its own
      // `stopped … errors=0` summary, for a condition the next three lines
      // exist to handle.
      const code = (e as { code?: string })?.code;
      const closed = code === "DISPATCH_CLOSED" || code === "DISPATCH_DRAINING";
      if (closed) {
        // There is nothing to retry into, and re-arming a timer here would
        // resurrect one `cancelAll()` just cleared.
        log.debug(`schedule: '${id}' dropped — the dispatch loop is closed`);
        cancelTimer(id);
        return;
      }
      log.error(`schedule: dispatch '${id}' failed: ${e}`);
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

  /** A duration that is not a number slips past every comparison below —
   *  `"1s" < 10` is false, `Number.isFinite("1s")` reports only the coerced
   *  NaN, and `setInterval` turns the string into a 1ms hot loop. The type
   *  says `number`, but the dev server is transpile-only: a string reaches here
   *  from any app that never ran `deno check`, including the `schedules:`
   *  entries the framework arms itself at boot. aio's CLI does take `60s`
   *  spellings (`am cost --window=60s`), so reaching for one here is the
   *  natural mistake — name the accepted form instead of reporting the
   *  coercion. */
  function requireMs(api: string, id: string, ms: number): void {
    if (typeof ms !== "number") {
      throw new Error(
        `schedule.${api} '${id}': ms is a plain NUMBER of milliseconds, got ` +
          `${typeof ms} ${JSON.stringify(ms)} — write 300_000, not "5m"`,
      );
    }
  }

  function handleAfter(
    id: string,
    ms: number,
    action: { type: string; payload?: unknown },
  ): void {
    requireMs("after", id, ms);
    // 0 is a real delay ("next tick" — schedule.next arms it); negatives are a
    // caller bug. The old floor of 1 forced `next` to carry a 1ms sentinel.
    if (ms < 0) {
      throw new Error(`schedule.after '${id}': ms must be >= 0, got ${ms}`); // AIO-252
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
    requireMs("every", id, ms);
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
      // `at` is REPLACE semantics: issuing it for an id cancels whatever that
      // id was. Returning early kept the previous job armed, so re-pointing a
      // reminder at a time that turned out to be in the past left the OLD one
      // to fire — a schedule the app believed it had moved. Cancel first, then
      // say what happened, both halves in one line.
      const replaced = timers.has(id) || epochs.has(id);
      cancelTimer(id);
      log.warn(
        `schedule: at '${id}' is in the past (${time}, ${
          Math.round((clock.now() - target) / 1000)
        }s ago) — it will never fire and is not registered${
          replaced
            ? `; the previous '${id}' schedule it replaces was CANCELLED`
            : ""
        }. Times are UTC.`,
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

  /** A `self("m")` descriptor that reached the scheduler unresolved names no
   *  cell — dispatching it would be a silent no-op. Refuse loudly instead. */
  function rejectUnresolvedSelf(
    id: string,
    action: { type: string; payload?: unknown },
  ): void {
    const m = selfMethodOf(action);
    if (m !== null) {
      throw new Error(
        `schedule '${id}': action self("${m}") was never resolved to a cell ` +
          `method — self() only works from inside a cell method (s.$do, a ` +
          `returned effect, or cancelOn). Use the cell's own action type ` +
          `(e.g. myCell.${m}.action()) here.`,
      );
    }
  }

  function handle(effect: ScheduleEffect): void {
    validateId(effect.id);
    if (effect.kind !== "cancel") {
      rejectUnresolvedSelf(effect.id, effect.action);
    }
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
      rejectUnresolvedSelf(def.id, def.action); // no owning cell here — refuse
      staticIds.add(def.id);
      if ("every" in def) {
        handleEvery(def.id, def.every, def.action, def.skipIfRunning === true);
      } else if ("after" in def) handleAfter(def.id, def.after, def.action);
      else if ("at" in def) handleAt(def.id, def.at, def.action);
      else if ("cron" in def) handleCron(def.id, def.cron, def.action);
    }
  }

  function cancelAll(): void {
    for (const id of [...timers.keys()]) forgetId(id);
    timers.clear();
    // Every id is gone, so every per-id note about one is too. These three
    // were the maps `cancelAll` did not clear, which is how a process that
    // boots and tears down apps in a loop (every test file, every dev restart)
    // kept a growing record of ids nothing could ever refer to again.
    warnedCollisions.clear();
    staticIds.clear();
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
    for (
      const id of new Set([
        ...timers.keys(),
        ...epochs.keys(),
        ...staticIds,
        ...warnedCollisions,
      ])
    ) {
      if (id === prefix || id.startsWith(match)) forgetId(id);
    }
  }

  function active(): string[] {
    return [...timers.keys()];
  }

  return {
    handle,
    start,
    cancelAll,
    cancelByPrefix,
    active,
    _bookkeepingSize: () =>
      timers.size + epochs.size + inFlight.size + skips.size +
      staticIds.size + warnedCollisions.size,
  };
}

// ── Virtual clock ───────────────────────────────────────────────────

/** Let every already-queued microtask run, the way a real turn of the event
 *  loop does before the next timer callback. Ten rounds covers the promise
 *  chains a scheduled tick realistically builds (each `await` costs one). */
async function _drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

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
  /** Move time forward, firing everything that comes due, in order — and
   *  draining microtasks between fires, as the real event loop does. */
  advance: (ms: number) => Promise<void>;
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
    async advance(ms: number): Promise<void> {
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
        // The real event loop separates two timer callbacks by a full turn:
        // every microtask the first one queued has run before the second
        // starts. Firing them back-to-back made the harness MORE FORGIVING
        // than production — a tick whose promise chain had already settled in
        // reality was still "running" here, so `skipIfRunning` skipped where
        // production would fire (and every retry/backoff chain resolved a beat
        // late). A test environment that is softer than production is how
        // green-test-broken-prod is manufactured; this is the one place the
        // virtual clock could be honest about it for free.
        await _drainMicrotasks();
      }
      now = target;
    },
  };
}
