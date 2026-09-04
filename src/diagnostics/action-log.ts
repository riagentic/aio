// src/diagnostics/action-log.ts — Rolling JSONL action recorder

import { log } from "./logger-api.ts";

// What counts as framework noise is decided ONCE, in action-kind.ts. This file
// used to carry its own copy that dropped every `:__set` type — so an async
// method's writes, which exist in no other action, were missing from the log
// `docs/debugging/troubleshooting.md` points at to "replay the action
// sequence", while the journal, the timeline and time travel all recorded them.
import { isActionNoise } from "./action-kind.ts";

/** Create a rolling JSONL action recorder that auto-truncates at max lines */
export function createActionLog(path: string, max: number) {
  let lineCount = 0;
  let writeErrors = 0;
  let modeFixed = false;
  // Serialize all file operations to prevent interleaved writes/truncation
  let _queue: Promise<void> = Promise.resolve();

  // The existing file's line count is read on the FIRST APPEND, not here.
  //
  // Creating the log used to start a `Deno.readTextFile` immediately and put
  // it on `_queue`, where nothing awaits it until someone appends or flushes —
  // so a process (or a test) that made a log and wrote nothing left a file
  // read in flight at exit. `--sanitize-ops` reported it against whichever
  // test ran next, which is how it was found: two files that each pass alone
  // and fail together. It is the same shape as the post-`final` write two
  // comments down — "a file write nobody would wait for, landing in the next
  // process's — or the next test's — time" — and that one was already fixed.
  //
  // Lazy is also simply correct: the count exists to enforce `max` on append,
  // so nothing needs it until an append happens, and the first append chains
  // through the same `_enqueue` and therefore awaits it.
  let counted = false;
  const countExisting = async (): Promise<void> => {
    if (counted) return;
    counted = true;
    try {
      const text = await Deno.readTextFile(path);
      lineCount = text.trim().split("\n").filter((l) => l.length > 0).length;
    } catch {
      lineCount = 0;
    }
  };

  function _enqueue(fn: () => Promise<void>): Promise<void> {
    _queue = _queue.then(fn, fn);
    return _queue;
  }

  // Set by `flush()` — the shutdown flush. An append after it (Phase 5's
  // `onStop` → `onDestroy` dispatches) is teardown, not history: it used to
  // start a file write nobody would wait for, landing in the next process's
  // — or the next test's — time.
  let final = false;

  async function append(type: string, payload: unknown): Promise<void> {
    if (isActionNoise(type) || final) return;
    await _enqueue(countExisting);
    await _enqueue(async () => {
      let line: string;
      try {
        line = JSON.stringify({
          type,
          payload: payload ?? {},
          ts: Date.now(),
        }) + "\n";
      } catch {
        // Circular ref or BigInt — fall back to type-only
        line = JSON.stringify({ type, payload: {}, ts: Date.now() }) + "\n";
      }
      try {
        // 0600 like every other payload-retaining sink (journal, checkpoint):
        // action payloads are user data, and redaction only covers the methods
        // an app listed. Mode applies on creation; pre-existing files are
        // tightened once below.
        await Deno.writeTextFile(path, line, { append: true, mode: 0o600 });
        lineCount++;
        if (!modeFixed) {
          modeFixed = true;
          try {
            await Deno.chmod(path, 0o600);
          } catch {
            /* Windows, or FS without modes — creation mode did its best */
          }
        }
      } catch (e) {
        if (writeErrors++ < 3) log.error("action-log", `write failed: ${e}`);
      }
    });
    // `max` is enforced HERE, on the way in.
    //
    // Truncation used to be reachable only through `flush()`, which runs once
    // at `onStop` — so `max: 10` produced a hundred-line file on a running app,
    // and a SIGKILLed process never truncated at all. The bound is the whole
    // contract of a "rolling" log: it is what stops an always-on diagnostic
    // from filling a disk, and (with action payloads on those lines) how long
    // history sticks around.
    if (lineCount > max) await truncateIfNeeded();
  }

  /** Cut the file back under `max`.
   *
   *  Keeps the newest HALF of `max`, not the newest half of the FILE: the old
   *  rule kept `lines.length / 2`, so a 100-line file with `max: 10` truncated
   *  to 50 — still five times the bound it exists to enforce. Halving `max`
   *  (rather than trimming to exactly `max`) makes the rewrite amortized O(1)
   *  per append instead of O(max), while `lineCount <= max` holds after every
   *  append. */
  async function truncateIfNeeded(): Promise<void> {
    await _enqueue(async () => {
      if (lineCount <= max) return;
      try {
        const text = await Deno.readTextFile(path);
        const lines = text.trim().split("\n").filter((l) => l.length > 0);
        if (lines.length <= max) {
          lineCount = lines.length;
          return;
        }
        const keep = lines.slice(-Math.max(1, Math.floor(max / 2)));
        await Deno.writeTextFile(path, keep.join("\n") + "\n", {
          mode: 0o600,
        });
        lineCount = keep.length;
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
          lineCount = 0; // file vanished externally — nothing left to bound
          return;
        }
        // The bound IS the contract of a rolling log. Zeroing the counter
        // here masked the overflow (the next attempt waited `max` appends
        // away while the file sat over its bound) and said nothing — the
        // append path logs its failures, so this one does too, on the same
        // three-strikes budget. Keeping the count makes the next append retry.
        if (writeErrors++ < 3) {
          log.error("action-log", `truncate failed: ${e}`);
        }
      }
    });
  }

  async function flush(): Promise<void> {
    final = true;
    // The count is needed HERE too, not only on append: a log opened over a
    // file an earlier run left oversized must still come back under `max` at
    // shutdown, and with nothing appended in between this is the only place
    // that learns how many lines are already there. (Counting lazily is what
    // stopped the constructor leaving a file read nobody awaited; forgetting
    // this half turned that fix into a silently unbounded log.)
    await _enqueue(countExisting);
    // The appends are queued writes; the shutdown flush waits for the ones
    // still in flight, or the last lines of a run land in the NEXT process's
    // (or the next test's) time — and a SIGKILLed successor never sees them.
    await _queue;
    await truncateIfNeeded();
  }

  return { append, truncateIfNeeded, flush };
}
