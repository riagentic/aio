// Runtime helpers extracted from _run() — config resolution, memoization, vitals, app object
import { DENO_JSON_NAMES, parseDenoJson } from "./deno-json.ts";
import type { AioApp, AioConfig, AioUser } from "./aio-types.ts";
import type { ReportErrorOpts } from "../diagnostics/error.ts";
import {
  attachPerf,
  markError,
  record,
  type ReduceBreakdown,
  type TTState,
} from "../diagnostics/time-travel.ts";
import { createCoalescer } from "./broadcast-coalescer.ts";
import { attributeRound } from "./server-broadcast.ts";
import type { VitalsSystem } from "../vitals/mod.ts";
import type { ComposedCells } from "../state/cell.ts";
import type { ServerHandle } from "./server-types.ts";
import {
  AppLock,
  instances,
  lockDir,
  type LockMeta,
} from "./single-instance-lock.ts";
import { resolve } from "@std/path";
import { runtimeCount } from "./shutdown.ts";
import { launchElectronClient } from "../electron/electron.ts";
import { getLogger, log } from "../diagnostics/logger-api.ts";

/** Cache key for a user — a STABLE serialization of everything `ui.forUser`
 *  can observe, not just the id.
 *
 *  Keying on `user.id` alone was a cross-user leak: `resolveUser` may return
 *  `{id:"alice", role:"admin"}` for one token and `{id:"alice", role:"viewer"}`
 *  for another (impersonation, a role switch, a re-issued session, two devices
 *  with different scopes). `forUser` receives the WHOLE user object, so two
 *  users that differ anywhere are two different views — and the admin's view
 *  was being served to the viewer whenever no dispatch happened in between.
 *  The `""` bucket was worse still: every user-less caller (UDS, trojan,
 *  anonymous WS) shared one slot with any user whose id was empty.
 *
 *  Object keys are sorted so two structurally-equal users still share a slot,
 *  and the key is recomputed per call so an IN-PLACE mutation of a
 *  connection's user object (a role change on a live socket) invalidates it.
 *
 *  Cost: one JSON pass over a user record (a handful of small fields) per
 *  client per broadcast, against a `forUser` call that structuredClones and
 *  rewrites the whole cell slice — two to three orders of magnitude apart on
 *  any state worth memoizing. The memo keeps its purpose; it just can no
 *  longer answer a question it was not asked.
 *
 *  Returns null when the user cannot be serialized (cycles, exotic values) —
 *  the caller then SKIPS the cache entirely and recomputes. A cache miss costs
 *  time; a wrong cache hit costs someone else's data. */
function userMemoKey(user?: AioUser): string | null {
  // "no user" is its OWN bucket, and cannot be spelled by any serialized user:
  // every JSON.stringify of an object starts with "{".
  if (user === undefined || user === null) return "no-user";
  try {
    const key = JSON.stringify(user, (_k, v) => {
      // Values JSON drops or mangles become OBJECTS, never marker strings — a
      // marker string could be forged by a user field holding that exact text,
      // which would alias two different users into one cache slot.
      if (v === undefined) return { __aioUndefined: true };
      if (typeof v === "function") return { __aioFunction: true };
      if (typeof v === "bigint") return { __aioBigInt: String(v) };
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(v as Record<string, unknown>).sort()) {
          sorted[k] = (v as Record<string, unknown>)[k];
        }
        return sorted;
      }
      return v;
    });
    return typeof key === "string" ? key : null;
  } catch {
    return null; // cyclic / unserializable → no caching, ever
  }
}

let _memoKeyWarned = false;

