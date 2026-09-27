/**
 * @module
 * The pid lock file — ONE decider for the build lock
 * (`build/build-compile.ts`) and the Electron runtime download lock
 * (`electron/electron-runtime-fetch.ts`).
 *
 * The lock holds the bare pid (what an older aio reads with `Number`); the
 * holder's identity sits beside it in `<lock>.id` as `<pid>-<tail>` (see
 * {@link ownIdTail}). Both change ONLY under the lock's mutex
 * (`withLockMutexAt`) — take, take over, release — so a waiter never judges
 * half of one, and a take-over removes the lock only if it still names the
 * owner that was judged dead: two waiters that judged the same dead holder
 * can no longer have the second delete the lock the first just took. A
 * release removes the lock only while it still names US: a holder whose lock
 * was taken over (it looked dead — paused, suspended) never deletes the new
 * holder's.
 */
import { resolve } from "@std/path";
import { log } from "../diagnostics/logger-api.ts";
import {
  isLockOwnerAlive,
  ownerIdentity,
  ownPidNs,
  withLockMutexAt,
} from "./single-instance-lock.ts";

export { ownPidNs };

/** A lock owner: pid plus, when recorded, its kernel start stamp and pid
 *  namespace. */
export type ProcId = {
  pid: number;
  startToken?: string;
  startEpoch?: number;
  /** The writer's pid namespace (see {@link ownPidNs}). */
  ns?: number;
};

/** The pid lock paths THIS process holds right now, each with its
 *  {@link keepFresh} stop and the `.id` stamp it wrote (null: unwritten). Our
 *  own pid on a lock is otherwise a previous run's: in a container every
 *  process is pid 1, so "that pid is alive" says nothing about it. */
type Held = { stop: () => void; id: string | null; lost: boolean };
const held = new Map<string, Held>();

/** Is `lock` still the one `h` took (text and `.id` as written)? Once not,
 *  say so — once per hold. */
function stillMine(lock: string, h: Held): boolean {
  if (
    readOrNull(lock) === `${Deno.pid}` && readOrNull(`${lock}.id`) === h.id
  ) return true;
  if (!h.lost) {
    h.lost = true;
    log.warn(
      `${lock} was taken over (or removed) while this process held it — ` +
        `it looked dead: paused, suspended, or its heartbeat stalled. Two ` +
        `processes ran at once; the lock is left to its new holder.`,
    );
  }
  return false;
}

/** How often a holder refreshes its lock's (and link journal's) mtime
 *  (`heartbeatMs`), and how long a file from another pid namespace may go
 *  untouched before its holder counts as dead (`staleMs`). A restarted
 *  container (or a new flatpak/bwrap sandbox) always has a NEW pid namespace,
 *  so "foreign" alone kept a killed holder's lock and journal forever.
 *  For a LOCK, "untouched" is what THIS waiter saw on its own monotonic clock
 *  (see {@link observedStale}), never wall clock vs mtime. Mutable for tests
 *  only. @internal */
export const _lockTiming = { heartbeatMs: 20_000, staleMs: 120_000 };

/** Refresh `path`'s mtime every `_lockTiming.heartbeatMs` until the returned
 *  stop is called. Never keeps the process alive (unref'd). With `ours`: a
 *  tick that finds the file no longer ours (a lock taken over while we looked
 *  dead) stops for good — refreshing it would keep the NEW holder's lock
 *  alive after that holder died. */
export function keepFresh(path: string, ours?: () => boolean): () => void {
  const t = setInterval(() => {
    if (ours && !ours()) return clearInterval(t);
    try {
      const now = new Date();
      Deno.utimeSync(path, now, now);
    } catch { /* aio-ok: gone or unwritable — a reader then judges it stale */ }
  }, _lockTiming.heartbeatMs);
  Deno.unrefTimer(t);
  return () => clearInterval(t);
}

/** Was `path` touched within `_lockTiming.staleMs` by the wall clock?
 *  Absent: no. Never to TAKE a lock (see {@link observedStale}): host suspend
 *  and clock skew between hosts on one shared volume make it lie. */
