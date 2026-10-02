// rename-over.ts — the rename half of "write a tmp, rename it over the file".
//
// On POSIX `rename(2)` swaps the directory entry in one step whoever has the
// old file open, so it either works or fails for a reason waiting cannot cure
// (a directory that is not writable, a mount point): no retry there.
//
// On Windows a rename over a file fails with "access denied" (or a sharing
// violation) for as long as ANY process has that file open without
// FILE_SHARE_DELETE — a second launch reading it, a syncing or backup tool.
// The handle is closed a moment later and the OS has no event for that, so
// the only correct answer is to try again for a bounded time. Every runtime
// file replace goes through here
// (`tests/rename-goes-through-the-helper.test.ts`).
//
// What the wait does NOT cure, measured on Windows 11 with the virus scanner
// on (2 000 tries a cell): a temp renamed over a target that was written the
// same way was refused 0 times in 20 000, quiet or busy — but a target that
// was PUBLISHED BY HARD LINK (temp written, linked to the name, temp deleted)
// refused the rename over it in 1.4–4.1 % of the tries, for 0.5–1.3 s when
// the machine was quiet and for more than 10 s right after an install. That
// was the desktop boot refused "about once in thirty-five launches": the lock
// file is published that way. So a file published by link is never replaced
// by rename — it is written in place (0 refusals in 8 000); the same test
// holds that.

import { log } from "./logger-api.ts";

/** The pauses between tries, in ms — 10 retries, 1 315 ms in all. A reader
 *  holds a small file for milliseconds; past a second it is not a read. */
export const RENAME_BACKOFF_MS: readonly number[] = [
  5,
  10,
  20,
  40,
  80,
  160,
  250,
  250,
  250,
  250,
];

/** Is `e` what Windows answers while another process has the file open?
 *  ERROR_ACCESS_DENIED (5) arrives as `PermissionDenied`, ERROR_BUSY as
 *  `Busy`; a sharing or lock violation (32, 33) has no class of its own and
 *  is recognised by its OS error number. Pure. */
export function isHeldOpenError(e: unknown): boolean {
  return e instanceof Deno.errors.PermissionDenied ||
    e instanceof Deno.errors.Busy ||
    (e instanceof Error && /\(os error (32|33)\)/.test(e.message));
}

/** After a target stayed unreplaceable for the whole wait, how long later
 *  failures on it are answered at once — one attempt, no wait — before the
 *  full wait is spent again. A file held LONGER than the bound (a data folder
 *  inside a syncing or backup tool, a scanner on a large file) would otherwise
 *  cost every write to it another 1.3 s: measured, 20 dispatches took 25 s.
 *  Long on purpose: every write still makes its one attempt, so the first
 *  write after the holder lets go succeeds — the cool-down delays nothing but
 *  the next long wait. */
export const HELD_COOLDOWN_MS = 30_000;

/** How many held targets are remembered. Keyed on the TARGET (temps have
 *  unique names; targets are the app's few state files), oldest dropped. */
const HELD_MAX = 64;

/** The targets that hit the bound: until when they fail fast, and how many
 *  attempts have failed since they last worked. */
const _held = new Map<string, { until: number; failed: number }>();

/** A replace or removal that failed on Windows for a reason waiting did not
 *  cure. `repeat`: this target was already reported and is failing fast (or
 *  failed its next full wait, which the helper itself reported) — a caller
 *  that logs every failure may skip this one. */
export class HeldOpenError extends Error {
  constructor(message: string, cause: unknown, readonly repeat: boolean) {
    super(message, { cause });
    this.name = "HeldOpenError";
  }
}

/** The OS steps, replaceable by a test (Windows behaviour is tested on any
 *  OS through these). @internal */
