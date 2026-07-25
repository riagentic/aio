// Runtime helpers extracted from _run() — config resolution, memoization, vitals, app object
import type { AioApp, AioConfig, AioUser } from "./aio-types.ts";
import type { ReportErrorOpts } from "../diagnostics/error.ts";
import {
  markError,
  record,
  type ReduceBreakdown,
  type TTState,
} from "../diagnostics/time-travel.ts";
import { createCoalescer } from "./broadcast-coalescer.ts";
import type { VitalsSystem } from "../vitals/mod.ts";
import type { ComposedCells } from "../state/cell.ts";
import type { ServerHandle } from "./server-types.ts";
import { AppLock, lockDir } from "./single-instance-lock.ts";
import { launchElectronClient } from "../electron/electron.ts";
import { getLogger, log } from "../diagnostics/logger.ts";

/** Memoized getUIState — skips re-computation when state ref unchanged (AIO-9) */
export function createMemoizedUIState<S>(
  rawGetUIState: (s: S, user?: AioUser) => unknown,
): (s: S, user?: AioUser) => unknown {
  let memoState: S | null = null;
  const memoResults = new Map<string, unknown>();
  return (s: S, user?: AioUser): unknown => {
    if (s !== memoState) {
      memoState = s;
      memoResults.clear();
    }
    const uid = user?.id ?? "";
    if (memoResults.has(uid)) return memoResults.get(uid); // AIO-245
    const result = rawGetUIState(s, user);
    memoResults.set(uid, result);
    return result;
  };
}

/** Build reportOpts for error reporting — wired after tt init.
 *  Takes a GETTER for the time-travel state: `record()`/`undo()` replace the
 *  TTState object on every action, so capturing the value would pin markError
 *  to the stale boot snapshot and error marks would never reach the live
 *  timeline. */
export function buildReportOpts<S>(opts: {
  onError: AioConfig<S, unknown, unknown>["onError"];
  getTT: () => TTState<S, { type: string }> | null;
  prod: boolean;
}): ReportErrorOpts {
  return {
    onError: opts.onError,
    logger: getLogger()
      ? {
        error: (msg: string, data?: Record<string, unknown>) =>
          getLogger()!.pub("error", "aio", msg, data),
      }
      : undefined,
    tt: opts.getTT()
      ? {
        markError: (
          err: {
            code: string;
            message: string;
            cellName?: string;
            flowStep?: number;
          },
        ) => {
          const t = opts.getTT();
          if (t) markError(t, err);
        },
      }
      : undefined,
    prod: opts.prod,
  };
}

/** Start vitals periodic check timer — returns cleanup timer handle */
export function startVitalsCheck(opts: {
  vitalsSystem: VitalsSystem;
  heartbeatInterval: number;
  dispatch: { getQueueDepth: () => number; getEffectBacklog: () => number };
  getState: () => unknown;
}): ReturnType<typeof setInterval> {
  return setInterval(() => {
    opts.vitalsSystem.loopProbe.updateQueueDepth(
      opts.dispatch.getQueueDepth(),
    );
    opts.vitalsSystem.loopProbe.updateEffectBacklog(
      opts.dispatch.getEffectBacklog(),
    );
    const composed = (globalThis as Record<string, unknown>).__aioCells as
      | ComposedCells
      | undefined;
    if (composed) {
      const health = composed.registry.health(
        opts.getState() as Record<string, unknown>,
      );
      const tripped = health.filter((f: { enabled: boolean }) => !f.enabled)
        .map((f: { name: string }) => f.name);
      opts.vitalsSystem.loopProbe.updateCircuitBreakers(tripped);
    }
    opts.vitalsSystem.checkAndAlert();
  }, opts.heartbeatInterval);
}

