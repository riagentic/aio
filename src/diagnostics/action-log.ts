// src/diagnostics/action-log.ts — Rolling JSONL action recorder

import { log } from "../logger.ts";

const SKIP_SUFFIXES = [":__FlowState", ":__exec", ":__flow"];
const SKIP_CONTAINS = [":__set"];

function shouldSkip(type: string): boolean {
  if (SKIP_SUFFIXES.some((s) => type.endsWith(s))) return true;
  if (SKIP_CONTAINS.some((s) => type.includes(s))) return true;
  return false;
}

export function createActionLog(path: string, max: number) {
  let lineCount = 0;
  let writeErrors = 0;

  async function append(type: string, payload: unknown): Promise<void> {
    if (shouldSkip(type)) return;
    const line =
      JSON.stringify({ type, payload: payload ?? {}, ts: Date.now() }) + "\n";
    try {
      await Deno.writeTextFile(path, line, { append: true });
      lineCount++;
    } catch (e) {
      if (writeErrors++ < 3) log.error("action-log", `write failed: ${e}`);
    }
  }

  async function truncateIfNeeded(): Promise<void> {
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
  }

  async function flush(): Promise<void> {
    await truncateIfNeeded();
  }

  return { append, truncateIfNeeded, flush };
}
