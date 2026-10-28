// The locals of `_runPhases` (aio.ts) that its moved-out steps use. Each is a
// getter (and, for a `let` a step assigns, a setter) over the boot's own
// variable, so a step reads and writes it live, as the closure it was did.
// `readonly` = no moved step assigns it.
//
// aio.ts keeps every import it had, in its place — a bare `import "x"; // load
// order` where only a moved step uses the names — so modules still evaluate in
// the order they did before the steps moved out.
import type { DB } from "../db/types.ts";
import type { ReportErrorOpts } from "../diagnostics/error.ts";
import type { DiagnosticsHooks } from "../diagnostics/mod.ts";
import type { Redactor } from "../diagnostics/redact.ts";
import type { ReduceBreakdown, TTState } from "../diagnostics/time-travel.ts";
import type { CellFieldFilter } from "../state/cell-types.ts";
import type { createDispatch } from "../state/dispatch.ts";
import type { OwnEffect } from "../state/own.ts";
import type { ScheduleDef, ScheduleEffect } from "../state/schedule.ts";
import type { ServerSyncHandler } from "../sync/server-handler.ts";
import type { VitalsSystem } from "../vitals/mod.ts";
import type { BootResult } from "./aio-boot.ts";
import type { CliFlags } from "./aio-cli.ts";
import type { CellPatches } from "./aio-dispatch.ts";
import type { InternalApp, UdsBroadcastController } from "./aio-run-helpers.ts";
import type { AioApp, AioConfig, AioUser } from "./aio-types.ts";
import type { AppDirs } from "./app-dirs.ts";
import type { UserStore } from "./auth-users.ts";
import type { BlobStore } from "./blobs.ts";
import type { MigrationSummary } from "./boot-restore.ts";
import type { CellWorkerPool } from "./cell-worker-pool.ts";
import type {
  ActionCause,
  Journal,
  JournalEntry,
  JournalGap,
  TimeTravelRestore,
} from "./journal.ts";
import type { PersistenceManager } from "./persistence.ts";
import type { ServerHandle } from "./server-types.ts";
import type { SessionStore } from "./sessions.ts";
import type { AppLock } from "./single-instance-lock.ts";
import type { SkvInstance } from "./skv.ts";
import type { Timeline } from "./timeline.ts";
import type { UDSHandle } from "./uds.ts";
import type { AsyncLocalStorage } from "node:async_hooks";

/** Make a write durable by its own save, NOW — for a line the journal
 *  did not take (a refused append, `_journalAppend`) or may not take (a
 *  redacted cell's state, `_journalReaction`/`_recordTimeTravel`). A sync
 *  cell's save is the fold of THAT cell (folding every pending cell would
 *  restart every other listener's reaction chain, see `SyncReaction`); a
 *  store-persisted cell's is the store's persist.
 *
 *  Coalesced PER CLOCK, never across them: one flag for both let a refused
 *  sync line's fold swallow the KV line's persist in the same burst, and
 *  the KV reaction was gone after a SIGKILL (review rev8). One save at a
 *  time per clock; a request landing while one runs re-runs it when it is
 *  done (a save reads state when it starts). */
export type SaveNow = { clock: "kv" } | { clock: "sync"; cell: string };

