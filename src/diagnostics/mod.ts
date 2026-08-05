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
import { noRedaction, REDACTED } from "./redact.ts";
import type { Redactor } from "./redact.ts";

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

/** aio's own diagnostic artifacts, and the flag that owns each one. */
const ARTIFACTS = {
  actionLog: ["actions.jsonl"],
  checkpoint: ["checkpoint.json", "checkpoint.json.tmp"],
} as const;

/**
 * Remove the artifacts of every disabled writer.
 *
 * Deliberately narrow: only files aio itself writes, only in aio's own log
 * directory, and only for a flag that is currently OFF. A removal is reported
 * at info level rather than done quietly — deleting a file the developer can
 * see is exactly the kind of thing that must never be a surprise.
 */
export function purgeDisabledArtifacts(
  logDir: string,
  enabled: { actionLog: boolean; checkpoint: boolean },
): string[] {
  const removed: string[] = [];
  for (const [flag, files] of Object.entries(ARTIFACTS)) {
    if (enabled[flag as keyof typeof enabled]) continue;
    for (const f of files) {
      try {
        Deno.removeSync(`${logDir}/${f}`);
        removed.push(f);
      } catch {
        // Absent is the normal case; unreadable/locked is the app's own dir to
        // fix, and failing boot over a leftover diagnostic file would be worse
        // than leaving it.
      }
    }
  }
  if (removed.length > 0) {
    log.info(
      "diagnostics",
      `removed ${
        removed.join(", ")
      } — the writer is off, so the artifact goes too`,
    );
  }
  return removed;
}

/** Initialize the diagnostics subsystem. Returns null if disabled. */
export function initDiagnostics(
  config: DiagnosticsConfig,
  isProd: boolean,
  logDir: string,
  guardDispatches?: boolean,
  /** Shared with the journal and timeline — see diagnostics/redact.ts. */
  redact: Redactor = noRedaction,
): DiagnosticsHooks | null {
  const opts = resolveOptions(config, isProd);
  // A writer that is OFF must not leave its output behind. Turning `actionLog`
  // off stopped new lines but left every line already written — including, in
  // one real case, an unlock action's passphrase, world-readable, for as long
  // as the log directory lived. The flag is the whole
  // contract: off means the artifact does not exist.
  purgeDisabledArtifacts(logDir, {
    actionLog: opts !== false && !!opts.actionLog,
    checkpoint: opts !== false && !!opts.checkpoint,
  });
  if (opts === false) return null;

  // ── Checkpoint (read early, before cells init) ──
  let recovered: CheckpointData | null = null;
  let cpWriter: ReturnType<typeof createCheckpoint> | null = null;
  if (opts.checkpoint) {
    recovered = readCheckpoint(logDir);
    if (recovered) {
      const age = Date.now() - recovered.ts;
      const ageSec = Math.round(age / 1000);
      // AIO-417: don't imply automatic recovery — a diagnostic
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
  // Diagnostics observe; they never decide. Each writer runs inside its own
  // guard so (a) one failing writer can't take out the others, and (b) nothing
  // propagates to the caller — the runtime's afterAction chain continues into
  // work that IS load-bearing (the sync-cell durability fold, the journal, the
  // timeline), and a broken state diff must never cost a durable write.
  // Reported once per stage: it fails identically on every action.
  const stageFailed = new Set<string>();
  function observe(stage: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (stageFailed.has(stage)) return;
      stageFailed.add(stage);
      log.error(
        "diagnostics",
        `${stage} failed and was skipped — diagnostics are observe-only, so ` +
          `the action still applied. This output is now incomplete ` +
          `(reported once). Cause: ${
            e instanceof Error ? e.message : String(e)
          }`,
      );
    }
  }

  function afterAction(
    prev: Record<string, unknown>,
    next: Record<string, unknown>,
    action: { type: string; payload?: unknown },
  ): void {
    if (diffEnabled && prev !== next) {
      observe("state-diff", () => {
        const diffs = computeDiffs(prev, next);
        for (const d of diffs) {
          log.debug("state-diff", formatDiff(d.cell, d.changes));
        }
      });
    }
    if (actionLog) {
      observe("action-log", () => {
        actionLog!.append(
          action.type,
          redact(action.type) ? REDACTED : action.payload,
        );
      });
    }
    lastState = next;
    recentActions.push(action.type);
    if (recentActions.length > MAX_RECENT) recentActions.shift();
    if (cpWriter && prev !== next) {
      observe("checkpoint", () => {
        cpWriter!.schedule({
          ts: Date.now(),
          state: next,
          recentActions: [...recentActions],
          cells: getHealthSnapshot(),
        });
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
