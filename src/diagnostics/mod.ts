// src/diagnostics/mod.ts — Entry point: resolve config, init components, return hooks

import {
  type CheckpointData,
  type DiagnosticsConfig,
  resolveOptions,
} from "./types.ts";
import { computeDiffs, formatDiff } from "./state-diff.ts";
import { createActionLog } from "./action-log.ts";
import { createCheckpoint, readCheckpoint } from "./checkpoint.ts";
import { installCrashHandler } from "./crash-handler.ts";
import { log } from "./logger.ts";
import { diagSubscribe } from "./diagnostic-bus.ts";

/** Lifecycle hooks returned by initDiagnostics for the runtime to call */
export type DiagnosticsHooks = {
  afterAction: (
    prev: Record<string, unknown>,
    next: Record<string, unknown>,
    action: { type: string; payload?: unknown },
  ) => void;
  onStart: (cellNames: string[]) => void;
  onStop: () => Promise<void>;
  onError: (cellName: string) => void;
  getRecoveredState: () => CheckpointData | null;
  setHealthGetter: (
    fn: () => Record<string, { errors: number; enabled: boolean }>,
  ) => void;
  uninstallCrashHandler?: () => void;
};

/** Initialize the diagnostics subsystem. Returns null if disabled. */
export function initDiagnostics(
  config: DiagnosticsConfig,
  isProd: boolean,
  logDir: string,
  guardDispatches?: boolean,
): DiagnosticsHooks | null {
  const opts = resolveOptions(config, isProd);
  if (opts === false) return null;

  // ── Checkpoint (read early, before cells init) ──
  let recovered: CheckpointData | null = null;
  let cpWriter: ReturnType<typeof createCheckpoint> | null = null;
  if (opts.checkpoint) {
    recovered = readCheckpoint(logDir);
    if (recovered) {
      const age = Date.now() - recovered.ts;
      const ageSec = Math.round(age / 1000);
      // AIO-417 (TBD U5): don't imply automatic recovery — a diagnostic
      // checkpoint is only applied if the app provides an `onCheckpointRestore`
      // hook. The old "found state from Xs ago" read as "state was recovered".
      if (age > 3600_000) {
        log.warn(
          "checkpoint",
          `diagnostic snapshot is ${
            Math.round(age / 60_000)
          }m old — applied only via onCheckpointRestore; consider starting fresh`,
        );
      } else {
        log.info(
          "checkpoint",
          `diagnostic snapshot from ${ageSec}s ago (applied only if onCheckpointRestore is set)`,
        );
      }
    }
    const debounce = typeof opts.checkpoint === "object"
      ? (opts.checkpoint.debounce ?? 5000)
      : 5000;
    cpWriter = createCheckpoint(logDir, debounce);
  }

  // ── Action log ──
  let actionLog: ReturnType<typeof createActionLog> | null = null;
  if (opts.actionLog) {
    const max = typeof opts.actionLog === "object"
      ? (opts.actionLog.max ?? 1000)
      : 1000;
    actionLog = createActionLog(`${logDir}/actions.jsonl`, max);
  }

  // ── State diffs ──
  const diffEnabled = !!opts.stateDiffs;

  // ── Internal state for checkpoint ──
  let lastState: Record<string, unknown> = {};
  const recentActions: string[] = [];
  const MAX_RECENT = 20;
  const cellErrorCounts = new Map<string, number>();
  const cellEnabled = new Map<string, boolean>();
  let healthGetter:
    | (() => Record<string, { errors: number; enabled: boolean }>)
    | null = null;

  function getHealthSnapshot(): Record<
    string,
    { errors: number; enabled: boolean }
  > {
    if (healthGetter) return healthGetter();
    const result: Record<string, { errors: number; enabled: boolean }> = {};
    for (const [name, count] of cellErrorCounts) {
      result[name] = {
        errors: count,
        enabled: cellEnabled.get(name) ?? true,
      };
    }
    return result;
  }

  // ── Crash handler ──
  let uninstallCrash: (() => void) | undefined;
  if (opts.crashHandler) {
    uninstallCrash = installCrashHandler({
      guardRejections: guardDispatches,
      log: { error: (msg, data) => log.error("crash", msg, data) },
      getHealthData: () => ({ cells: getHealthSnapshot() }),
      writeEmergencyCheckpoint: () => {
        if (cpWriter) {
          cpWriter.writeSync({
            ts: Date.now(),
            state: lastState,
            recentActions: [...recentActions],
            cells: getHealthSnapshot(),
          });
        }
      },
    });
  }

  // ── Diagnostic bus → structured logger ──
  if (opts.diagnosticBus !== false) {
    diagSubscribe((ev) => {
      if (ev.severity === "error") log.error("diag", ev.message);
      else if (ev.severity === "warning") log.warn("diag", ev.message);
    });
  }

  // ── Hooks ──
  function afterAction(
    prev: Record<string, unknown>,
    next: Record<string, unknown>,
    action: { type: string; payload?: unknown },
  ): void {
    if (diffEnabled && prev !== next) {
      const diffs = computeDiffs(prev, next);
      for (const d of diffs) {
        log.debug("state-diff", formatDiff(d.cell, d.changes));
      }
    }
    if (actionLog) actionLog.append(action.type, action.payload);
    lastState = next;
    recentActions.push(action.type);
    if (recentActions.length > MAX_RECENT) recentActions.shift();
    if (cpWriter && prev !== next) {
      cpWriter.schedule({
        ts: Date.now(),
        state: next,
        recentActions: [...recentActions],
        cells: getHealthSnapshot(),
      });
    }
  }

  function onStart(cellNames: string[]): void {
    for (const name of cellNames) {
      cellErrorCounts.set(name, 0);
      cellEnabled.set(name, true);
    }
  }

  function onError(cellName: string): void {
    cellErrorCounts.set(
      cellName,
      (cellErrorCounts.get(cellName) ?? 0) + 1,
    );
  }

  async function onStop(): Promise<void> {
    if (actionLog) await actionLog.flush();
    if (cpWriter) await cpWriter.flush();
  }

  return {
    afterAction,
    onStart,
    onStop,
    onError,
    getRecoveredState: () => recovered,
    setHealthGetter: (fn) => {
      healthGetter = fn;
    },
    uninstallCrashHandler: uninstallCrash,
  };
}

export { type CheckpointData, type DiagnosticsConfig } from "./types.ts";
