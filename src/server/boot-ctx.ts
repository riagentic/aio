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
import type { CellFieldFilter } from "../state/cell-types.ts";
import type { ServerSyncHandler } from "../sync/server-handler.ts";
import type { BootResult } from "./aio-boot.ts";
import type { CliFlags } from "./aio-cli.ts";
import type { AioConfig } from "./aio-types.ts";
import type { AppDirs } from "./app-dirs.ts";
import type { MigrationSummary } from "./boot-restore.ts";
import type {
  Journal,
  JournalEntry,
  JournalGap,
  TimeTravelRestore,
} from "./journal.ts";
import type { SkvInstance } from "./skv.ts";

/** The boot's locals, live. */
export interface BootCtx<S, A, E> {
  readonly initialState: S;
  readonly config: AioConfig<S, A, E>;
  readonly cli: CliFlags;
  readonly appId: string;
  _heapLine: string | undefined;
  _stampDataDir: (() => Promise<void>) | undefined;
  readonly _dirs: AppDirs;
  distDir: string;
  prod: boolean;
  readonly getDBState: (s: S) => unknown;
  readonly syncCellIds: string[];
  state: S;
  readonly _reportOpts: ReportErrorOpts;
  readonly boot: BootResult<S>;
  readonly kvDb: SkvInstance | null;
  readonly asyncDb: DB | null;
  readonly journal: Journal | null;
  readonly syncHandler: ServerSyncHandler | undefined;
  readonly strayJournal: Journal | null;
  readonly storeSavedElsewhere: boolean;
  readonly journalHeld: ReadonlySet<string>;
  readonly migrationSummary: MigrationSummary | undefined;
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
  readonly _foldedAt: Map<string, number>;
  readonly _rederivedCells: Set<string>;
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
