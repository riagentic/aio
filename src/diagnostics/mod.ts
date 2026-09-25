// src/diagnostics/mod.ts — Entry point: resolve config, init components, return hooks

import {
  type CheckpointData,
  type DiagnosticsConfig,
  resolveOptions,
} from "./types.ts";
import { computeDiffs, formatDiff } from "./state-diff.ts";
import { sweepStaleTmps, uuidTmpAfter } from "./tmp-sweep.ts";
import { createActionLog } from "./action-log.ts";
import {
  type CheckpointView,
  createCheckpoint,
  readCheckpoint,
} from "./checkpoint.ts";
import { installCrashHandler } from "./crash-handler.ts";
import { log } from "./logger-api.ts";
import { diagSubscribe } from "./diagnostic-bus.ts";
import { isRedactedAction, noRedaction, REDACTED } from "./redact.ts";
import { actionOrigin } from "./action-kind.ts";
import type { Redactor } from "./redact.ts";
import { isDiagnosticsOptOut } from "./diagnostics-optout.ts";
import { WORKER_PATCH_ACTION } from "./action-kind.ts";

/** The cell an action belongs to: the `cell:` prefix of its type, or — for a
 *  `worker: true` cell's patch batch, whose type names no cell — the cell in
 *  its payload. */
function actionCell(type: string, payload: unknown): string | undefined {
  if (type === WORKER_PATCH_ACTION) {
    const c = (payload as { cell?: unknown } | null | undefined)?.cell;
    return typeof c === "string" && c !== "" ? c : undefined;
  }
  const i = type.indexOf(":");
  return i > 0 ? type.slice(0, i) : undefined;
}

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
  /** Hand the checkpoint the app's restore rule, so it never holds a
   *  `persist: "none"` cell (see `CheckpointView`). Optional: a runtime with
   *  no cells has no rule, and its checkpoint stays whole. */
  setCheckpointView?: (view: CheckpointView) => void;
  setHealthGetter: (
    fn: () => Record<string, { errors: number; enabled: boolean }>,
  ) => void;
  uninstallCrashHandler?: () => void;
  /** Flip the crash guard from boot mode (rejections fatal) to runtime mode
   *  (rejections supervised) — called by aio.run when boot succeeds. */
  markBootComplete: () => void;
};