/** Memoized getUIState — skips re-computation when state ref unchanged (AIO-9).
 *  Keyed on the FULL user (see userMemoKey), because that is exactly what
 *  `ui.forUser` is handed. */
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
    const key = userMemoKey(user);
    if (key === null) {
      if (!_memoKeyWarned) {
        _memoKeyWarned = true;
        log.warn(
          "getUIState: this user object cannot be serialized (cycle or exotic " +
            "value), so its per-user view is recomputed on every broadcast " +
            "rather than cached — correctness over speed. Keep user records " +
            "plain data if this shows up in a profile.",
        );
      }
      return rawGetUIState(s, user);
    }
    if (memoResults.has(key)) return memoResults.get(key); // AIO-245
    const result = rawGetUIState(s, user);
    memoResults.set(key, result);
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
    // The shim is ALWAYS installed and asks the getter each time. Deciding once,
    // by calling the getter here, is the same as capturing the value: this runs
    // during boot, BEFORE time travel is created, so the getter answered null
    // and the marker was never installed — no error reached a history entry in
    // any running app, and an empty error column reads as "nothing failed".
    // (`markError` itself no-ops when TT is off.)
    tt: {
      markError: (
        err: {
          code: string;
          message: string;
          cellName?: string;
          actionType?: string;
        },
      ) => {
        const t = opts.getTT();
        if (t) markError(t, err);
      },
    },
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
  /** Called after state is replaced wholesale (snapshot load) — worker cells
   *  hold their own copy and must be re-seeded. */
  onStateReplaced?: () => void;
  shutdown: () => Promise<void>;
  sessionStore?: import("./sessions.ts").SessionStore | null;
  userStore?: import("./auth-users.ts").UserStore | null;
  blobs?: import("./blobs.ts").BlobStore;
}): AioApp<S, A> {
  return {
    dispatch: refs.dispatch,
    getState: refs.getState,
    port: refs.port,
    sessions: refs.sessionStore ?? undefined,
    auth: refs.userStore ?? undefined,
    db: (refs.asyncDb ?? undefined) as AioApp<S, A>["db"],
    blobs: refs.blobs,
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
      // Worker cells hold their own copy of their slice — a wholesale swap has
      // to reach them, or they'd keep mutating the state we just replaced.
      refs.onStateReplaced?.();
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

/** Build onPerf callback for TT + vitals tracking.
 *
 *  Takes a GETTER for time travel, for the same reason `buildReportOpts` does:
 *  `record()` returns a NEW TTState per action, so a captured value is the boot
 *  snapshot forever. It captured the value — and since the entries ARRAY is
 *  copied but its entries are shared by reference, every action's timing was
 *  written onto the one entry that snapshot held (`__init`). The panel showed
 *  no timing on any real action and a stranger's timing on `__init`. */
export function buildOnPerf<S>(
  getTT: () => TTState<S, { type: string }> | null,
  vitalsSystem: VitalsSystem | undefined,
  /** Cost meter — reduce time per cell for `am cost`. Reuses the timings the
   *  dispatch loop already produces; no new measurement on the hot path. */
  costMeter?: { recordReduce(cell: string, ms: number): void },
):
  | ((timing: {
    actionType: string;
    reduce: number;
    effects: number;
    budget: { reduce: number; effect: number };
    breakdown?: ReduceBreakdown;
  }) => void)
  | undefined {
  if (!getTT() && !vitalsSystem && !costMeter) return undefined;
  return (timing) => {
    if (costMeter) {
      // "cell:method" / "cell/ACTION" → cell. An action with no separator is
      // its own bucket rather than being dropped.
      const at = timing.actionType ?? "";
      const cut = at.indexOf(":") >= 0 ? at.indexOf(":") : at.indexOf("/");
      costMeter.recordReduce(cut > 0 ? at.slice(0, cut) : at, timing.reduce);
    }
    const tt = getTT();
    if (tt && tt.entries.length > 0) {
      // Matched by action type: an action time travel skipped has no entry, and
      // its numbers must not be printed against someone else's.
      attachPerf(tt, timing.actionType, {
        reduce: timing.reduce,
        effects: timing.effects,
        budget: timing.budget,
        breakdown: timing.breakdown,
      });
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
  /** Interactive priority: drain the coalescer NOW (client-action latency). */
  flushUrgent: () => void;
  /** Cancel the pending throttle timer — used by createShutdownOrchestrator */
  dispose: () => void;
};

/** Build UDS broadcast throttle callback for dispatch */
export function createUdsBroadcastController(refs: {
  getUdsHandle: () => UDSHandle | null;
  syncIntervalMs: number;
  /** The cost meter, so `am cost` sees the UDS transport at all. Optional
   *  because a caller without one (every unit test of the throttle) must not
   *  have to build one — the attribution simply does not happen. */
  costMeter?: () => Parameters<typeof attributeRound>[0] | null;
  /** The client-facing state, for attributing a whole-slice resend. */
  getUIState?: () => Record<string, unknown> | undefined;
  /** Count ONE real broadcast round — `vitals`' broadcasts/sec pressure alarm.
   *  The WS flush only counts a round when it has WS clients, which is right
   *  for WS and left a desktop app (every client on the socket) with the alarm
   *  permanently silent. Same class as the cost meter above it. */
  onBroadcastRound?: () => void;
}): UdsBroadcastController {
  const broadcastState = (
    forceOrPatches?: boolean | PatchEntry[],
  ) => {
    const handle = refs.getUdsHandle();
    if (!handle) return;
    const sent = handle.broadcastState(forceOrPatches);
    // Attribute what ACTUALLY left the socket. `am cost` used to see nothing
    // on UDS — the transport a local desktop app uses for every client,
    // because it opens no TCP ports at all — so the one command that answers
    // "what is this app moving, and which cell is moving it" reported an idle
    // app. The rule itself is `attributeRound`, shared with the WS path, so
    // the two transports cannot drift into two answers.
    if (!sent || (sent.full === 0 && sent.patch === 0)) return;
    // A round that really put bytes on a wire — counted for both diagnostics.
    refs.onBroadcastRound?.();
    const meter = refs.costMeter?.();
    if (!meter) return;
    const force = forceOrPatches === true;
    const patches = Array.isArray(forceOrPatches) ? forceOrPatches : [];
    attributeRound(meter, {
      anyFullSend: sent.full > 0,
      anyPatchSend: sent.patch > 0,
      force,
      patchesToSend: patches,
      getUIState: refs.getUIState ?? (() => undefined),
    });
  };
  // The shared coalescer buffers patches (and a pending force-full) across the
  // queue/throttle window and flushes them as ONE send — identical semantics
  // to the WS broadcaster, because both now use the same primitive. This is
  // what closes the a field report bug (UDS used to drop patches while WS
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
    // Interactive priority (see Coalescer.flushUrgent): client actions call
    // this so their patches never wait out the background throttle window.
    flushUrgent: () => coalescer.flushUrgent(),
    dispose: () => coalescer.dispose(),
  };
}

/** Single-instance enforcement — lock in /tmp/aio/{appId}[@home].lock.
 *
 *  Identity is appId AND resolved data home (`AppLock`): a second boot from a
 *  DIFFERENT home is a different instance by construction and never collides,
 *  so a refusal here can only be a true duplicate — the same data dir — and
 *  its port/pid ARE the caller's own instance. A boot beside a foreign-home
 *  sibling says so in one info line that names no port and no pid: the
 *  caller asked for a different home, and the other instance's coordinates
 *  are not its business (a field report, §2.1 — a harness killed the
 *  user's wallet with the pid the old refusal had just printed). */
export async function acquireSingletonLock(
  appId: string,
  home: string | undefined,
  port: number,
  singletonMode: boolean,
  killExisting: boolean,
  meta: LockMeta = {},
): Promise<AppLock | null> {
  if (singletonMode === false) return null;
  const appLock = new AppLock(appId, home);
  const result = await appLock.acquire(port, killExisting, meta);
  if (!result.ok) {
    const ex = result.existing;
    const where = ex.port > 0 ? ` at http://localhost:${ex.port}` : "";
    const who = ex.pid > 0 ? ` (pid ${ex.pid})` : "";
    const msg = `[AIO] ${
      killExisting ? "Failed to take over" : "Already running"
    }: ${ex.appId}${where}${who} (home ${appLock.home})`;
    // Alone in the process: the refusal IS the exit, and a clean one-line
    // error beats a stack trace. With a sibling app already running (D2 —
    // an app plus its admin panel), `Deno.exit(1)` would take THAT app down
    // through `unload` with no Phase 1–7 and no final persist — so the
    // refusal is thrown to the caller instead, and the sibling keeps running.
    if (runtimeCount() > 0) throw new Error(msg);
    log.error(msg);
    Deno.exit(1);
  }
  const foreign = instances(appId).filter((i) =>
    i.pid !== Deno.pid && resolve(i.home ?? "") !== appLock.home
  );
  if (foreign.length > 0) {
    log.info(
      `[AIO] another instance of ${appId} runs from a different home; ` +
        `this one continues (home ${appLock.home})`,
    );
  }
  log.debug(
    `lock: acquired ${lockDir()}/${appLock.key}.lock (PID ${Deno.pid})`,
  );
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

import {
  type DiagnosticsConfig,
  initDiagnostics,
  purgeDisabledArtifacts,
} from "../diagnostics/mod.ts";
import type { Redactor } from "../diagnostics/redact.ts";
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
  redact?: Redactor,
): {
  diagHooks: ReturnType<typeof initDiagnostics> | null;
  vitalsSystem: VitalsSystem | undefined;
  diagResolvedOpts: DiagnosticsOptions | false;
} {
  // `true`/omitted → defaults on ({}); `false` → off; object → tuned.
  const diagOn = diagConfig !== false;
  const diagCfg = (diagConfig === true || diagConfig == null) ? {} : diagConfig;
  // Diagnostics off wholesale still has to clean up after itself — that is the
  // very case where an old `actions.jsonl` sits forgotten in the log directory.
  if (!diagOn) {
    purgeDisabledArtifacts(getLogDir(), {
      actionLog: false,
      checkpoint: false,
    });
  }
  const diagHooks = !diagOn
    ? null
    : initDiagnostics(diagCfg, prod, getLogDir(), guardDispatches, redact);
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

/** THE app's own deno.json — ONE decider, located relative to the app's ENTRY
 *  module, never via the launch cwd.
 *
 *  Everything an app declares about ITSELF lives in this file: `version`,
 *  `title`, `target`. Reading it from `Deno.cwd()` meant a compiled binary
 *  adopted the identity of whatever directory it was started in — under
 *  systemd, where `ExecStart` runs from `$HOME`, a binary showed the title
 *  `AIO App` and defaulted to the ELECTRON client (auto-downloading Electron)
 *  even though its own deno.json said `"target": "browser"`; started in
 *  another project's directory it served that project's `<title>`. `version`
 *  was fixed once, in isolation, so the artifact ended up HALF-identified —
 *  which is exactly why this is one function and not three lookups.
 *
 *  AIO'S BUILDER embeds deno.json next to the entry module — `assetIncludes`
 *  passes `--include <deno.json>` and `--include .aio/build-version.json` —
 *  so the same lookup answers in dev and in a binary it produced.
 *
 *  `deno compile` ON ITS OWN does NOT: it takes deno.json as the CONFIG,
 *  which does not make the file readable through the binary's VFS. The read
 *  below then misses, the walk finds nothing, and the binary knows neither
 *  its version nor its title nor its target — reporting "unknown (compiled
 *  binary carries no build stamp …)". A field report hit exactly this
 *  compiling a repo's SECOND app by hand (the fleet reads one `entry`), and
 *  this comment said the behaviour that does not hold. Both `--include`s are
 *  now named in the failure itself.
 *
 *  Four levels up, NEAREST wins: the two-level version resolved `src/app.ts`
 *  but never a nested entry like `src/relay/app.ts`, which then silently
 *  reported "0.0.0". Walking is entry-relative, so a deeper search still
 *  cannot adopt the LAUNCH directory's identity — the bug this function exists
 *  to prevent — and the nearest ancestor is the app's own root.
 *
 *  Not memoized: it is read a handful of times at boot, and a cache would
 *  freeze a value the dev server can otherwise pick up on restart. */
export function appDenoJson(): Record<string, unknown> | undefined {
  return appDenoJsonLocated()?.config;
}

/** {@link appDenoJson} plus WHERE it was found — the directory URL the app's
 *  identity lives in (its build stamp sits beside it). Same walk, one place. */
export function appDenoJsonLocated():
  | { config: Record<string, unknown>; dir: URL }
  | undefined {
  try {
    const main = new URL(Deno.mainModule);
    for (const up of ["./", "../", "../../", "../../../", "../../../../"]) {
      for (const name of DENO_JSON_NAMES) {
        const url = new URL(`${up}${name}`, main);
        let text: string;
        try {
          text = Deno.readTextFileSync(url);
        } catch {
          continue; // nothing at this level — keep walking up
        }
        // The file EXISTS. A parse failure here used to be swallowed by the
        // same catch as "no file", so a `//` comment — legal in deno.json, and
        // the natural place to explain an import alias — made the runtime walk
        // silently PAST its own app's config and adopt a parent's, or none:
        // wrong title, wrong version, and the pin-drift warning never firing.
        // Comments now parse; anything still broken is said out loud and the
        // walk continues, because an unrelated malformed file in some ancestor
        // directory is not this app's problem to die on.
        try {
          return {
            config: parseDenoJson(text, url.pathname),
            dir: new URL(up, main),
          };
        } catch (e) {
          log.warn(
            `config: ignoring ${url.pathname} — ${
              e instanceof Error ? e.message.split("\n")[0] : String(e)
            }`,
          );
        }
      }
    }
  } catch { /* no usable main module (REPL, eval) */ }
  return undefined;
}

/** Resolve window title: CLI > config > the APP's deno.json "title" > fallback.
 *
 *  The deno.json step reads the app's own file ({@link appDenoJson}), not
 *  `<cwd>/deno.json` — a compiled binary's title must not depend on where it
 *  was launched from. Async for its callers' sake; the read itself is sync. */
export function resolveTitle(
  cliTitle: string | undefined,
  uiTitle: string | undefined,
): Promise<string> {
  if (cliTitle) return Promise.resolve(cliTitle);
  if (uiTitle) return Promise.resolve(uiTitle);
  const t = appDenoJson()?.title;
  return Promise.resolve(typeof t === "string" && t ? t : "AIO App");
}