export const _renameDeps = {
  rename: (from: string, to: string): void => Deno.renameSync(from, to),
  renameAsync: (from: string, to: string): Promise<void> =>
    Deno.rename(from, to),
  remove: (path: string): void => Deno.removeSync(path),
  /** A synchronous pause: the sync callers hold a file mutex. */
  pause: (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
  windows: (): boolean => Deno.build.os === "windows",
  now: (): number => performance.now(),
  debug: (msg: string): void => log.debug("fs", msg),
  warn: (msg: string): void => log.warn("fs", msg),
  info: (msg: string): void => log.info("fs", msg),
  /** Forget every remembered target (a test starts clean). */
  reset: (): void => _held.clear(),
};

const held = (e: unknown): boolean =>
  _renameDeps.windows() && isHeldOpenError(e);

/** What to do about failure number `tries` of one call: a wait in ms before
 *  the next try, or null when it is final — not a held-open error, the
 *  backoff is spent, or the target is inside its cool-down. */
function retryWait(e: unknown, tries: number, target?: string): number | null {
  if (!held(e)) return null;
  const known = target === undefined ? undefined : _held.get(target);
  if (known && _renameDeps.now() < known.until) return null; // fail fast
  return RENAME_BACKOFF_MS[tries - 1] ?? null;
}

/** The error a final failure throws: `e` itself unless Windows refused it as
 *  held/denied — then one that says what is known (the file, the tries, the
 *  OS error) and the two things it can mean. A replace is also remembered. */
function finalError(
  verb: "replace" | "remove",
  path: string,
  e: unknown,
  tries: number,
  waited: number,
): unknown {
  if (!held(e)) return e;
  const text = `could not ${verb} ${path} after ${tries} ` +
    `${tries === 1 ? "try" : "tries"} over ${waited} ms: ${
      e instanceof Error ? e.message : String(e)
    } — it is open in another program, or this user may not write it.`;
  if (verb === "remove") return new HeldOpenError(text, e, false);
  const known = _held.get(path);
  const failed = (known?.failed ?? 0) + 1;
  // Inside the cool-down: counted, not waited for, not said again.
  if (known && tries === 1 && _renameDeps.now() < known.until) {
    known.failed = failed;
    return new HeldOpenError(text, e, true);
  }
  // A full wait just failed. The first one is the caller's to report; each
  // later one (one per cool-down) is said here, with the count.
  if (known) {
    _renameDeps.warn(
      `${path} still cannot be replaced — ${failed} failed attempts since ` +
        `it last worked: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  _held.delete(path);
  if (_held.size >= HELD_MAX) _held.delete(_held.keys().next().value!);
  _held.set(path, { until: _renameDeps.now() + HELD_COOLDOWN_MS, failed });
  return new HeldOpenError(text, e, known !== undefined);
}

function sayDone(
  verb: "replaced" | "removed",
  path: string,
  tries: number,
  waited: number,
): void {
  // The success path: one map-size test, nothing else.
  if (_held.size > 0 && verb === "replaced") {
    const known = _held.get(path);
    if (known) {
      _held.delete(path);
      _renameDeps.info(
        `${path}: replaced again after ${known.failed} failed attempts`,
      );
      return;
    }
  }
  if (tries === 1) return;
  _renameDeps.debug(
    `${path}: another process had it open — ${verb} on try ${tries}, ` +
      `after ${waited} ms`,
  );
}

function replaceSync(from: string, to: string, tmp: boolean): void {
  let waited = 0;
  for (let tries = 1;; tries++) {
    try {
      _renameDeps.rename(from, to);
      return sayDone("replaced", to, tries, waited);
    } catch (e) {
      const wait = retryWait(e, tries, to);
      if (wait === null) {
        if (tmp) {
          try {
            Deno.removeSync(from);
          } catch {
            /* aio-ok: already gone — the rename's error is reported */
          }
        }
        throw finalError("replace", to, e, tries, waited);
      }
      _renameDeps.pause(wait);
      waited += wait;
    }
  }
}

async function replace(from: string, to: string, tmp: boolean): Promise<void> {
  let waited = 0;
  for (let tries = 1;; tries++) {
    try {
      await _renameDeps.renameAsync(from, to);
      return sayDone("replaced", to, tries, waited);
    } catch (e) {
      const wait = retryWait(e, tries, to);
      if (wait === null) {
        if (tmp) {
          try {
            await Deno.remove(from);
          } catch {
            /* aio-ok: already gone — the rename's error is reported */
          }
        }
        throw finalError("replace", to, e, tries, waited);
      }
      await _renameDeps.sleep(wait);
      waited += wait;
    }
  }
}

/** Rename the TEMP file `from` over `to`. On Windows a target another process
 *  holds open is retried through {@linkcode RENAME_BACKOFF_MS} (one debug
 *  line when it took more than one try). On any failure `from` is removed — a
 *  tmp is never left behind — and the error names the file and the OS error.
 *  A target that stayed held for the whole wait fails FAST for
 *  {@linkcode HELD_COOLDOWN_MS} (see there) and its recovery is said once.
 *  A success on the first try is the one rename call and nothing else. */
export function renameOverSync(from: string, to: string): void {
  replaceSync(from, to, true);
}

/** {@linkcode renameOverSync} for async callers: the same rule, bounds,
 *  memory and messages, awaiting a timer between tries instead of blocking. */
export function renameOver(from: string, to: string): Promise<void> {
  return replace(from, to, true);
}

/** Move the file `from` to `to` — a file that is DATA, not a temp (a damaged
 *  database set aside, a log archived, a staged copy installed): the same
 *  retry, and on failure `from` stays exactly where it was. */
export function moveFileSync(from: string, to: string): void {
  replaceSync(from, to, false);
}

/** {@linkcode moveFileSync} for async callers. */
export function moveFile(from: string, to: string): Promise<void> {
  return replace(from, to, false);
}

/** Remove the file at `path`, waiting out a Windows holder the same way: a
 *  delete of a file another process has open is refused exactly like a
 *  rename over it. A file that is already gone is the goal (`false`); any
 *  other final failure is thrown, named like a failed replace. */
export function removeOverSync(path: string): boolean {
  let waited = 0;
  for (let tries = 1;; tries++) {
    try {
      _renameDeps.remove(path);
      sayDone("removed", path, tries, waited);
      return true;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return false;
      const wait = retryWait(e, tries);
      if (wait === null) throw finalError("remove", path, e, tries, waited);
      _renameDeps.pause(wait);
      waited += wait;
    }
  }
}
