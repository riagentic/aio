// cell-worker-protocol.ts — the messages a `worker: true` cell exchanges with
// the main isolate. One file so both sides can never drift.
//
// Direction of travel:
//   main → worker: init (seed state), call (dispatch an action)
//   worker → main: ready, patches (streamed as the method commits), done/fail
//
// Everything here must be structured-cloneable — it crosses a real thread.

import type { WirePatch as Patch } from "../protocol/patch-ops.ts";
import type { Msg } from "../state/cell-types.ts";

/** Worker name prefix — how a spawned worker learns it is a cell host, and
 *  which cell it hosts. `self.name` is set by the main side at spawn. */
export const CELL_WORKER_PREFIX = "aio-cell:";

/** Separator between the hosted cell and the OWNER's appId in a worker name.
 *  Neither side can contain it: a cell name is `/^[A-Za-z_][\w\-]*$/` and an
 *  appId is a slug (`[a-z0-9-]`). */
const APP_ID_SEP = "@";

/** The worker name the main isolate spawns a cell host under:
 *  `aio-cell:<cell>@<appId>`.
 *
 *  The appId rides in the name because it is the ONE thing a worker can read
 *  synchronously before its entry module's top-level `aio.run()` executes — a
 *  message would arrive after the identity was already needed. And the worker
 *  cannot derive the identity itself: inside a Deno worker `Deno.mainModule`
 *  is undefined (in `deno run` and in a compiled binary alike), so the
 *  embedded-deno.json and entry-directory branches of `resolveAppId` never
 *  fire there. A compiled app with no explicit appId launched from `/` died at
 *  boot ("cannot infer an appId"), and launched from another project's
 *  directory its worker silently took THAT project's identity. */
export function cellWorkerName(cell: string, appId?: string): string {
  return `${CELL_WORKER_PREFIX}${cell}${appId ? APP_ID_SEP + appId : ""}`;
}

/** Split a worker name into the hosted cell and the owner's appId. Null when
 *  the name is not a cell host's. */
export function parseCellWorkerName(
  name: string | undefined,
): { cell: string; appId: string | null } | null {
  if (typeof name !== "string" || !name.startsWith(CELL_WORKER_PREFIX)) {
    return null;
  }
  const rest = name.slice(CELL_WORKER_PREFIX.length);
  const at = rest.lastIndexOf(APP_ID_SEP);
  return at < 0
    ? { cell: rest, appId: null }
    : { cell: rest.slice(0, at), appId: rest.slice(at + 1) || null };
}

/** The appId the owning main isolate resolved, when this code runs inside a
 *  cell worker it spawned; null anywhere else. */
export function inheritedWorkerAppId(): string | null {
  return parseCellWorkerName((globalThis as { name?: string }).name)?.appId ??
    null;
}

/** True inside a `worker: true` cell's worker, which re-imports the app's OWN
 *  entry module. Boot-time work in that entry (creating directories, migrating
 *  files, opening databases, starting servers) then runs TWICE — and anything
 *  slow there delays the worker's ready handshake, which aio fails after
 *  30s with "did not become ready". Guard such work with this:
 *
 *      if (!isCellWorker()) await prepareDataDirectories();
 *      await aio.run({ ... });
 *
 *  (a field report, 2026-07-26 — found the hard way: a 20ms mkdir+copy before
 *  aio.run() was enough to stall the handshake.) */
export function isCellWorker(): boolean {
  const name = (globalThis as { name?: string }).name;
  return typeof name === "string" && name.startsWith(CELL_WORKER_PREFIX);
}

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
  | {
    t: "init";
    state: Record<string, unknown>;
    prod: boolean;
    /** The owner's RESOLVED `freezeState` (`config.freezeState ?? !prod`),
     *  sent rather than recomputed so both isolates deep-freeze on the same
     *  decision. A worker builds its dispatch before this message arrives, so
     *  without it a worker cell's committed state carried only Immer's
     *  `autoFreeze` — a narrower tripwire inside a worker than outside it, in
     *  dev AND prod, which is the asymmetry this boundary exists to close. */
    freezeState: boolean;
    /** The owner's `__aioDev` flag, carried across the thread.
     *
     *  Every dev tripwire — frozen-state enforcement, the readonly hint, the
     *  hidden-field read guard — reads `globalThis.__aioDev`, and a worker gets
     *  a FRESH global. Without this the worker isolate was strictly more
     *  permissive than the isolate that spawned it: under `testServer({ workers:
     *  "real" })` a mutation that throws in-isolate would pass in a real worker,
     *  which is the green-test/broken-prod trade this whole boundary exists to
     *  remove. Tests are the strictest environment, never the most permissive.
     */
    dev: boolean;
  }
  /** Run one action. `id` correlates the reply. */
  | { t: "call"; id: number; action: Msg; ctx?: AmbientContext }
  /** A cancelOn TRIGGER fired on the other side of the thread.
   *
   *  The cancel registry (`src/state/method-cancel.ts`) is module-scoped, so
   *  each isolate holds its own. `notifyMethodCancel` fires in whichever
   *  isolate ran the reduce — and a peer cell reduces on main, where the
   *  worker's AbortController does not exist. Nothing else on this wire
   *  carries a peer's action, so `cancelOn: { slow: [peer.stop] }` on a
   *  `worker: true` cell was simply inert in production while passing
   *  in-isolate, where one registry holds both halves.
   *
   *  `type` is the trigger ACTION type, not the target method: the worker
   *  composed the same cell def and so registered the same edge, and letting
   *  it resolve the edge itself keeps one decider. */
  | { t: "cancel"; type: string }
  /** Graceful stop — the worker aborts its in-flight methods, streams their
   *  final writes home as patches, then acks with `closed`. */
  | { t: "close" };

/** How long the worker itself waits for aborted methods to finish writing.
 *  Slightly under the main side's deadline so the `closed` ack wins the race
 *  against the terminate timer when the drain succeeds. */
export const WORKER_CLOSE_DRAIN_MS = 800;

/** How long the main isolate waits for the `closed` ack before terminating.
 *  Deliberately SHORTER than the main isolate's 3s drain (shutdown.ts): the
 *  worker budget stacks on top of it (pool close runs first), and a WEDGED
 *  worker — sync code that never yields — cannot process the close message at
 *  all, so waiting longer buys nothing: it can only be terminated. A
 *  cooperative worker acks in milliseconds; an aborted streaming method's
 *  remaining writes are patch posts, not seconds of work. */
export const WORKER_CLOSE_DEADLINE_MS = 1_000;

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
  | {
    t: "fail";
    id: number;
    message: string;
    stack?: string;
    /** The error's `name` and string `code` — what a caller branches on, and
     *  what structured clone of a custom Error subclass does not carry. */
    name?: string;
    code?: string;
  }
  /** The host could not start (bad cell name, unsupported config). Fatal. */
  | { t: "boot-error"; message: string }
  /** Close is complete: in-flight methods were aborted and their final
   *  patches have already been posted (message order is FIFO). */
  | { t: "closed" };
