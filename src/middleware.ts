// Middleware factories — built-in interceptors for aio.run({ middleware: [...] })
// Extracted from aio.ts. Self-contained — no _run internals needed.

import { log } from "./logger.ts";

/** Middleware function — intercepts actions before reduce */
export type MiddlewareFn = (
  action: unknown,
  state: unknown,
  user?: { id: string; role: string },
) => unknown | null;

/** Composes multiple beforeReduce functions into one. */
export function composeMiddleware<S, A>(
  ...fns: ((
    action: A,
    state: S,
    user?: { id: string; role: string },
  ) => A | null)[]
): (action: A, state: S, user?: { id: string; role: string }) => A | null {
  return (
    action: A,
    state: S,
    user?: { id: string; role: string },
  ): A | null => {
    let result: A | null = action;
    for (const fn of fns) {
      if (result === null) return null;
      result = fn(result, state, user);
    }
    return result;
  };
}

/** Built-in middleware factories for aio.run({ middleware: [...] }) */
export const middleware = {
  /** Log all dispatched actions (or filter by feature name) */
  logger: (opts?: { features?: string[] }): MiddlewareFn => {
    const filter = opts?.features
      ? new Set(opts.features.map((f) => f.toLowerCase()))
      : null;
    return (action, _state) => {
      const type = (action as { type: string }).type;
      if (filter) {
        const prefix = type.split(":")[0]?.toLowerCase() ?? "";
        if (!filter.has(prefix)) return action;
      }
      const source = (action as { _source?: string })._source;
      const tag = source ? ` [${source}]` : "";
      log.debug("action", `${tag.slice(1, -1) || "-"} ${type}`);
      return action;
    };
  },

  /** Redux DevTools integration — connects state to browser devtools extension */
  devtools: (): MiddlewareFn => {
    return (action, _state) => action; // actual connection handled by connectDevTools() in browser
  },

  /** Performance budget — warn/error if reduce takes too long */
  perfBudget: (opts: { reduce?: number; effect?: number }): MiddlewareFn => {
    return (action, _state) => {
      // Perf budgets are already handled by createDispatch — this middleware
      // allows overriding via the middleware array as well
      const type = (action as { type: string }).type;
      const start = performance.now(); // Store start time for post-reduce check (side-channel via global)
      (globalThis as Record<string, unknown>).__aioMiddlewarePerfStart = start;
      (globalThis as Record<string, unknown>).__aioMiddlewarePerfBudget = opts;
      void type; // used for logging in perf violations
      return action;
    };
  },

  /** Validate action shapes — ensure type is string, payload is plain object */
  validate: (): MiddlewareFn => {
    return (action, _state) => {
      const a = action as Record<string, unknown>;
      if (typeof a.type !== "string") {
        log.error(
          "middleware",
          `action.type must be a string, got ${typeof a.type}`,
        );
        return null;
      }
      if (
        a.payload !== undefined &&
        (typeof a.payload !== "object" || a.payload === null ||
          Array.isArray(a.payload))
      ) {
        log.warn(
          "middleware",
          `action.payload should be a plain object: ${a.type}`,
        );
      }
      return action;
    };
  },

  /** Track action counts, timing, error rates per feature */
  metrics: (): MiddlewareFn => {
    const counters = new Map<string, { count: number; errors: number }>();
    (globalThis as Record<string, unknown>).__aioMetrics = counters;
    return (action, _state) => {
      const type = (action as { type: string }).type;
      const prefix = type.split(":")[0] ?? "unknown";
      const entry = counters.get(prefix) ?? { count: 0, errors: 0 };
      entry.count += 1;
      counters.set(prefix, entry);
      return action;
    };
  },

  /** Deep freeze state after reduce (catches accidental mutations in dev) */
  freeze: (): MiddlewareFn => {
    // Actual freezing handled by dispatch.ts freezeState option
    return (action, _state) => action;
  },

  /** Create custom middleware — return modified action, or null to drop.
   *  `pass` is identity — call it to signal the action should continue unmodified.
   *  The return value determines what happens: return action to continue, null to drop. */
  create: (
    fn: (
      action: unknown,
      state: unknown,
      pass: (action: unknown) => unknown,
      user?: { id: string; role: string },
    ) => unknown,
  ): MiddlewareFn => {
    return (action, state, user) => fn(action, state, (a) => a, user);
  },
};