/** Build the AioApp object — dispatch, getState, snapshot/loadSnapshot, close */
export function buildAppObject<S, A>(refs: {
  dispatch: (action: A) => Promise<unknown>;
  getState: () => S;
  setState: (s: S) => void;
  port: number;
  asyncDb: unknown;
  initialState: S;
  persistence: { resetPrevState: () => void };
  schedulePersist: () => void;
  getTT: () => TTState<S, { type: string }> | null;
  setTT: (tt: TTState<S, { type: string }>) => void;
  getServer: () => ServerHandle;
  udsBroadcastFull: () => void;
  shutdown: () => Promise<void>;
  sessionStore?: import("./sessions.ts").SessionStore | null;
  userStore?: import("./auth-users.ts").UserStore | null;
}): AioApp<S, A> {
  return {
    dispatch: refs.dispatch,
    getState: refs.getState,
    port: refs.port,
    sessions: refs.sessionStore ?? undefined,
    auth: refs.userStore ?? undefined,
    db: (refs.asyncDb ?? undefined) as AioApp<S, A>["db"],
    snapshot: () => JSON.stringify(refs.getState()),
    loadSnapshot: (json: string) => {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(
          "loadSnapshot: snapshot must be a JSON object — pass the exact string returned by app.snapshot()",
        );
      }
      const initKeys = new Set(
        Object.keys(refs.initialState as Record<string, unknown>),
      );
      const snapKeys = Object.keys(parsed as Record<string, unknown>);
      const unknown = snapKeys.filter((k) => !initKeys.has(k));
      if (unknown.length) {
        log.warn(`snapshot: unknown keys present: ${unknown.join(", ")}`);
      }
      refs.setState(parsed as S);
      refs.persistence.resetPrevState();
      const tt = refs.getTT();
      if (tt) {
        refs.setTT(record(tt, { type: "__snapshot" }, refs.getState()));
        refs.getServer().broadcastTT();
      }
      refs.schedulePersist();
      refs.getServer().broadcast();
      refs.udsBroadcastFull();
      log.info("snapshot: loaded");
    },
    close: async () => {
      await refs.shutdown();
    },
  };
}

/** Build onPerf callback for TT + vitals tracking */
export function buildOnPerf<S>(
  tt: TTState<S, { type: string }> | null,
  vitalsSystem: VitalsSystem | undefined,
):
  | ((timing: {
    actionType: string;
    reduce: number;
    effects: number;
    budget: { reduce: number; effect: number };
    breakdown?: ReduceBreakdown;
  }) => void)
  | undefined {
  if (!tt && !vitalsSystem) return undefined;
  return (timing) => {
    if (tt && tt.entries.length > 0) {
      tt.entries[tt.index]!.perf = {
        reduce: timing.reduce,
        effects: timing.effects,
        budget: timing.budget,
        breakdown: timing.breakdown,
      };
    }
    if (vitalsSystem) {
      vitalsSystem.loopProbe.onPerf(timing);
    }
  };
}

import type { PatchEntry } from "../protocol/broadcast-utils.ts";
import type { UDSHandle } from "./uds.ts";

/** UDS broadcast controller — encapsulates throttle state + provides shutdown hooks */
export type UdsBroadcastController = {
  /** Throttled broadcast for dispatch — pass patches or true for force-full */
  onUdsBroadcast: (
    validPatches?: boolean | PatchEntry[],
  ) => void;
  /** Direct broadcast — for TT/snapshot state jumps (force-full) */
  broadcastFull: () => void;
  /** Cancel the pending throttle timer — used by createShutdownOrchestrator */
  dispose: () => void;
};

/** Build UDS broadcast throttle callback for dispatch */
export function createUdsBroadcastController(refs: {
  getUdsHandle: () => UDSHandle | null;
  syncIntervalMs: number;
}): UdsBroadcastController {
  const broadcastState = (
    forceOrPatches?: boolean | PatchEntry[],
  ) => {
    const handle = refs.getUdsHandle();
    if (!handle) return;
    handle.broadcastState(forceOrPatches);
  };
  // The shared coalescer buffers patches (and a pending force-full) across the
  // queue/throttle window and flushes them as ONE send — identical semantics
  // to the WS broadcaster, because both now use the same primitive. This is
  // what closes the risoto 2026-07-19 bug (UDS used to drop patches while WS
  // buffered them) by construction: the two transports can no longer diverge.
  const coalescer = createCoalescer<PatchEntry>(
    refs.syncIntervalMs,
    (patches, force) =>
      broadcastState(force ? true : (patches.length > 0 ? patches : undefined)),
  );

  return {
    onUdsBroadcast: (validPatches) => {
      if (!refs.getUdsHandle()) return;
      if (validPatches === true) coalescer.forceFull();
      else {coalescer.add(
          Array.isArray(validPatches) ? validPatches : undefined,
        );}
    },
    // A deliberate full-state jump (time-travel / snapshot) sends immediately —
    // it is not part of the coalesced per-dispatch stream.
    broadcastFull: () => broadcastState(true),
    dispose: () => coalescer.dispose(),
  };
}

