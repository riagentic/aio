// src/diagnostics/checkpoint.ts — Atomic state checkpoint + recovery

import type { CheckpointData } from "./types.ts";
import { log } from "./logger.ts";

const FILE = "checkpoint.json";
const TMP = "checkpoint.json.tmp";

let _warnedDegraded = false;

/** TOTAL JSON.stringify: circular references (AIO-152), BigInt, and anything
 *  else state may legally hold that JSON cannot represent (a throwing getter,
 *  a hostile `toJSON`).
 *
 *  The old fallback replacer re-threw on a BigInt — the same throw the first
 *  attempt failed with — and could not intercept a getter that throws during
 *  property access at all. A snapshot writer is OBSERVE-ONLY: it may lose
 *  detail, never a caller. `flush()` is awaited on the shutdown path, so a
 *  throw here failed the shutdown that was trying to record the crash. */
function _safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch { /* fall through to the lossy encoder */ }
  try {
    const seen = new WeakSet();
    return JSON.stringify(data, (_key, value) => {
      if (typeof value === "bigint") return `${value}n`;
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
  } catch (e) {
    // Last resort: keep the envelope (a checkpoint that can't be read back is
    // worse than one without its state) and say why the state is missing.
    if (!_warnedDegraded) {
      _warnedDegraded = true;
      log.warn(
        "checkpoint",
        `state could not be serialized — the snapshot keeps its envelope but ` +
          `NOT the state (reported once). Cause: ${
            e instanceof Error ? e.message : String(e)
          }`,
      );
    }
    const d = (data ?? {}) as Partial<CheckpointData>;
    try {
      return JSON.stringify({
        ts: typeof d.ts === "number" ? d.ts : Date.now(),
        state: { _unserializable: e instanceof Error ? e.message : String(e) },
        recentActions: Array.isArray(d.recentActions)
          ? [...d.recentActions]
          : [],
        cells: {},
      });
    } catch {
      return `{"ts":${Date.now()},"state":{},"recentActions":[],"cells":{}}`;
    }
  }
}

/** Read checkpoint from dir. Returns null if missing, corrupt, or unreadable. */
export function readCheckpoint(dir: string): CheckpointData | null {
  try {
    const text = Deno.readTextFileSync(`${dir}/${FILE}`);
    const data = JSON.parse(text) as CheckpointData;
    if (
      !data || typeof data.ts !== "number" || !data.state ||
      !Array.isArray(data.recentActions) || !data.cells
    ) return null;
    return data;
  } catch {
    return null;
  }
}

/** Create a checkpoint writer. Debounce=0 means immediate write. */
export function createCheckpoint(dir: string, debounceMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: CheckpointData | null = null;

  // ONE tmp file, so two overlapping writes raced: both wrote it, the first
  // rename consumed it, the second failed with NotFound — and that rejection
  // surfaced through `flush()`, i.e. on the shutdown path. Writes are
  // serialized instead of racing.
  let chain: Promise<void> = Promise.resolve();
  function enqueue(fn: () => Promise<void>): Promise<void> {
    chain = chain.then(fn, fn);
    return chain;
  }

  function write(data: CheckpointData): Promise<void> {
    return enqueue(async () => {
      const tmp = `${dir}/${TMP}`;
      const target = `${dir}/${FILE}`;
      const json = _safeStringify(data);
      await Deno.writeTextFile(tmp, json);
      await Deno.rename(tmp, target);
    });
  }

  /** Synchronous emergency write — for crash handler. */
  function writeSync(data: CheckpointData): void {
    try {
      Deno.writeTextFileSync(`${dir}/${FILE}`, _safeStringify(data));
    } catch { /* best effort during crash */ }
  }

  /** Schedule a debounced write. */
  function schedule(data: CheckpointData): void {
    pending = data;
    if (debounceMs <= 0) {
      write(data).catch((e) =>
        console.error(`[checkpoint] write failed: ${e}`)
      ); // AIO-279: log instead of swallow
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (pending) {
        write(pending).catch((e) =>
          console.error(`[checkpoint] write failed: ${e}`)
        ); // AIO-279
      }
      timer = null;
    }, debounceMs);
  }

  /** Flush any pending write immediately.
   *  Awaited on the shutdown path: a snapshot that cannot be written is
   *  reported, never thrown — a diagnostic must not fail the shutdown it is
   *  trying to record. */
  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    const data = pending;
    pending = null;
    try {
      if (data) await write(data);
      else await chain; // still let an in-flight debounce-0 write land
    } catch (e) {
      log.warn(
        "checkpoint",
        `final write failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return { write, writeSync, schedule, flush };
}
