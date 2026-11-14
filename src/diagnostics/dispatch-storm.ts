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

/** The values {@linkcode createStormDetector} uses when `rate`/`sustain` are
 *  omitted — or are not a value it can act on. */
export const STORM_DEFAULTS = { rate: 200, sustain: 5 } as const;

function validStormRate(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1;
}

function validStormSustain(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

/** Why `aio.run({ dispatchStorm })` would not do what it says — one sentence
 *  per problem, empty when it is fine. Warned at boot, never refused: every
 *  one of these booted through 1.0.24 (the compatibility rule). An unusable
 *  `rate`/`sustain` is replaced by its default at runtime, and the sentence
 *  says so. Pure. */
export function stormConfigProblems(v: unknown): string[] {
  if (v === undefined || v === null || typeof v === "boolean") return [];
  if (typeof v !== "object" || Array.isArray(v)) {
    return [
      `dispatchStorm is ${
        JSON.stringify(v)
      }, which is neither true/false nor { rate, sustain, breaker } — the ` +
      `guard runs with its defaults`,
    ];
  }
  const out: string[] = [];
  const c = v as Record<string, unknown>;
  if (c.rate !== undefined && !validStormRate(c.rate)) {
    out.push(
      `dispatchStorm.rate is ${
        JSON.stringify(c.rate)
      }, which is not a number of dispatches per second ≥ 1 — using the ` +
        `default ${STORM_DEFAULTS.rate} (write rate: 200, not "200/s")`,
    );
  }
  if (c.sustain !== undefined && !validStormSustain(c.sustain)) {
    out.push(
      `dispatchStorm.sustain is ${
        JSON.stringify(c.sustain)
      }, which is not a whole number of seconds ≥ 1 — using the default ` +
        `${STORM_DEFAULTS.sustain}`,
    );
  }
  if (c.breaker !== undefined && typeof c.breaker !== "boolean") {
    out.push(
      `dispatchStorm.breaker is ${
        JSON.stringify(c.breaker)
      }, which is not true or false — it is read for truthiness, so ` +
        `"false" turns the breaker ON`,
    );
  }
  return out;
}

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
  /** This is the END of a storm, not the start of one.
   *
   *  There was no discriminator, so the handler guessed from `rate === 0` —
   *  and a storm that ends at ANY non-zero rate (i.e. the ordinary way: the
   *  rate drops back under the threshold) took the WARN branch. The result was
   *  a storm warning whose reported rate was BELOW the configured threshold,
   *  plus a second `dispatch:storm` diagnostic emitted at the moment the
   *  problem went away. The module's own doc says "`onStorm` fires once when a
   *  storm starts and once when it ends (rate 0)" — a claim with no test,
   *  false for the commonest way a storm ends. */
  ended?: boolean;
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
 *  `onStorm` fires once when a storm STARTS and once when it ENDS — and the
 *  end carries `ended: true` rather than a rate the caller has to interpret
 *  (a storm that recovers by dropping under the threshold ends at a NON-zero
 *  rate, so "rate 0" was never the discriminator this line used to claim).
 *
 *  The detector is dispatch-driven: no timer is armed per app. A storm whose
 *  source goes SILENT is therefore closed on the next dispatch of ANY type, or
 *  the next `storming()` — both are clock reads. Without that sweep it was
 *  closed by nothing at all: `onStorm` never fired its end, `storming()` went
 *  on naming the type, and the last word in the log was the warning.
 *  `now` is injectable for tests. */
export function createStormDetector(
  cfg: StormConfig & {
    onStorm?: (info: StormInfo) => void;
    now?: () => number;
  } = {},
): StormDetector {
  // A value the comparisons below cannot act on is read as the default, not
  // as written: `rate: "200/s"` compared as NaN and no storm was ever named,
  // and `rate: 0` made EVERY type "storm" after `sustain` seconds — with
  // `breaker`, each was then dropped for good. Both booted silently; the boot
  // now says so (`stormConfigProblems`, warned by aio-run-entry.ts) and this
  // is what that warning promises.
  const rate = validStormRate(cfg.rate) ? cfg.rate : STORM_DEFAULTS.rate;
  const sustain = validStormSustain(cfg.sustain)
    ? cfg.sustain
    : STORM_DEFAULTS.sustain;
  const breaker = cfg.breaker ?? false;
  const now = cfg.now ?? Date.now;
  const types = new Map<string, TypeState>();
  /** How many types are mid-storm. The sweep below runs only when this is
   *  non-zero, so an app that never storms pays one integer test per
   *  dispatch — which is what lets the sweep sit on the hot path at all. */
  let storming = 0;

  /** Close the bucket of every STORMING type whose clock has run on.
   *
   *  `roll` only ever ran for the type being dispatched, so a storm whose
   *  source went quiet was ended by nothing: the commonest real recovery — the
   *  feedback loop is fixed, the watcher stops — produced no end event and
   *  left `storming()` naming it forever. Every dispatch, of any type, and
   *  every `storming()` is a clock read; this is what makes them count. */
  function sweep(nowMs: number): void {
    if (storming === 0) return;
    for (const [t, st] of [...types.entries()]) {
      if (st.storming) roll(st, t, nowMs);
    }
  }

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
        storming++;
        cfg.onStorm?.({
          type,
          rate: s.lastRate,
          seconds: s.hotSeconds,
          breaking: breaker,
        });
      }
    } else {
      if (s.storming) {
        storming--;
        cfg.onStorm?.({
          type,
          rate: s.lastRate,
          seconds: s.hotSeconds,
          breaking: false,
          ended: true,
        });
      }
      s.hotSeconds = 0;
      s.storming = false;
      s.dropped = 0;
      // Evict quiet types so the map can't grow unbounded over a long-running
      // server with many distinct action types. A type that went silent for
      // >2s and isn't storming is re-created fresh on its next dispatch.
      if (s.lastRate === 0 && elapsed >= 2000) {
        types.delete(type);
        return;
      }
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
      // …and close any OTHER storm whose source has gone quiet. See `sweep`.
      sweep(nowMs);
      s.count++;
      if (breaker && s.storming) {
        s.dropped++;
        return false;
      }
      return true;
    },
    storming(): string[] {
      // Asking is a clock read too: a status surface must not be told a storm
      // is raging because nothing happens to have been dispatched since it
      // stopped.
      sweep(now());
      return [...types.entries()].filter(([, s]) => s.storming).map((
        [t],
      ) => t);
    },
  };
}