/** Single-instance enforcement — lock in /tmp/aio/{appId}.lock */
export async function acquireSingletonLock(
  appId: string,
  port: number,
  singletonMode: boolean,
  killExisting: boolean,
): Promise<AppLock | null> {
  if (singletonMode === false) return null;
  const appLock = new AppLock(appId);
  const result = await appLock.acquire(port, killExisting);
  if (!result.ok) {
    const ex = result.existing;
    const exUrl = `http://localhost:${ex.port}`;
    console.error(
      `[AIO] ${
        killExisting ? "Failed to take over" : "Already running"
      }: ${ex.appId} at ${exUrl} (pid ${ex.pid})`,
    );
    Deno.exit(1);
  }
  log.debug(`lock: acquired ${lockDir()}/${appId}.lock (PID ${Deno.pid})`);
  return appLock;
}

/** --server-url thin client mode — launches Electron with connect-page, then exits.
 *  Returns true if we handled the thin-client path (caller should exit). */
export async function handleThinClient(
  serverUrl: string | undefined,
  setRunning: (v: boolean) => void,
): Promise<boolean> {
  if (serverUrl === undefined) return false;
  if (serverUrl) log.info(`connecting to ${serverUrl}`);
  else log.info("launching connect page");
  const proc = await launchElectronClient(log, serverUrl || undefined);
  if (proc) {
    const status = await proc.status;
    log.info(`electron closed (code ${status.code ?? 0})`);
  }
  setRunning(false);
  Deno.exit(0);
}

import { type DiagnosticsConfig, initDiagnostics } from "../diagnostics/mod.ts";
import { getLogDir } from "../diagnostics/logger-api.ts";
import {
  type DiagnosticsOptions,
  resolveOptions as resolveDiagOptions,
} from "../diagnostics/types.ts";
import { createVitalsSystem } from "../vitals/mod.ts";

/** Initialize diagnostics + vitals from config — returns hooks and vitals system */
export function initDiagAndVitals(
  diagConfig: DiagnosticsConfig | false | undefined,
  prod: boolean,
  cellNames?: string[],
  guardDispatches?: boolean,
): {
  diagHooks: ReturnType<typeof initDiagnostics> | null;
  vitalsSystem: VitalsSystem | undefined;
  diagResolvedOpts: DiagnosticsOptions | false;
} {
  // `true`/omitted → defaults on ({}); `false` → off; object → tuned.
  const diagOn = diagConfig !== false;
  const diagCfg = (diagConfig === true || diagConfig == null) ? {} : diagConfig;
  const diagHooks = !diagOn
    ? null
    : initDiagnostics(diagCfg, prod, getLogDir(), guardDispatches);
  if (diagHooks && cellNames) diagHooks.onStart(cellNames);

  const diagResolvedOpts = !diagOn ? false : resolveDiagOptions(diagCfg, prod);
  let vitalsSystem: VitalsSystem | undefined;
  if (diagResolvedOpts && diagResolvedOpts.vitals !== false) {
    const vitalsConfig = typeof diagResolvedOpts.vitals === "object"
      ? diagResolvedOpts.vitals
      : {};
    vitalsSystem = createVitalsSystem(vitalsConfig);
  }

  return { diagHooks, vitalsSystem, diagResolvedOpts };
}

/** Resolve window title: CLI > config > deno.json "title" > fallback */
export async function resolveTitle(
  cliTitle: string | undefined,
  uiTitle: string | undefined,
): Promise<string> {
  if (cliTitle) return cliTitle;
  if (uiTitle) return uiTitle;
  try {
    const { join } = await import("@std/path");
    const raw = await Deno.readTextFile(join(Deno.cwd(), "deno.json"));
    const denoJsonTitle = JSON.parse(raw).title;
    if (denoJsonTitle) return denoJsonTitle;
  } catch { /* no deno.json or no title field */ }
  return "AIO App";
}
