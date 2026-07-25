// cell-worker-protocol.ts — the messages a `worker: true` cell exchanges with
// the main isolate. One file so both sides can never drift.
//
// Direction of travel:
//   main → worker : init (seed state), call (dispatch an action)
//   worker → main : ready, patches (streamed as the method commits), done/fail
//
// Everything here must be structured-cloneable — it crosses a real thread.

import type { Patch } from "immer";
import type { Msg } from "../state/cell-types.ts";

/** Worker name prefix — how a spawned worker learns it is a cell host, and
 *  which cell it hosts. `self.name` is set by the main side at spawn. */
export const CELL_WORKER_PREFIX = "aio-cell:";

/** Plain-data view of the ambient caller context (auth-context.ts), forwarded
 *  with every call so `serverUser()` / `serverRequest()` answer inside the
 *  worker exactly as they do on the main isolate. Headers travel as entries —
 *  a `Headers` instance is not structured-cloneable. */
export type AmbientContext = {
  user?: { id: string; role: string };
  request?: {
    ip?: string;
    headers: [string, string][];
    cookies: Record<string, string>;
    url: string;
    method: string;
    via: "http" | "ws";
  };
};

export type ToWorker =
  /** Seed the worker with the authoritative slice (after persistence/migration
   *  ran on the main isolate) and the run-mode flags it needs. */
  | { t: "init"; state: Record<string, unknown>; prod: boolean }
  /** Run one action. `id` correlates the reply. */
  | { t: "call"; id: number; action: Msg; ctx?: AmbientContext }
  /** Graceful stop — the worker flushes nothing, main already has every patch. */
  | { t: "close" };

export type FromWorker =
  /** The host is bound and ready for calls. */
  | { t: "ready"; cell: string }
  /** Immer patches produced by a commit — streamed as they happen, so a method
   *  that writes `s.status = "building"` before an await updates clients
   *  immediately instead of at the end. */
  | { t: "patches"; ops: Patch[] }
  /** Effects the method returned — executed on the main isolate (schedules and
   *  cross-cell dispatches live there). */
  | { t: "effects"; list: Msg[] }
  /** The call settled. `ret` is the method's transported return value. */
  | { t: "done"; id: number; ret?: unknown }
  /** The call threw. `message`/`stack` are carried as plain data. */
  | { t: "fail"; id: number; message: string; stack?: string }
  /** The host could not start (bad cell name, unsupported config). Fatal. */
  | { t: "boot-error"; message: string };