/** aio's own diagnostic artifacts, and the flag that owns each one. */
const ARTIFACTS = {
  actionLog: ["actions.jsonl"],
  checkpoint: ["checkpoint.json", "checkpoint.json.tmp"],
} as const;
const CHECKPOINT_TMP = "checkpoint.json.tmp";

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
    // …and the random-named tmps its writer leaves on a crash
    // (`checkpoint.json.tmp.<uuid>`), by the same narrow rule as the sweep.
    if (flag === "checkpoint") {
      removed.push(...sweepStaleTmps(logDir, [uuidTmpAfter(CHECKPOINT_TMP)]));
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

/** A checkpoint older than this is worth a WARN when it is about to be
 *  handed to `onCheckpointRestore` (see `staleCheckpointWarning`). */
export const CHECKPOINT_STALE_MS = 3600_000;

/** `42s` under two minutes, `Nm` after — the snapshot's age as a boot line
 *  reads it. */
function fmtCheckpointAge(ageMs: number): string {
  return ageMs < 120_000
    ? `${Math.round(ageMs / 1000)}s`
    : `${Math.round(ageMs / 60_000)}m`;
}

/** The warning for a checkpoint about to be handed to `onCheckpointRestore`,
 *  or null while it is fresh. Only the restore site calls it — the one place
 *  that knows a hook exists — so an app with no hook never sees a WARN about
 *  a snapshot nothing will apply (field report (a desktop agent app) §1). Pure. */
export function staleCheckpointWarning(
  ts: number,
  now: number = Date.now(),
): string | null {
  const age = now - ts;
  return age > CHECKPOINT_STALE_MS
    ? `checkpoint: handing a ${
      fmtCheckpointAge(age)
    }-old diagnostic snapshot to onCheckpointRestore — consider starting fresh (delete logs/checkpoint.json)`
    : null;
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
  let cpView: CheckpointView | null = null;
  /** Is `cell` one that must never be kept (`persist: "none"`)? Asked of the
   *  view — the app's restore rule, built from `persistingCellIds` — so every
   *  sink below follows the ONE persist decider rather than restating it.
   *  `logs/actions.jsonl` wrote such a cell's arguments (the token its
   *  `setToken(t)` was called with) in cleartext, in 1.0.11, on every call. */
  const unkept = (cell: string | undefined): boolean =>
    cell !== undefined && cpView !== null && !(cell in cpView({ [cell]: 0 }));
  /** What the view leaves of one key's value inside a KEPT cell — a field a
   *  `persist: { exclude | include }` keeps off disk comes back REDACTED, a
   *  dot-path exclude below the key is projected out. The same view, asked
   *  of a one-key slice, so the field rule is not restated here: debug.log
   *  printed `token ""→"TOPSECRET"` for exactly the field the checkpoint
   *  beside it dropped. */
  const keptValue = (cell: string, key: string, v: unknown): unknown => {
    if (cpView === null || key === "_root") return v;
    const slice = cpView({ [cell]: { [key]: v } })[cell];
    return slice !== null && typeof slice === "object" && key in slice
      ? (slice as Record<string, unknown>)[key]
      : REDACTED;
  };
  let cpWriter: ReturnType<typeof createCheckpoint> | null = null;
  if (opts.checkpoint) {
    recovered = readCheckpoint(logDir);
    if (recovered) {
      // AIO-417: don't imply automatic recovery — a diagnostic
      // checkpoint is only applied if the app provides an `onCheckpointRestore`
      // hook. The old "found state from Xs ago" read as "state was recovered".
      // INFO at any age: this point cannot know whether a hook exists, and
      // without one nothing applies the snapshot — a WARN that asks for no
      // action, on every boot, is noise. The WARN for an OLD snapshot belongs
      // where it is about to be applied: `staleCheckpointWarning`, called by
      // the restore step (aio-boot.ts) only when the hook is set.
      log.info(
        "checkpoint",
        `diagnostic snapshot from ${
          fmtCheckpointAge(Date.now() - recovered.ts)
        } ago (applied only if onCheckpointRestore is set)`,
      );
    }
    const debounce = typeof opts.checkpoint === "object"
      ? (opts.checkpoint.debounce ?? 5000)
      : 5000;
    // The checkpoint honours the SAME redaction list as the other three sinks.
    // It was the one that did not, and it is the one that writes the most.
    cpWriter = createCheckpoint(logDir, debounce, redact, () => cpView);
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
  let bootComplete = false;
  if (opts.crashHandler) {
    uninstallCrash = installCrashHandler({
      guardRejections: guardDispatches,
      isBootComplete: () => bootComplete,
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
  // Unsubscribed at stop: the subscription closes over this whole instance
  // (checkpoint view, health getter → the app's config), and the bus is one
  // per process — kept, every closed app stayed reachable from it forever.
  let unsubscribeBus: (() => void) | null = null;
  if (opts.diagnosticBus !== false) {
    unsubscribeBus = diagSubscribe((ev) => {
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
    // `cell({ diagnostics: false })` — this cell's actions stay out of every
    // sink that puts them ON DISK: the state-diff debug log, the action
    // journal, and the checkpoint's recentActions.
    //
    // WHAT IT DOES NOT TOUCH, on purpose. The durability journal
    // (`journal: true`) is not a diagnostic — it is how committed actions are
    // replayed, and dropping a cell from it would be silent data loss dressed
    // as a privacy feature. Nor does it touch persistence: a cell that must
    // keep its STATE off disk says `persist: "none"`, and making one key mean
    // both is exactly the conflation this key exists to end. (A
    // `persist: "none"` cell's PAYLOADS are withheld separately — see `unkept`
    // — because its arguments are the state it must never keep; the line
    // itself stays, which is what `diagnostics: false` removes.)
    const quiet = isDiagnosticsOptOut(action.type);
    if (diffEnabled && prev !== next && !quiet) {
      observe("state-diff", () => {
        const diffs = computeDiffs(prev, next);
        for (const d of diffs) {
          // A redacted cell's VALUES are exactly what a state diff prints, and
          // debug.log keeps them on disk. The timeline redacts diff before/after
          // for this reason ("redacting the payload alone would have been
          // theatre"), and so does the checkpoint; this sink printed
          // `vault: key ""→"hunter2"` in cleartext. The changed KEYS stay — what
          // moved is not the secret.
          const hide = redact.redactsCell(d.cell) || unkept(d.cell);
          log.debug(
            "state-diff",
            formatDiff(
              d.cell,
              hide
                ? d.changes.map((c) => ({
                  key: c.key,
                  from: REDACTED,
                  to: REDACTED,
                }))
                : d.changes.map((c) => ({
                  key: c.key,
                  from: keptValue(d.cell, c.key, c.from),
                  to: keptValue(d.cell, c.key, c.to),
                })),
            ),
          );
        }
      });
    }
    if (actionLog && !quiet) {
      observe("action-log", () => {
        // The write-set of a redacted method carries the same secret as its
        // arguments, under a DIFFERENT type — the ORIGIN decides too, exactly
        // as it does for the journal and the timeline.
        // …and a `persist: "none"` cell's actions carry the values it must
        // never keep: its arguments ARE its state.
        const hide = isRedactedAction(
          redact,
          action.type,
          actionOrigin(action.type, action.payload),
        ) || unkept(actionCell(action.type, action.payload)) ||
          // A `worker: true` cell's patch batch names no cell in its type —
          // its ops are the values the method stored — so it goes by the
          // payload's cell, the answer the journal and timeline give it.
          (action.type === WORKER_PATCH_ACTION &&
            redact.redactsCell(actionCell(action.type, action.payload) ?? ""));
        actionLog!.append(action.type, hide ? REDACTED : action.payload);
      });
    }
    lastState = next;
    if (!quiet) recentActions.push(action.type);
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
    unsubscribeBus?.();
    unsubscribeBus = null;
    if (actionLog) await actionLog.flush();
    if (cpWriter) await cpWriter.flush();
  }

  return {
    afterAction,
    onStart,
    onStop,
    onError,
    getRecoveredState: () => recovered,
    setCheckpointView: (v) => {
      cpView = v;
      // The checkpoint an OLDER build left is rewritten through the view at
      // once when it holds anything the view drops — not on this run's first
      // write, which may never come (tests/hosts.test.ts, boot step).
      // Compared by CONTENT, not by cell count: the view also drops fields a
      // `persist: { exclude }` keeps off disk, inside cells it keeps. The
      // state was parsed from JSON, so both sides serialize.
      if (recovered && cpWriter) {
        const kept = v(recovered.state);
        if (
          JSON.stringify(kept) !== JSON.stringify(recovered.state)
        ) cpWriter.rewriteNow(recovered);
      }
      // …and so is what an older build wrote to the action log for a cell
      // that is now `persist: "none"`: new lines are withheld on the way in
      // (`afterAction`), the old ones are rewritten here, once, in place.
      actionLog?.scrub(
        (type, payload) => unkept(actionCell(type, payload)),
        REDACTED,
      ).then(
        (n) =>
          n > 0 && log.info(
            "action-log",
            `withheld the payload of ${n} line(s) an older build wrote for ` +
              `persist:"none" cell(s) — rewritten in place`,
          ),
        (e) =>
          log.error(
            "action-log",
            `could not rewrite the payloads an older build wrote for ` +
              `persist:"none" cell(s) — they may still be in the log: ${e}`,
          ),
      );
    },
    setHealthGetter: (fn) => {
      healthGetter = fn;
    },
    uninstallCrashHandler: uninstallCrash,
    markBootComplete: () => {
      bootComplete = true;
    },
  };
}

export { type CheckpointData, type DiagnosticsConfig } from "./types.ts";
