// src/diagnostics/checkpoint.ts — Atomic state checkpoint + recovery

import type { CheckpointData } from "./types.ts";

const FILE = "checkpoint.json";
const TMP = "checkpoint.json.tmp";

/** Safe JSON.stringify that handles circular references (AIO-152). */
function _safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    const seen = new WeakSet();
    return JSON.stringify(data, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
  }
}

/** Read checkpoint from dir. Returns null if missing, corrupt, or unreadable. */
export function readCheckpoint(dir: string): CheckpointData | null {
  try {
    const text = Deno.readTextFileSync(`${dir}/${FILE}`);
    const data = JSON.parse(text) as CheckpointData;
    if (
      !data || typeof data.ts !== "number" || !data.state ||
      !Array.isArray(data.recentActions) || !data.features
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

  async function write(data: CheckpointData): Promise<void> {
    const tmp = `${dir}/${TMP}`;
    const target = `${dir}/${FILE}`;
    const json = _safeStringify(data);
    await Deno.writeTextFile(tmp, json);
    await Deno.rename(tmp, target);
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
      write(data).catch(() => {});
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (pending) write(pending).catch(() => {});
      timer = null;
    }, debounceMs);
  }

  /** Flush any pending write immediately */
  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    if (pending) await write(pending);
    pending = null;
  }

  return { write, writeSync, schedule, flush };
}
