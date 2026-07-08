/**
 * @module
 * Output formatting helpers for am — aio manager CLI.
 */

import type { GlobalFlags, OutputMode } from "./am-types.ts";

/** Detect output mode from CLI flags and terminal state */
export function detectMode(flags: GlobalFlags): OutputMode {
  if (flags.json) return "json";
  if (flags.quiet) return "quiet";
  return Deno.stdout.isTerminal() ? "pretty" : "json";
}

/** Formatted output — respects quiet/json/pretty mode */
export function out(data: unknown, mode: OutputMode): void {
  if (mode === "quiet") return;
  if (mode === "json") {
    console.log(JSON.stringify(data));
  } else {
    if (typeof data === "string") console.log(data);
    else console.log(JSON.stringify(data, null, 2));
  }
}

/** Error output — JSON or plain depending on mode */
export function outError(msg: string, mode: OutputMode): void {
  if (mode === "json") console.error(JSON.stringify({ error: msg }));
  else console.error(`error: ${msg}`);
}

/** Format seconds into human-readable uptime string (e.g. "2h 15m 30s") */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