export function touchedRecently(path: string): boolean {
  try {
    const m = Deno.statSync(path).mtime;
    return !m || Date.now() - m.getTime() < _lockTiming.staleMs;
  } catch {
    return false; // aio-ok: gone — nothing holds it
  }
}

/** Per path: the (mtime, lock text, `.id` text) this process last saw, and
 *  when — on `performance.now()`, which a suspended host does not advance. */
const seen = new Map<string, { sig: string; at: number }>();

/** Has `path` (a lock) sat UNCHANGED for `_lockTiming.staleMs` while THIS
 *  process watched it? A first sight or any change (a heartbeat) starts the
 *  window over. Judging "mtime older than 2 min" by our wall clock took a LIVE
 *  holder's lock: after a host suspend (the clock jumps, the holder heartbeats
 *  only once it runs again), or when the holder's host clock lags ours on a
 *  shared NFS volume. A frozen holder (`docker pause`, SIGSTOP) still looks
 *  dead once we watched it that long — no reader can tell it from a dead one;
 *  its release then leaves the new holder's lock alone. Absent: stale. */
function observedStale(path: string): boolean {
  let sig: string;
  try {
    const m = Deno.statSync(path).mtime?.getTime();
    sig = `${m}|${readOrNull(path)}|${readOrNull(`${path}.id`)}`;
  } catch {
    return true; // aio-ok: gone — nothing holds it
  }
  const key = resolve(path), was = seen.get(key), now = performance.now();
  if (was?.sig !== sig) {
    seen.set(key, { sig, at: now });
    return false;
  }
  return now - was.at >= _lockTiming.staleMs;
}

/** Is the holder of `path` — a lock from another pid namespace — alive, for a
 *  reader that never takes it (build link recovery)? Watched by THIS process
 *  (a waiter): what it saw ({@link observedStale}). Never watched (the
 *  one-shot recovery every `deno task build` runs first): its mtime by our
 *  wall clock ({@link touchedRecently}), as the holder's journals are judged —
 *  a first sight read as "alive" kept a killed container build's links
 *  unrecovered forever. */
export function foreignLockAlive(path: string): boolean {
  return seen.has(resolve(path)) ? !observedStale(path) : touchedRecently(path);
}

/** This process's identity as hex an older aio's patterns accept:
 *  `d<ns, 8 hex>` (Linux pid namespace) then the kernel start stamp —
 *  `a<ticks>` (Linux), `e<epoch>` (macOS) — "" where the platform has none. */
export function ownIdTail(): string {
  const ns = ownPidNs();
  const id = ownerIdentity(Deno.pid);
  return (ns === undefined ? "" : `d${ns.toString(16).padStart(8, "0")}`) +
    (id.startToken
      ? `a${Number(id.startToken).toString(16)}`
      : id.startEpoch !== undefined
      ? `e${id.startEpoch.toString(16)}`
      : "");
}

/** Parse an {@link ownIdTail} back into a {@link ProcId} for `pid`. */
export function withTag(pid: number, tail: string): ProcId {
  const d = /^d([0-9a-f]{8})/.exec(tail);
  const ns = d ? parseInt(d[1]!, 16) : undefined;
  const m = /^([ae])([0-9a-f]+)$/.exec(d ? tail.slice(9) : tail);
  const id: ProcId = !m
    ? { pid }
    : m[1] === "a"
    ? { pid, startToken: String(parseInt(m[2]!, 16)) }
    : { pid, startEpoch: parseInt(m[2]!, 16) };
  if (ns !== undefined) id.ns = ns;
  return id;
}

/** The owner a lock's text (and its `.id` stamp, used only when it names the
 *  same pid) records. Null: not a pid. */
export function lockOwner(raw: string, idRaw: string | null): ProcId | null {
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const [p, tail] = (idRaw ?? "").trim().split("-");
  return Number(p) === pid ? withTag(pid, tail ?? "") : { pid };
}

export function readOrNull(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null; // aio-ok: absent (or unreadable) — the callers' "no file"
  }
}

