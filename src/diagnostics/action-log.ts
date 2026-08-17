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

  // Initialize lineCount from existing file (best-effort)
  _queue = _queue.then(async () => {
    try {
      const text = await Deno.readTextFile(path);
      lineCount = text.trim().split("\n").filter((l) => l.length > 0).length;
    } catch {
      lineCount = 0;
    }
  });

  function _enqueue(fn: () => Promise<void>): Promise<void> {
    _queue = _queue.then(fn, fn);
    return _queue;
  }

  async function append(type: string, payload: unknown): Promise<void> {
    if (isActionNoise(type)) return;
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
    await truncateIfNeeded();
  }

  return { append, truncateIfNeeded, flush };
}