/** The boot's locals, live. */
export interface BootCtx<S, A, E> {
  _electronProc: Deno.ChildProcess | null;
  readonly initialState: S;
  readonly config: AioConfig<S, A, E>;
  readonly cli: CliFlags;
  readonly appId: string;
  _heapLine: string | undefined;
  _stampDataDir: (() => Promise<void>) | undefined;
  readonly _dirs: AppDirs;
  readonly port: number;
  readonly releaseFileSizeGuard: () => void;
  readonly appLock: AppLock | null;
  readonly VERBOSE: boolean;
  distDir: string;
  prod: boolean;
  readonly redact: Redactor;
  readonly diagHooks: DiagnosticsHooks | null;
  readonly vitalsSystem: VitalsSystem | undefined;
  readonly reduce: (state: S, action: A) => {
    state: S;
    effects: (E | ScheduleEffect | OwnEffect)[];
  };
  readonly execute: (app: AioApp<S, A>, effect: E) => void;
  readonly onAction:
    | ((action: A, state: S, user?: AioUser) => void)
    | undefined;
  readonly onEffect:
    | ((effect: E, state: S, user?: AioUser) => void)
    | undefined;
  readonly onStopping: (() => void | Promise<void>) | undefined;
  readonly onStop: (() => void | Promise<void>) | undefined;
  readonly shouldPersist: boolean;
  readonly dbPath: string | undefined;
  readonly getDBState: (s: S) => unknown;
  readonly syncCellIds: string[];
  state: S;
  tt:
    | TTState<S, {
      type: string;
    }>
    | null;
  readonly _reportOpts: ReportErrorOpts;
  readonly boot: BootResult<S>;
  readonly kvDb: SkvInstance | null;
  readonly asyncDb: DB | null;
  readonly persistence: PersistenceManager;
  readonly journal: Journal | null;
  readonly syncHandler: ServerSyncHandler | undefined;
  readonly strayJournal: Journal | null;
  readonly storeSavedElsewhere: boolean;
  readonly journalHeld: ReadonlySet<string>;
  readonly migrationSummary: MigrationSummary | undefined;
  readonly schedulePersist: (cellPatches?: CellPatches) => void;
  _legacyBoot: S | null;
  readonly _marking: boolean;
  readonly _listenedTypes: Set<string>;
  readonly _deferred: {
    cell: string;
    id: string;
    action: string;
    payload: unknown;
    ts: number;
    intentSeq: number;
  }[];
  readonly _unmarked: {
    cell: string;
    id: string;
    ts: number;
  }[];
  readonly _retireForeign: boolean;
  _cleanRunFrom: number | undefined;
  readonly _keepUnpersistedFields: (restored: S, replayed: S) => S;
  readonly _roundTripReplayedCells: (restored: S, replayed: S) => S;
  readonly _restartedSlice: (
    cell: string,
    disk: Record<string, unknown>,
  ) => Record<string, unknown>;
  readonly _restoreStoredSlice: (
    cell: string,
    stored: Record<string, unknown>,
    live: Record<string, unknown>,
  ) => Record<string, unknown>;
  readonly _ttStateCells: (
    tt: Partial<TimeTravelRestore> | undefined,
  ) => string[];
  readonly _keepJournalCopy: () => string;
  readonly _warnUnstampedAcrossMigration: (tail: JournalEntry[]) => void;
  readonly _rerunRestoreHooks: (restored: S, replayed: S) => S;
  readonly _isRecord: (v: unknown) => v is Record<string, unknown>;
  readonly _unpersistedFromBoot: (
    cell: string,
    filter: CellFieldFilter,
    was: Record<string, unknown>,
    now: Record<string, unknown>,
  ) => Record<string, unknown>;
  readonly _quarantinedTail: (tail: JournalEntry[]) => JournalEntry[];
  readonly _refuseJournalAcrossGap: (
    j: NonNullable<Journal | null>,
    gap: JournalGap,
  ) => Promise<void>;
  readonly _syncJournal: boolean;
  readonly _appliedTs: Map<string, number>;
  readonly _reactionChain: Map<string, {
    seq: number;
    state: unknown;
    snapshotAt?: number;
  }>;
  readonly _captured: Map<string, {
    at: number;
    state: unknown;
    lined: boolean;
  }>;
  readonly _kvChain: Map<string, {
    seq: number;
    stored: unknown;
  }>;
  readonly _foldedAt: Map<string, number>;
  readonly _rederivedCells: Set<string>;
  readonly ttSkipActions: Set<string> | undefined;
  readonly server: ServerHandle;
  readonly udsHandle: UDSHandle | null;
  readonly _vitalsCheckTimer: NodeJS.Timeout | undefined;
  readonly scheduleManager: {
    handle: (effect: ScheduleEffect) => void;
    start: (defs: ScheduleDef[]) => void;
    cancelAll: () => void;
    close: () => void;
    cancelByPrefix: (prefix: string) => void;
    active: () => string[];
    _bookkeepingSize: () => number;
  };
  readonly ownManager: {
    handle: (effect: OwnEffect) => void;
    disposeAll: () => void;
    disposeByPrefix: (prefix: string) => void;
    active: () => string[];
  };
  readonly udsCtrl: UdsBroadcastController;
  readonly onPerf:
    | ((timing: {
      actionType: string;
      reduce: number;
      effects: number;
      budget: {
        reduce: number;
        effect: number;
      };
      breakdown?: ReduceBreakdown;
    }) => void)
    | undefined;
  readonly _reseedWorkerCells: () => void;
  _shapeThrew: boolean;
  readonly _storedSlice: (cell: string, slice: unknown) => unknown;
  readonly _ttOwed: object;
  readonly _jumpSyncCells: (before: S, after: S) => void;
  readonly _recordTimeTravel: (
    cmd: string,
    arg: number | undefined,
    before: S,
    after: S,
  ) => void;
  readonly _diagAfterAction:
    | ((prev: S, next: S, action: A) => void)
    | undefined;
  readonly _syncCellSet: Set<string>;
  readonly timeline: Timeline;
  readonly _effectScope: AsyncLocalStorage<true>;
  readonly _causeOf: (action: A) => ActionCause;
  readonly _outsideCall: <T>(fn: () => T) => T;
  readonly _callOf: (action: A) => string | undefined;
  readonly _inCallScope: <T>(
    effect: unknown,
    fn: (call: string | undefined, sure?: boolean) => T,
  ) => T;
  readonly _sureOf: WeakSet<object>;
  readonly _openCalls: Set<string>;
  readonly _callDoor: <
    T extends {
      dispatch: (a: A) => unknown;
    },
  >(app: T, call: string | undefined, sure?: boolean) => T;
  readonly _isDisableReset: (action: A) => boolean;
  readonly afterActionHook: (prev: S, next: S, action: A) => void;
  readonly _atomicOwed: SaveNow[] | null;
  _appendOk: boolean;
  readonly _journalSaid: {
    refused(e: unknown): void;
    landed(): void;
  };
  readonly _quarantinedWrites: Map<string, {
    n: number;
    at: number;
    timer?: ReturnType<typeof setTimeout>;
  }>;
  readonly _quarantinedWrite: (cell: string) => void;
  readonly _markSyncApplied: (action: A) => void;
  readonly _quarantinedSkip: (cell: string) => boolean;
  readonly _journalReaction: (
    next: S,
    reacted: readonly string[],
    bySyncOp: boolean,
    jump?: boolean,
    wrote?: string,
  ) => void;
  readonly _saving: {
    sync: {
      tail: Promise<string | undefined> | null;
      queued: Promise<string | undefined> | null;
      cells: Set<string>;
    };
    kv: {
      tail: Promise<string | undefined> | null;
      queued: Promise<string | undefined> | null;
      cells: Set<string>;
    };
  };
  readonly _saveNow: (what: SaveNow) => Promise<string | undefined>;
  _owedTo: object | null;
  readonly _owedByAction: WeakMap<object, Set<Promise<string | undefined>>>;
  readonly _owedByCall: Map<string, Set<Promise<string | undefined>>>;
  readonly _owe: (
    p: Promise<string | undefined>,
  ) => Promise<string | undefined>;
  readonly _durableFor: (
    action: object,
  ) => Promise<string | undefined> | undefined;
  readonly _offCallSettle: () => void;
  readonly _reactedKeys: (prev: S, next: S, own: string) => string[];
  readonly _journalAppend: (
    entry: Parameters<NonNullable<Journal | null>["append"]>[0],
    ts: number,
    save?: SaveNow,
  ) => number;
  readonly _journalVersions: (
    type: string,
    payload: unknown,
    origin: string | undefined,
  ) => Record<string, number> | undefined;
  readonly _notifyCrossUser: (reached: number, user: unknown) => void;
  readonly _writeGuard:
    | ((actionType: string, patches: unknown) => void)
    | undefined;
  readonly dispatch: ReturnType<typeof createDispatch<S, A, E>>;
  readonly freezeEnabled: boolean;
  readonly discoveryRef: {
    stop: (() => void) | null;
  };
  readonly sessionStore: SessionStore | null;
  readonly userStore: UserStore | null;
  readonly _unregisterAuthStore: (() => void) | null;
  readonly _workerEntry: string;
  readonly _hostWorkers: boolean;
  readonly _workerUserCalls: number;
  readonly workerPool: CellWorkerPool;
  readonly appDispatch: ReturnType<typeof createDispatch<S, A, E>>;
  readonly _shutdownRuntime: () => Promise<void>;
  readonly _stopCtl: AbortController;
  readonly shutdown: () => Promise<void>;
  readonly _unregisterRuntime: () => void;
  readonly blobStore: BlobStore;
  readonly app: InternalApp<S, A>;
}

/** The context over the boot's own variables: each field is a getter that
 *  reads its variable when read; a `[get, set]` pair also assigns it. */
export function liveCtx<T extends object>(
  fields: { [K in keyof T]: (() => T[K]) | [() => T[K], (v: T[K]) => void] },
): T {
  const ctx = {} as T;
  for (
    const [k, f] of Object.entries(fields) as [
      string,
      (() => unknown) | [() => unknown, (v: unknown) => void],
    ][]
  ) {
    const [get, set] = typeof f === "function" ? [f, undefined] : f;
    Object.defineProperty(ctx, k, { get, set, enumerable: true });
  }
  return ctx;
}

/** A moved step's parameters after the context. */
export type StepArgs<F> = F extends (c: never, ...a: infer R) => unknown ? R
  : never;
