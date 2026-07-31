// src/diagnostics/action-log.ts — Rolling JSONL action recorder

import { log } from "./logger.ts";

const SKIP_SUFFIXES = [":__exec"];
const SKIP_CONTAINS = [":__set"];

function shouldSkip(type: string): boolean {
  if (SKIP_SUFFIXES.some((s) => type.endsWith(s))) return true;
  if (SKIP_CONTAINS.some((s) => type.includes(s))) return true;
  return false;
}

/** Create a rolling JSONL action recorder that auto-truncates at max lines */
export function createActionLog(path: string, max: number) {
  let lineCount = 0;
  let writeErrors = 0;
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
    if (shouldSkip(type)) return;
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
        await Deno.writeTextFile(path, line, { append: true });
        lineCount++;
      } catch (e) {
        if (writeErrors++ < 3) log.error("action-log", `write failed: ${e}`);
      }
    });
  }

  async function truncateIfNeeded(): Promise<void> {
    await _enqueue(async () => {
      if (lineCount <= max) return;
      try {
        const text = await Deno.readTextFile(path);
        const lines = text.trim().split("\n");
        if (lines.length <= max) {
          lineCount = lines.length;
          return;
        }
        const keep = lines.slice(Math.floor(lines.length / 2));
        await Deno.writeTextFile(path, keep.join("\n") + "\n");
        lineCount = keep.length;
      } catch {
        lineCount = 0;
      }
    });
  }

  async function flush(): Promise<void> {
    await truncateIfNeeded();
  }

  return { append, truncateIfNeeded, flush };
}
