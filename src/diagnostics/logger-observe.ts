// logger-observe.ts — Action observer logic for AioLogger

import type { LogLevel } from "./logger-types.ts";
import {
  elapsed,
  filterInternal,
  FLOW_STEP_RE,
  SKIP_CONTAINS,
  SKIP_SUFFIXES,
  stripFlowPrefix,
} from "./logger-types.ts";

/** Minimal interface for the parts of AioLogger that observe() needs */
export type ObserveCtx = {
  suppressTypes: string[];
  stats: { dispatched: number; errors: number };
  flowStarts: Map<string, number>;
  lastStatus: Map<string, string>;
  emit: (
    lvl: LogLevel,
    cat: string,
    msg: string,
    data?: Record<string, unknown> | null,
    dur?: number,
  ) => void;
};

/** Process a dispatched action — routes to the correct log level/category */
export function observeAction(
  ctx: ObserveCtx,
  action: { type: string; payload?: unknown },
  state: Record<string, unknown>,
): void {
  const type = action.type;
  const payload = (action.payload ?? {}) as Record<string, unknown>;

  ctx.stats.dispatched++;

  // Skip pure internals entirely
  if (SKIP_SUFFIXES.some((s) => type.endsWith(s))) return;
  if (SKIP_CONTAINS.some((s) => type.includes(s))) return;
  if (ctx.suppressTypes.includes(type)) return;

  const prefix = type.split(":")[0]?.toLowerCase() ?? "unknown";

  // ── Cell lifecycle ─────────────────────────────────────────
  if (type.endsWith(":__init")) {
    ctx.emit("info", `cell:${prefix}`, "ready");
    return;
  }
  if (type.endsWith(":__destroy")) {
    ctx.emit("info", `cell:${prefix}`, "stopped");
    return;
  }

  // ── Flow events ───────────────────────────────────────────────
  if (FLOW_STEP_RE.test(type)) {
    const flowName = payload._flow as string | undefined;
    if (flowName) {
      const key = `${prefix}:${flowName}`;
      if (!ctx.flowStarts.has(key)) ctx.flowStarts.set(key, Date.now());
    }
    ctx.emit(
      "debug",
      `flow:${prefix}`,
      stripFlowPrefix(type),
      filterInternal(payload),
    );
    return;
  }

  if (type.endsWith(":__flow:done")) {
    const flowName = payload._flow as string ?? "?";
    const key = `${prefix}:${flowName}`;
    const dur = elapsed(ctx.flowStarts.get(key));
    ctx.flowStarts.delete(key);
    ctx.emit(
      "info",
      `flow:${prefix}`,
      `${flowName} done`,
      filterInternal(payload),
      dur,
    );
    return;
  }

  if (type.endsWith(":__flow:failed")) {
    const flowName = payload._flow as string ?? "?";
    ctx.flowStarts.delete(`${prefix}:${flowName}`);
    ctx.stats.errors++;
    ctx.emit("error", `flow:${prefix}`, `${flowName} failed`, {
      reason: payload.reason ?? "unknown",
    });
    return;
  }

  if (type.endsWith(":__flow:error")) {
    ctx.stats.errors++;
    ctx.emit("error", `flow:${prefix}`, `${payload.flow ?? "?"} error`, {
      error: String(payload.error ?? "?"),
    });
    return;
  }

  // ── Async method error ────────────────────────────────────────
  if (type.endsWith(":__error")) {
    ctx.stats.errors++;
    ctx.emit(
      "error",
      `cell:${prefix}`,
      `${payload._method ?? "?"} failed`,
      { error: String(payload.error ?? "?") },
    );
    return;
  }

  // ── Everything else -> debug.log only, then check machine state
  ctx.emit(
    "debug",
    `cell:${prefix}`,
    type.slice(prefix.length + 1),
    filterInternal(payload),
  );

  // Check machine state transitions (any action may cause a status change)
  checkTransitions(ctx, state);
}

function checkTransitions(
  ctx: ObserveCtx,
  state: Record<string, unknown>,
): void {
  for (const [name, last] of ctx.lastStatus) {
    const newStatus = (state[name] as Record<string, unknown> | undefined)
      ?.__aio_status as string | undefined;
    if (newStatus !== undefined && newStatus !== last) {
      ctx.lastStatus.set(name, newStatus);
      if (newStatus) ctx.emit("info", `cell:${name}`, newStatus);
    }
  }
}