function removeIfThere(path: string): void {
  try {
    Deno.removeSync(path);
  } catch { /* aio-ok: already gone — the goal holds */ }
}

/** Was `id` written in another pid namespace? */
export function foreignNs(id: ProcId): boolean {
  return id.ns !== undefined && id.ns !== ownPidNs();
}

/** Is the process `id` names still running? Another pid namespace: its pid
 *  says nothing here, so it counts as running until THIS process has watched
 *  the lock it holds (`path`) sit unchanged for `_lockTiming.staleMs` — a live
 *  holder heartbeats it (no `path`: running). Our own pid: only if THIS process
 *  holds it (`ours`). Another pid: alive AND not recycled (the lock decider,
 *  which also counts EPERM as alive).
 *  @decider */
export function holderAlive(
  id: ProcId,
  ours: boolean,
  path?: string,
): boolean {
  if (foreignNs(id)) return path === undefined || !observedStale(path);
  return id.pid === Deno.pid ? ours : isLockOwnerAlive(id);
}

/** One attempt at `lock`: take it if free; else judge its owner and, if dead,
 *  remove it — under the mutex, only if it still names that owner — so the
 *  caller retries at once (`retry`). Never throws: an unwritable directory is
 *  a lock that cannot be taken (`held: false`), waited out like a holder. */
export function tryPidLock(
  lock: string,
): { held: boolean; owner: ProcId | null; retry: boolean } {
  let took = false, id: string | null = null;
  try {
    took = withLockMutexAt(lock, () => {
      try {
        Deno.writeTextFileSync(lock, `${Deno.pid}`, { createNew: true });
      } catch {
        return false; // aio-ok: someone holds it — judged below
      }
      // Unwritten, a reader falls back to pid liveness — the old answer,
      // never a worse one.
      id = `${Deno.pid}-${ownIdTail()}`;
      try {
        Deno.writeTextFileSync(`${lock}.id`, id);
      } catch {
        id = null; // aio-ok: unwritten stamp = pid-liveness fallback
      }
      return true;
    }, false) ?? false;
  } catch { /* aio-ok: no mutex (unwritable dir) — waited out like a holder */ }
  if (took) {
    held.get(resolve(lock))?.stop();
    const h: Held = { stop: () => {}, id, lost: false };
    h.stop = keepFresh(lock, () => stillMine(lock, h));
    held.set(resolve(lock), h);
    return { held: true, owner: null, retry: false };
  }
  const raw = readOrNull(lock), idRaw = readOrNull(`${lock}.id`);
  const owner = raw === null ? null : lockOwner(raw, idRaw);
  if (!owner || holderAlive(owner, held.has(resolve(lock)), lock)) {
    return { held: false, owner, retry: false };
  }
  try {
    withLockMutexAt(lock, () => {
      if (readOrNull(lock) !== raw || readOrNull(`${lock}.id`) !== idRaw) {
        return; // taken (or released) since it was judged — not ours to drop
      }
      if (foreignNs(owner) && !observedStale(lock)) return; // touched: alive
      removeIfThere(`${lock}.id`); // stamp first: never outlives its lock
      removeIfThere(lock);
    }, false);
    return { held: false, owner, retry: true };
  } catch { /* aio-ok: no mutex (unwritable dir) — waited out by the caller */ }
  return { held: false, owner, retry: false };
}

/** Release a lock {@link tryPidLock} took — only while it still names us
 *  (lock text and `.id` stamp as we wrote them): one taken over while we held
 *  it is the new holder's, left alone, and said so. Throws when the mutex
 *  cannot be had — the caller says so; the lock is then taken over once we
 *  exit. */
export function releasePidLock(lock: string): void {
  const mine = held.get(resolve(lock));
  mine?.stop();
  held.delete(resolve(lock));
  withLockMutexAt(lock, () => {
    if (!mine || !stillMine(lock, mine)) return;
    removeIfThere(`${lock}.id`); // stamp first: never outlives its lock
    removeIfThere(lock);
  }, false);
}
