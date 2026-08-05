// logger-observe.ts — Action observer logic for AioLogger

import type { LogLevel } from "./logger-types.ts";
import { filterInternal } from "./logger-types.ts";
import { isActionNoise } from "./action-kind.ts";
import { actionOrigin } from "./action-kind.ts";
import { isRedactedAction, noRedaction, REDACTED } from "./redact.ts";
import type { Redactor } from "./redact.ts";

/** Minimal interface for the parts of AioLogger that observe() needs */
export type ObserveCtx = {
  suppressTypes: string[];
  stats: { dispatched: number; errors: number };
  lastStatus: Map<string, string>;
  /** The app's `redactActions` list. debug.log RETAINS payloads on disk, so it
   *  is governed by the same one list as the journal, the timeline, the action
   *  log and the checkpoint — it was the sink that was not, and it wrote a
   *  redacted method's arguments in cleartext. */
  redact?: Redactor;
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

  // Skip pure internals entirely (`cell:__exec` — a marker, not a change).
  // `cell:__setMethod` is NOT one: it is the only action carrying what an
  // async or transactional method wrote. See action-kind.ts.
  if (isActionNoise(type)) return;
  if (ctx.suppressTypes.includes(type)) return;

  const prefix = type.split(":")[0]?.toLowerCase() ?? "unknown";
  const redact = ctx.redact ?? noRedaction;
  // A write-set commit and an error frame travel under their OWN type, so the
  // originating `cell:method` decides too — an exact pattern would otherwise
  // plug the call and leak the same values under a different name.
  const hidden = isRedactedAction(redact, type, actionOrigin(type, payload));

  // ── Cell lifecycle ─────────────────────────────────────────
  if (type.endsWith(":__init")) {
    ctx.emit("info", `cell:${prefix}`, "ready");
    return;
  }
  if (type.endsWith(":__destroy")) {
    ctx.emit("info", `cell:${prefix}`, "stopped");
    return;
  }

  // ── Async method error ────────────────────────────────────────
  if (type.endsWith(":__error")) {
    ctx.stats.errors++;
    ctx.emit(
      "error",
      `cell:${prefix}`,
      `${payload._method ?? "?"} failed`,
      { error: hidden ? REDACTED : String(payload.error ?? "?") },
    );
    return;
  }

  // ── Everything else -> debug.log only, then check machine state
  ctx.emit(
    "debug",
    `cell:${prefix}`,
    type.slice(prefix.length + 1),
    hidden ? { payload: REDACTED } : filterInternal(payload),
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
