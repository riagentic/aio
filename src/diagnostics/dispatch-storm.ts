/**
 * @module
 * Dispatch-storm detection (watcher-loop field report #2) — names runaway dispatch
 * feedback loops by *frequency* instead of letting them surface as downstream
 * symptoms (perf-budget noise, log churn, event-loop starvation).
 *
 * The original incident: an app's workspace watcher observed aio's own log
 * writes → `fsChanged` dispatched 500×/s sustained → 130% CPU, dead listener.
 * `BUDGET_EFFECT` guards duration only, so the storm itself went unnamed.
 */

/** Config for {@linkcode createStormDetector} — also the shape of
 *  `aio.run({ dispatchStorm })`. */
export type StormConfig = {
  /** Dispatches/second per action type that count as "hot" (default: 200) */
  rate?: number;
  /** Consecutive hot seconds before a storm is declared (default: 5) */
  sustain?: number;
  /** Drop the offending action while its storm persists (default: false —
   *  warn only). The drop happens in `beforeReduce`, so reducers, effects,
   *  logging, and broadcast never run for dropped dispatches. */
  breaker?: boolean;
};

/** Storm notification passed to the `onStorm` callback. */
export type StormInfo = {
  /** Offending action type, e.g. "workspace:fsChanged" */
  type: string;
  /** Measured rate in the last full second (dispatches/sec) */
  rate: number;
  /** How many consecutive seconds the type stayed above the threshold */
  seconds: number;
  /** True when the breaker is active — dispatches are being dropped */
  breaking: boolean;
};

type TypeState = {
  bucketStart: number;
  count: number;
  hotSeconds: number;
  lastRate: number;
  storming: boolean;
  dropped: number;
};

/** A dispatch-rate tracker. Call `track(type)` on every dispatch; it returns
 *  `false` when the breaker is on and that type is mid-storm (drop it). */
export type StormDetector = {
  track(type: string): boolean;
  /** Currently-storming action types (for tests/status surfaces) */
  storming(): string[];
};

/** Creates a per-action-type dispatch-rate tracker with 1-second buckets.
 *  `onStorm` fires once when a storm starts and once when it ends (rate 0).
 *  `now` is injectable for tests. */
export function createStormDetector(
  cfg: StormConfig & {
    onStorm?: (info: StormInfo) => void;
    now?: () => number;
  } = {},
): StormDetector {
  const rate = cfg.rate ?? 200;
  const sustain = cfg.sustain ?? 5;
  const breaker = cfg.breaker ?? false;
  const now = cfg.now ?? Date.now;
  const types = new Map<string, TypeState>();

  function roll(s: TypeState, type: string, nowMs: number): void {
    const elapsed = nowMs - s.bucketStart;
    if (elapsed < 1000) return;
    // Evaluate the closed bucket(s). A gap of >1 bucket means the type went
    // quiet — rate for the skipped seconds is 0, ending any storm.
    s.lastRate = elapsed < 2000 ? s.count : 0;
    if (s.lastRate >= rate) {
      s.hotSeconds++;
      if (!s.storming && s.hotSeconds >= sustain) {
        s.storming = true;
        cfg.onStorm?.({
          type,
          rate: s.lastRate,
          seconds: s.hotSeconds,
          breaking: breaker,
        });
      }
    } else {
      if (s.storming) {
        cfg.onStorm?.({
          type,
          rate: s.lastRate,
          seconds: s.hotSeconds,
          breaking: false,
        });
      }
      s.hotSeconds = 0;
      s.storming = false;
      s.dropped = 0;
    }
    s.count = 0;
    s.bucketStart = nowMs;
  }

  return {
    track(type: string): boolean {
      const nowMs = now();
      let s = types.get(type);
      if (!s) {
        s = {
          bucketStart: nowMs,
          count: 0,
          hotSeconds: 0,
          lastRate: 0,
          storming: false,
          dropped: 0,
        };
        types.set(type, s);
      }
      roll(s, type, nowMs);
      s.count++;
      if (breaker && s.storming) {
        s.dropped++;
        return false;
      }
      return true;
    },
    storming(): string[] {
      return [...types.entries()].filter(([, s]) => s.storming).map((
        [t],
      ) => t);
    },
  };
}
